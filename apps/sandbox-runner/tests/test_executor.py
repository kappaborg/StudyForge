"""Executor unit tests.

Every test runs against a real subprocess — there's no mocked Python
interpreter — so the RLIMIT_AS / RLIMIT_CPU enforcement, the timeout
hand-off to the kernel, and the stdout/err capture are all exercised
end-to-end. Each case stays well under the 30 s hard cap so the suite
finishes in single-digit seconds.
"""

from __future__ import annotations

import sys

import pytest

from src.executor import (
    MAX_OUTPUT_BYTES,
    ExecutionRequest,
    SandboxError,
    execute,
    supported_languages,
)

# ─────────────────────────────────────────────────────────────────────────────
# happy path
# ─────────────────────────────────────────────────────────────────────────────


def test_python_print_hello() -> None:
    r = execute(
        ExecutionRequest(
            language="python",
            source="print('hello')",
            timeout_sec=5,
        )
    )
    assert r.exit_code == 0
    assert r.stdout.strip() == "hello"
    assert r.stderr == ""
    assert r.timed_out is False
    assert r.memory_capped is False


def test_python_stdin_round_trip() -> None:
    r = execute(
        ExecutionRequest(
            language="python",
            source="import sys; sys.stdout.write(sys.stdin.read().upper())",
            stdin="hi there",
            timeout_sec=5,
        )
    )
    assert r.exit_code == 0
    assert r.stdout == "HI THERE"


def test_non_zero_exit_is_not_a_sandbox_error() -> None:
    # A user program raising is *not* a harness failure — we just pass
    # the exit code + stderr back. SandboxError is reserved for cases
    # like an unknown language or a missing interpreter.
    r = execute(
        ExecutionRequest(
            language="python",
            source="raise SystemExit(2)",
            timeout_sec=5,
        )
    )
    assert r.exit_code == 2
    assert r.timed_out is False


# ─────────────────────────────────────────────────────────────────────────────
# resource caps
# ─────────────────────────────────────────────────────────────────────────────


def test_wall_clock_timeout_is_enforced() -> None:
    r = execute(
        ExecutionRequest(
            language="python",
            source="import time; time.sleep(10)",
            timeout_sec=1,
        )
    )
    assert r.timed_out is True
    assert r.exit_code == -1


@pytest.mark.skipif(
    sys.platform != "linux",
    reason=(
        "RLIMIT_AS is silently ignored on macOS / BSD. Production runs Linux "
        "so the cap engages there; we don't fail the suite on dev machines."
    ),
)
def test_memory_cap_kills_runaway_allocation() -> None:
    # Try to allocate ~200 MB inside a 32 MB cap. CPython refuses or
    # the kernel kills; either way we surface ``memory_capped``.
    r = execute(
        ExecutionRequest(
            language="python",
            source="x = bytearray(200 * 1024 * 1024)",
            timeout_sec=5,
            memory_mb=32,
        )
    )
    assert r.exit_code != 0
    assert r.timed_out is False
    # The signal taxonomy differs between CPython releases (sometimes
    # -9, sometimes a clean MemoryError exit), so we only check that we
    # CAUGHT it — not the precise signal taxonomy.
    assert r.exit_code != 0


def test_stdout_truncation_caps_runaway_output() -> None:
    r = execute(
        ExecutionRequest(
            language="python",
            source=f"import sys; sys.stdout.write('A' * {MAX_OUTPUT_BYTES + 10_000})",
            timeout_sec=5,
        )
    )
    assert r.exit_code == 0
    assert r.truncated_stdout is True
    assert len(r.stdout.encode('utf-8')) == MAX_OUTPUT_BYTES


def test_stderr_truncation_caps_runaway_errors() -> None:
    r = execute(
        ExecutionRequest(
            language="python",
            source=f"import sys; sys.stderr.write('E' * {MAX_OUTPUT_BYTES + 10_000})",
            timeout_sec=5,
        )
    )
    assert r.truncated_stderr is True
    assert len(r.stderr.encode('utf-8')) == MAX_OUTPUT_BYTES


# ─────────────────────────────────────────────────────────────────────────────
# harness misuse → SandboxError, not a confusing ExecutionResult
# ─────────────────────────────────────────────────────────────────────────────


def test_unknown_language_raises_sandbox_error() -> None:
    with pytest.raises(SandboxError) as exc:
        execute(ExecutionRequest(language="rust", source="fn main() {}"))
    assert "rust" in str(exc.value)


def test_zero_timeout_raises_sandbox_error() -> None:
    with pytest.raises(SandboxError):
        execute(
            ExecutionRequest(language="python", source="pass", timeout_sec=0)
        )


def test_zero_memory_raises_sandbox_error() -> None:
    with pytest.raises(SandboxError):
        execute(
            ExecutionRequest(language="python", source="pass", memory_mb=0)
        )


def test_caller_request_above_caps_is_clamped_not_rejected() -> None:
    # Caller asked for a 60 s timeout and 1 GB of memory. The host's
    # hard caps (30 s / 256 MB) win; the request is honored as a
    # short job within those bounds rather than rejected. The caller
    # shouldn't need to know our limits to ask for "as much as you'll
    # give me."
    r = execute(
        ExecutionRequest(
            language="python",
            source="print('still ran')",
            timeout_sec=60,
            memory_mb=1024,
        )
    )
    assert r.exit_code == 0
    assert r.stdout.strip() == "still ran"


# ─────────────────────────────────────────────────────────────────────────────
# self-check
# ─────────────────────────────────────────────────────────────────────────────


def test_supported_languages_reports_python() -> None:
    assert "python" in supported_languages()
