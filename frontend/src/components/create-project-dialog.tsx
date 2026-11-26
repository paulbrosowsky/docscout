import * as React from "react"
import { ChevronRightIcon } from "lucide-react"

import { api, CHUNK_DEFAULTS, type Project } from "@/lib/api"
import { Button } from "@/components/ui/button"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { ChunkFields, chunkError } from "@/components/chunk-fields"
import { DirectoryPicker } from "@/components/directory-picker"

/** Two steps: name and description, then the directory. Indexing starts on create. */
function CreateProjectDialogBody({
  onOpenChange,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (project: Project) => void
}) {
  const [step, setStep] = React.useState<1 | 2>(1)
  const [name, setName] = React.useState("")
  const [description, setDescription] = React.useState("")
  const [chunks, setChunks] = React.useState(CHUNK_DEFAULTS)
  // Defaults come from the server (CHUNK_SIZE / CHUNK_OVERLAP in .env).
  React.useEffect(() => {
    api.health().then(
      (h) => setChunks(h.chunk_defaults),
      () => {}
    )
  }, [])
  const [root, setRoot] = React.useState<string | null>(null)
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const create = async () => {
    setSaving(true)
    setError(null)
    try {
      const project = await api.createProject({
        name,
        description,
        root_path: root ?? "",
        ...chunks,
      })
      onCreated(project)
      onOpenChange(false)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {step === 1 ? "New project" : "Add the main directory"}
        </DialogTitle>
        <DialogDescription>
          {step === 1
            ? "Name the project and say what it is for."
            : "Choose the folder to search. Docscout scans it and indexes every document."}
        </DialogDescription>
      </DialogHeader>

      {step === 1 ? (
        <form
          id="project-step-1"
          onSubmit={(e) => {
            e.preventDefault()
            if (name.trim() && !chunkError(chunks)) setStep(2)
          }}
        >
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="project-name">Name</FieldLabel>
              <Input
                id="project-name"
                autoFocus
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Contracts 2026"
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="project-description">Description</FieldLabel>
              <Textarea
                id="project-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Rental and service contracts for the Berlin office"
              />
            </Field>
            <Collapsible>
              <CollapsibleTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="-ml-2 text-muted-foreground"
                  />
                }
              >
                <ChevronRightIcon className="transition-transform group-data-panel-open/button:rotate-90" />
                Index settings
              </CollapsibleTrigger>
              <CollapsibleContent className="pt-3">
                <ChunkFields value={chunks} onChange={setChunks} />
              </CollapsibleContent>
            </Collapsible>
          </FieldGroup>
        </form>
      ) : (
        <DirectoryPicker value={root} onChange={setRoot} />
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}

      <DialogFooter>
        {step === 1 ? (
          <Button
            type="submit"
            form="project-step-1"
            disabled={!name.trim() || !!chunkError(chunks)}
          >
            Next
          </Button>
        ) : (
          <>
            <Button variant="outline" onClick={() => setStep(1)}>
              Back
            </Button>
            <Button onClick={create} disabled={saving || root === null}>
              {saving && <Spinner />}
              Create and index
            </Button>
          </>
        )}
      </DialogFooter>
    </>
  )
}

export function CreateProjectDialog(
  props: React.ComponentProps<typeof CreateProjectDialogBody>
) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        {/* The body mounts on open, so its state starts fresh each time. */}
        <CreateProjectDialogBody {...props} />
      </DialogContent>
    </Dialog>
  )
}
