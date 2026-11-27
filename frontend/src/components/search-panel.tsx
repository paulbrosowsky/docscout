import * as React from "react"
import {
  ArrowUpIcon,
  FileTextIcon,
  SearchIcon,
  SparklesIcon,
  ZapIcon,
} from "lucide-react"

import { api, type SearchResult } from "@/lib/api"
import { cn } from "@/lib/utils"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@/components/ui/input-group"
import { Kbd } from "@/components/ui/kbd"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"

export const FAST_MODE = "__fast__"

/** True when the snippet mostly repeats the summary (short documents). */
function overlaps(summary: string, snippet: string) {
  const norm = (t: string) =>
    t
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim()
  const probe = norm(snippet.replace(/^… /, "")).slice(0, 60)
  return probe.length > 0 && norm(summary).includes(probe)
}

function ResultSummary({
  projectId,
  result,
  query,
  model,
}: {
  projectId: number
  result: SearchResult
  query: string
  model: string
}) {
  const [text, setText] = React.useState<string | null>(null)
  const [failed, setFailed] = React.useState(false)

  // The parent keys this component by query and model, so state starts fresh.
  React.useEffect(() => {
    if (model === FAST_MODE) return
    let cancelled = false
    api.summarize(projectId, result.path, query, model).then(
      (r) => !cancelled && setText(r.summary),
      () => !cancelled && setFailed(true)
    )
    return () => {
      cancelled = true
    }
  }, [projectId, result.path, query, model])

  if (model === FAST_MODE || failed) {
    return <p className="text-sm text-muted-foreground">{result.summary}</p>
  }
  if (text === null) {
    return (
      <div className="flex flex-col gap-1.5 py-0.5">
        <Skeleton className="h-3.5 w-full" />
        <Skeleton className="h-3.5 w-2/3" />
      </div>
    )
  }
  return (
    <p className="text-sm text-muted-foreground">
      <SparklesIcon className="mr-1 inline size-3.5 -translate-y-px text-primary" />
      {text}
    </p>
  )
}

export function SearchPanel({
  projectId,
  models,
  model,
  onModelChange,
  onOpenResult,
  activePath,
  disabled,
}: {
  projectId: number
  models: string[]
  model: string
  onModelChange: (model: string) => void
  onOpenResult: (result: SearchResult) => void
  activePath: string | null
  disabled?: boolean
}) {
  const [query, setQuery] = React.useState("")
  const [submitted, setSubmitted] = React.useState<string | null>(null)
  const [results, setResults] = React.useState<SearchResult[] | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const submit = async () => {
    const q = query.trim()
    if (!q || loading) return
    setLoading(true)
    setError(null)
    try {
      const res = await api.search(projectId, q)
      setResults(res.results)
      setSubmitted(q)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  const items = [
    { value: FAST_MODE, label: "Fast (no AI)" },
    ...models.map((m) => ({ value: m, label: m })),
  ]

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b p-3">
        <form
          className="mx-auto w-full max-w-3xl"
          onSubmit={(e) => {
            e.preventDefault()
            submit()
          }}
        >
          <InputGroup>
            <InputGroupTextarea
              placeholder="Describe what you are looking for, e.g. “what is the notice period for the Berlin flat?”"
              className="max-h-48 min-h-20"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault()
                  submit()
                }
              }}
              disabled={disabled}
            />
            <InputGroupAddon align="block-end">
              <Select
                items={items}
                value={model}
                onValueChange={(v) => v && onModelChange(v as string)}
              >
                <SelectTrigger
                  size="sm"
                  className="border-none bg-transparent shadow-none hover:bg-muted dark:bg-transparent"
                  title="Model for result summaries"
                >
                  {model === FAST_MODE ? <ZapIcon /> : <SparklesIcon />}
                  <SelectValue />
                </SelectTrigger>
                <SelectContent
                  alignItemWithTrigger={false}
                  align="start"
                  className="min-w-64"
                >
                  <SelectGroup>
                    <SelectItem value={FAST_MODE}>Fast (no AI)</SelectItem>
                  </SelectGroup>
                  {models.length > 0 && (
                    <>
                      <SelectSeparator />
                      <SelectGroup>
                        <SelectLabel>Summarise results with</SelectLabel>
                        {models.map((m) => (
                          <SelectItem key={m} value={m}>
                            {m}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </>
                  )}
                </SelectContent>
              </Select>
              <span className="ml-auto hidden text-xs text-muted-foreground sm:inline">
                <Kbd>Enter</Kbd> to search
              </span>
              <InputGroupButton
                type="submit"
                variant="default"
                size="icon-sm"
                className="rounded-full"
                disabled={!query.trim() || loading || disabled}
                aria-label="Search"
              >
                {loading ? <Spinner /> : <ArrowUpIcon />}
              </InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
        </form>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* Results share the search box's centred column. */}
        <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col">
          {error && <p className="p-4 text-sm text-destructive">{error}</p>}
          {results === null && !error && (
            <Empty className="flex-1">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <SearchIcon />
                </EmptyMedia>
                <EmptyTitle>Search by meaning</EmptyTitle>
                <EmptyDescription>
                  Ask in your own words. Docscout finds documents that match the
                  context, not just the exact words.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
          {results && results.length === 0 && (
            <p className="p-4 text-sm text-muted-foreground">
              No matching documents. The project may still be indexing.
            </p>
          )}
          {results && results.length > 0 && submitted && (
            <ol className="flex flex-col gap-1 p-2">
              {results.map((r) => (
                <li key={r.path}>
                  <div
                    className={cn(
                      "flex flex-col gap-1.5 rounded-2xl px-3 py-2.5 transition-colors hover:bg-muted/60",
                      activePath === r.path && "bg-muted"
                    )}
                  >
                    <div className="flex items-start gap-2">
                      <button
                        type="button"
                        className="text-left font-medium hover:underline"
                        onClick={() => onOpenResult(r)}
                      >
                        {r.title}
                      </button>
                      <span
                        className="ml-auto shrink-0 pt-0.5 font-mono text-[11px] text-muted-foreground"
                        title="Relevance relative to the best match"
                      >
                        {Math.round(r.score * 100)}%
                      </span>
                    </div>
                    <ResultSummary
                      key={`${submitted}|${model}`}
                      projectId={projectId}
                      result={r}
                      query={submitted}
                      model={model}
                    />
                    {r.snippet && !overlaps(r.summary, r.snippet) && (
                      <blockquote className="border-l-2 pl-2 text-xs text-muted-foreground/80 italic">
                        {r.snippet}
                      </blockquote>
                    )}
                    <button
                      type="button"
                      onClick={() => onOpenResult(r)}
                      className="flex w-fit items-center gap-1 font-mono text-xs text-primary/80 hover:text-primary hover:underline"
                    >
                      <FileTextIcon className="size-3.5" />
                      {r.page != null ? `${r.path}, page ${r.page}` : r.path}
                    </button>
                  </div>
                </li>
              ))}
            </ol>
          )}
          {loading && results === null && (
            <div className="flex flex-col gap-3 p-4">
              {[0, 1, 2].map((i) => (
                <div key={i} className="flex flex-col gap-2">
                  <Skeleton className="h-4 w-1/2" />
                  <Skeleton className="h-3 w-full" />
                  <Skeleton className="h-3 w-4/5" />
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
