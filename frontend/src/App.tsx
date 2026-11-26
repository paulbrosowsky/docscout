import * as React from "react"
import {
  ChevronsUpDownIcon,
  CpuIcon,
  FolderTreeIcon,
  MoonIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  PlusIcon,
  RefreshCwIcon,
  ScanSearchIcon,
  Settings2Icon,
  SunIcon,
} from "lucide-react"
import { usePanelRef } from "react-resizable-panels"

import {
  api,
  isBusy,
  type Project,
  type SearchResult,
  type TreeNode,
} from "@/lib/api"
import { useTheme } from "@/components/theme-provider"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { Progress } from "@/components/ui/progress"
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Spinner } from "@/components/ui/spinner"
import { CreateProjectDialog } from "@/components/create-project-dialog"
import { FilePreview } from "@/components/file-preview"
import { FileTree } from "@/components/file-tree"
import { ModelSettingsDialog } from "@/components/model-settings-dialog"
import { ProjectSettingsDialog } from "@/components/project-settings-dialog"
import { FAST_MODE, SearchPanel } from "@/components/search-panel"

const LAST_PROJECT = "docscout:project"
const SEARCH_MODEL = "docscout:search-model"

function ScanIndicator({
  project,
  onCancel,
}: {
  project: Project
  onCancel: () => void
}) {
  const s = project.scan
  if (!isBusy(s.state)) {
    if (s.state === "error")
      return (
        <span className="text-xs text-destructive" title={s.message ?? ""}>
          Indexing failed
        </span>
      )
    return null
  }
  const [label, done, total] =
    s.state === "summarizing"
      ? ["Summarising", s.summarized, s.to_summarize]
      : s.state === "indexing"
        ? ["Indexing", s.indexed, s.to_index]
        : ["Scanning", 0, 0]
  return (
    <div
      className="flex w-56 items-center gap-2"
      title={s.current ?? undefined}
    >
      <Spinner className="size-3.5 shrink-0" />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="truncate text-xs text-muted-foreground">
          {label} {total ? `${done}/${total}` : "…"}
        </span>
        <Progress value={total ? (done / total) * 100 : null} />
      </div>
      <Button variant="ghost" size="xs" onClick={onCancel}>
        Stop
      </Button>
    </div>
  )
}

