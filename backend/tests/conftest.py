import hashlib
import os
import re
from pathlib import Path

import numpy as np
import pytest

SAMPLES = Path(__file__).resolve().parents[2] / "sample-docs"

os.environ.setdefault("DOCS_ROOT", str(SAMPLES.parent))
os.environ.setdefault("SUMMARY_MODE", "extractive")
os.environ.setdefault("EMBEDDING_MODEL", "test-hash-embedder")
os.environ.setdefault("EMBEDDING_DIM", "384")


class HashEmbedder:
    """Deterministic bag-of-words embedder, so tests run without downloading a model."""

    dim = 384

    def _vec(self, text: str) -> np.ndarray:
        v = np.zeros(self.dim, dtype=np.float32)
        for word in re.findall(r"\w{3,}", text.lower()):
            h = int(hashlib.md5(word.encode()).hexdigest(), 16)
            v[h % self.dim] += 1.0
        n = np.linalg.norm(v)
        return v / n if n else v + 1e-6

    def embed_passages(self, texts):
        return [self._vec(t) for t in texts]

    def embed_query(self, text):
        return self._vec(text)


@pytest.fixture(scope="session")
def samples() -> Path:
    return SAMPLES


def pytest_configure(config):
    from app.embeddings import set_embedder

    set_embedder(HashEmbedder())
