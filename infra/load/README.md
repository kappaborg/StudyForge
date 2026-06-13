# Load testing

Scripts that model production load against a deployed environment.
Not part of CI — these run pre-release against staging to verify the
Phase 5 §12 exit criteria.

## What's here

| File | Models | Phase 5 criterion |
| --- | --- | --- |
| [`tutor.js`](./tutor.js) | Streaming tutor concurrency | `p95 ttft < 1.5 s @ 1 k concurrent` |

## Running

You need [`k6`](https://k6.io) on `$PATH`. macOS:

```bash
brew install k6
```

Linux (Debian/Ubuntu):

```bash
sudo gpg -k && \
sudo gpg --no-default-keyring --keyring /usr/share/keyrings/k6-archive-keyring.gpg --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69 && \
echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" | sudo tee /etc/apt/sources.list.d/k6.list && \
sudo apt-get update && \
sudo apt-get install k6
```

## Tutor concurrency — `tutor.js`

```bash
k6 run \
  --env BASE_URL=https://study-forge-api.onrender.com \
  --env COURSE_ID=11111111-1111-1111-1111-111111111111 \
  --vus 1000 \
  --duration 5m \
  infra/load/tutor.js
```

The script reports four custom metrics:

| Metric | What it measures |
| --- | --- |
| `tutor_ttft_ms` | Wall-clock to first non-empty content delta |
| `tutor_total_ms` | Wall-clock to the terminal `[DONE]` event |
| `tutor_first_token_seen` | Rate of streams that emitted at least one content chunk |
| `tutor_stream_errors` | Count of streams that 5xx'd or never produced a first chunk |

Thresholds (the gate):

- `tutor_ttft_ms`: `p(95) < 1500`, `p(99) < 3000`
- `tutor_total_ms`: `p(95) < 8000`
- `tutor_first_token_seen`: `rate > 0.99`
- `tutor_stream_errors`: `count < 10`
- `http_req_failed`: `rate < 0.01`

k6 prints a summary at the end and exits non-zero if any threshold
fires. A clean run is the headline evidence that satisfies the
"`p95 first-token < 1.5 s under 1 k concurrent sessions`" criterion.

### Smoke test (local / cheap)

The defaults are conservative so a developer can smoke the script
against `pnpm dev`:

```bash
k6 run --vus 10 --duration 30s infra/load/tutor.js
```

This still exercises the same thresholds — useful for catching
"stream returns 5xx" regressions without booting a load rig.

## Open

- [ ] **Real streaming TTFT measurement.** The current script
      approximates first-token latency from the response-completion
      timestamp because k6's `http.post` buffers the whole body. A
      Phase 5b follow-up wires `k6/experimental/browser` or a Node
      harness that uses `fetch` with `ReadableStream` for true
      per-chunk timestamps.
- [ ] **Mixed workload** — flashcard generation + roadmap planning +
      tutor in the same run, weighted to match prod traffic.
- [ ] **Per-tenant rate-limit verification.** A load test that asserts
      the budget pill caps engage (free-tier user gets a 429 once daily
      budget is exhausted, instead of degrading the rest of the herd).
