from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    environment: str = Field(default="development")
    log_level: str = Field(default="info")

    database_url: str = Field(default="postgresql://studyforge:studyforge@localhost:5432/studyforge")
    redis_url: str = Field(default="redis://localhost:6379/0")

    # Object storage
    s3_endpoint: str = Field(default="http://localhost:9000")
    s3_region: str = Field(default="us-east-1")
    s3_access_key: str = Field(default="studyforge")
    s3_secret_key: str = Field(default="studyforge-dev-secret")
    s3_bucket: str = Field(default="studyforge-uploads")

    # Vector store
    vector_backend: str = Field(default="chroma")
    chroma_url: str = Field(default="http://localhost:8000")
    pinecone_api_key: str | None = None
    pinecone_index: str | None = None

    # Embedder selection. ``stub`` is the deterministic Phase-1 hash
    # embedder (fast, no model download, semantically useless). ``fastembed``
    # loads BAAI/bge-large-en-v1.5 via ONNX runtime on first use — real
    # semantic search, no torch dependency.
    embedder_backend: str = Field(default="stub")

    # LLM provider keys (free-tier first)
    groq_api_key: str | None = None
    gemini_api_key: str | None = None
    hf_api_key: str | None = None
    openrouter_api_key: str | None = None
    cerebras_api_key: str | None = None
    together_api_key: str | None = None
    fireworks_api_key: str | None = None
    ollama_base_url: str = Field(default="http://localhost:11434")
    openai_api_key: str | None = None
    anthropic_api_key: str | None = None

    sentry_dsn: str | None = None
    otel_exporter_otlp_endpoint: str | None = None


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
