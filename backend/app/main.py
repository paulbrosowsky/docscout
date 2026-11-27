from __future__ import annotations

import logging
import mimetypes
import threading
from contextlib import asynccontextmanager
from dataclasses import asdict
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import indexer
from .config import SUPPORTED_EXTENSIONS, settings
from .db import close_pool, connection, init_pool
from .paths import PathError, resolve_dir, resolve_project_file, to_rel
from .search import search as run_search
from .embeddings import get_embedder
from .model_settings import LLMSettings, get_llm_settings, save_llm_settings
from .summarizer import get_summarizer

# Small instruction models that run well on a CPU, offered in the model picker.
SUGGESTED_MODELS = [
    {"name": "qwen2.5:1.5b", "note": "Default. 1.5B, multilingual, about 1 GB"},
    {"name": "qwen3:1.7b", "note": "1.7B, newer Qwen, about 1.4 GB"},
    {"name": "qwen2.5:0.5b", "note": "Fastest, lower quality, about 400 MB"},
    {"name": "qwen2.5:3b", "note": "Better summaries, slower, about 1.9 GB"},
    {"name": "LiquidAI/lfm2.5-1.2b-instruct", "note": "Liquid LFM2.5 1.2B, fast on CPU"},
    {"name": "gemma3:1b", "note": "Google Gemma 3 1B, about 800 MB"},
]

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")


def _warm_up() -> None:
    """Load (and on first run download) the embedding model in the background."""
    try:
        get_embedder()
        logging.getLogger("docscout").info("Embedding model %s ready", settings.embedding_model)
    except Exception:
        logging.getLogger("docscout").exception("Could not load the embedding model")


@asynccontextmanager
async def lifespan(_: FastAPI):
    init_pool()
    if settings.warm_up:
        threading.Thread(target=_warm_up, daemon=True, name="warm-up").start()
    yield
    close_pool()


app = FastAPI(title="Docscout", lifespan=lifespan)


# ---------- models ----------


class ChunkSettings(BaseModel):
    chunk_size: int = Field(default_factory=lambda: settings.chunk_size, ge=200, le=8000)
    chunk_overlap: int = Field(default_factory=lambda: settings.chunk_overlap, ge=0, le=2000)


class ProjectIn(ChunkSettings):
    name: str = Field(min_length=1, max_length=200)
    description: str = Field(default="", max_length=2000)
    root_path: str | None = None


class ProjectPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=2000)
    root_path: str | None = None
    chunk_size: int | None = Field(default=None, ge=200, le=8000)
    chunk_overlap: int | None = Field(default=None, ge=0, le=2000)


class SummarizeIn(BaseModel):
    path: str
    query: str = Field(min_length=1, max_length=4000)
    model: str | None = None


class PullIn(BaseModel):
    model: str = Field(min_length=1, max_length=200)


class SearchIn(BaseModel):
    query: str = Field(min_length=1, max_length=4000)
    limit: int = Field(default=10, ge=1, le=50)


def _check_chunks(size: int, overlap: int) -> None:
    if overlap >= size // 2:
        raise HTTPException(400, "Chunk overlap must be less than half the chunk size")


# ---------- helpers ----------


def _project(project_id: int) -> dict:
    with connection() as conn:
        row = conn.execute(
            """
            SELECT p.*,
                   (SELECT count(*) FROM files f WHERE f.project_id = p.id) AS file_count,
                   (SELECT count(*) FROM files f WHERE f.project_id = p.id AND f.status = 'indexed') AS indexed_count
            FROM projects p WHERE p.id = %s
            """,
            (project_id,),
        ).fetchone()
    if not row:
        raise HTTPException(404, "Project not found")
    row["scan"] = indexer.get_status(project_id).as_dict()
    return row


def _overlaps(a: str, b: str) -> bool:
    """Two directories (relative to DOCS_ROOT) overlap if one contains the other."""
    if a == "" or b == "":
        return True
    return a == b or a.startswith(b + "/") or b.startswith(a + "/")


def _project_roots(exclude_id: int | None = None) -> list[dict]:
    with connection() as conn:
        return conn.execute(
            "SELECT id, name, root_path FROM projects WHERE root_path IS NOT NULL AND id <> %s",
            (exclude_id or 0,),
        ).fetchall()


def _conflict(root: str, exclude_id: int | None = None) -> dict | None:
    for other in _project_roots(exclude_id):
        if _overlaps(root, other["root_path"]):
            return other
    return None


