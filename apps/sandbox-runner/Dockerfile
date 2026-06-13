# syntax=docker/dockerfile:1.7
#
# Sandbox runner image. The Python service inside owns the in-process
# resource caps (timeout, RLIMIT_AS, output truncation). The
# runtime-level controls (syscall allowlist, network namespace
# isolation, read-only FS) come from the *container runtime* that hosts
# this image — pick ``runsc`` (gVisor) per ADR-0003 by passing
# ``--runtime=runsc`` to ``docker run`` or setting ``runtimeClassName:
# runsc`` on the k8s pod spec. Without that wrap the executor still
# runs (it just falls back to the host kernel for network + syscalls).
#
# Build context: REPO ROOT.
# Dockerfile path: apps/sandbox-runner/Dockerfile.

FROM python:3.11-slim-bookworm AS base

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    # uv installs into the project ``.venv`` by default; pin to the
    # well-known path so the runtime CMD doesn't have to discover it.
    UV_PROJECT_ENVIRONMENT=/opt/venv

# uv is fast + cache-aware; we use it for both dependency resolution
# and the ``uv run uvicorn ...`` entrypoint so the local + container
# pipelines stay identical.
RUN pip install --no-cache-dir uv==0.4.18

WORKDIR /app

# Pull dependency manifests first so a source-only change doesn't
# invalidate the dependency layer. ``uv.lock`` is committed, so
# resolution is deterministic and fast.
COPY apps/sandbox-runner/pyproject.toml apps/sandbox-runner/uv.lock /app/
RUN uv sync --frozen --no-dev

COPY apps/sandbox-runner/src /app/src

# Defense-in-depth: drop to a non-root user even before the runtime
# wrapper does. ``runsc`` already enforces user namespace mapping, but
# a misconfiguration that strips the wrapper shouldn't leave us
# running as root. UID 10001 is outside the typical host-user range.
RUN groupadd --system --gid 10001 sandbox \
 && useradd --system --uid 10001 --gid sandbox --no-create-home --shell /usr/sbin/nologin sandbox \
 && chown -R sandbox:sandbox /app

USER sandbox

# Sandbox-runner listens on 8003 to avoid colliding with the
# ai-worker's 8001 in local docker-compose runs.
EXPOSE 8003

# Plain healthcheck — the Python ``http.client`` import is in the
# stdlib so no extra runtime dependency.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD python -c "import http.client, sys; c = http.client.HTTPConnection('localhost', 8003, timeout=2); c.request('GET', '/health'); r = c.getresponse(); sys.exit(0 if r.status == 200 else 1)" \
  || exit 1

CMD ["uv", "run", "uvicorn", "src.main:app", "--host", "0.0.0.0", "--port", "8003"]
