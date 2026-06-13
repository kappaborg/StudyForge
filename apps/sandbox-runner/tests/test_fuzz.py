"""Fuzz suite against the in-process executor harness.

These cases exercise the controls the executor itself promises to
enforce: wall-clock timeout, RLIMIT_AS / RLIMIT_CPU caps, stdout / err
byte caps, harness-misuse error paths, encoding edge cases on the
source string. They do NOT cover the controls the runtime wrapper
(gVisor / Firecracker) owns — network namespace isolation, syscall
allowlist, read-only FS, drop-to-non-root — because the harness is a
plain process here; those PoCs would succeed against a bare CPython
and therefore would over-promise.

Phase 5 §12 names "≥ 100 known PoC payloads, zero escapes" as the
final exit criterion. This file is the frame: ~20 high-value cases
across five categories. Adding more is a one-liner per case; the
framework is set up so a future commit can drop in the remaining
attack corpus once the runtime wrapper is in place.

Test design note
- ``timeout_sec=4`` is the default budget below — high enough that
  the host's load can't false-timeout a healthy run; low enough that
  the suite finishes in seconds.
- Output-flooding tests use the executor's actual MAX_OUTPUT_BYTES
  constant so a future bump moves both the cap and the test threshold
  in lockstep.
"""

from __future__ import annotations

import pytest

from src.executor import (
    MAX_OUTPUT_BYTES,
    MAX_TIMEOUT_SEC,
    ExecutionRequest,
    SandboxError,
    execute,
)

# ─────────────────────────────────────────────────────────────────────────────
# Category 1: timer evasion
#
# The wall-clock timeout is enforced by ``subprocess.run(timeout=...)``
# which the kernel honours via SIGKILL on the child. These cases try
# tricks that *could* fool a less rigorous harness — signal handlers,
# os.setsid, threading, asyncio, exec replacing the binary — and
# assert that the timeout still fires.
# ─────────────────────────────────────────────────────────────────────────────


_TIMER_EVASION_PAYLOADS = [
    pytest.param(
        "import time; time.sleep(60)",
        id="raw-sleep",
    ),
    pytest.param(
        "import signal, time\n"
        "signal.signal(signal.SIGTERM, lambda *_: None)\n"
        "signal.signal(signal.SIGINT, lambda *_: None)\n"
        "time.sleep(60)",
        id="ignore-sigterm",
    ),
    pytest.param(
        "import os, time\n"
        "os.setsid()\n"
        "time.sleep(60)",
        id="detach-session",
    ),
    pytest.param(
        "import threading, time\n"
        "t = threading.Thread(target=lambda: time.sleep(60), daemon=False)\n"
        "t.start(); t.join()",
        id="threaded-sleep",
    ),
    pytest.param(
        "import asyncio\n"
        "async def main():\n"
        "    await asyncio.sleep(60)\n"
        "asyncio.run(main())",
        id="asyncio-sleep",
    ),
    pytest.param(
        # A busy loop trips RLIMIT_CPU on Linux even if subprocess
        # timeout somehow didn't (belt-and-braces). On macOS RLIMIT_CPU
        # is also widely honoured, so this case stays portable.
        "while True: pass",
        id="busy-loop",
    ),
]


@pytest.mark.parametrize("source", _TIMER_EVASION_PAYLOADS)
def test_timer_evasion_does_not_bypass_wall_clock(source: str) -> None:
    r = execute(
        ExecutionRequest(language="python", source=source, timeout_sec=1)
    )
    # Either the wall-clock timeout fired (subprocess timeout) or the
    # process exited under another harness control. The key invariant
    # is that we did NOT run past the 1 s budget by more than the
    # subprocess teardown grace (≈ 1 s on a busy CI runner).
    assert r.duration_ms < 3_500, (
        f"payload {source[:60]!r} took {r.duration_ms} ms — longer than the "
        "timeout + teardown grace; the wall-clock cap leaked"
    )


# ─────────────────────────────────────────────────────────────────────────────
# Category 2: output flooding
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "source,channel",
    [
        pytest.param(
            f"import sys\nsys.stdout.write('A' * {MAX_OUTPUT_BYTES * 4})",
            "stdout",
            id="stdout-burst",
        ),
        pytest.param(
            f"import sys\n"
            f"for _ in range({MAX_OUTPUT_BYTES // 1000 + 5_000}):\n"
            f"    sys.stdout.write('X' * 1000)",
            "stdout",
            id="stdout-trickle",
        ),
        pytest.param(
            f"import sys\nsys.stderr.write('E' * {MAX_OUTPUT_BYTES * 4})",
            "stderr",
            id="stderr-burst",
        ),
    ],
)
def test_output_flood_is_truncated_at_the_cap(source: str, channel: str) -> None:
    r = execute(
        ExecutionRequest(language="python", source=source, timeout_sec=5)
    )
    captured = r.stdout if channel == "stdout" else r.stderr
    flag = r.truncated_stdout if channel == "stdout" else r.truncated_stderr
    assert flag is True
    assert len(captured.encode("utf-8")) == MAX_OUTPUT_BYTES


