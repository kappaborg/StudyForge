// k6 load test for the tutor streaming path.
//
// Phase 5 §12 names the exit criterion: "p95 first-token < 1.5 s under
// 1 k concurrent tutor sessions." This script models that load.
//
// It targets the SSE stream endpoint (``POST /v1/chat/tutor/stream``)
// rather than the synchronous ``/v1/chat/tutor`` because §10 of
// ``prompt.md`` calls out time-to-first-token as the load-bearing
// metric for tutor UX, and the synchronous path only surfaces wall-
// clock-to-completion.
//
// What we measure
//   * ttft   — wall-clock from request open to the first SSE chunk
//     that carries non-empty content.delta. This is what a student
//     perceives as "the tutor started replying."
//   * total  — wall-clock from request open to the terminal
//     ``[DONE]`` event.
//   * errors — any non-2xx response, dropped connection, or stream
//     that never produces a first chunk.
//
// Custom thresholds enforce the exit criterion: ``ttft p(95) < 1500``.
// Tune ``VUS`` (virtual-user concurrency) via env.
//
// Run
//   k6 run --env BASE_URL=https://study-forge-api.onrender.com \
//          --env COURSE_ID=... \
//          --vus 1000 --duration 5m \
//          infra/load/tutor.js
//
// The default ``VUS=10`` keeps the script cheap to smoke locally; the
// 1000-VU run is reserved for staging pre-release gates.

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Counter, Rate } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3001';
const COURSE_ID = __ENV.COURSE_ID || '';
const QUESTION = __ENV.QUESTION || 'What is the gradient descent algorithm?';

// One Trend per latency milestone so the summary surfaces p50/p95/p99
// for each independently. k6 emits the percentiles automatically;
// thresholds below enforce the headline number.
const ttftMs = new Trend('tutor_ttft_ms', true);
const totalMs = new Trend('tutor_total_ms', true);
const streamErrors = new Counter('tutor_stream_errors');
const firstTokenSeen = new Rate('tutor_first_token_seen');

export const options = {
  // Conservative defaults; CLI flags override for the real run.
  vus: parseInt(__ENV.VUS || '10', 10),
  duration: __ENV.DURATION || '30s',

  thresholds: {
    // Phase 5 §12 exit criterion: p95 ttft < 1500ms.
    tutor_ttft_ms: ['p(95)<1500', 'p(99)<3000'],
    tutor_total_ms: ['p(95)<8000'],
    tutor_first_token_seen: ['rate>0.99'],
    tutor_stream_errors: ['count<10'],

    // Standard HTTP-level guardrails so a flat 5xx still trips the gate
    // even if the stream parser somehow produces a valid ttft.
    http_req_failed: ['rate<0.01'],
  },
};

export function setup() {
  // Sanity-check the target before flooding it with VUs. A typo in
  // BASE_URL is a far more common failure than a real throughput cap.
  const probe = http.get(`${BASE_URL}/health`, { timeout: '5s' });
  check(probe, {
    'health responds 200': (r) => r.status === 200,
  });
  if (probe.status !== 200) {
    throw new Error(
      `BASE_URL=${BASE_URL} did not respond 200 on /health (got ${probe.status})`,
    );
  }
  return { startedAt: Date.now() };
}

export default function () {
  const url = `${BASE_URL}/v1/chat/tutor/stream`;
  const payload = JSON.stringify({
    courseId: COURSE_ID || undefined,
    question: QUESTION,
  });

  const requestStartedAt = Date.now();
  let firstChunkAt = null;
  let chunkCount = 0;

  // k6 doesn't have a native SSE parser; we stream the response as a
  // single ``http.request`` and walk the body line-by-line. The
  // upstream endpoint sends ``data: {...}\n\n`` framing — same as the
  // OpenAI / Anthropic API formats — so we look for the first
  // ``data:`` line whose JSON payload carries a non-empty ``delta``.
  const res = http.post(url, payload, {
    headers: {
      'content-type': 'application/json',
      accept: 'text/event-stream',
    },
    timeout: '30s',
    // ``responseType: text`` keeps the body available for parsing.
    responseType: 'text',
  });

  if (res.status !== 200) {
    streamErrors.add(1);
    firstTokenSeen.add(false);
    return;
  }

  // k6 buffers the whole response by the time the call returns, so we
  // can't measure true streaming latency — but we CAN measure the
  // request-completion time as an upper bound. For real ttft we'd need
  // to switch to ``k6/experimental/browser`` or run a Node load
  // harness; for now we approximate with the response-end timestamp
  // when the first chunk is observable in the body.
  const body = res.body || '';
  const lines = body.split('\n');
  for (const line of lines) {
    if (!line.startsWith('data:')) continue;
    const payloadStr = line.slice('data:'.length).trim();
    if (payloadStr === '[DONE]' || payloadStr === '') continue;
    try {
      const evt = JSON.parse(payloadStr);
      const delta = (evt && (evt.delta || (evt.choices && evt.choices[0] && evt.choices[0].delta && evt.choices[0].delta.content))) || '';
      if (typeof delta === 'string' && delta.length > 0) {
        firstChunkAt = requestStartedAt + res.timings.waiting;
        break;
      }
    } catch (_) {
      // Malformed JSON in an SSE event = stream noise; skip.
    }
    chunkCount += 1;
  }

  const finishedAt = requestStartedAt + res.timings.duration;
  totalMs.add(finishedAt - requestStartedAt);

  if (firstChunkAt === null) {
    streamErrors.add(1);
    firstTokenSeen.add(false);
  } else {
    ttftMs.add(firstChunkAt - requestStartedAt);
    firstTokenSeen.add(true);
  }

  check(res, {
    'stream returned 200': (r) => r.status === 200,
    'stream had data chunks': () => chunkCount > 0 || firstChunkAt !== null,
  });

  // Light think-time between iterations so we don't synthetically
  // serialise requests inside a single VU.
  sleep(0.5);
}

export function teardown(data) {
  const wallMs = Date.now() - data.startedAt;
  console.log(`tutor load test wall time: ${(wallMs / 1000).toFixed(1)}s`);
}