def _check_root(root_path: str | None, project_id: int | None = None) -> str | None:
    """Validate a project directory: it must exist and not overlap another project's."""
    if root_path is None:
        return None
    try:
        root = to_rel(resolve_dir(root_path))
    except PathError as exc:
        raise HTTPException(400, str(exc))
    other = _conflict(root, project_id)
    if other:
        shown = "/" + other["root_path"]
        if root == other["root_path"]:
            reason = f"is already used by project \"{other['name']}\""
        elif root == "" or other["root_path"].startswith(root + "/"):
            reason = f"contains {shown}, which belongs to project \"{other['name']}\""
        else:
            reason = f"is inside {shown}, which belongs to project \"{other['name']}\""
        raise HTTPException(409, f"This folder {reason}. Project folders must not overlap.")
    return root


def _file_or_404(project: dict, path: str) -> Path:
    if project.get("root_path") is None:
        raise HTTPException(400, "Project has no directory yet")
    try:
        return resolve_project_file(project["root_path"], path)
    except PathError as exc:
        raise HTTPException(404, str(exc))


# ---------- system ----------


@app.get("/api/health")
def health() -> dict:
    with connection() as conn:
        conn.execute("SELECT 1")
    return {
        "ok": True,
        "docs_root": str(settings.docs_root),
        "embedding_model": settings.embedding_model,
        "summary_model": get_llm_settings().model,
        "chunk_defaults": {
            "chunk_size": settings.chunk_size,
            "chunk_overlap": settings.chunk_overlap,
        },
        "llm_available": get_summarizer().llm_available(refresh=True),
    }


@app.get("/api/fs/dirs")
def list_dirs(path: str = "", project_id: int | None = None) -> dict:
    """Browse directories below DOCS_ROOT, for choosing a project directory.

    Each folder says whether another project already covers it (taken_by) and
    whether it can be chosen (available). project_id excludes that project.
    """
    try:
        target = resolve_dir(path)
    except PathError as exc:
        raise HTTPException(400, str(exc))
    roots = _project_roots(project_id)

    def status(rel: str) -> dict:
        taken = next(
            (r for r in roots if rel == r["root_path"] or rel.startswith(r["root_path"] + "/")),
            None,
        )
        inside = [r for r in roots if _overlaps(rel, r["root_path"])]
        return {
            "taken_by": {"id": taken["id"], "name": taken["name"]} if taken else None,
            "available": not inside,
            # Projects in subfolders: you can still open the folder to go deeper.
            "contains": [r["name"] for r in inside if r is not taken],
        }

    dirs = []
    try:
        entries = sorted(target.iterdir(), key=lambda p: p.name.lower())
    except PermissionError:
        entries = []
    for entry in entries:
        if entry.name.startswith(".") or not entry.is_dir():
            continue
        child = entry.relative_to(settings.docs_root).as_posix()
        dirs.append({"name": entry.name, "path": child, **status(child)})
    rel = target.relative_to(settings.docs_root).as_posix()
    rel = "" if rel == "." else rel
    parent = None
    if rel:
        parent = Path(rel).parent.as_posix()
        parent = "" if parent == "." else parent
    return {"path": rel, "parent": parent, "dirs": dirs, **status(rel)}


# ---------- projects ----------


@app.get("/api/projects")
def list_projects() -> list[dict]:
    with connection() as conn:
        rows = conn.execute(
            """
            SELECT p.*, (SELECT count(*) FROM files f WHERE f.project_id = p.id) AS file_count
            FROM projects p ORDER BY p.created_at DESC
            """
        ).fetchall()
    for row in rows:
        row["scan"] = indexer.get_status(row["id"]).as_dict()
    return rows


@app.post("/api/projects", status_code=201)
def create_project(body: ProjectIn) -> dict:
    """Create a project; with a directory, indexing starts right away."""
    root = _check_root(body.root_path)
    _check_chunks(body.chunk_size, body.chunk_overlap)
    with connection() as conn:
        row = conn.execute(
            "INSERT INTO projects (name, description, root_path, chunk_size, chunk_overlap) "
            "VALUES (%s, %s, %s, %s, %s) RETURNING id",
            (body.name.strip(), body.description.strip(), root, body.chunk_size, body.chunk_overlap),
        ).fetchone()
    if root is not None:
        indexer.start_scan(row["id"])
    return _project(row["id"])


@app.get("/api/projects/{project_id}")
def get_project(project_id: int) -> dict:
    return _project(project_id)


