# sandbox-runner

Ephemeral, resource-capped executor for student-uploaded code. The
**runtime-level** isolation (network namespace, syscall allowlist,
read-only FS) is owned by the container runtime that wraps this
service (gVisor's `runsc` or Firecracker — pick at deploy time per
ADR-0003 when it lands). This Python service owns the **process-level**
controls: wall-clock timeout, RLIMIT_AS / RLIMIT_CPU caps, stdout/err
capture with byte caps.

## Surface

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Liveness probe; returns supported language list |
| `POST` | `/v1/execute` | Run one program and return its outcome |

### `POST /v1/execute`

```json
{
  "language": "python",
  "source": "print('hello')",
  "stdin": "",
  "timeout_sec": 5,
  "memory_mb": 64
}
```

```json
{
  "exit_code": 0,
  "stdout": "hello\n",
  "stderr": "",
  "duration_ms": 42,
  "timed_out": false,
  "memory_capped": false,
  "truncated_stdout": false,
  "truncated_stderr": false
}
```

Caller-supplied `timeout_sec` / `memory_mb` are **clamped** to the host
caps (30 s / 256 MB) — values above are honored as the cap, not
rejected. Caller doesn't need to know our limits to ask for "as much
as you'll give me." Values **below** the cap are honored verbatim so a
quick syntax check can run with a 1 s budget.

## Run

```bash
pnpm --filter sandbox-runner dev    # uvicorn --reload, port 8003
pnpm --filter sandbox-runner start  # production
```

## Test

```bash
cd apps/sandbox-runner
uv sync --extra dev
uv run pytest
```

11 unit tests cover the happy path (print / stdin / non-zero exit),
the resource caps (timeout, memory, stdout / stderr truncation), and
harness misuse (unknown language, zero timeout / memory, clamping).
The memory-cap test is Linux-only (RLIMIT_AS is silently ignored on
macOS / BSD); CI runs Linux so the cap engages there.

## Languages

| Language | Backend | Status |
| --- | --- | --- |
| `python` | `python3 -c <source>` | ✓ |
| `node` | `node -e <source>` | tracked — see open list |
| `ruby` | `ruby -e <source>` | tracked — see open list |

Adding a language is a one-liner in `_LANGUAGE_COMMANDS`; the rest of
the harness is language-agnostic.

## Open

- [ ] gVisor / Firecracker runtime selection (ADR-0003).
- [ ] Container with `runsc` runtime hint baked into the Render
      service definition (deploy-time concern, not service code).
- [ ] Node + Ruby language entries.
- [ ] Supply-chain fuzz suite: run ≥ 100 known PoC payloads and
      assert zero escapes (Phase 5 §12 exit criterion).
- [ ] gRPC over UDS as an alternative transport — useful when the
      ai-worker and the sandbox sit in the same pod.
- [ ] Per-tenant accounting hook so abusive callers can be rate-
      limited at the gateway.
