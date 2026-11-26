import * as React from "react"
import { DownloadIcon, Trash2Icon } from "lucide-react"

import { api, type LLMSettings, type ModelsInfo } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Progress } from "@/components/ui/progress"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Slider } from "@/components/ui/slider"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"

function formatBytes(n: number | null) {
  if (!n) return ""
  return n > 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`
}

function SliderField({
  label,
  description,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string
  description: string
  value: number
  min: number
  max: number
  step: number
  onChange: (v: number) => void
}) {
  return (
    <Field>
      <div className="flex items-center justify-between">
        <FieldLabel>{label}</FieldLabel>
        <span className="font-mono text-xs text-muted-foreground">{value}</span>
      </div>
      <Slider
        value={[value]}
        min={min}
        max={max}
        step={step}
        onValueChange={(v) => onChange(Array.isArray(v) ? v[0] : v)}
      />
      <FieldDescription>{description}</FieldDescription>
    </Field>
  )
}

function NumberField({
  id,
  label,
  description,
  value,
  min,
  max,
  onChange,
}: {
  id: string
  label: string
  description: string
  value: number
  min: number
  max: number
  onChange: (v: number) => void
}) {
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(e.target.valueAsNumber)}
      />
      <FieldDescription>{description}</FieldDescription>
    </Field>
  )
}

function ModelSettingsDialogBody({
  open,
  onOpenChange,
  onChanged,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onChanged: () => void
}) {
  const [settings, setSettings] = React.useState<LLMSettings | null>(null)
  const [models, setModels] = React.useState<ModelsInfo | null>(null)
  const [pullName, setPullName] = React.useState("")
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const loadModels = React.useCallback(
    () => api.models().then(setModels, (e: Error) => setError(e.message)),
    []
  )

  React.useEffect(() => {
    api.llmSettings().then(setSettings, (e: Error) => setError(e.message))
    loadModels()
  }, [loadModels])

  // Poll while a download runs.
  const pulling = models?.pulls.some((p) => p.state === "pulling")
  React.useEffect(() => {
    if (!open || !pulling) return
    const t = setInterval(loadModels, 1000)
    return () => clearInterval(t)
  }, [open, pulling, loadModels])

  const update = <K extends keyof LLMSettings>(key: K, value: LLMSettings[K]) =>
    setSettings((s) => (s ? { ...s, [key]: value } : s))

  const save = async () => {
    if (!settings) return
    setSaving(true)
    setError(null)
    try {
      setSettings(await api.saveLlmSettings(settings))
      onChanged()
      onOpenChange(false)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const pull = async (name: string) => {
    if (!name.trim()) return
    setError(null)
    try {
      await api.pullModel(name.trim())
      setPullName("")
      await loadModels()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const remove = async (name: string) => {
    setError(null)
    try {
      await api.deleteModel(name)
      await loadModels()
      onChanged()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const installed = models?.models ?? []
  const isInstalled = (name: string) =>
    installed.some((m) => m.name === name || m.name === `${name}:latest`)
  const modelItems = installed.map((m) => ({ label: m.name, value: m.name }))
  if (settings && !isInstalled(settings.model)) {
    modelItems.unshift({
      label: `${settings.model} (not installed)`,
      value: settings.model,
    })
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Model settings</DialogTitle>
        <DialogDescription>
          Local models run on this machine through Ollama. Nothing leaves your
          computer.
        </DialogDescription>
      </DialogHeader>
      {!settings ? (
        <div className="flex justify-center py-10">
          <Spinner />
        </div>
      ) : (
        <Tabs defaultValue="model">
          <TabsList>
            <TabsTrigger value="model">Model</TabsTrigger>
            <TabsTrigger value="parameters">Parameters</TabsTrigger>
            <TabsTrigger value="prompts">Prompts</TabsTrigger>
            <TabsTrigger value="library">Library</TabsTrigger>
          </TabsList>
          <ScrollArea className="mt-4 h-[26rem] pr-3">
            <TabsContent value="model">
              <FieldGroup>
                <Field orientation="horizontal">
                  <FieldContent>
                    <FieldLabel htmlFor="llm-enabled">AI summaries</FieldLabel>
                    <FieldDescription>
                      Summarise each file while indexing. When off, results show
                      the opening sentences instead.
                    </FieldDescription>
                  </FieldContent>
                  <Switch
                    id="llm-enabled"
                    checked={settings.enabled}
                    onCheckedChange={(v) => update("enabled", v)}
                  />
                </Field>
                <Field>
                  <FieldLabel>Default model</FieldLabel>
                  <Select
                    items={modelItems}
                    value={settings.model}
                    onValueChange={(v) => v && update("model", v as string)}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {modelItems.map((m) => (
                        <SelectItem key={m.value} value={m.value}>
                          {m.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FieldDescription>
                    Used for file summaries while indexing, and preselected in
                    the search box.
                  </FieldDescription>
                </Field>
                <Field>
                  <FieldLabel>Embedding model</FieldLabel>
                  <div className="flex items-center gap-2 text-sm">
                    <code className="rounded-md bg-muted px-2 py-1 text-xs">
                      {models?.embedding_model}
                    </code>
                    <Badge variant="secondary">
                      {models?.embedding_dim} dims
                    </Badge>
                  </div>
                  <FieldDescription>
                    Turns passages into vectors for search. Set with
                    EMBEDDING_MODEL in .env, because changing it re-indexes
                    every project.
                  </FieldDescription>
                </Field>
                {models && !models.ollama_available && (
                  <p className="text-sm text-destructive">
                    Ollama is not reachable. Search still works, with extractive
                    summaries.
                  </p>
                )}
              </FieldGroup>
            </TabsContent>

            <TabsContent value="parameters">
              <FieldGroup>
                <SliderField
                  label="Temperature"
                  description="Lower is more factual and repeatable, higher is more varied."
                  value={settings.temperature}
                  min={0}
                  max={1.5}
                  step={0.05}
                  onChange={(v) => update("temperature", v)}
                />
                <SliderField
                  label="Top P"
                  description="Only sample from the most likely words whose probabilities add up to this."
                  value={settings.top_p}
                  min={0.05}
                  max={1}
                  step={0.05}
                  onChange={(v) => update("top_p", v)}
                />
                <div className="grid grid-cols-2 gap-4">
                  <NumberField
                    id="num-ctx"
                    label="Context window"
                    description="Tokens the model reads at once (num_ctx). More needs more RAM."
                    value={settings.num_ctx}
                    min={512}
                    max={131072}
                    onChange={(v) => update("num_ctx", v)}
                  />
                  <NumberField
                    id="num-predict"
                    label="Max output tokens"
                    description="Upper limit for a summary's length (num_predict)."
                    value={settings.num_predict}
                    min={16}
                    max={4096}
                    onChange={(v) => update("num_predict", v)}
                  />
                </div>
                <NumberField
                  id="max-input"
                  label="Document text per summary"
                  description="Characters of each document sent to the model. Keep it below about 3 × the context window."
                  value={settings.max_input_chars}
                  min={500}
                  max={100000}
                  onChange={(v) => update("max_input_chars", v)}
                />
              </FieldGroup>
            </TabsContent>

            <TabsContent value="prompts">
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="summary-prompt">
                    File summary prompt
                  </FieldLabel>
                  <Textarea
                    id="summary-prompt"
                    className="min-h-28 font-mono text-xs"
                    value={settings.summary_prompt}
                    onChange={(e) => update("summary_prompt", e.target.value)}
                  />
                  <FieldDescription>
                    Used once per file while indexing. The title and text are
                    appended.
                  </FieldDescription>
                </Field>
                <Field>
                  <FieldLabel htmlFor="answer-prompt">
                    Search result prompt
                  </FieldLabel>
                  <Textarea
                    id="answer-prompt"
                    className="min-h-28 font-mono text-xs"
                    value={settings.answer_prompt}
                    onChange={(e) => update("answer_prompt", e.target.value)}
                  />
                  <FieldDescription>
                    Used when a model is chosen in the search box. The query and
                    the best matching passages are appended.
                  </FieldDescription>
                </Field>
              </FieldGroup>
            </TabsContent>

            <TabsContent value="library">
              <div className="flex flex-col gap-4">
                <div className="flex flex-col gap-1">
                  {installed.length === 0 && (
                    <p className="text-sm text-muted-foreground">
                      No models installed yet.
                    </p>
                  )}
                  {installed.map((m) => (
                    <div
                      key={m.name}
                      className="flex items-center gap-2 rounded-xl px-2 py-1.5 hover:bg-muted"
                    >
                      <span className="text-sm font-medium">{m.name}</span>
                      {m.parameter_size && (
                        <Badge variant="secondary">{m.parameter_size}</Badge>
                      )}
                      {m.quantization && (
                        <Badge variant="outline">{m.quantization}</Badge>
                      )}
                      <span className="ml-auto text-xs text-muted-foreground">
                        {formatBytes(m.size)}
                      </span>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        title={`Remove ${m.name}`}
                        onClick={() => remove(m.name)}
                      >
                        <Trash2Icon />
                      </Button>
                    </div>
                  ))}
                </div>

                {models?.pulls
                  .filter((p) => p.state !== "done")
                  .map((p) => (
                    <div key={p.model} className="flex flex-col gap-1.5">
                      <div className="flex justify-between text-xs">
                        <span>
                          {p.model}: {p.error ?? p.status}
                        </span>
                        {p.total > 0 && (
                          <span>
                            {Math.round((p.completed / p.total) * 100)}%
                          </span>
                        )}
                      </div>
                      {p.state === "pulling" && (
                        <Progress
                          value={p.total ? (p.completed / p.total) * 100 : null}
                        />
                      )}
                    </div>
                  ))}

                <form
                  className="flex gap-2"
                  onSubmit={(e) => {
                    e.preventDefault()
                    pull(pullName)
                  }}
                >
                  <Input
                    placeholder="Model name, e.g. qwen2.5:1.5b"
                    value={pullName}
                    onChange={(e) => setPullName(e.target.value)}
                  />
                  <Button type="submit" disabled={!pullName.trim()}>
                    <DownloadIcon />
                    Download
                  </Button>
                </form>

                <div className="flex flex-col gap-1">
                  <p className="text-xs font-medium text-muted-foreground">
                    Suggested for CPU
                  </p>
                  {models?.suggested.map((s) => (
                    <div
                      key={s.name}
                      className="flex items-center gap-2 rounded-xl px-2 py-1.5 hover:bg-muted"
                    >
                      <div className="flex min-w-0 flex-col">
                        <span className="text-sm">{s.name}</span>
                        <span className="text-xs text-muted-foreground">
                          {s.note}
                        </span>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        className="ml-auto"
                        disabled={isInstalled(s.name)}
                        onClick={() => pull(s.name)}
                      >
                        {isInstalled(s.name) ? "Installed" : "Download"}
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            </TabsContent>
          </ScrollArea>
        </Tabs>
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}
      <DialogFooter>
        <Button variant="outline" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button onClick={save} disabled={saving || !settings}>
          {saving && <Spinner />}
          Save
        </Button>
      </DialogFooter>
    </>
  )
}

export function ModelSettingsDialog(
  props: React.ComponentProps<typeof ModelSettingsDialogBody>
) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        {/* The body mounts on open, so its state starts fresh each time. */}
        <ModelSettingsDialogBody {...props} />
      </DialogContent>
    </Dialog>
  )
}
