"""Background scanning and indexing of a project's directory.

Phase 1 extracts text and stores embeddings for every new or changed file, so
the project becomes searchable as fast as possible. Phase 2 writes the
per-file summaries, which is the slow part on a CPU.
"""

from __future__ import annotations

import logging
import os
import threading
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path

from .chunking import chunk_sections
from .config import SUPPORTED_EXTENSIONS, settings
from .db import connection
from .embeddings import get_embedder
from .extract import extract
from .paths import resolve_dir
from .summarizer import extractive_summary, get_summarizer

log = logging.getLogger(__name__)


@dataclass
class ScanStatus:
    state: str = "idle"  # idle | scanning | indexing | summarizing | done | error
    total: int = 0
    indexed: int = 0
    summarized: int = 0
    to_index: int = 0
    to_summarize: int = 0
    current: str | None = None
    failed: int = 0
    message: str | None = None
    started_at: float | None = None
    finished_at: float | None = None

    def as_dict(self) -> dict:
        return asdict(self)


@dataclass
class _Job:
    status: ScanStatus = field(default_factory=ScanStatus)
    thread: threading.Thread | None = None
    cancel: threading.Event = field(default_factory=threading.Event)


_jobs: dict[int, _Job] = {}
_jobs_lock = threading.Lock()
# One indexing job at a time: the CPU is the bottleneck anyway.
_work_lock = threading.Lock()


def get_status(project_id: int) -> ScanStatus:
    job = _jobs.get(project_id)
    return job.status if job else ScanStatus()


def is_running(project_id: int) -> bool:
    job = _jobs.get(project_id)
    return bool(job and job.thread and job.thread.is_alive())


def start_scan(project_id: int, full: bool = False) -> ScanStatus:
    """Scan the project's directory. full=True re-indexes every file."""
    with _jobs_lock:
        job = _jobs.get(project_id)
        if job and job.thread and job.thread.is_alive():
            return job.status
        job = _Job()
        job.status.state = "scanning"
        job.status.started_at = time.time()
        job.thread = threading.Thread(
            target=_run, args=(project_id, full, job), daemon=True, name=f"scan-{project_id}"
        )
        _jobs[project_id] = job
        job.thread.start()
        return job.status


def cancel_scan(project_id: int) -> None:
    job = _jobs.get(project_id)
    if job:
        job.cancel.set()


def walk(root: Path) -> list[tuple[str, int, float]]:
    """Return (relative path, size, mtime) for each supported file below root."""
    found = []
    max_bytes = settings.max_file_mb * 1024 * 1024
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        dirnames[:] = sorted(d for d in dirnames if not d.startswith((".", "~$")))
        for name in sorted(filenames):
            if name.startswith((".", "~$")):
                continue
            if Path(name).suffix.lower() not in SUPPORTED_EXTENSIONS:
                continue
            full = Path(dirpath) / name
            try:
                st = full.stat()
            except OSError:
                continue
            if st.st_size > max_bytes:
                continue
            found.append((full.relative_to(root).as_posix(), st.st_size, st.st_mtime))
    return found


def _run(project_id: int, full: bool, job: _Job) -> None:
    status = job.status
    try:
        with _work_lock:
            _scan(project_id, full, job)
            if job.cancel.is_set():
                status.state, status.message = "idle", "Cancelled"
            else:
                status.state = "done"
    except Exception as exc:
        log.exception("Scan of project %s failed", project_id)
        status.state, status.message = "error", str(exc)
    finally:
        status.current = None
        status.finished_at = time.time()