@app.patch("/api/projects/{project_id}")
def update_project(project_id: int, body: ProjectPatch) -> dict:
    project = _project(project_id)
    fields = {k: v for k, v in body.model_dump(exclude_unset=True).items()}
    for key in ("name", "chunk_size", "chunk_overlap"):
        if key in fields and fields[key] is None:
            del fields[key]
    if "root_path" in fields:
        fields["root_path"] = _check_root(fields["root_path"], project_id)
    root_changed = "root_path" in fields and fields["root_path"] != project["root_path"]
    chunks_changed = any(
        k in fields and fields[k] != project[k] for k in ("chunk_size", "chunk_overlap")
    )
    _check_chunks(
        fields.get("chunk_size", project["chunk_size"]),
        fields.get("chunk_overlap", project["chunk_overlap"]),
    )
    if (root_changed or chunks_changed) and indexer.is_running(project_id):
        raise HTTPException(409, "Indexing is running; wait for it to finish or cancel it")
    with connection() as conn:
        for key, value in fields.items():
            # Keys come from the pydantic model, never from user input.
            conn.execute(f"UPDATE projects SET {key} = %s WHERE id = %s", (value, project_id))
        if root_changed:
            conn.execute("DELETE FROM files WHERE project_id = %s", (project_id,))
    root = fields.get("root_path", project["root_path"])
    if root is not None and (root_changed or chunks_changed):
        indexer.start_scan(project_id, full=chunks_changed and not root_changed)
    return _project(project_id)


@app.delete("/api/projects/{project_id}", status_code=204)
def delete_project(project_id: int) -> None:
    indexer.cancel_scan(project_id)
    with connection() as conn:
        conn.execute("DELETE FROM projects WHERE id = %s", (project_id,))


@app.post("/api/projects/{project_id}/scan")
def scan_project(project_id: int, full: bool = False) -> dict:
    project = _project(project_id)
    if project["root_path"] is None:
        raise HTTPException(400, "Add a directory to the project first")
    return indexer.start_scan(project_id, full=full).as_dict()


@app.post("/api/projects/{project_id}/scan/cancel")
def cancel_scan(project_id: int) -> dict:
    _project(project_id)
    indexer.cancel_scan(project_id)
    return indexer.get_status(project_id).as_dict()


@app.get("/api/projects/{project_id}/status")
def scan_status(project_id: int) -> dict:
    _project(project_id)
    return indexer.get_status(project_id).as_dict()


@app.get("/api/projects/{project_id}/tree")
def project_tree(project_id: int) -> list[dict]:
    """The project's supported files as a nested folder tree."""
    _project(project_id)
    with connection() as conn:
        rows = conn.execute(
            "SELECT path, title, status FROM files WHERE project_id = %s ORDER BY path",
            (project_id,),
        ).fetchall()

    root: dict = {"children": {}}
    for row in rows:
        parts = row["path"].split("/")
        node = root
        for i, part in enumerate(parts[:-1]):
            node = node["children"].setdefault(
                part,
                {"type": "folder", "name": part, "path": "/".join(parts[: i + 1]), "children": {}},
            )
        node["children"][parts[-1]] = {
            "type": "file",
            "name": parts[-1],
            "path": row["path"],
            "title": row["title"],
            "status": row["status"],
        }

    def finish(children: dict) -> list[dict]:
        out = []
        for child in children.values():
            if child["type"] == "folder":
                out.append({**child, "children": finish(child["children"])})
            else:
                out.append(child)
        # Folders first, then files, both alphabetically, like an explorer.
        return sorted(out, key=lambda c: (c["type"] != "folder", c["name"].lower()))

    return finish(root["children"])


@app.get("/api/projects/{project_id}/file")
def file_info(project_id: int, path: str = Query(...)) -> dict:
    _project(project_id)
    with connection() as conn:
        row = conn.execute(
            "SELECT path, title, ext, size, summary, summary_source, status, error, indexed_at "
            "FROM files WHERE project_id = %s AND path = %s",
            (project_id, path),
        ).fetchone()
    if not row:
        raise HTTPException(404, "File not found")
    return row