export function App() {
  const { theme, setTheme } = useTheme()
  const [projects, setProjects] = React.useState<Project[] | null>(null)
  const [project, setProject] = React.useState<Project | null>(null)
  const [tree, setTree] = React.useState<TreeNode[] | null>(null)
  const [selected, setSelected] = React.useState<{
    path: string
    page?: number | null
  } | null>(null)
  const [treeCollapsed, setTreeCollapsed] = React.useState(false)
  const [createOpen, setCreateOpen] = React.useState(false)
  const [settingsOpen, setSettingsOpen] = React.useState(false)
  const [modelsOpen, setModelsOpen] = React.useState(false)
  const [models, setModels] = React.useState<string[]>([])
  const [searchModel, setSearchModel] = React.useState<string>(
    () => localStorage.getItem(SEARCH_MODEL) ?? ""
  )
  const [loadError, setLoadError] = React.useState<string | null>(null)
  const treePanel = usePanelRef()

  const loadProjects = React.useCallback(async () => {
    try {
      const list = await api.projects()
      setProjects(list)
      return list
    } catch (e) {
      setLoadError((e as Error).message)
      return []
    }
  }, [])

  const loadModels = React.useCallback(
    () =>
      Promise.all([api.models(), api.llmSettings()]).then(
        ([info, cfg]) => {
          const names = info.models.map((m) => m.name)
          setModels(names)
          setSearchModel((current) => {
            if (current && (current === FAST_MODE || names.includes(current)))
              return current
            const def = names.find(
              (n) => n === cfg.model || n === `${cfg.model}:latest`
            )
            return cfg.enabled && def ? def : FAST_MODE
          })
        },
        () => {
          setModels([])
          setSearchModel(FAST_MODE)
        }
      ),
    []
  )

  // Initial load: projects, models, last opened project.
  React.useEffect(() => {
    loadModels()
    api.projects().then(
      (list) => {
        setProjects(list)
        const last = Number(localStorage.getItem(LAST_PROJECT))
        setProject(list.find((p) => p.id === last) ?? list[0] ?? null)
      },
      (e: Error) => setLoadError(e.message)
    )
  }, [loadModels])

  React.useEffect(() => {
    if (searchModel) localStorage.setItem(SEARCH_MODEL, searchModel)
  }, [searchModel])

  const projectId = project?.id
  const loadTree = React.useCallback(
    () =>
      projectId == null
        ? Promise.resolve()
        : api.tree(projectId).then(setTree, () => setTree([])),
    [projectId]
  )

  // Switching projects resets the view (adjusting state while rendering).
  const [shownProjectId, setShownProjectId] = React.useState(projectId)
  if (projectId !== shownProjectId) {
    setShownProjectId(projectId)
    setSelected(null)
    setTree(null)
  }

  // ... then rescans for changes and loads the tree.
  React.useEffect(() => {
    if (projectId == null) return
    localStorage.setItem(LAST_PROJECT, String(projectId))
    loadTree()
    api
      .scan(projectId)
      .then(() => api.project(projectId))
      .then(setProject)
      .catch(() => {})
  }, [projectId, loadTree])

  // Poll while indexing, and refresh the tree as files are found.
  const busy = project ? isBusy(project.scan.state) : false
  React.useEffect(() => {
    if (!busy || projectId == null) return
    let ticks = 0
    const timer = setInterval(async () => {
      try {
        const next = await api.project(projectId)
        setProject(next)
        if (++ticks % 3 === 0 || !isBusy(next.scan.state)) loadTree()
        if (!isBusy(next.scan.state)) loadProjects()
      } catch {
        /* keep polling */
      }
    }, 1000)
    return () => clearInterval(timer)
  }, [busy, projectId, loadTree, loadProjects])

  const toggleTree = () => {
    const panel = treePanel.current
    if (!panel) return
    if (panel.isCollapsed()) panel.expand()
    else panel.collapse()
  }

  const openResult = (r: SearchResult) => {
    setSelected({ path: r.path, page: r.page })
    treePanel.current?.collapse()
  }

  const onCreated = (p: Project) => {
    setProjects((list) => [p, ...(list ?? [])])
    setProject(p)
  }

  if (loadError && projects === null) {
    return (
      <div className="flex h-svh items-center justify-center p-6">
        <Empty>
          <EmptyHeader>
            <EmptyTitle>Cannot reach the Docscout server</EmptyTitle>
            <EmptyDescription>{loadError}</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button onClick={() => window.location.reload()}>Retry</Button>
          </EmptyContent>
        </Empty>
      </div>
    )
  }

  return (
    <div className="flex h-svh flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
        <div className="flex items-center gap-2 pr-2 font-semibold">
          <ScanSearchIcon className="size-5" />
          Docscout
        </div>
        {projects && projects.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={<Button variant="ghost" size="sm" className="max-w-64" />}
            >
              <span className="truncate">
                {project?.name ?? "Choose a project"}
              </span>
              <ChevronsUpDownIcon className="text-muted-foreground" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-64">
              <DropdownMenuGroup>
                <DropdownMenuLabel>Projects</DropdownMenuLabel>
                <DropdownMenuRadioGroup
                  value={String(project?.id ?? "")}
                  onValueChange={(v) =>
                    setProject(projects.find((p) => String(p.id) === v) ?? null)
                  }
                >
                  {projects.map((p) => (
                    <DropdownMenuRadioItem key={p.id} value={String(p.id)}>
                      <div className="flex min-w-0 flex-col">
                        <span className="truncate">{p.name}</span>
                        {p.description && (
                          <span className="truncate text-xs text-muted-foreground">
                            {p.description}
                          </span>
                        )}
                      </div>
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => setCreateOpen(true)}>
                <PlusIcon />
                New project
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {project && (
          <ScanIndicator
            project={project}
            onCancel={() =>
              api
                .cancelScan(project.id)
                .then(() => api.project(project.id))
                .then(setProject)
            }
          />
        )}
        <div className="ml-auto flex items-center gap-1">
          {project && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setSettingsOpen(true)}
            >
              <Settings2Icon />
              Project settings
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={() => setModelsOpen(true)}>
            <CpuIcon />
            Models
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            title="Toggle dark mode (D)"
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          >
            {theme === "dark" ? <SunIcon /> : <MoonIcon />}
          </Button>
        </div>
      </header>

      {projects === null ? (
        <div className="flex flex-1 items-center justify-center">
          <Spinner />
        </div>
      ) : !project ? (
        <Empty className="flex-1">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <FolderTreeIcon />
            </EmptyMedia>
            <EmptyTitle>Create your first project</EmptyTitle>
            <EmptyDescription>
              A project points at a folder of PDF, Markdown and Word files.
              Docscout indexes them on this machine so you can search them by
              meaning.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button onClick={() => setCreateOpen(true)}>
              <PlusIcon />
              New project
            </Button>
          </EmptyContent>
        </Empty>
      ) : (
        <ResizablePanelGroup
          orientation="horizontal"
          className="min-h-0 flex-1"
        >
          <ResizablePanel
            id="tree"
            panelRef={treePanel}
            defaultSize="22%"
            minSize={200}
            collapsible
            collapsedSize={0}
            onResize={(size) => setTreeCollapsed(size.asPercentage === 0)}
          >
            <div className="flex h-full min-h-0 flex-col bg-sidebar">
              <div className="flex h-10 shrink-0 items-center gap-1 border-b px-3">
                <span className="truncate text-xs font-medium text-muted-foreground">
                  /{project.root_path ?? ""}
                </span>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="ml-auto"
                  title="Rescan for changes"
                  disabled={busy || project.root_path == null}
                  onClick={() =>
                    api
                      .scan(project.id)
                      .then(() => api.project(project.id))
                      .then(setProject)
                  }
                >
                  <RefreshCwIcon />
                </Button>
              </div>
              <ScrollArea className="min-h-0 flex-1">
                <div className="p-2">
                  {tree === null ? (
                    <div className="flex justify-center p-4">
                      <Spinner />
                    </div>
                  ) : tree.length === 0 ? (
                    <p className="p-2 text-xs text-muted-foreground">
                      {busy
                        ? "Scanning…"
                        : project.root_path == null
                          ? "This project has no directory yet. Add one in Project settings."
                          : "No PDF, Markdown or Word files found in this directory."}
                    </p>
                  ) : (
                    <FileTree
                      key={project.id}
                      nodes={tree}
                      selected={selected?.path ?? null}
                      onSelect={(path) => setSelected({ path })}
                    />
                  )}
                </div>
              </ScrollArea>
            </div>
          </ResizablePanel>
          <ResizableHandle />
          <ResizablePanel id="search" defaultSize="38%" minSize={320}>
            <div className="flex h-full min-h-0 flex-col">
              <div className="flex h-10 shrink-0 items-center gap-2 border-b px-2">
                <Button
                  variant="ghost"
                  size="icon-xs"
                  title={treeCollapsed ? "Show files" : "Hide files"}
                  onClick={toggleTree}
                >
                  {treeCollapsed ? (
                    <PanelLeftOpenIcon />
                  ) : (
                    <PanelLeftCloseIcon />
                  )}
                </Button>
                <span className="truncate text-xs text-muted-foreground">
                  {project.file_count} files
                  {project.description ? ` · ${project.description}` : ""}
                </span>
              </div>
              <div className="min-h-0 flex-1">
                <SearchPanel
                  key={project.id}
                  projectId={project.id}
                  models={models}
                  model={searchModel || FAST_MODE}
                  onModelChange={setSearchModel}
                  onOpenResult={openResult}
                  activePath={selected?.path ?? null}
                />
              </div>
            </div>
          </ResizablePanel>
          {selected && (
            <>
              <ResizableHandle />
              <ResizablePanel id="preview" defaultSize="40%" minSize={320}>
                <FilePreview
                  key={`${project.id}:${selected.path}`}
                  projectId={project.id}
                  path={selected.path}
                  page={selected.page}
                  onClose={() => setSelected(null)}
                />
              </ResizablePanel>
            </>
          )}
        </ResizablePanelGroup>
      )}

      <CreateProjectDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={onCreated}
      />
      {project && (
        <ProjectSettingsDialog
          project={project}
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
          onSaved={(p) => {
            setProject(p)
            loadProjects()
            loadTree()
          }}
          onDeleted={async () => {
            const list = await loadProjects()
            setProject(list[0] ?? null)
          }}
        />
      )}
      <ModelSettingsDialog
        open={modelsOpen}
        onOpenChange={setModelsOpen}
        onChanged={loadModels}
      />
    </div>
  )
}

export default App
