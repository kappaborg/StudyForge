# syntax=docker/dockerfile:1.7

FROM python:3.11-slim-bookworm AS base
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential curl tesseract-ocr libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir uv

FROM base AS deps
WORKDIR /app
COPY apps/ai-worker/pyproject.toml ./
RUN uv pip install --system --no-cache .

FROM deps AS runtime
WORKDIR /app
COPY apps/ai-worker/src ./src
EXPOSE 8001
CMD ["uvicorn", "src.main:app", "--host", "0.0.0.0", "--port", "8001"]