# ─────────────────────────────────────────────────────────────────────────────
# Category 3: harness misuse — clamping + validation
#
# Callers we don't trust will send adversarial limits. The executor's
# clamping promise: above-cap values are honoured AS the cap (not
# rejected), below-cap values are honoured verbatim, non-finite / zero
# / negative values raise SandboxError before any process is spawned.
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "timeout_sec",
    [60.0, 1e6, 1e308, float(MAX_TIMEOUT_SEC) + 1, 31.0],
    ids=["1-min", "1m-sec", "near-inf", "above-cap-by-one", "31-sec"],
)
def test_above_cap_timeout_is_clamped_to_max(timeout_sec: float) -> None:
    r = execute(
        ExecutionRequest(
            language="python",
            source="print('clamped ok')",
            timeout_sec=timeout_sec,
        )
    )
    # The job ran cleanly inside the host cap, not the caller's huge
    # request. Duration is well under MAX_TIMEOUT_SEC * 1000 ms.
    assert r.exit_code == 0
    assert r.duration_ms < MAX_TIMEOUT_SEC * 1000
    assert r.stdout.strip() == "clamped ok"


@pytest.mark.parametrize(
    "memory_mb,raises",
    [
        (1_000_000, False),  # clamped to MAX_MEMORY_MB
        (1024, False),        # also clamped
        (0, True),
        (-1, True),
    ],
    ids=["1M-mb", "1G-mb", "zero", "negative"],
)
def test_memory_mb_clamp_and_reject(memory_mb: int, raises: bool) -> None:
    req = ExecutionRequest(
        language="python",
        source="print('ok')",
        timeout_sec=3,
        memory_mb=memory_mb,
    )
    if raises:
        with pytest.raises(SandboxError):
            execute(req)
    else:
        r = execute(req)
        assert r.exit_code == 0


@pytest.mark.parametrize(
    "timeout_sec",
    [0.0, -1.0, -1e308],
    ids=["zero", "negative-one", "negative-huge"],
)
def test_invalid_timeout_raises_sandbox_error(timeout_sec: float) -> None:
    with pytest.raises(SandboxError):
        execute(
            ExecutionRequest(
                language="python",
                source="pass",
                timeout_sec=timeout_sec,
            )
        )


# ─────────────────────────────────────────────────────────────────────────────
# Category 4: source-string encoding edge cases
#
# The runner reads ``source`` as a Python string and exec's it via
# ``python3 -c``. Pathological inputs (null bytes, mixed UTF-8 + BOM,
# very long lines) must not crash the harness — at worst the child's
# parser refuses and we surface a non-zero exit.
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "source,expect_zero",
    [
        pytest.param("print('ok')\n", True, id="trailing-newline"),
        pytest.param("# bom test\nprint('ok')", True, id="ascii-with-comment"),
        pytest.param("print('é')", True, id="utf-8-source"),
        pytest.param("print('🌀')", True, id="emoji-source"),
        pytest.param("\xef\xbb\xbfprint('bom')", False, id="utf-8-bom-prefix"),
        pytest.param("print('a')\nprint('b')\n" * 200, True, id="200-statements"),
    ],
)
def test_pathological_source_strings_do_not_crash_the_harness(
    source: str, expect_zero: bool
) -> None:
    r = execute(
        ExecutionRequest(language="python", source=source, timeout_sec=3)
    )
    # Either it ran clean OR the child reported a SyntaxError /
    # encoding error with a non-zero exit. The harness itself is never
    # the failure.
    assert r.timed_out is False
    if expect_zero:
        assert r.exit_code == 0
    else:
        assert r.exit_code != 0


def test_null_byte_in_source_does_not_crash_harness() -> None:
    # ``\0`` in a Python source string is a SyntaxError at parse time.
    # The harness must surface that as a non-zero ExecutionResult,
    # never a Python-level exception leaking out of ``execute``.
    r = execute(
        ExecutionRequest(
            language="python",
            source="print('a')\x00print('b')",
            timeout_sec=3,
        )
    )
    assert r.timed_out is False
    assert r.exit_code != 0


# ─────────────────────────────────────────────────────────────────────────────
# Category 5: unknown language rejection
#
# A previous bug class: the registry lookup is the only language-side
# control. Fuzz the rejection path to make sure no special string slips
# through (empty, whitespace, very long, with separators).
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "language",
    [
        "",
        " ",
        "py",
        "PYTHON",
        "python ",
        "python3",
        "node",
        "ruby",
        "rust",
        "  python  ",
        "python;rm -rf /",
        "p" * 1_000,
    ],
)
def test_unknown_language_strings_all_rejected(language: str) -> None:
    with pytest.raises(SandboxError):
        execute(ExecutionRequest(language=language, source="pass"))
