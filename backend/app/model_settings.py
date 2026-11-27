"""Model settings that can be changed from the UI, stored in Postgres."""

from __future__ import annotations

import json
import threading
from typing import Any

from pydantic import BaseModel, Field

from .config import settings
from .db import connection


class LLMSettings(BaseModel):
    # Model used for file summaries while indexing and as the default in the search box.
    model: str = Field(default_factory=lambda: settings.summary_model)
    enabled: bool = Field(default_factory=lambda: settings.summary_mode == "llm")
    temperature: float = Field(default=0.2, ge=0, le=2)
    top_p: float = Field(default=0.9, gt=0, le=1)
    num_ctx: int = Field(default=4096, ge=512, le=131072)
    num_predict: int = Field(default=160, ge=16, le=4096)
    # Characters of document text the model sees per summary.
    max_input_chars: int = Field(default=6000, ge=500, le=100000)
    summary_prompt: str = Field(
        default=(
            "Summarize the following document in 2 to 3 sentences.\n"
            "Write the summary in the same language as the document.\n"
            'Say what the document is and what it is about. Do not start with "This document".\n'
            "Answer with the summary only."
        ),
        max_length=4000,
    )
    answer_prompt: str = Field(
        default=(
            "A user searched their documents for the query below. In 1 to 2 sentences, "
            "say what this document contains that is relevant to the query. "
            "Use the language of the query. If nothing is relevant, say so briefly. "
            "Answer with the sentences only."
        ),
        max_length=4000,
    )

    def options(self) -> dict[str, Any]:
        return {
            "temperature": self.temperature,
            "top_p": self.top_p,
            "num_ctx": self.num_ctx,
            "num_predict": self.num_predict,
        }


_cache: LLMSettings | None = None
_lock = threading.Lock()


def get_llm_settings() -> LLMSettings:
    global _cache
    with _lock:
        if _cache is None:
            with connection() as conn:
                row = conn.execute("SELECT value FROM meta WHERE key = 'llm_settings'").fetchone()
            data = json.loads(row["value"]) if row else {}
            _cache = LLMSettings(**data)
        return _cache


def save_llm_settings(new: LLMSettings) -> LLMSettings:
    global _cache
    with _lock:
        with connection() as conn:
            conn.execute(
                "INSERT INTO meta (key, value) VALUES ('llm_settings', %s) "
                "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
                (new.model_dump_json(),),
            )
        _cache = new
        return new


def reset_cache() -> None:
    global _cache
    with _lock:
        _cache = None