@app.get("/api/projects/{project_id}/raw")
def raw_file(project_id: int, path: str = Query(...)) -> FileResponse:
    project = _project(project_id)
    full = _file_or_404(project, path)
    if full.suffix.lower() not in SUPPORTED_EXTENSIONS:
        raise HTTPException(404, "File not found")
    media = mimetypes.guess_type(full.name)[0] or "application/octet-stream"
    if full.suffix.lower() in (".md", ".markdown"):
        media = "text/markdown; charset=utf-8"
    return FileResponse(
        full,
        media_type=media,
        content_disposition_type="inline",
        filename=full.name,
        headers={"X-Content-Type-Options": "nosniff"},
    )


@app.get("/api/projects/{project_id}/preview")
def preview(project_id: int, path: str = Query(...)) -> dict:
    """Preview payload: PDFs are shown by the browser, Markdown and DOCX as content."""
    project = _project(project_id)
    full = _file_or_404(project, path)
    ext = full.suffix.lower()
    if ext == ".pdf":
        return {"kind": "pdf", "path": path}
    if ext in (".md", ".markdown"):
        return {
            "kind": "markdown",
            "path": path,
            "content": full.read_text(encoding="utf-8", errors="replace"),
        }
    if ext == ".docx":
        import mammoth

        with full.open("rb") as fh:
            result = mammoth.convert_to_html(
                fh,
                style_map="p[style-name='Title'] => h1:fresh\np[style-name='Subtitle'] => h2:fresh",
            )
        return {"kind": "html", "path": path, "content": result.value}
    raise HTTPException(415, "Unsupported file type")


@app.post("/api/projects/{project_id}/search")
async def search_project(project_id: int, body: SearchIn) -> dict:
    _project(project_id)
    hits = await run_in_threadpool(run_search, project_id, body.query, body.limit)
    return {"query": body.query, "results": [asdict(h) for h in hits]}


@app.post("/api/projects/{project_id}/summarize")
def summarize_result(project_id: int, body: SummarizeIn) -> dict:
    """A query-focused summary of one search result, written by the chosen model."""
    _project(project_id)
    cfg = get_llm_settings()
    model = body.model or cfg.model
    summarizer = get_summarizer()
    if not summarizer.has_model(model):
        raise HTTPException(409, f"Model {model} is not installed in Ollama")
    with connection() as conn:
        f = conn.execute(
            "SELECT id, title, path FROM files WHERE project_id = %s AND path = %s",
            (project_id, body.path),
        ).fetchone()
        if not f:
            raise HTTPException(404, "File not found")
        vector = get_embedder().embed_query(body.query)
        rows = conn.execute(
            "SELECT content FROM chunks WHERE file_id = %s ORDER BY embedding <=> %s LIMIT 4",
            (f["id"], vector),
        ).fetchall()
    try:
        text = summarizer.answer(model, body.query, f["title"] or f["path"], [r["content"] for r in rows])
    except Exception as exc:
        raise HTTPException(502, f"The model did not answer: {exc}")
    return {"path": body.path, "model": model, "summary": text}


# ---------- model settings ----------


@app.get("/api/settings/llm")
def read_llm_settings() -> LLMSettings:
    return get_llm_settings()


@app.put("/api/settings/llm")
def write_llm_settings(body: LLMSettings) -> LLMSettings:
    return save_llm_settings(body)


@app.get("/api/models")
def list_models() -> dict:
    models = get_summarizer().list_models()
    return {
        "ollama_available": models is not None,
        "models": models or [],
        "pulls": get_summarizer().pull_status(),
        "embedding_model": settings.embedding_model,
        "embedding_dim": settings.embedding_dim,
        "suggested": SUGGESTED_MODELS,
    }


@app.post("/api/models/pull")
def pull_model(body: PullIn) -> dict:
    if get_summarizer().list_models() is None:
        raise HTTPException(503, "Ollama is not reachable")
    return get_summarizer().pull(body.model.strip())


@app.delete("/api/models/{name:path}", status_code=204)
def delete_model(name: str) -> None:
    try:
        get_summarizer().delete_model(name)
    except Exception as exc:
        raise HTTPException(502, str(exc))


# ---------- frontend ----------

if settings.static_dir and Path(settings.static_dir).is_dir():
    from fastapi.responses import HTMLResponse

    static_root = Path(settings.static_dir)
    app.mount("/assets", StaticFiles(directory=static_root / "assets"), name="assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    def spa(full_path: str):
        if full_path.startswith("api/"):
            raise HTTPException(404, "Not found")
        candidate = (static_root / full_path).resolve()
        if full_path and candidate.is_file() and static_root.resolve() in candidate.parents:
            return FileResponse(candidate)
        return HTMLResponse((static_root / "index.html").read_text(encoding="utf-8"))
