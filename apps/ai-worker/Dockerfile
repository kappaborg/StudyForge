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

# ── runtime ─────────────────────────────────────────────────────────────────
FROM deps AS runtime
WORKDIR /app
COPY apps/ai-worker/src ./src

# Render injects $PORT. Honour it; default to 8001 for local docker run.
ENV PORT=8001 \
    DISABLE_AUDIO=1

EXPOSE 8001

# ``sh -c`` so the $PORT env expands at container start.
CMD ["sh", "-c", "exec uvicorn src.main:app --host 0.0.0.0 --port ${PORT}"]
