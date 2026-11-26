import * as React from "react"
import { ArrowUpIcon, FolderIcon, HardDriveIcon } from "lucide-react"

import { api, type DirListing } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Spinner } from "@/components/ui/spinner"

/** Browse the folders below the documents root and pick one. */
export function DirectoryPicker({
  value,
  onChange,
}: {
  value: string | null
  onChange: (path: string) => void
}) {
  const [listing, setListing] = React.useState<DirListing | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [loading, setLoading] = React.useState(true)

  const open = React.useCallback(
    async (path: string) => {
      setLoading(true)
      setError(null)
      try {
        const result = await api.dirs(path)
        setListing(result)
        onChange(result.path)
      } catch (e) {
        setError((e as Error).message)
      } finally {
        setLoading(false)
      }
    },
    [onChange]
  )

  // Initial listing, on mount only: later navigation goes through open().
  const initial = React.useRef(value ?? "")
  const onChangeRef = React.useRef(onChange)
  React.useEffect(() => {
    api
      .dirs(initial.current)
      .then(
        (result) => {
          setListing(result)
          onChangeRef.current(result.path)
        },
        (e: Error) => setError(e.message)
      )
      .finally(() => setLoading(false))
  }, [])

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 rounded-xl bg-muted px-3 py-2 font-mono text-xs">
        <HardDriveIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate">/{listing?.path ?? ""}</span>
        {loading && <Spinner className="ml-auto size-3.5" />}
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
          {listing?.dirs.map((dir) => (
            <Button
              key={dir.path}
              variant="ghost"
              size="sm"
              className="justify-start font-normal"
              onClick={() => open(dir.path)}
            >
              <FolderIcon />
              <span className="truncate">{dir.name}</span>
            </Button>
          ))}
          {listing && listing.dirs.length === 0 && (
            <p className="px-3 py-2 text-xs text-muted-foreground">
              No subfolders here.
            </p>
          )}
        </div>
      </ScrollArea>
      {error && <p className="text-xs text-destructive">{error}</p>}
      <p className="text-xs text-muted-foreground">
        Open a folder to select it. All PDF, Markdown and Word files below it
        are indexed.
      </p>
    </div>
  )
}
