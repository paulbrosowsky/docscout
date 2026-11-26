"""Text extraction for PDF, Markdown and DOCX files."""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path


@dataclass
class Section:
    text: str
    page: int | None = None


@dataclass
class Extracted:
    title: str
    sections: list[Section]

    @property
    def full_text(self) -> str:
        return "\n\n".join(s.text for s in self.sections if s.text.strip())


def _clean(text: str) -> str:
    text = text.replace("\x00", "")
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def _first_line_title(text: str) -> str | None:
    for line in text.splitlines():
        line = line.strip()
        if 3 <= len(line) <= 120:
            return line
        if line:
            return None
    return None


def extract_pdf(path: Path) -> Extracted:
    from pypdf import PdfReader

    reader = PdfReader(str(path))
    sections = []
    for i, page in enumerate(reader.pages, start=1):
        try:
            text = page.extract_text() or ""
        except Exception:  # damaged page: skip it, keep the rest
            text = ""
        text = _clean(text)
        if text:
            sections.append(Section(text=text, page=i))

    title = None
    try:
        meta_title = (reader.metadata or {}).get("/Title")
        if meta_title and str(meta_title).strip().lower() not in {"", "untitled"}:
            title = str(meta_title).strip()
    except Exception:
        pass
    if not title and sections:
        title = _first_line_title(sections[0].text)
    return Extracted(title=title or path.stem, sections=sections)


_FRONT_MATTER = re.compile(r"\A---\s*\n(.*?)\n---\s*\n", re.DOTALL)


def extract_markdown(path: Path) -> Extracted:
    raw = path.read_text(encoding="utf-8", errors="replace")
    title = None
    m = _FRONT_MATTER.match(raw)
    if m:
        tm = re.search(r"^title:\s*[\"']?(.+?)[\"']?\s*$", m.group(1), re.MULTILINE)
        if tm:
            title = tm.group(1).strip()
        raw = raw[m.end():]
    if not title:
        hm = re.search(r"^#{1,2}\s+(.+?)\s*#*\s*$", raw, re.MULTILINE)
        if hm:
            title = hm.group(1).strip()
    return Extracted(title=title or path.stem, sections=[Section(text=_clean(raw))])


def extract_docx(path: Path) -> Extracted:
    import docx

    document = docx.Document(str(path))
    title = (document.core_properties.title or "").strip() or None
    parts: list[str] = []
    for para in document.paragraphs:
        text = para.text.strip()
        if not text:
            continue
        style = (para.style.name if para.style is not None else "") or ""
        if not title and (style == "Title" or style.startswith("Heading")):
            title = text
        if style.startswith("Heading") or style == "Title":
            parts.append(f"\n{text}\n")
        else:
            parts.append(text)
    for table in document.tables:
        for row in table.rows:
            cells = [c.text.strip() for c in row.cells if c.text.strip()]
            if cells:
                parts.append(" | ".join(cells))
    text = _clean("\n\n".join(parts))
    if not title:
        title = _first_line_title(text)
    return Extracted(title=title or path.stem, sections=[Section(text=text)])


def extract(path: Path) -> Extracted:
    ext = path.suffix.lower()
    if ext == ".pdf":
        return extract_pdf(path)
    if ext in (".md", ".markdown"):
        return extract_markdown(path)
    if ext == ".docx":
        return extract_docx(path)
    raise ValueError(f"Unsupported file type: {ext}")
