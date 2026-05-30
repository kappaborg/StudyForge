# syntax=docker/dockerfile:1.7
#
# Python worker. Tesseract is installed for image OCR; ffmpeg is omitted
# because audio transcription is disabled on the free-tier deploy (set
# DISABLE_AUDIO=1 to short-circuit the audio pipeline before
# faster-whisper would need to load a model).
#
# Build context: REPO ROOT. Dockerfile path: apps/ai-worker/Dockerfile.

FROM python:3.11-slim-bookworm AS base
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      build-essential curl tesseract-ocr libgl1 libglib2.0-0 \
 && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir uv

# ── install dependencies ────────────────────────────────────────────────────
FROM base AS deps
WORKDIR /app
COPY apps/ai-worker/pyproject.toml ./
# faster-whisper is in dependencies but we never import it when
# DISABLE_AUDIO=1, so it costs disk but no RAM. Keeping the dep avoids
# a separate pyproject for prod.
RUN uv pip install --system --no-cache .

# ── pre-download the fastembed model ────────────────────────────────────────
# Render's ``/tmp`` is wiped between container restarts and on cold start
# from scratch — so the worker would otherwise need to download the
# embedding ONNX (~133 MB) on its first request, which takes long enough
# to time out Render's gateway. Baking the model into the image makes
# embeddings work on the very first request after a wake-up.
#
# Default model is overridden via ``FASTEMBED_MODEL`` env if set.
FROM deps AS modelcache
ENV FASTEMBED_CACHE_PATH=/opt/fastembed_cache \
    FASTEMBED_MODEL=BAAI/bge-small-en-v1.5
RUN python -c "from fastembed import TextEmbedding; TextEmbedding(model_name='${FASTEMBED_MODEL}', cache_dir='${FASTEMBED_CACHE_PATH}')"

# ── runtime ─────────────────────────────────────────────────────────────────
FROM deps AS runtime
WORKDIR /app
COPY apps/ai-worker/src ./src

# Bring the prefetched model + tell fastembed where to find it.
COPY --from=modelcache /opt/fastembed_cache /opt/fastembed_cache
ENV FASTEMBED_CACHE_PATH=/opt/fastembed_cache

# Render injects $PORT. Honour it; default to 8001 for local docker run.
ENV PORT=8001 \
    DISABLE_AUDIO=1

EXPOSE 8001

# ``sh -c`` so the $PORT env expands at container start.
CMD ["sh", "-c", "exec uvicorn src.main:app --host 0.0.0.0 --port ${PORT}"]
