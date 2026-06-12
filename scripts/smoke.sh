#!/usr/bin/env bash
# Full-stack smoke test. Runs after `pnpm install`, `prisma db push`,
# and the API + worker dev servers are listening. Walks two users
# through the headline flows; fails fast on any non-2xx response.
#
# Used by:
#   • Local dev: `bash scripts/smoke.sh` after `pnpm dev`
#   • CI: invoked by .github/workflows/ci.yml job `smoke`
#
# Env:
#   API_URL       (default http://localhost:3001)
#   WORKER_URL    (default http://localhost:8001)
#   YOUTUBE_URL   default points at "Me at the zoo" — the oldest video,
#                 has captions, ~19s, perfect for a smoke.

set -euo pipefail

API_URL="${API_URL:-http://localhost:3001}"
WORKER_URL="${WORKER_URL:-http://localhost:8001}"
YOUTUBE_URL="${YOUTUBE_URL:-https://www.youtube.com/watch?v=jNQXAC9IVRw}"
TS="$(date +%s)"

# Helpers ────────────────────────────────────────────────────────────────────

note() { printf '\n\033[1;36m== %s ==\033[0m\n' "$*"; }
ok()   { printf '  \033[1;32m✓\033[0m %s\n' "$*"; }
fail() { printf '  \033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

# Curl with idempotency key + cookie jar + fail-fast on 4xx/5xx.
post() {
  local jar=$1; local path=$2; local body=$3
  curl -sf -b "$jar" -c "$jar" -X POST "$API_URL$path" \
    -H 'content-type: application/json' \
    -H "idempotency-key: smoke-${TS}-$(openssl rand -hex 8)" \
    -d "$body"
}

post_unauth() {
  local jar=$1; local path=$2; local body=$3
  curl -sf -c "$jar" -X POST "$API_URL$path" \
    -H 'content-type: application/json' \
    -d "$body"
}

get() {
  local jar=$1; local path=$2
  curl -sf -b "$jar" "$API_URL$path"
}

require_json_field() {
  local json=$1; local field=$2
  echo "$json" | python3 -c "import sys,json; v=json.load(sys.stdin)['$field']; sys.exit(0 if v else 1)" \
    || fail "expected JSON field '$field' to be truthy: $json"
}

extract() {
  local json=$1; local expr=$2
  echo "$json" | python3 -c "import sys,json; d=json.load(sys.stdin); print(${expr})"
}

# Health probes ──────────────────────────────────────────────────────────────

note 'health'
curl -sf "$API_URL/health"   >/dev/null && ok "api $API_URL/health"   || fail "api unreachable"
curl -sf "$WORKER_URL/health" >/dev/null && ok "worker $WORKER_URL/health" || fail "worker unreachable"

# 10-stage smoke ─────────────────────────────────────────────────────────────

JAR_A=$(mktemp)
JAR_B=$(mktemp)
trap 'rm -f "$JAR_A" "$JAR_B"' EXIT

note '1. signup user A'
A=$(post_unauth "$JAR_A" /v1/auth/signup "{\"email\":\"a-$TS@x.com\",\"password\":\"passwd1234\"}")
require_json_field "$A" userId
ok "user=$(extract "$A" "d['userId'][:8]")"

note '2. create folder'
post "$JAR_A" /v1/folders '{"name":"Smoke folder"}' >/dev/null
FOLDERS=$(get "$JAR_A" /v1/folders)
FID=$(echo "$FOLDERS" | python3 -c "import sys,json; print([f['id'] for f in json.load(sys.stdin) if f['kind']=='materials'][0])")
ok "folder=${FID:0:8}"

note '3. YouTube ingest'
if [ "${SKIP_YOUTUBE_INGEST:-}" = "true" ]; then
  echo "  ⊘ skipped (SKIP_YOUTUBE_INGEST=true — live YouTube rate-limits CI)"
  # Stand in with a manually-seeded document so downstream stages have a
  # document to attach to. The YouTube path is covered separately by the
  # ai-worker's unit tests.
  ING=$(post "$JAR_A" /v1/documents "{\"folderId\":\"$FID\",\"title\":\"Smoke test document\",\"contentMd\":\"# Test\\nRetrieval-augmented generation is a technique that grounds LLM responses in retrieved chunks.\"}")
  DOC=$(extract "$ING" "d['documentId']")
  CHUNKS=$(extract "$ING" "d.get('chunkCount', 1)")
else
  ING=$(post "$JAR_A" /v1/uploads/youtube "{\"url\":\"$YOUTUBE_URL\",\"folderId\":\"$FID\"}")
  DOC=$(extract "$ING" "d['documentId']")
  CHUNKS=$(extract "$ING" "d['chunkCount']")
fi
ok "doc=${DOC:0:8} chunks=$CHUNKS"

note '4. manual flashcard'
FC=$(post "$JAR_A" /v1/flashcards/manual "{\"folderId\":\"$FID\",\"front\":\"What is RAG?\",\"back\":\"Retrieval-augmented generation.\"}")
ok "flashcard=$(extract "$FC" "d['flashcardId'][:8]")"

note '5. SRS due'
DUE=$(get "$JAR_A" '/v1/flashcards/due?limit=5')
DUE_COUNT=$(extract "$DUE" "len(d['cards'])")
test "$DUE_COUNT" -ge 1 || fail "expected ≥1 due card, got $DUE_COUNT"
ok "due=$DUE_COUNT"

note '6. exam scope: parse + save'
PARSED=$(post "$JAR_A" /v1/exam-scopes/parse '{"text":"Theory: Ch 4 and 6 (Mapping)"}')
ok "parsed title=$(extract "$PARSED" "d['title'][:30]")"
SCOPE=$(post "$JAR_A" /v1/exam-scopes "{\"folderId\":\"$FID\",\"title\":\"Smoke midterm\",\"scopes\":[{\"mode\":\"theory\",\"chapters\":[4,6],\"topics\":[\"Mapping\"]}]}")
SID=$(extract "$SCOPE" "d['id']")
ok "scope=${SID:0:8}"

note '7. publish folder'
SHARE=$(post "$JAR_A" "/v1/folders/$FID/share" '{}')
CODE=$(extract "$SHARE" "d['code']")
ok "code=$CODE"

note '8. scope share link'
LINK=$(post "$JAR_A" "/v1/exam-scopes/$SID/share" '{}')
TOK=$(extract "$LINK" "d['token']")
ok "token=${TOK:0:12}…"

note '9. user B signs up + subscribes + accepts scope'
post_unauth "$JAR_B" /v1/auth/signup "{\"email\":\"b-$TS@x.com\",\"password\":\"passwd1234\"}" >/dev/null
SUB=$(post "$JAR_B" /v1/shared/subscribe "{\"code\":\"$CODE\"}")
ok "subscribed: $(extract "$SUB" "d['title']+' by '+d['publishedBy']")"
post "$JAR_B" /v1/folders '{"name":"B folder"}' >/dev/null
BFOLDERS=$(get "$JAR_B" /v1/folders)
BFID=$(echo "$BFOLDERS" | python3 -c "import sys,json; print([f['id'] for f in json.load(sys.stdin) if f['kind']=='materials'][0])")
PREV=$(get "$JAR_B" "/v1/shared/scopes/preview/$TOK")
ok "preview: $(extract "$PREV" "d['title']+' from '+d['sharedBy']")"
FORK=$(post "$JAR_B" /v1/shared/scopes/accept "{\"token\":\"$TOK\",\"folderId\":\"$BFID\"}")
ok "fork: $(extract "$FORK" "d['id'][:8]+' in '+d['folderName']")"

note '10. tutor ask (reranker active)'
ASK=$(post "$JAR_A" /v1/chat/tutor/ask "{\"query\":\"what is this about?\",\"folderId\":\"$FID\"}")
CITES=$(extract "$ASK" "len(d['citations'])")
ok "citations=$CITES"

printf '\n\033[1;32m✅ all 10 stages passed\033[0m\n'
