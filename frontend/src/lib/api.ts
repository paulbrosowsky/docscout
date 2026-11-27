export type ScanState =
  "idle" | "scanning" | "indexing" | "summarizing" | "done" | "error"

export interface ScanStatus {
  state: ScanState
  total: number
  indexed: number
  summarized: number
  to_index: number
  to_summarize: number
  current: string | null
  failed: number
  message: string | null
}

export interface Project {
  id: number
  name: string
  description: string
  root_path: string | null
  chunk_size: number
  chunk_overlap: number
  created_at: string
  scanned_at: string | null
  file_count: number
  indexed_count?: number
  scan: ScanStatus
}

export type FileStatus = "pending" | "indexed" | "empty" | "error"

export type TreeNode =
  | {
      type: "file"
      name: string
      path: string
      title: string | null
      status: FileStatus
    }
  | { type: "folder"; name: string; path: string; children: TreeNode[] }

export interface FileInfo {
  path: string
  title: string | null
  ext: string
  size: number
  summary: string | null
  summary_source: "llm" | "extractive" | null
  status: FileStatus
  error: string | null
}

export type Preview =
  | { kind: "pdf"; path: string }
  | { kind: "markdown"; path: string; content: string }
  | { kind: "html"; path: string; content: string }

export interface SearchResult {
  path: string
  title: string
  summary: string
  snippet: string
  page: number | null
  score: number
  similarity: number
}

export interface LLMSettings {
  model: string
  enabled: boolean
  temperature: number
  top_p: number
  num_ctx: number
  num_predict: number
  max_input_chars: number
  summary_prompt: string
  answer_prompt: string
}

export interface OllamaModel {
  name: string
  size: number | null
  parameter_size: string | null
  quantization: string | null
  family: string | null
}

export interface ModelPull {
  model: string
  state: "pulling" | "done" | "error"
  status: string
  completed: number
  total: number
  error: string | null
}

export interface ModelsInfo {
  ollama_available: boolean
  models: OllamaModel[]
  pulls: ModelPull[]
  embedding_model: string
  embedding_dim: number
  suggested: { name: string; note: string }[]
}

export const CHUNK_DEFAULTS = { chunk_size: 1000, chunk_overlap: 150 }

export interface FolderStatus {
  /** The project whose folder is this one or one of its parents. */
  taken_by: { id: number; name: string } | null
  /** False when choosing it would overlap another project's folder. */
  available: boolean
  /** Projects inside subfolders of this folder. */
  contains: string[]
}

export interface DirListing extends FolderStatus {
  path: string
  parent: string | null
  dirs: ({ name: string; path: string } & FolderStatus)[]
}

export interface Health {
  ok: boolean
  docs_root: string
  embedding_model: string
  summary_model: string
  llm_available: boolean
  chunk_defaults: { chunk_size: number; chunk_overlap: number }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  })
  if (!res.ok) {
    let detail = res.statusText
    try {
      const body = await res.json()
      detail =
        typeof body.detail === "string" ? body.detail : JSON.stringify(body)
    } catch {
      /* not JSON */
    }
    throw new Error(detail)
  }
  return res.status === 204 ? (undefined as T) : res.json()
}

const q = (params: Record<string, string>) => new URLSearchParams(params)

export const api = {
  health: () => request<Health>("/api/health"),
  dirs: (path = "", projectId?: number) =>
    request<DirListing>(
      `/api/fs/dirs?${q({ path, ...(projectId ? { project_id: String(projectId) } : {}) })}`
    ),
  projects: () => request<Project[]>("/api/projects"),
  project: (id: number) => request<Project>(`/api/projects/${id}`),
  createProject: (body: {
    name: string
    description: string
    root_path?: string | null
    chunk_size?: number
    chunk_overlap?: number
  }) =>
    request<Project>("/api/projects", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateProject: (
    id: number,
    body: Partial<
      Pick<
        Project,
        "name" | "description" | "root_path" | "chunk_size" | "chunk_overlap"
      >
    >
  ) =>
    request<Project>(`/api/projects/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteProject: (id: number) =>
    request<void>(`/api/projects/${id}`, { method: "DELETE" }),
  scan: (id: number, full = false) =>
    request<ScanStatus>(`/api/projects/${id}/scan?full=${full}`, {
      method: "POST",
    }),
  cancelScan: (id: number) =>
    request<ScanStatus>(`/api/projects/${id}/scan/cancel`, { method: "POST" }),
  status: (id: number) => request<ScanStatus>(`/api/projects/${id}/status`),
  tree: (id: number) => request<TreeNode[]>(`/api/projects/${id}/tree`),
  file: (id: number, path: string) =>
    request<FileInfo>(`/api/projects/${id}/file?${q({ path })}`),
  preview: (id: number, path: string) =>
    request<Preview>(`/api/projects/${id}/preview?${q({ path })}`),
  rawUrl: (id: number, path: string) =>
    `/api/projects/${id}/raw?${q({ path })}`,
  search: (id: number, query: string, limit = 10) =>
    request<{ query: string; results: SearchResult[] }>(
      `/api/projects/${id}/search`,
      { method: "POST", body: JSON.stringify({ query, limit }) }
    ),
  summarize: (id: number, path: string, query: string, model: string) =>
    request<{ path: string; model: string; summary: string }>(
      `/api/projects/${id}/summarize`,
      { method: "POST", body: JSON.stringify({ path, query, model }) }
    ),
  llmSettings: () => request<LLMSettings>("/api/settings/llm"),
  saveLlmSettings: (body: LLMSettings) =>
    request<LLMSettings>("/api/settings/llm", {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  models: () => request<ModelsInfo>("/api/models"),
  pullModel: (model: string) =>
    request<ModelPull>("/api/models/pull", {
      method: "POST",
      body: JSON.stringify({ model }),
    }),
  deleteModel: (model: string) =>
    request<void>(`/api/models/${encodeURIComponent(model)}`, {
      method: "DELETE",
    }),
}

export function isBusy(state: ScanState) {
  return state === "scanning" || state === "indexing" || state === "summarizing"
}
