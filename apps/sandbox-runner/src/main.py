"""FastAPI front for the sandbox executor.

Exposes one POST endpoint (``/v1/execute``) plus the canonical
``/health`` so a process supervisor (Render, Docker, k8s, the
ai-worker calling out via httpx) can probe liveness. Authentication
is intentionally absent at this layer: the service is meant to sit
*behind* the api / ai-worker on an internal network. Public exposure
is a deployment decision the operator owns.

The execution itself is delegated to ``executor.execute`` — this module
only translates HTTP shapes.
"""

from __future__ import annotations

import asyncio
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from .executor import (
    MAX_MEMORY_MB,
    MAX_TIMEOUT_SEC,
    ExecutionRequest,
    ExecutionResult,
    SandboxError,
    execute,
    supported_languages,
)

app = FastAPI(
    title="StudyForge Sandbox Runner",
    version="0.1.0",
    description=(
        "In-process resource-capped executor. The escape-resistant runtime "
        "(gVisor / Firecracker) wraps this service externally."
    ),
)

# Bound the in-process concurrency so a burst of requests can't fork
# more children than the host can hold. Six concurrent executions is a
# reasonable default for a 4-vCPU container; tunable via env later.
_EXECUTOR_POOL = ThreadPoolExecutor(max_workers=6, thread_name_prefix="sandbox")


class ExecuteRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    language: str
    source: str = Field(min_length=1, max_length=200_000)
    stdin: str | None = Field(default=None, max_length=200_000)
    timeout_sec: float = Field(default=float(MAX_TIMEOUT_SEC), gt=0, le=float(MAX_TIMEOUT_SEC))
    memory_mb: int = Field(default=MAX_MEMORY_MB, gt=0, le=MAX_MEMORY_MB)


class ExecuteResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    exit_code: int
    stdout: str
    stderr: str
    duration_ms: int
    timed_out: bool
    memory_capped: bool
    truncated_stdout: bool
    truncated_stderr: bool

    @classmethod
    def from_result(cls, result: ExecutionResult) -> ExecuteResponse:
        return cls(
            exit_code=result.exit_code,
            stdout=result.stdout,
            stderr=result.stderr,
            duration_ms=result.duration_ms,
            timed_out=result.timed_out,
            memory_capped=result.memory_capped,
            truncated_stdout=result.truncated_stdout,
            truncated_stderr=result.truncated_stderr,
        )


@app.get("/health")
def health() -> dict[str, object]:
    return {
        "status": "ok",
        "service": "sandbox-runner",
        "ts": datetime.now(UTC).isoformat(),
        "supported_languages": supported_languages(),
    }


@app.post("/v1/execute", response_model=ExecuteResponse)
async def run(req: ExecuteRequest) -> ExecuteResponse:
    inner = ExecutionRequest(
        language=req.language,
        source=req.source,
        stdin=req.stdin,
        timeout_sec=req.timeout_sec,
        memory_mb=req.memory_mb,
    )
    loop = asyncio.get_running_loop()
    try:
        # Offload to the bounded pool so the event loop never stalls
        # on a 30s child. ``run_in_executor`` returns whatever the
        # callable returns; SandboxError propagates back into the
        # ``except`` below.
        result = await loop.run_in_executor(_EXECUTOR_POOL, execute, inner)
    except SandboxError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return ExecuteResponse.from_result(result)
