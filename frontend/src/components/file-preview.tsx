import * as React from "react"
import DOMPurify from "dompurify"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { ExternalLinkIcon, SparklesIcon, XIcon } from "lucide-react"

import { api, type FileInfo, type Preview } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"

export function FilePreview({
  projectId,
  path,
  page,
  onClose,
}: {
  projectId: number
  path: string
  page?: number | null
  onClose: () => void
}) {
  const [preview, setPreview] = React.useState<Preview | null>(null)
  const [info, setInfo] = React.useState<FileInfo | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    // The parent keys this component by path, so state starts empty.
    let cancelled = false
    api.preview(projectId, path).then(
      (p) => !cancelled && setPreview(p),
      (e) => !cancelled && setError(e.message)
    )
    api.file(projectId, path).then(
      (f) => !cancelled && setInfo(f),
      () => {}
    )
    return () => {
      cancelled = true
    }
  }, [projectId, path])

  const raw = api.rawUrl(projectId, path)
  const name = path.split("/").pop()

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-start gap-2 border-b px-4 py-2.5">
        <div className="flex min-w-0 flex-col">
          <span className="truncate font-medium">{info?.title || name}</span>
          <span className="truncate font-mono text-xs text-muted-foreground">
            {path}
          </span>
        </div>
        <div className="ml-auto flex shrink-0 gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            title="Open in a new tab"
            render={<a href={raw} target="_blank" rel="noreferrer" />}
          >
            <ExternalLinkIcon />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            title="Close preview"
            onClick={onClose}
          >
            <XIcon />
          </Button>
        </div>
      </div>
      {info?.summary && (
        <div className="flex gap-2 border-b bg-muted/40 px-4 py-2 text-xs text-muted-foreground">
          {info.summary_source === "llm" && (
            <SparklesIcon className="mt-0.5 size-3.5 shrink-0 text-primary" />
          )}
          <p>{info.summary}</p>
          {info.status === "error" && (
            <Badge variant="destructive">{info.error}</Badge>
          )}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto">
        {error && <p className="p-4 text-sm text-destructive">{error}</p>}
        {!preview && !error && (
          <div className="flex h-full items-center justify-center">
            <Spinner />
          </div>
        )}
        {preview?.kind === "pdf" && (
          <iframe
            key={`${path}#${page ?? 1}`}
            title={path}
            src={`${raw}#page=${page ?? 1}`}
            className="h-full w-full border-0"
          />
        )}
        {preview?.kind === "markdown" && (
          <article className="mx-auto prose prose-sm max-w-3xl p-6 dark:prose-invert">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {preview.content.replace(/^---\n[\s\S]*?\n---\n/, "")}
            </ReactMarkdown>
          </article>
        )}
        {preview?.kind === "html" && (
          <article
            className="mx-auto prose prose-sm max-w-3xl p-6 dark:prose-invert"
            dangerouslySetInnerHTML={{
              __html: DOMPurify.sanitize(preview.content),
            }}
          />
        )}
      </div>
    </div>
  )
}
