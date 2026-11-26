import os
from dataclasses import dataclass, field
from pathlib import Path


def _env(name: str, default: str) -> str:
    value = os.environ.get(name)
    return value if value not in (None, "") else default


@dataclass(frozen=True)
class Settings:
    database_url: str = field(
        default_factory=lambda: _env(
            "DATABASE_URL", "postgresql://docscout:docscout@localhost:5432/docscout"
        )
    )
    # All project directories must live below this root. In Docker it is the
    # read-only mount of the host's document folder.
    docs_root: Path = field(
        default_factory=lambda: Path(_env("DOCS_ROOT", "/data")).resolve()
    )
    embedding_model: str = field(
        default_factory=lambda: _env("EMBEDDING_MODEL", "intfloat/multilingual-e5-small")
    )
    embedding_dim: int = field(
        default_factory=lambda: int(_env("EMBEDDING_DIM", "384"))
    )
    model_cache_dir: str = field(
        default_factory=lambda: _env("MODEL_CACHE_DIR", "/models")
    )
    ollama_url: str = field(
        default_factory=lambda: _env("OLLAMA_URL", "http://localhost:11434")
    )
    summary_model: str = field(
        default_factory=lambda: _env("SUMMARY_MODEL", "qwen2.5:1.5b")
    )
    # "llm" uses Ollama and falls back to "extractive" when it is unreachable.
    summary_mode: str = field(default_factory=lambda: _env("SUMMARY_MODE", "llm"))
    chunk_size: int = field(default_factory=lambda: int(_env("CHUNK_SIZE", "1000")))
    chunk_overlap: int = field(
        default_factory=lambda: int(_env("CHUNK_OVERLAP", "150"))
    )
    max_file_mb: int = field(default_factory=lambda: int(_env("MAX_FILE_MB", "100")))
    warm_up: bool = field(default_factory=lambda: _env("WARM_UP", "1") == "1")
    static_dir: str = field(default_factory=lambda: _env("STATIC_DIR", ""))


settings = Settings()

SUPPORTED_EXTENSIONS = {".pdf", ".md", ".markdown", ".docx"}