def _scan(project_id: int, full: bool, job: _Job) -> None:
    status = job.status
    with connection() as conn:
        project = conn.execute(
            "SELECT root_path, chunk_size, chunk_overlap FROM projects WHERE id = %s",
            (project_id,),
        ).fetchone()
    if project is None or project["root_path"] is None:
        raise ValueError("Project has no directory")
    root = resolve_dir(project["root_path"])
    found = walk(root)
    status.total = len(found)

    with connection() as conn:
        existing = {
            r["path"]: r
            for r in conn.execute(
                "SELECT id, path, size, mtime, status, summary FROM files WHERE project_id = %s",
                (project_id,),
            ).fetchall()
        }
        if full:
            conn.execute("UPDATE files SET status = 'pending' WHERE project_id = %s", (project_id,))
        seen = set()
        changed: set[str] = set()  # new or modified on disk
        for rel, size, mtime in found:
            seen.add(rel)
            row = existing.get(rel)
            if row is None or row["status"] != "indexed":
                changed.add(rel)
            if row is None:
                conn.execute(
                    "INSERT INTO files (project_id, path, ext, size, mtime, title, status) "
                    "VALUES (%s, %s, %s, %s, %s, %s, 'pending')",
                    (project_id, rel, Path(rel).suffix.lower(), size, 0, Path(rel).stem),
                )
            elif row["size"] != size or abs(row["mtime"] - mtime) > 1e-3:
                changed.add(rel)
                conn.execute(
                    "UPDATE files SET status = 'pending', size = %s WHERE id = %s",
                    (size, row["id"]),
                )
        gone = [r["id"] for p, r in existing.items() if p not in seen]
        if gone:
            conn.execute("DELETE FROM files WHERE id = ANY(%s)", (gone,))
        conn.execute("UPDATE projects SET scanned_at = now() WHERE id = %s", (project_id,))
        conn.commit()

        pending = conn.execute(
            "SELECT id, path FROM files WHERE project_id = %s AND status IN ('pending', 'error') ORDER BY path",
            (project_id,),
        ).fetchall()

    mtimes = {rel: mtime for rel, _, mtime in found}
    status.to_index = len(pending)
    status.indexed = 0
    status.state = "indexing"
    embedder = get_embedder()

    for row in pending:
        if job.cancel.is_set():
            return
        status.current = row["path"]
        try:
            doc = extract(root / row["path"])
            chunks = chunk_sections(doc.sections, project["chunk_size"], project["chunk_overlap"])
            vectors = embedder.embed_passages([c.text for c in chunks]) if chunks else []
            with connection() as conn, conn.transaction():
                conn.execute("DELETE FROM chunks WHERE file_id = %s", (row["id"],))
                with conn.cursor() as cur:
                    cur.executemany(
                        "INSERT INTO chunks (file_id, project_id, idx, page, content, embedding) "
                        "VALUES (%s, %s, %s, %s, %s, %s)",
                        [
                            (row["id"], project_id, i, c.page, c.text, v)
                            for i, (c, v) in enumerate(zip(chunks, vectors))
                        ],
                    )
                text = doc.full_text
                conn.execute(
                    "UPDATE files SET title = %s, mtime = %s, status = %s, error = NULL, indexed_at = now() "
                    "WHERE id = %s",
                    (doc.title[:300], mtimes.get(row["path"], 0), "indexed" if chunks else "empty", row["id"]),
                )
                # A re-chunk of an unchanged file keeps its LLM summary.
                if row["path"] in changed:
                    conn.execute(
                        "UPDATE files SET summary = %s, summary_source = 'extractive' WHERE id = %s",
                        (extractive_summary(text) if text else "No text could be extracted.", row["id"]),
                    )
        except Exception as exc:
            log.warning("Failed to index %s: %s", row["path"], exc)
            status.failed += 1
            with connection() as conn:
                conn.execute(
                    "UPDATE files SET status = 'error', error = %s WHERE id = %s",
                    (str(exc)[:500], row["id"]),
                )
        status.indexed += 1

    summarizer = get_summarizer()
    if not summarizer.llm_available(refresh=True):
        return

    # Every indexed file that still has only an extractive summary, including
    # files from earlier scans that ran while the LLM was unavailable.
    with connection() as conn:
        todo = conn.execute(
            "SELECT id, path, title FROM files WHERE project_id = %s AND status = 'indexed' "
            "AND summary_source = 'extractive' ORDER BY path",
            (project_id,),
        ).fetchall()
    if not todo:
        return

    status.state = "summarizing"
    status.to_summarize = len(todo)
    status.summarized = 0
    for row in todo:
        if job.cancel.is_set():
            return
        status.current = row["path"]
        with connection() as conn:
            parts = conn.execute(
                "SELECT content FROM chunks WHERE file_id = %s ORDER BY idx LIMIT 12",
                (row["id"],),
            ).fetchall()
        text = "\n\n".join(p["content"] for p in parts)
        summary, source = summarizer.summarize(row["title"] or row["path"], text)
        if source == "llm":
            with connection() as conn:
                conn.execute(
                    "UPDATE files SET summary = %s, summary_source = 'llm' WHERE id = %s",
                    (summary, row["id"]),
                )
        status.summarized += 1
