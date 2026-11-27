"""Path helpers that keep every file access inside DOCS_ROOT."""

from __future__ import annotations

from pathlib import Path

from .config import settings


class PathError(ValueError):
    pass


def _inside(child: Path, parent: Path) -> bool:
    return child == parent or parent in child.parents


def resolve_dir(rel: str | None) -> Path:
    """Resolve a directory given relative to DOCS_ROOT."""
    root = settings.docs_root
    target = (root / (rel or "").lstrip("/")).resolve()
    if not _inside(target, root):
        raise PathError("Path is outside the documents root")
    if not target.is_dir():
        raise PathError("Directory does not exist")
    return target


def resolve_project_file(project_root: str | None, rel: str) -> Path:
    base = resolve_dir(project_root)
    target = (base / rel.lstrip("/")).resolve()
    if not _inside(target, base):
        raise PathError("Path is outside the project directory")
    if not target.is_file():
        raise PathError("File does not exist")
    return target


def to_rel(path: Path) -> str:
    rel = path.resolve().relative_to(settings.docs_root).as_posix()
    return "" if rel == "." else rel
