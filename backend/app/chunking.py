"""Paragraph-aware chunking with a small overlap between chunks."""

from __future__ import annotations

import re
from dataclasses import dataclass

from .extract import Section


@dataclass
class Chunk:
    text: str
    page: int | None


_SENTENCE_END = re.compile(r"(?<=[.!?])\s+")


def _split_long(text: str, size: int) -> list[str]:
    """Split one oversized paragraph on sentence, then word boundaries."""
    pieces: list[str] = []
    current = ""
    for sentence in _SENTENCE_END.split(text):
        while len(sentence) > size:
            cut = sentence.rfind(" ", 0, size)
            cut = cut if cut > size // 2 else size
            pieces.append((current + " " + sentence[:cut]).strip() if current else sentence[:cut])
            current = ""
            sentence = sentence[cut:].strip()
        if len(current) + len(sentence) + 1 > size and current:
            pieces.append(current)
            current = sentence
        else:
            current = f"{current} {sentence}".strip()
    if current:
        pieces.append(current)
    return pieces


def _tail(text: str, overlap: int) -> str:
    if overlap <= 0 or len(text) <= overlap:
        return text if overlap > 0 else ""
    cut = text.find(" ", len(text) - overlap)
    return text[cut + 1:] if cut != -1 else text[-overlap:]


def chunk_sections(sections: list[Section], size: int = 1000, overlap: int = 150) -> list[Chunk]:
    chunks: list[Chunk] = []
    for section in sections:
        paragraphs: list[str] = []
        for para in re.split(r"\n\s*\n", section.text):
            para = para.strip()
            if not para:
                continue
            paragraphs.extend(_split_long(para, size) if len(para) > size else [para])

        current = ""
        for para in paragraphs:
            if current and len(current) + len(para) + 2 > size:
                chunks.append(Chunk(text=current, page=section.page))
                current = f"{_tail(current, overlap)}\n\n{para}".strip()
            else:
                current = f"{current}\n\n{para}".strip()
        if current:
            chunks.append(Chunk(text=current, page=section.page))
    return chunks
