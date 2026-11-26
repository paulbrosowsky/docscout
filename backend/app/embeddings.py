"""Local CPU embeddings via fastembed (ONNX Runtime, no PyTorch)."""

from __future__ import annotations

import threading
from typing import Protocol, Sequence

import numpy as np

from .config import settings


class Embedder(Protocol):
    dim: int

    def embed_passages(self, texts: Sequence[str]) -> list[np.ndarray]: ...

    def embed_query(self, text: str) -> np.ndarray: ...


# Models fastembed does not ship in its own catalogue but that work with it.
_CUSTOM_MODELS = {
    "intfloat/multilingual-e5-small": dict(dim=384, model_file="onnx/model.onnx"),
    "intfloat/multilingual-e5-base": dict(dim=768, model_file="onnx/model.onnx"),
}


class FastEmbedder:
    def __init__(self, model_name: str, cache_dir: str | None = None):
        from fastembed import TextEmbedding

        supported = {m["model"] for m in TextEmbedding.list_supported_models()}
        if model_name not in supported and model_name in _CUSTOM_MODELS:
            from fastembed.common.model_description import ModelSource, PoolingType

            spec = _CUSTOM_MODELS[model_name]
            TextEmbedding.add_custom_model(
                model=model_name,
                pooling=PoolingType.MEAN,
                normalization=True,
                sources=ModelSource(hf=model_name),
                dim=spec["dim"],
                model_file=spec["model_file"],
            )
        self.model_name = model_name
        self._model = TextEmbedding(model_name, cache_dir=cache_dir)
        self.dim = len(next(iter(self._model.embed(["dim probe"]))))
        # E5 models were trained with these prefixes; others ignore them.
        self._e5 = "e5" in model_name.lower()
        self._lock = threading.Lock()

    def embed_passages(self, texts: Sequence[str]) -> list[np.ndarray]:
        if self._e5:
            texts = [f"passage: {t}" for t in texts]
        with self._lock:
            return list(self._model.embed(list(texts), batch_size=16))

    def embed_query(self, text: str) -> np.ndarray:
        if self._e5:
            text = f"query: {text}"
        with self._lock:
            return next(iter(self._model.embed([text])))


_embedder: Embedder | None = None
_embedder_lock = threading.Lock()


def get_embedder() -> Embedder:
    global _embedder
    with _embedder_lock:
        if _embedder is None:
            _embedder = FastEmbedder(settings.embedding_model, settings.model_cache_dir)
        return _embedder


def set_embedder(embedder: Embedder) -> None:
    """Swap the embedder (used by tests)."""
    global _embedder
    with _embedder_lock:
        _embedder = embedder
