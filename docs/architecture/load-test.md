# Ingest load test

The Phase 1 exit criterion says: **500 MB mixed archive ingests in
≤ 10 minutes on reference hardware**. This doc captures the harness, the
measured numbers, and the upgrade path.

## Harness

`apps/ai-worker/scripts/ingest_load_test.py` generates synthetic PDFs
of realistic density (~150–250 chunks per MB) and runs them through
the full `ingest_document` pipeline: parse → safety → chunk → persist →
embed. It reports per-stage seconds, sec/MB, and the projected 500 MB
wall time, and prints a PASS/FAIL line against the 600s budget.

```bash
cd apps/ai-worker
PYTHONPATH=. python scripts/ingest_load_test.py --count 5 --size-mb 5
```

Locally we usually run `--count 1 --size-mb 1` for a smoke; CI nightly
runs `--count 10 --size-mb 50` for a full 500 MB pass.

## Reference numbers (local, Apple Silicon CPU, ONNX bge-large-en-v1.5)

| Stage              | Time / MB | Share |
|--------------------|-----------|-------|
| parse + chunk + persist | ~0.5 s   | 0.6%  |
| embed (BGE on CPU)      | ~85 s    | 99.4% |
| **total**               | **~86 s** | —    |

Projected 500 MB on CPU: **~12 h** — far over the 10-min budget.

## Why we're over budget

99% of the time is in the embedder. ONNX bge-large-en-v1.5 on an Apple
M-series CPU runs ~2.7 chunks/s. 500 MB at ~150 chunks/MB = ~75 000
chunks, which needs ~195 chunks/s to fit the budget — roughly a 70×
speedup.

## Paths to PASS

The harness will report PASS on any of:

1. **GPU acceleration** — `fastembed` falls back to ONNX-GPU on CUDA
   machines; ~30–80× faster. Set `EMBEDDER_BACKEND=fastembed` and run
   on a CUDA box.
2. **Remote inference endpoint** — `EMBEDDER_BACKEND=hf-inference` (not
   yet wired) calls Hugging Face Inference API. Faster than CPU on a
   T4, free tier limits apply.
3. **Smaller embedder** — `bge-small-en-v1.5` at 384-dim is ~3× faster
   than bge-large but requires a schema migration on `Chunk.embedding
   vector(1024)` → `vector(384)`. Captured as future work in
   `docs/architecture/06-rag-architecture.md`.
4. **Batched parallel ingest** — the worker currently embeds chunks
   sequentially per document. Parallelising across documents (one
   embedding worker per CPU core) buys ~4× on commodity laptops.

The honest current state is **the harness fails on CPU**. That's the
right signal to give until one of the upgrade paths lands. Self-hosters
on a CPU-only box will see ingest take much longer than 10 minutes for
a 500 MB corpus; the product still works, it just takes longer.
