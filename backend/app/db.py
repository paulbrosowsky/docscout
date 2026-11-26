"""Postgres + pgvector storage."""

from __future__ import annotations

import logging
from contextlib import contextmanager
from typing import Iterator

import psycopg
from pgvector.psycopg import register_vector
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

from .config import settings

log = logging.getLogger(__name__)

_pool: ConnectionPool | None = None


def _configure(conn: psycopg.Connection) -> None:
    register_vector(conn)
    conn.row_factory = dict_row


def init_pool() -> ConnectionPool:
    global _pool
    if _pool is None:
        # Create the extension before the pool registers the vector type.
        with psycopg.connect(settings.database_url, autocommit=True) as conn:
            conn.execute("CREATE EXTENSION IF NOT EXISTS vector")
        _pool = ConnectionPool(
            settings.database_url, min_size=1, max_size=8, configure=_configure, open=True
        )
        migrate()
    return _pool


def close_pool() -> None:
    global _pool
    if _pool is not None:
        _pool.close()
        _pool = None


@contextmanager
def connection() -> Iterator[psycopg.Connection]:
    pool = init_pool()
    with pool.connection() as conn:
        yield conn


SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (
    key text PRIMARY KEY,
    value text NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
    id serial PRIMARY KEY,
    name text NOT NULL,
    description text NOT NULL DEFAULT '',
    root_path text,
    chunk_size int NOT NULL DEFAULT 1000,
    chunk_overlap int NOT NULL DEFAULT 150,
    created_at timestamptz NOT NULL DEFAULT now(),
    scanned_at timestamptz
);

CREATE TABLE IF NOT EXISTS files (
    id serial PRIMARY KEY,
    project_id int NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    path text NOT NULL,
    title text,
    ext text NOT NULL,
    size bigint NOT NULL DEFAULT 0,
    mtime double precision NOT NULL DEFAULT 0,
    summary text,
    summary_source text,
    status text NOT NULL DEFAULT 'pending',
    error text,
    indexed_at timestamptz,
    UNIQUE (project_id, path)
);
"""

CHUNKS = """
CREATE TABLE IF NOT EXISTS chunks (
    id bigserial PRIMARY KEY,
    file_id int NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    project_id int NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    idx int NOT NULL,
    page int,
    content text NOT NULL,
    embedding vector({dim}) NOT NULL,
    tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED
);
CREATE INDEX IF NOT EXISTS chunks_embedding_idx ON chunks USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS chunks_tsv_idx ON chunks USING gin (tsv);
CREATE INDEX IF NOT EXISTS chunks_project_idx ON chunks (project_id);
CREATE INDEX IF NOT EXISTS chunks_file_idx ON chunks (file_id);
"""


def migrate() -> None:
    assert _pool is not None
    signature = f"{settings.embedding_model}:{settings.embedding_dim}"
    with _pool.connection() as conn:
        conn.execute(SCHEMA)
        conn.execute("ALTER TABLE projects ADD COLUMN IF NOT EXISTS chunk_size int NOT NULL DEFAULT 1000")
        conn.execute("ALTER TABLE projects ADD COLUMN IF NOT EXISTS chunk_overlap int NOT NULL DEFAULT 150")
        row = conn.execute("SELECT value FROM meta WHERE key = 'embedding'").fetchone()
        if row and row["value"] != signature:
            # A different embedding model makes old vectors meaningless: re-index.
            log.warning("Embedding model changed (%s -> %s); clearing the index", row["value"], signature)
            conn.execute("DROP TABLE IF EXISTS chunks")
            conn.execute("UPDATE files SET status = 'pending', mtime = 0")
        conn.execute(CHUNKS.format(dim=settings.embedding_dim))
        conn.execute(
            "INSERT INTO meta (key, value) VALUES ('embedding', %s) "
            "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
            (signature,),
        )
