"""In-process executor for sandboxed code.

This module owns the **process-level** controls:

  * wall-clock timeout enforced via ``subprocess.run(timeout=...)``;
  * peak-memory cap via ``resource.setrlimit(RLIMIT_AS, ...)`` set in the
    child's pre-exec hook;
  * stdout / stderr captured to byte caps so a runaway program can't
    fill the host's disk;
  * exit code + structured ``ExecutionResult`` returned verbatim so the
    caller's audit log carries the same evidence the runner saw.

The **runtime-level** controls — gVisor's syscall allowlist, network
namespace isolation, read-only root FS, drop to a non-root user — are
applied by the container runtime that wraps this process (``runsc`` or
``firecracker`` per ADR-0003). This file makes no assumptions about
what runtime is in play; it works identically inside a normal Docker
container during local tests and inside a hardened runsc instance in
production.

The supported languages are intentionally narrow: Python source via
``python3 -c`` (mirrors the ``.py`` / ``.ipynb`` uploads §8 promises to
execute). Adding JS / Ruby is a matter of registering another entry in
``_LANGUAGE_COMMANDS`` — the rest of the harness is language-agnostic.
"""

from __future__ import annotations

import contextlib
import resource
import shlex
import subprocess
import time
from dataclasses import dataclass

# Hard caps. ``ExecutionRequest`` accepts caller-supplied overrides
# *below* these values; values above are clamped down on entry. Anything
# above these is a host-impact decision and should be raised via env or
# config, not a request field.
MAX_TIMEOUT_SEC = 30
MAX_MEMORY_MB = 256
# 256 KiB ought to be plenty for any program that's actually doing the
# work students upload; runaway prints don't need to fill the wire.
MAX_OUTPUT_BYTES = 256 * 1024


@dataclass(frozen=True)
class ExecutionRequest:
    language: str
    source: str
    stdin: str | None = None
    timeout_sec: float = MAX_TIMEOUT_SEC
    memory_mb: int = MAX_MEMORY_MB


@dataclass(frozen=True)
class ExecutionResult:
    """Verbatim subprocess outcome. Values are passed through to the
    caller (gateway) which surfaces them to the student + writes them
    to the audit log."""

    exit_code: int
    stdout: str
    stderr: str
    duration_ms: int
    timed_out: bool
    memory_capped: bool
    truncated_stdout: bool
    truncated_stderr: bool


class SandboxError(Exception):
    """Raised for *structural* failures (unknown language, request that
    couldn't be launched). A user program that exits non-zero is NOT a
    sandbox error — that's a normal ExecutionResult."""


# Each entry maps to the literal argv we exec. ``{source}`` is the slot
# the source goes into; the runner builds the actual list and never
# passes the source via a shell, so quoting doesn't matter.
_LANGUAGE_COMMANDS: dict[str, list[str]] = {
    "python": ["python3", "-c", "{source}"],
}


def supported_languages() -> list[str]:
    return sorted(_LANGUAGE_COMMANDS.keys())


def execute(req: ExecutionRequest) -> ExecutionResult:
    """Run a single program. Pure synchronous function — callers wrap in
    a thread-pool when they need concurrency. Never raises on a
    user-program failure; only on harness misuse."""
    cmd_template = _LANGUAGE_COMMANDS.get(req.language)
    if cmd_template is None:
        raise SandboxError(
            f"unsupported language {req.language!r}; supported: {supported_languages()}",
        )

    # Clamp caller-supplied limits to host caps. Below-cap values are
    # honored so a "quick syntax check" can run with a 1s budget.
    timeout = min(float(req.timeout_sec), float(MAX_TIMEOUT_SEC))
    if timeout <= 0:
        raise SandboxError("timeout_sec must be > 0")
    memory_mb = min(int(req.memory_mb), MAX_MEMORY_MB)
    if memory_mb <= 0:
        raise SandboxError("memory_mb must be > 0")

    cmd = [
        part.replace("{source}", req.source) if part == "{source}" else part
        for part in cmd_template
    ]

    memory_bytes = memory_mb * 1024 * 1024

    def _preexec() -> None:
        # Address-space cap. RLIMIT_AS counts the virtual size of every
        # mmap the child makes, so it covers heap + code + stack. When
        # the child blows the cap the kernel kills with SIGSEGV and the
        # exit code surfaces accordingly.
        #
        # macOS / BSD kernels enforce RLIMIT_AS very differently than
        # Linux — sometimes refusing the call entirely, sometimes
        # ignoring it. Production runs on Linux so the cap engages
        # there; on developer machines we degrade gracefully so the
        # harness stays cross-platform. The escape-resistant runtime
        # (gVisor / Firecracker) carries the real enforcement in prod.
        with contextlib.suppress(OSError, ValueError):
            resource.setrlimit(resource.RLIMIT_AS, (memory_bytes, memory_bytes))
        with contextlib.suppress(OSError, ValueError):
            resource.setrlimit(
                resource.RLIMIT_CPU, (int(timeout) + 1, int(timeout) + 1)
            )

    timed_out = False
    started = time.perf_counter()
    try:
        completed = subprocess.run(
            cmd,
            input=(req.stdin or "").encode("utf-8"),
            capture_output=True,
            preexec_fn=_preexec,
            timeout=timeout,
            check=False,
        )
        exit_code = completed.returncode
        stdout_bytes = completed.stdout or b""
        stderr_bytes = completed.stderr or b""
    except subprocess.TimeoutExpired as exc:
        timed_out = True
        exit_code = -1  # sentinel — caller distinguishes via ``timed_out``
        stdout_bytes = exc.stdout or b""
        stderr_bytes = exc.stderr or b""
    except FileNotFoundError as exc:
        # The runtime is missing ``python3`` (developer machine without
        # the interpreter). Surface clearly so the harness owner knows
        # it isn't a student-code failure.
        raise SandboxError(f"interpreter not found: {exc}") from exc
    duration_ms = int((time.perf_counter() - started) * 1000)

    truncated_stdout = len(stdout_bytes) > MAX_OUTPUT_BYTES
    truncated_stderr = len(stderr_bytes) > MAX_OUTPUT_BYTES
    stdout = stdout_bytes[:MAX_OUTPUT_BYTES].decode("utf-8", errors="replace")
    stderr = stderr_bytes[:MAX_OUTPUT_BYTES].decode("utf-8", errors="replace")

    # RLIMIT_AS violations surface as -9 / SIGKILL on Linux; the
    # underlying signal varies (SIGSEGV is also common in CPython when
    # an allocation fails inside the interpreter). We treat *both* as a
    # memory cap hit; the caller can show "your program asked for more
    # than 256MB."
    memory_capped = (not timed_out) and exit_code in (-9, -11) and (
        "MemoryError" in stderr
        or "Cannot allocate memory" in stderr
        or stderr.strip() == ""
    )

    return ExecutionResult(
        exit_code=exit_code,
        stdout=stdout,
        stderr=stderr,
        duration_ms=duration_ms,
        timed_out=timed_out,
        memory_capped=memory_capped,
        truncated_stdout=truncated_stdout,
        truncated_stderr=truncated_stderr,
    )


def _argv_repr(cmd: list[str]) -> str:
    """Test-only helper — kept so a future PR debugging ``execute`` can
    log the shell-equivalent without joining argv ad-hoc."""
    return " ".join(shlex.quote(part) for part in cmd)


__all__ = [
    "MAX_MEMORY_MB",
    "MAX_OUTPUT_BYTES",
    "MAX_TIMEOUT_SEC",
    "ExecutionRequest",
    "ExecutionResult",
    "SandboxError",
    "execute",
    "supported_languages",
]
