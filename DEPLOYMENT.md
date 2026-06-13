# Deployment runbook — free-tier production

Walks you through provisioning every external service this app needs and
wiring them up. Designed for a personal Vercel link you can share with
testers, on $0/month plans.

## What you'll end up with

- **Web** on Vercel (`https://YOUR-APP.vercel.app`) — the public URL
- **API** on Render (`https://YOUR-API.onrender.com`) — NestJS
- **AI worker** on Render (`https://YOUR-AI-WORKER.onrender.com`) — Python (FastAPI, embedding + tutor stream + agents)
- **Notification worker** on Render — Node background worker (Resend email dispatcher; skip if you don't want email)
- **Sandbox runner** on Render *(optional)* — Python FastAPI runtime for student-uploaded code (only if you turn on the code-exec features)
- **Postgres** on Neon — 3 GB free
- **Redis** on Upstash — 10 k commands/day free
- **Blob storage** on Cloudflare R2 — 10 GB free
- **Email** on Resend — 3 k sends/month free *(skip if no email)*
- **Google OAuth** via Google Cloud Console — free

Total time: ~90 minutes the first time through (~75 if you skip the notification worker; ~120 if you also stand up the sandbox runner).

## Before you start

You'll need accounts on: Vercel, Render, Neon, Upstash, Cloudflare,
Resend, Google Cloud. All free, all standard email signup.

The repo is already at `https://github.com/kappaborg/StudyForge.git`. You
push the latest commit, then point each service at the repo.

---

## Step 0 — push the latest commit to GitHub

```bash
cd "/Users/kappasutra/Documents/Student Helper"
git push origin main
```

If `git push` prompts for credentials, use a [GitHub Personal Access Token](https://github.com/settings/tokens) (classic, with `repo` scope) as the password, not your GitHub password.

---

## Step 1 — Neon (Postgres + pgvector)

1. Go to [neon.tech](https://neon.tech) → sign up (the "Continue with GitHub" button is fastest) → **New Project**.
2. Region: pick `aws-us-east-2` or `aws-eu-central-1` — match wherever Render is closest.
3. After it provisions, click **Connect** (top right of the dashboard). The "Connect to your database" modal opens with two important controls:

   **a. Copy the pooled URL → this is `DATABASE_URL`**
   - Make sure **Connection pooling** is ON (green toggle).
   - Click **Show password**, then **Copy snippet**.
   - **Append `&pgbouncer=true`** to the very end of the URL.
   - Final shape:
     ```
     postgresql://neondb_owner:PASSWORD@ep-XYZ-pooler.REGION.aws.neon.tech/neondb?sslmode=require&channel_binding=require&pgbouncer=true
     ```

   **b. Copy the direct URL → this is `DIRECT_URL`**
   - Toggle **Connection pooling** OFF (grey).
   - Click **Show password**, then **Copy snippet** again.
   - The hostname no longer contains `-pooler`.
   - Do NOT append `pgbouncer=true` to this one.
   - Final shape:
     ```
     postgresql://neondb_owner:PASSWORD@ep-XYZ.REGION.aws.neon.tech/neondb?sslmode=require&channel_binding=require
     ```

   Both URLs share the same password. Save them both.

4. Inside the project → **SQL Editor** → paste and run:

   ```sql
   CREATE EXTENSION IF NOT EXISTS vector;
   CREATE EXTENSION IF NOT EXISTS citext;
   ```

   You should see two `CREATE EXTENSION` rows. **Skipping this causes the Step 7 migration to fail.**

You'll run `prisma migrate deploy` against `DIRECT_URL` in Step 7.

---

## Step 2 — Upstash (Redis)

1. [console.upstash.com](https://console.upstash.com) → **Create Database**.
2. Type: **Regional**. Pick the same region as Neon.
3. Eviction: **noeviction** (the default).
4. After it creates, scroll to **REST API** → toggle to **Redis CLI / TLS URL**.
5. Copy the `rediss://...` URL — this is your `REDIS_URL`.

---

## Step 3 — Cloudflare R2 (S3-compatible blob storage)

1. [dash.cloudflare.com](https://dash.cloudflare.com) → **R2** → **Create bucket**.
   - Name: `studyforge-uploads`
   - Region: **Automatic**
2. Click into the bucket → **Settings** tab → note your **Account ID** (top right of the dashboard).
3. Side nav → **R2** → **Manage R2 API Tokens** → **Create API Token**:
   - Permissions: **Object Read & Write**
   - Specify bucket: `studyforge-uploads`
   - TTL: **Forever**
4. Copy the `Access Key ID` and `Secret Access Key`. **You can only view the secret once.**
5. Save:
   - `S3_ENDPOINT` = `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`
   - `S3_ACCESS_KEY` = the access key id
   - `S3_SECRET_KEY` = the secret
   - `S3_BUCKET` = `studyforge-uploads`
   - `S3_REGION` = `auto`

---

## Step 4 — Resend (email)

1. [resend.com](https://resend.com) → sign up.
2. **API Keys** → **Create API Key** → name it `studyforge-prod`, role `Sending access`. Copy the `re_...` token.
3. For testing without a domain, the sender `StudyForge <onboarding@resend.dev>` works out of the box — emails will only deliver to the address you signed up with. Verify a real domain before sharing the link with people other than yourself.

Save:
- `RESEND_API_KEY` = the `re_...` token
- `EMAIL_FROM` = `StudyForge <onboarding@resend.dev>`

---

## Step 5 — Google Cloud Console (OAuth)

1. [console.cloud.google.com](https://console.cloud.google.com) → **Create Project** → name it `studyforge`.
2. **APIs & Services** → **OAuth consent screen**:
   - User type: **External**
   - App name: `StudyForge`
   - User support email + developer email: your email
   - Scopes: leave default (just `openid`, `email`, `profile` — no extra scopes needed)
   - Test users: add the Google accounts of anyone you want to let in while in "Testing" mode (up to 100).
3. **APIs & Services** → **Credentials** → **Create Credentials** → **OAuth client ID**:
   - Application type: **Web application**
   - Name: `studyforge-web`
   - **Authorized JavaScript origins:** *(leave empty — we don't use implicit flow)*
   - **Authorized redirect URIs:**
     - `https://YOUR-API.onrender.com/v1/auth/google/callback` *(you don't know this URL yet — fill it in after Step 6 and come back to edit)*
4. Save the `Client ID` and `Client Secret`.

Save:
- `GOOGLE_CLIENT_ID` = the client id (`...apps.googleusercontent.com`)
- `GOOGLE_CLIENT_SECRET` = the client secret
- `GOOGLE_CALLBACK_URL` = `https://YOUR-API.onrender.com/v1/auth/google/callback` (you'll know `YOUR-API` after Step 6)

---

## Step 6 — Render (API + workers)

### 6a. API service

1. [dashboard.render.com](https://dashboard.render.com) → **New** → **Web Service**.
2. **Connect a repository** → pick `kappaborg/StudyForge` (authorise GitHub if first time).
3. Configure:
   - **Name**: `studyforge-api`
   - **Region**: same as Neon
   - **Branch**: `main`
   - **Root Directory**: *(leave blank — repo root)*
   - **Environment**: **Docker**
   - **Dockerfile Path**: `apps/api/Dockerfile`
   - **Docker Context Directory**: `.` *(repo root)*
   - **Instance Type**: **Free**
4. **Environment Variables** — add every var from `apps/api/.env.production.example`:
   - `DATABASE_URL` from Step 1 (POOLED URL **with `&pgbouncer=true` appended**)
   - `DIRECT_URL` from Step 1 (the non-pooled URL — Render itself doesn't use it, but tomorrow's `prisma migrate` from Render's Shell would)
   - `REDIS_URL` from Step 2
   - `S3_ENDPOINT`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET`, `S3_REGION`, `S3_PUBLIC_URL` from Step 3
   - `RESEND_API_KEY`, `EMAIL_FROM` from Step 4
   - `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` from Step 5
   - `NODE_ENV=production`
   - `SESSION_COOKIE_SECRET` — generate with `openssl rand -base64 48`
   - **Leave `MEILI_HOST` unset** (search falls back to Postgres)
   - `CORS_ORIGIN` and `WEB_BASE_URL` — you don't know your Vercel URL yet. Set these to a placeholder (`https://example.com`) and update after Step 9.
   - `GOOGLE_CALLBACK_URL` — fill in after this service is created (next sub-step).
   - `AI_WORKER_URL` — fill in after the worker is created.
5. Click **Create Web Service**. First build takes ~5 min.
6. Once deployed, copy the **live URL** (e.g. `https://studyforge-api-xyz.onrender.com`).
7. Go back to Step 5 in Google Cloud → edit the OAuth client → set **Authorized redirect URI** to `<that URL>/v1/auth/google/callback` and save.
8. Back on Render → API service → **Environment** → set `GOOGLE_CALLBACK_URL` to the same URL → save (this restarts the service).

### 6b. AI worker service

1. Render → **New** → **Web Service** → same repo.
2. Configure:
   - **Name**: `studyforge-ai-worker`
   - **Environment**: **Docker**
   - **Dockerfile Path**: `apps/ai-worker/Dockerfile`
   - **Docker Context Directory**: `.`
   - **Instance Type**: **Free**
3. Environment variables from `apps/ai-worker/.env.production.example`:
   - `DATABASE_URL` (same string as the API)
   - `REDIS_URL`
   - `S3_*` (same as API)
   - `DISABLE_AUDIO=1`
   - `EMBEDDER_BACKEND=fastembed`
   - `VECTOR_BACKEND=pgvector`
   - **At least one of**: `GROQ_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`. Without an LLM key the tutor won't answer. Groq's [free tier](https://console.groq.com/keys) is the most generous.
4. Create. First build takes ~8 min (pulls tesseract + downloads fastembed model on first request).
5. Copy the live URL.
6. Go to the API service → **Environment** → set `AI_WORKER_URL` to the worker URL → save.

### 6c. Notification worker (optional — skip if you don't want email)

The notification worker dispatches the `Notification` table's `email` rows
via Resend with exponential-backoff retry (1 m → 5 m → 30 m → 2 h → 12 h,
capped at `MAX_RETRIES=5`). The api still writes notifications to the
table either way — without this worker the rows sit in `state='queued'`
forever, which is harmless if you don't care about email delivery.

1. Render → **New** → **Background Worker** (not Web Service — it has no
   HTTP surface, the api owns ingest).
2. Configure:
   - **Name**: `studyforge-notification-worker`
   - **Environment**: **Docker**
   - **Dockerfile Path**: `apps/notification-worker/Dockerfile`
   - **Docker Context Directory**: `.`
   - **Instance Type**: **Free**
3. Environment variables:
   - `DATABASE_URL` (same pooled URL as the api — uses `FOR UPDATE SKIP LOCKED` so the connection-pool concern is the same as the api)
   - `RESEND_API_KEY` from Step 4 (omit to run in **dryrun** mode — notifications progress to `delivered` without an actual send, useful while testing)
   - `EMAIL_FROM` (same as api)
   - `WEB_BASE_URL` (so the rendered emails link back to your Vercel URL)
   - `NOTIFICATION_TICK_MS=30000` *(default; lower for faster delivery, raise to stay further under Resend's rate limit)*
4. Create. First build takes ~4 min. Logs should show `tick: 0 processed`
   every 30 seconds; that's a healthy idle state.

### 6d. Sandbox runner (optional — only if you turn on code-exec features)

Ephemeral, resource-capped executor for student-uploaded code (Python /
JS for now). Process-level controls (RLIMIT_AS, RLIMIT_CPU, byte-capped
stdout/stderr, wall-clock timeout) live in the service; **runtime-level**
isolation (network namespace, syscall allowlist, read-only root FS) is
owned by the container runtime. On Render's default runc, you get a
container — adequate for trusted-tester demos, **not adequate for public
exposure**. See `docs/adr/0003-sandbox-runtime.md` for the gVisor /
Firecracker upgrade path.

1. Render → **New** → **Web Service**.
2. Configure:
   - **Name**: `studyforge-sandbox-runner`
   - **Environment**: **Docker**
   - **Dockerfile Path**: `apps/sandbox-runner/Dockerfile`
   - **Docker Context Directory**: `.`
   - **Instance Type**: **Free**
3. Environment variables: none required for a dev / trusted-tester
   deployment. The service reads its caps (default 30 s wall-clock /
   256 MB RAM / 64 KiB stdout-tail) from `apps/sandbox-runner/src/config.py`.
4. Create. First build takes ~3 min.
5. Copy the live URL → API service → **Environment** → set
   `SANDBOX_RUNNER_URL` → save. (If unset, code-exec endpoints return
   `503 sandbox unavailable`, which is the safe default.)

> ⚠️ **Render free tier does NOT support `runsc` (gVisor) or any custom
> runtime.** Step 6d on free is "trusted users only, no untrusted code."
> When you outgrow that, the runbook for moving sandbox-runner to a
> gVisor-equipped host lives in ADR-0003.

---

## Step 7 — run Prisma migrations against Neon

From your laptop, with **both** URLs from Step 1 exported:

```bash
cd "/Users/kappasutra/Documents/Student Helper/apps/api"
DATABASE_URL="<paste POOLED URL with &pgbouncer=true>" \
DIRECT_URL="<paste DIRECT URL>" \
  pnpm exec prisma migrate deploy
```

Why both: `prisma migrate` opens a direct (unpooled) channel via `DIRECT_URL`. The running app uses `DATABASE_URL` through the PgBouncer pooler. Mixing them up causes either `prepared statement "s0" already exists` (under load) or `permission denied for prepared statement` (during migrate).

Expected output:
```
Applied N migrations
```

Verify by visiting Neon → SQL Editor:

```sql
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public' ORDER BY 1;
```

You should see ~30 tables including `User`, `Tenant`, `Document`, `Chunk`, `Folder`, `Session`.

---

## Step 8 — Vercel (web)

1. [vercel.com/new](https://vercel.com/new) → import `kappaborg/StudyForge`.
2. Configure:
   - **Root Directory**: `apps/web`
   - **Framework Preset**: Next.js (auto-detected)
   - Build / output settings: leave defaults — `vercel.json` overrides them.
3. **Environment Variables**:
   - `NEXT_PUBLIC_API_BASE_URL` = the API URL from Step 6a
   - `NEXT_PUBLIC_AUTH_MODE` = `production` *(hides the email/password forms — Google-only)*
4. **Deploy**. First build takes ~3 min.
5. Once live, copy the `*.vercel.app` URL.

---

## Step 9 — point CORS + WEB_BASE_URL at the live Vercel URL

1. Render → API service → **Environment**:
   - `CORS_ORIGIN` = `https://<your-vercel-url>` (no trailing slash)
   - `WEB_BASE_URL` = same
2. Save → service restarts.

---

## Step 10 — smoke test the production deploy

1. Open `https://<your-vercel-url>` in an incognito window.
2. Click **Sign in** → **Continue with Google**.
3. After OAuth, you should land on `/dashboard` with the demo "Intro to Photosynthesis" pack visible:
   - One document in **Recently uploaded**
   - One flashcard deck under Materials → Flashcards
   - One quiz under Materials → Quizzes
4. Click **Review** → grade a card. Should round-trip without error.
5. Cmd-K → search `photo`. Should match the demo doc/chunks via the Postgres fallback.
6. Open **Settings** → change the language to (say) Türkçe. The nav and
   dashboard re-render in the new locale; the choice persists across
   reloads (it lives in a `NEXT_LOCALE` cookie, not localStorage).

If anything 5xx's, check:
- Render API service logs (most production errors land here)
- Vercel deployment logs (build issues)
- Neon → Monitoring (connection pool exhaustion is the most common pain point on free tier — bump pool size if you see "Too many clients" errors)

---

## Common gotchas

**Render free tier sleeps after 15 minutes of inactivity.** First request after sleep takes ~30 s (cold start). Tell testers this is expected; subsequent requests are fast.

**Neon idles after 5 minutes by default** (free tier). Same 1–2 s wake delay on the first query. Toggle "Auto-suspend" off in Neon settings if you want it always warm (still free).

**fastembed downloads a ~133 MB ONNX model on first ingest.** The worker will spend ~30 s on the first upload while it downloads bge-small. Subsequent uploads are fast.

**Google OAuth "Test users" cap is 100 emails.** If you have more testers than that, you'll need to publish the OAuth app — which requires a verified domain. Until then, add each tester's Gmail to the OAuth consent screen → Test users list.

**Audio uploads will fail by design** with the message *"Audio transcription is disabled on the public demo"*. This is correct. Re-enable by dropping `DISABLE_AUDIO=1` from the worker env, but the worker will OOM on Render free.

**Render free Background Workers** (used for notification-worker in Step 6c) **do not sleep** the way Web Services do, but they share a 750 hr/month budget across all free services on the account. Two free Web Services + a free Background Worker fits; four free services on the same account will start hitting the cap before the month ends.

---

## Updating after the first deploy

Each `git push origin main` triggers:
- Vercel rebuild of the web app
- Render rebuilds of both API and worker

Database schema changes:

```bash
cd apps/api
DATABASE_URL="<pooled URL with &pgbouncer=true>" \
DIRECT_URL="<direct URL>" \
  pnpm exec prisma migrate deploy
```

Run this whenever a new migration is added before the new code goes live.
