import * as React from "react"
import {
  ChevronRightIcon,
  FileIcon,
  FileTextIcon,
  FileTypeIcon,
  FolderIcon,
  FolderOpenIcon,
  TriangleAlertIcon,
} from "lucide-react"

import type { TreeNode } from "@/lib/api"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"

// File Tree, built the way shadcn's AI Elements File Tree is built:
// a folder is a Collapsible, a file is a ghost Button.

function fileIcon(name: string) {
  const ext = name.split(".").pop()?.toLowerCase()
  if (ext === "pdf") return <FileTypeIcon className="text-red-500" />
  if (ext === "docx") return <FileTextIcon className="text-blue-500" />
  if (ext === "md" || ext === "markdown")
    return <FileIcon className="text-muted-foreground" />
  return <FileIcon />
}

function ancestors(path: string) {
  const parts = path.split("/")
  return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join("/"))
}

function FileTreeNode({
  node,
  selected,
  onSelect,
  open,
  onOpenChange,
}: {
  node: TreeNode
  selected: string | null
  onSelect: (path: string) => void
  open: Set<string>
  onOpenChange: (path: string, open: boolean) => void
}) {
  switch (node.type) {
    case "folder": {
      const isOpen = open.has(node.path)
      return (
        <Collapsible
          open={isOpen}
          onOpenChange={(value) => onOpenChange(node.path, value)}
        >
          <CollapsibleTrigger
            render={
              <Button
                variant="ghost"
                size="sm"
                className="w-full justify-start font-normal aria-expanded:bg-transparent aria-expanded:hover:bg-muted dark:aria-expanded:hover:bg-muted/50"
              />
            }
          >
            <ChevronRightIcon className="transition-transform group-data-panel-open/button:rotate-90" />
            {isOpen ? <FolderOpenIcon /> : <FolderIcon />}
            <span className="truncate">{node.name}</span>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="ml-4 flex flex-col">
              {node.children.map((child) => (
                <FileTreeNode
                  key={child.path}
                  node={child}
                  selected={selected}
                  onSelect={onSelect}
                  open={open}
                  onOpenChange={onOpenChange}
                />
              ))}
            </div>
          </CollapsibleContent>
        </Collapsible>
      )
    }
    case "file": {
      const isSelected = selected === node.path
      return (
        <Button
          variant="ghost"
          size="sm"
          title={
            node.title && node.title !== node.name
              ? `${node.title}\n${node.path}`
              : node.path
          }
          className={cn(
            "w-full justify-start font-normal",
            isSelected && "bg-accent text-accent-foreground",
            node.status === "pending" && "text-muted-foreground"
          )}
          aria-current={isSelected ? "true" : undefined}
          onClick={() => onSelect(node.path)}
          data-path={node.path}
        >
          {fileIcon(node.name)}
          <span className="truncate">{node.name}</span>
          {node.status === "error" && (
            <TriangleAlertIcon className="ml-auto text-amber-500" />
          )}
        </Button>
      )
    }
    default: {
      const unreachable: never = node
      return unreachable
    }
  }
}

export function FileTree({
  nodes,
  selected,
  onSelect,
}: {
  nodes: TreeNode[]
  selected: string | null
  onSelect: (path: string) => void
}) {
  // Top-level folders start open; the selected file's folders always open.
  const [open, setOpen] = React.useState<Set<string>>(
    () => new Set(nodes.filter((n) => n.type === "folder").map((n) => n.path))
  )

  // When the selection changes, open its folders (adjusting state while rendering).
  const [shownSelected, setShownSelected] = React.useState<string | null>(null)
  if (selected !== shownSelected) {
    setShownSelected(selected)
    if (selected) {
      const missing = ancestors(selected).filter((p) => !open.has(p))
      if (missing.length) setOpen(new Set([...open, ...missing]))
    }
  }

  const onOpenChange = React.useCallback((path: string, value: boolean) => {
    setOpen((prev) => {
      const next = new Set(prev)
      if (value) next.add(path)
      else next.delete(path)
      return next
    })
  }, [])

  return (
    <div className="flex flex-col text-sm" role="tree">
      {nodes.map((node) => (
        <FileTreeNode
          key={node.path}
          node={node}
          selected={selected}
          onSelect={onSelect}
          open={open}
          onOpenChange={onOpenChange}
        />
      ))}
    </div>
  )
}
