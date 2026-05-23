"""Embedder implementations.

The ``Embedder`` Protocol lives in ``retriever.py``; this module provides
concrete implementations. Two shipped in Phase 1:

  * ``StubEmbedder`` — deterministic, hash-based, no ML. Same query produces
    the same vector across runs, which makes the dense-retrieval tests pass
    against real Postgres without downloading model weights. Phase 1 mid
    swaps this for the real BGE-M3 model.
  * ``BgeM3Embedder`` — wraps ``sentence-transformers`` BAAI/bge-m3, 1024
    dims, normalised. Lazy-imports the model so ``apps/ai-worker`` boots
    without GPU dependencies. Phase 1 mid.

Both produce normalised 1024-dim vectors so cosine similarity reduces to
a dot product on pgvector's HNSW index.
"""

from __future__ import annotations

import hashlib
import logging
import math

EMBEDDING_DIM = 1024

log = logging.getLogger(__name__)


class StubEmbedder:
    """Deterministic embedder used by tests + the dev loop.

    Maps any text to a stable, unit-norm vector by hashing the input and
    expanding the hash into ``EMBEDDING_DIM`` floats. Same input always
    produces the same vector, so semantic / exact / dense caches all behave
    identically to a real embedder for test purposes.
    """

    dim = EMBEDDING_DIM

    async def embed_query(self, text: str) -> list[float]:
        return _expand_to_unit_vector(text, EMBEDDING_DIM)

    async def embed_passages(self, passages: list[str]) -> list[list[float]]:
        return [_expand_to_unit_vector(p, EMBEDDING_DIM) for p in passages]


def _expand_to_unit_vector(text: str, dim: int) -> list[float]:
    """Hash-expand text into a ``dim``-component unit vector in [-1, 1]^dim."""
    seed = hashlib.sha256(text.encode("utf-8")).digest()
    out: list[float] = []
    counter = 0
    while len(out) < dim:
        block = hashlib.sha256(seed + counter.to_bytes(4, "big")).digest()
        for i in range(0, len(block), 4):
            if len(out) >= dim:
                break
            n = int.from_bytes(block[i : i + 4], "big")
            out.append((n / 0xFFFFFFFF) * 2 - 1)
        counter += 1

    norm = math.sqrt(sum(x * x for x in out))
    if norm == 0.0:
        # Astronomical odds; protect against zero-vector regardless.
        out[0] = 1.0
        norm = 1.0
    return [x / norm for x in out]


# ─────────────────────────────────────────────────────────────────────────────
# BGE-M3 (Phase 1 mid)
# ─────────────────────────────────────────────────────────────────────────────


class BgeM3Embedder:
    """Loads BAAI/bge-m3 lazily on first use. Heavy dependency
    (``sentence-transformers``), so the import is deferred until ``embed_*``
    is called. Phase 1 mid wires this into the worker boot path."""

    dim = EMBEDDING_DIM

    def __init__(self, model_name: str = "BAAI/bge-m3") -> None:
        self._model_name = model_name
        self._model: object | None = None

    def _load(self) -> object:
        if self._model is None:
            try:
                from sentence_transformers import SentenceTransformer
            except ImportError as exc:  # pragma: no cover — surfaces on first use
                raise RuntimeError(
                    "BgeM3Embedder requires `sentence-transformers`. "
                    "Install with: uv pip install sentence-transformers"
                ) from exc
            log.info("loading BGE-M3 (%s) — first call only", self._model_name)
            self._model = SentenceTransformer(self._model_name)
        return self._model

    async def embed_query(self, text: str) -> list[float]:  # pragma: no cover
        model = self._load()
        vec = model.encode(  # type: ignore[attr-defined]
            text, normalize_embeddings=True, convert_to_numpy=True
        )
        return [float(v) for v in vec]

    async def embed_passages(self, passages: list[str]) -> list[list[float]]:  # pragma: no cover
        model = self._load()
        vecs = model.encode(  # type: ignore[attr-defined]
            passages, normalize_embeddings=True, convert_to_numpy=True
        )
        return [[float(v) for v in row] for row in vecs]


# ─────────────────────────────────────────────────────────────────────────────
# FastEmbed (Phase 5)
# ─────────────────────────────────────────────────────────────────────────────


class FastEmbedEmbedder:
    """ONNX-backed bge-large-en-v1.5 via ``fastembed`` — 1024-dim,
    normalised, English-only. Much lighter than ``sentence-transformers``
    (no torch dep, ~250 MB runtime instead of ~2 GB) so the self-host path
    stays tractable.

    The model file is ~1.3 GB and downloads on first use; subsequent runs
    pull it from the local cache. We chose ``bge-large-en-v1.5`` over
    BGE-M3 to match the existing 1024-dim ``vector(1024)`` schema without
    a column-type migration.
    """

    dim = EMBEDDING_DIM

    def __init__(self, model_name: str = "BAAI/bge-large-en-v1.5") -> None:
        self._model_name = model_name
        self._model: object | None = None

    def _load(self) -> object:  # pragma: no cover — heavy I/O
        if self._model is None:
            try:
                from fastembed import TextEmbedding
            except ImportError as exc:
                raise RuntimeError(
                    "FastEmbedEmbedder requires `fastembed`. "
                    "Install with: uv pip install fastembed"
                ) from exc
            log.info(
                "loading fastembed (%s) — model weights pulled on first call",
                self._model_name,
            )
            self._model = TextEmbedding(model_name=self._model_name)
        return self._model

    async def embed_query(self, text: str) -> list[float]:  # pragma: no cover
        model = self._load()
        # fastembed returns a generator over numpy arrays.
        gen = model.query_embed([text])  # type: ignore[attr-defined]
        vec = next(iter(gen))
        return [float(v) for v in vec]

    async def embed_passages(self, passages: list[str]) -> list[list[float]]:  # pragma: no cover
        if not passages:
            return []
        model = self._load()
        gen = model.passage_embed(passages)  # type: ignore[attr-defined]
        return [[float(v) for v in row] for row in gen]
