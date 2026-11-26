"""Summaries from a small local LLM served by Ollama.

Falls back to an extractive summary (the opening sentences) when Ollama is
not reachable, so search keeps working without the LLM.
"""

from __future__ import annotations

import logging
import re
import threading
import time

import httpx

from .config import settings
from .model_settings import LLMSettings, get_llm_settings

log = logging.getLogger(__name__)


_BLOCK_START = re.compile(r"^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+")


def _strip_markup(text: str) -> str:
    """Drop Markdown markers and end each block with a full stop, so summaries read as prose."""
    blocks: list[list[str]] = []
    new_block = True
    for line in text.splitlines():
        if not line.strip():
            new_block = True
            continue
        is_marker = bool(_BLOCK_START.match(line))
        line = _BLOCK_START.sub("", line).strip()
        if new_block or is_marker:
            blocks.append([line])
        else:
            blocks[-1].append(line)
        new_block = False
    out = []
    for block in blocks:
        b = " ".join(block)
        b = re.sub(r"[*_`]{1,3}([^*_`]+)[*_`]{1,3}", r"\1", b)
        b = re.sub(r"!?\[([^\]]*)\]\([^)]*\)", r"\1", b)
        out.append(b if re.search(r"[.!?:;]$", b) else f"{b}.")
    return " ".join(out)


def extractive_summary(text: str, max_chars: int = 320) -> str:
    text = re.sub(r"\s+", " ", _strip_markup(text)).strip()
    if len(text) <= max_chars:
        return text
    sentences = re.split(r"(?<=[.!?])\s+", text)
    out = ""
    for s in sentences:
        if len(out) + len(s) + 1 > max_chars:
            break
        out = f"{out} {s}".strip()
    if not out:
        cut = text.rfind(" ", 0, max_chars)
        out = text[: cut if cut > 0 else max_chars]
        return out + " …"
    return out


def _sample(text: str, limit: int) -> str:
    """Head plus a bit of the middle, so long documents are not judged by page one only."""
    if len(text) <= limit:
        return text
    head = text[: int(limit * 0.7)]
    mid_start = len(text) // 2
    mid = text[mid_start : mid_start + int(limit * 0.3)]
    return f"{head}\n[…]\n{mid}"


def _clean_llm_output(text: str) -> str:
    text = re.sub(r"<think>.*?</think>", "", text, flags=re.DOTALL)
    text = re.sub(r"^\s*(summary|zusammenfassung)\s*:\s*", "", text.strip(), flags=re.I)
    return text.strip().strip('"').strip()


class Summarizer:
    def __init__(self) -> None:
        self._client = httpx.Client(base_url=settings.ollama_url, timeout=300)
        self._models: set[str] | None = None
        self._models_at = 0.0
        self._pulls: dict[str, dict] = {}

    # ----- model management -----

    def list_models(self, refresh: bool = False) -> list[dict] | None:
        """Installed Ollama models, or None when Ollama is unreachable."""
        try:
            r = self._client.get("/api/tags", timeout=3)
            r.raise_for_status()
            models = r.json().get("models", [])
        except Exception:
            self._models = None
            return None
        self._models = {m.get("name") for m in models}
        self._models_at = time.time()
        return [
            {
                "name": m.get("name"),
                "size": m.get("size"),
                "parameter_size": (m.get("details") or {}).get("parameter_size"),
                "quantization": (m.get("details") or {}).get("quantization_level"),
                "family": (m.get("details") or {}).get("family"),
            }
            for m in models
        ]

    def has_model(self, model: str) -> bool:
        if self._models is None or time.time() - self._models_at > 30:
            self.list_models()
        if not self._models:
            return False
        return model in self._models or f"{model}:latest" in self._models

    def llm_available(self, refresh: bool = False, model: str | None = None) -> bool:
        cfg = get_llm_settings()
        if not cfg.enabled:
            return False
        if refresh:
            self.list_models()
        return self.has_model(model or cfg.model)

    def pull(self, model: str) -> dict:
        """Download a model in the background; progress via pull_status()."""
        state = self._pulls.get(model)
        if state and state["state"] == "pulling":
            return state
        state = {"model": model, "state": "pulling", "status": "starting", "completed": 0, "total": 0, "error": None}
        self._pulls[model] = state

        def run() -> None:
            try:
                with self._client.stream("POST", "/api/pull", json={"model": model}, timeout=None) as r:
                    r.raise_for_status()
                    import json as _json

                    for line in r.iter_lines():
                        if not line:
                            continue
                        msg = _json.loads(line)
                        if msg.get("error"):
                            raise RuntimeError(msg["error"])
                        state["status"] = msg.get("status", state["status"])
                        if msg.get("total"):
                            state["total"] = msg["total"]
                            state["completed"] = msg.get("completed", 0)
                state["state"] = "done"
                self.list_models()
            except Exception as exc:
                state["state"], state["error"] = "error", str(exc)

        threading.Thread(target=run, daemon=True, name=f"pull-{model}").start()
        return state

    def pull_status(self) -> list[dict]:
        return list(self._pulls.values())

    def delete_model(self, model: str) -> None:
        r = self._client.request("DELETE", "/api/delete", json={"model": model})
        r.raise_for_status()
        self.list_models()

    # ----- generation -----

    def _generate(self, cfg: LLMSettings, model: str, prompt: str) -> str:
        body = {"model": model, "prompt": prompt, "stream": False, "options": cfg.options()}
        if "qwen3" in model:
            body["think"] = False
        r = self._client.post("/api/generate", json=body)
        r.raise_for_status()
        return _clean_llm_output(r.json().get("response", ""))

    def summarize(self, title: str, text: str) -> tuple[str, str]:
        """Return (summary, source) where source is "llm" or "extractive"."""
        if not text.strip():
            return "", "extractive"
        cfg = get_llm_settings()
        if self.llm_available():
            try:
                prompt = (
                    f"{cfg.summary_prompt}\n\nTitle: {title}\n\nDocument:\n"
                    f"{_sample(text, cfg.max_input_chars)}\n"
                )
                summary = self._generate(cfg, cfg.model, prompt)
                if summary:
                    return summary, "llm"
            except Exception as exc:
                log.warning("LLM summary failed, using extractive summary: %s", exc)
                self._models = None
        return extractive_summary(text), "extractive"

    def answer(self, model: str, query: str, title: str, excerpts: list[str]) -> str:
        """A short, query-focused summary of one document."""
        cfg = get_llm_settings()
        context = _sample("\n\n---\n\n".join(excerpts), cfg.max_input_chars)
        prompt = (
            f"{cfg.answer_prompt}\n\nQuery: {query}\n\nDocument title: {title}\n\n"
            f"Relevant excerpts:\n{context}\n"
        )
        return self._generate(cfg, model, prompt)


_summarizer: Summarizer | None = None


def get_summarizer() -> Summarizer:
    global _summarizer
    if _summarizer is None:
        _summarizer = Summarizer()
    return _summarizer
