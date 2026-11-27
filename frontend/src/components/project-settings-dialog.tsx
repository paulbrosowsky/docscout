import * as React from "react"

import { api, isBusy, type Project } from "@/lib/api"
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
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldSeparator,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { ChunkFields, chunkError } from "@/components/chunk-fields"
import { DirectoryPicker } from "@/components/directory-picker"

function ProjectSettingsDialogBody({
  project,
  onOpenChange,
  onSaved,
  onDeleted,
}: {
  project: Project
  open: boolean
  onOpenChange: (open: boolean) => void
  onSaved: (project: Project) => void
  onDeleted: () => void
}) {
  const [name, setName] = React.useState(project.name)
  const [description, setDescription] = React.useState(project.description)
  // null while the open folder overlaps another project.
  const [picked, setPicked] = React.useState<string | null | undefined>(
    undefined
  )
  const root = picked === undefined ? project.root_path : picked
  const [chunks, setChunks] = React.useState({
    chunk_size: project.chunk_size,
    chunk_overlap: project.chunk_overlap,
  })
  const [saving, setSaving] = React.useState(false)
  const [confirmDelete, setConfirmDelete] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const reindexNeeded =
    root !== project.root_path ||
    chunks.chunk_size !== project.chunk_size ||
    chunks.chunk_overlap !== project.chunk_overlap
  const busy = isBusy(project.scan.state)

  const run = async (fn: () => Promise<void>) => {
    setSaving(true)
    setError(null)
    try {
      await fn()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const save = () =>
    run(async () => {
      const updated = await api.updateProject(project.id, {
        name,
        description,
        root_path: root,
        ...chunks,
      })
      onSaved(updated)
      onOpenChange(false)
    })

  const reindex = (full: boolean) =>
    run(async () => {
      await api.scan(project.id, full)
      onSaved(await api.project(project.id))
      onOpenChange(false)
    })

  return (
    <>
      <DialogHeader>
        <DialogTitle>Project settings</DialogTitle>
        <DialogDescription>{project.name}</DialogDescription>
      </DialogHeader>
      <Tabs defaultValue="general">
        <TabsList>
          <TabsTrigger value="general">General</TabsTrigger>
          <TabsTrigger value="directory">Directory</TabsTrigger>
          <TabsTrigger value="index">Index</TabsTrigger>
        </TabsList>
        <TabsContent value="general" className="pt-4">
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="settings-name">Name</FieldLabel>
              <Input
                id="settings-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="settings-description">
                Description
              </FieldLabel>
              <Textarea
                id="settings-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </Field>
            <FieldSeparator />
            <Field>
              <FieldLabel>Delete project</FieldLabel>
              <FieldDescription>
                Removes the project and its index. Your files are not touched.
              </FieldDescription>
              <div>
                <Button
                  variant="destructive"
                  disabled={saving}
                  onClick={() =>
                    confirmDelete
                      ? run(async () => {
                          await api.deleteProject(project.id)
                          onDeleted()
                          onOpenChange(false)
                        })
                      : setConfirmDelete(true)
                  }
                >
                  {confirmDelete ? "Click again to delete" : "Delete project"}
                </Button>
              </div>
            </Field>
          </FieldGroup>
        </TabsContent>
        <TabsContent value="directory" className="pt-4">
          <DirectoryPicker
            value={project.root_path}
            projectId={project.id}
            onChange={(path) => setPicked(path)}
          />
        </TabsContent>
        <TabsContent value="index" className="pt-4">
          <FieldGroup>
            <ChunkFields value={chunks} onChange={setChunks} />
            <FieldSeparator />
            <Field>
              <FieldLabel>Re-index</FieldLabel>
              <FieldDescription>
                Files are re-scanned on every visit and when you press Rescan. A
                full re-index rebuilds every passage.
              </FieldDescription>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  disabled={saving || busy || reindexNeeded}
                  onClick={() => reindex(false)}
                >
                  Rescan for changes
                </Button>
                <Button
                  variant="outline"
                  disabled={saving || busy || reindexNeeded}
                  onClick={() => reindex(true)}
                >
                  Full re-index
                </Button>
              </div>
            </Field>
          </FieldGroup>
        </TabsContent>
      </Tabs>
      {reindexNeeded && (
        <p className="text-xs text-muted-foreground">
          Saving re-indexes the project with the new settings.
        </p>
      )}
      {busy && reindexNeeded && (
        <p className="text-xs text-destructive">
          Indexing is running. Wait for it to finish before changing the
          directory or chunk settings.
        </p>
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}
      <DialogFooter>
        <Button variant="outline" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button
          onClick={save}
          disabled={
            saving ||
            !name.trim() ||
            !!chunkError(chunks) ||
            (busy && reindexNeeded)
          }
        >
          {saving && <Spinner />}
          Save
        </Button>
      </DialogFooter>
    </>
  )
}

export function ProjectSettingsDialog(
  props: React.ComponentProps<typeof ProjectSettingsDialogBody>
) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        {/* The body mounts on open, so its state starts fresh each time. */}
        <ProjectSettingsDialogBody {...props} />
      </DialogContent>
    </Dialog>
  )
}
