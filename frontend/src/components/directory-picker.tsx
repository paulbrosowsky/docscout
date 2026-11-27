import * as React from "react"
import {
  ArrowUpIcon,
  CheckCircle2Icon,
  FolderIcon,
  FolderLockIcon,
  HardDriveIcon,
  TriangleAlertIcon,
} from "lucide-react"

import { api, type DirListing } from "@/lib/api"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Spinner } from "@/components/ui/spinner"

function conflictText(listing: DirListing) {
  if (listing.taken_by)
    return `This folder belongs to project “${listing.taken_by.name}”.`
  if (listing.contains.length)
    return `This folder contains the folder of ${listing.contains
      .map((n) => `“${n}”`)
      .join(", ")}. Open a subfolder that no other project uses.`
  return null
}

/**
 * Browse the folders below the documents root and pick one.
 * Folders used by another project cannot be chosen, so projects never overlap.
 * onChange receives null while the open folder cannot be chosen.
 */
export function DirectoryPicker({
  value,
  onChange,
  projectId,
}: {
  value: string | null
  onChange: (path: string | null) => void
  /** When editing a project, its own folder counts as free. */
  projectId?: number
}) {
  const [listing, setListing] = React.useState<DirListing | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [loading, setLoading] = React.useState(true)

  const show = React.useCallback(
    (result: DirListing) => {
      setListing(result)
      onChange(result.available ? result.path : null)
    },
    [onChange]
  )

  const open = React.useCallback(
    async (path: string) => {
      setLoading(true)
      setError(null)
      try {
        show(await api.dirs(path, projectId))
      } catch (e) {
        setError((e as Error).message)
      } finally {
        setLoading(false)
      }
    },
    [show, projectId]
  )

  // Initial listing, on mount only: later navigation goes through open().
  const initial = React.useRef({ path: value ?? "", projectId })
  const showRef = React.useRef(show)
  React.useEffect(() => {
    api
      .dirs(initial.current.path, initial.current.projectId)
      .then(
        (result) => showRef.current(result),
        (e: Error) => setError(e.message)
      )
      .finally(() => setLoading(false))
  }, [])

  const conflict = listing ? conflictText(listing) : null

  return (
    <div className="flex flex-col gap-2">
      <div
        className={cn(
          "flex items-center gap-2 rounded-xl px-3 py-2 text-xs",
          conflict ? "bg-destructive/10 text-destructive" : "bg-muted"
        )}
      >
        <HardDriveIcon className="size-3.5 shrink-0 opacity-70" />
        <span className="truncate font-mono">/{listing?.path ?? ""}</span>
        {loading ? (
          <Spinner className="ml-auto size-3.5" />
        ) : conflict ? (
          <TriangleAlertIcon className="ml-auto size-3.5 shrink-0" />
        ) : (
          listing && (
            <CheckCircle2Icon className="ml-auto size-3.5 shrink-0 text-emerald-600" />
          )
        )}
      </div>
      <ScrollArea className="h-56 rounded-xl border">
        <div className="flex flex-col p-1">
          {listing?.parent != null && (
            <Button
              variant="ghost"
              size="sm"
              className="justify-start font-normal"
              onClick={() => open(listing.parent ?? "")}
            >
              <ArrowUpIcon />
              ..
            </Button>
          )}
          {listing?.dirs.map((dir) => {
            const taken = dir.taken_by
            return (
              <Button
                key={dir.path}
                variant="ghost"
                size="sm"
                className="justify-start font-normal"
                disabled={!!taken}
                title={
                  taken
                    ? `Used by project “${taken.name}”`
                    : dir.contains.length
                      ? `Contains folders of: ${dir.contains.join(", ")}`
                      : undefined
                }
                onClick={() => open(dir.path)}
              >
                {taken ? <FolderLockIcon /> : <FolderIcon />}
                <span className="truncate">{dir.name}</span>
                {taken && (
                  <Badge variant="secondary" className="ml-auto">
                    {taken.name}
                  </Badge>
                )}
                {!taken && dir.contains.length > 0 && (
                  <Badge variant="outline" className="ml-auto">
                    {dir.contains.length === 1
                      ? `contains ${dir.contains[0]}`
                      : `contains ${dir.contains.length} projects`}
                  </Badge>
                )}
              </Button>
            )
          })}
          {listing && listing.dirs.length === 0 && (
            <p className="px-3 py-2 text-xs text-muted-foreground">
              No subfolders here.
            </p>
          )}
        </div>
      </ScrollArea>
      {error && <p className="text-xs text-destructive">{error}</p>}
      <p
        className={cn(
          "text-xs",
          conflict ? "text-destructive" : "text-muted-foreground"
        )}
      >
        {conflict ??
          "Open a folder to select it. All PDF, Markdown and Word files below it are indexed. Each folder can belong to one project only."}
      </p>
    </div>
  )
}
