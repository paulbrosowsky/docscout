"""Hybrid search: pgvector similarity fused with Postgres full-text rank."""

from __future__ import annotations

import re
from dataclasses import dataclass

from .db import connection
from .embeddings import get_embedder

CANDIDATES = 80
RRF_K = 60


@dataclass
class Hit:
    path: str
    title: str
    summary: str
    snippet: str
    page: int | None
    score: float
    similarity: float


def _tsquery(query: str) -> str | None:
    words = re.findall(r"[\w-]{2,}", query.lower())
    words = [w.strip("-") for w in words if w.strip("-")]
    if not words:
        return None
    # OR the words: natural-language queries rarely contain every term.
    return " | ".join(f"'{w}'" for w in dict.fromkeys(words))


def _snippet(text: str, query: str, size: int = 280) -> str:
    # Drop Markdown block markers (headings, bullets, quotes) before flattening.
    text = re.sub(r"(?m)^\s{0,3}(#{1,6}|[-*+>]|\d+\.)\s+", "", text)
    text = re.sub(r"\s+", " ", text).strip()
    if len(text) <= size:
        return text
    words = [w for w in re.findall(r"\w{3,}", query.lower())]
    lower = text.lower()
    positions = [lower.find(w) for w in words if lower.find(w) >= 0]
    start = max(0, min(positions) - size // 3) if positions else 0
    if start:
        space = text.find(" ", start)
        start = space + 1 if 0 <= space < start + 20 else start
    end = min(len(text), start + size)
    out = text[start:end].strip()
    return ("… " if start else "") + out + (" …" if end < len(text) else "")


def search(project_id: int, query: str, limit: int = 10) -> list[Hit]:
    query = query.strip()
    if not query:
        return []
    vector = get_embedder().embed_query(query)
    tsq = _tsquery(query)

    with connection() as conn:
        conn.execute("SET LOCAL hnsw.ef_search = 200")
        # pgvector >= 0.8: keep scanning the HNSW graph until enough rows pass the project filter.
        try:
            conn.execute("SET LOCAL hnsw.iterative_scan = relaxed_order")
        except Exception:
            conn.rollback()
            conn.execute("SET LOCAL hnsw.ef_search = 200")

        vec_rows = conn.execute(
            """
            SELECT c.id, c.file_id, c.content, c.page, 1 - (c.embedding <=> %(v)s) AS sim
            FROM chunks c
            WHERE c.project_id = %(p)s
            ORDER BY c.embedding <=> %(v)s
            LIMIT %(n)s
            """,
            {"v": vector, "p": project_id, "n": CANDIDATES},
        ).fetchall()

        kw_rows = []
        if tsq:
            kw_rows = conn.execute(
                """
                SELECT c.id, c.file_id, c.content, c.page,
                       ts_rank_cd(c.tsv, to_tsquery('simple', %(q)s)) AS rank
                FROM chunks c
                WHERE c.project_id = %(p)s AND c.tsv @@ to_tsquery('simple', %(q)s)
                ORDER BY rank DESC
                LIMIT %(n)s
                """,
                {"q": tsq, "p": project_id, "n": CANDIDATES},
            ).fetchall()

        chunks: dict[int, dict] = {}
        for rank, row in enumerate(vec_rows):
            entry = chunks.setdefault(row["id"], {**row, "score": 0.0, "sim": row["sim"]})
            entry["score"] += 1.0 / (RRF_K + rank + 1)
        for rank, row in enumerate(kw_rows):
            entry = chunks.setdefault(row["id"], {**row, "score": 0.0, "sim": None})
            entry["score"] += 1.0 / (RRF_K + rank + 1)

        # Group chunks by file: best chunk decides, extra matching chunks add a little.
        files: dict[int, dict] = {}
        for entry in sorted(chunks.values(), key=lambda e: e["score"], reverse=True):
            f = files.get(entry["file_id"])
            if f is None:
                files[entry["file_id"]] = {
                    "best": entry,
                    "score": entry["score"],
                    "sim": entry["sim"],
                }
            else:
                f["score"] += entry["score"] * 0.15
                if entry["sim"] is not None and (f["sim"] is None or entry["sim"] > f["sim"]):
                    f["sim"] = entry["sim"]

        ranked = sorted(files.items(), key=lambda kv: kv[1]["score"], reverse=True)[:limit]
        if not ranked:
            return []
        meta = {
            r["id"]: r
            for r in conn.execute(
                "SELECT id, path, title, summary FROM files WHERE id = ANY(%s)",
                ([fid for fid, _ in ranked],),
            ).fetchall()
        }

    top = ranked[0][1]["score"]
    hits = []
    for fid, f in ranked:
        m = meta.get(fid)
        if not m:
            continue
        hits.append(
            Hit(
                path=m["path"],
                title=m["title"] or m["path"].rsplit("/", 1)[-1],
                summary=m["summary"] or "",
                snippet=_snippet(f["best"]["content"], query),
                page=f["best"]["page"],
                score=round(f["score"] / top, 4),
                similarity=round(float(f["sim"]), 4) if f["sim"] is not None else 0.0,
            )
        )
    return hits
