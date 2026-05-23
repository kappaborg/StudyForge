# Tutor eval — Ragas-lite + golden set

StudyForge's tutor is the only agent gated by an eval harness. Three
deterministic scorers run against a golden JSONL fixture, and CI fails
if any threshold drops below the documented floor.

## Run locally

```bash
cd apps/ai-worker
uv run python -m src.eval.cli \
  --prompt tutor.answer.v1 \
  --golden golden/tutor_answer_v1.jsonl \
  --min-pass-rate 1.0 \
  --min-citation-validity 0.95 \
  --min-refusal-consistency 1.0
```

Exit code 0 = gate passes, 1 = a threshold is violated.

## Scorers

| Metric | What it measures | Floor |
|---|---|---|
| `citation_validity` | Fraction of cited chunk_ids that exist in the supplied chunk set. 1.0 = the model never hallucinated a chunk_id. | **0.95** |
| `refusal_consistency` | The agent's refusal flag matches the golden case's `expect_refusal`. | **1.0** |
| `context_precision` | Lexical-proxy overlap between query and chunk tokens. Noisy — a chunk can be semantically relevant but lexically distant. Reported, not strictly gated. | informational |

`context_precision` is intentionally **not** in the CI gate. It's a
proxy that punishes legitimate lexical mismatches (e.g. a "data
cleaning" query hitting a chunk that talks about "frame metadata
review"). Real Ragas context-precision uses an LLM judge per chunk —
when we add that path (`EVAL_MODE=ragas`), it gates at ≥ 0.80.

## Golden set authoring

`golden/tutor_answer_v1.jsonl` — one `GoldenCase` per line. Tight
discipline keeps the eval signal-rich:

- **Cited cases**: list `expected_chunks` and a `model_response`
  containing `[chunk:<id>]` tags for every chunk you expect cited.
- **Refusal cases**: set `expect_refusal: true`, omit
  `expected_chunks`, use `model_response: "I could not find this in your materials."`

The agent is invoked against a `_ScriptedProvider` that returns the
case's `model_response` verbatim — no LLM call, no flakiness, no token
cost. Failures pinpoint prompt regressions, not retrieval drift.

## CI gate (Phase 5)

GitHub Actions runs the CLI on every PR touching `apps/ai-worker/`.
The job is gated on the two strict thresholds; PR review summary
includes the average scores in a comment so reviewers see drift early.
