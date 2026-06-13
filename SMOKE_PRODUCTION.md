# Production smoke checklist

10 manual steps that cover every critical path end-to-end. Run before
spending money on App Store + Play Console accounts. Total time ~5 min
once Render dynos are warm (first run adds ~30s for the cold start).

Live URLs:

- Web: <https://study-forge-web.vercel.app>
- API: <https://studyforge-y340.onrender.com> (proxied through Vercel; you
  shouldn't need to hit it directly)

## One-command pre-flight (every URL responds, no auth needed)

```bash
for ep in / /login /dashboard /manifest.webmanifest; do
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 30 "https://study-forge-web.vercel.app$ep")
  echo "  $ep → $code"
done
curl -s --max-time 30 "https://study-forge-web.vercel.app/health"
```

Expected: every web route → 200, `/manifest.webmanifest` → 200, the
health body returns `{"status":"ok","service":"api",...}`.

If any line errors, stop and investigate before doing the manual smoke
below.

## Manual smoke — 10 steps

Open <https://study-forge-web.vercel.app> in an **incognito window**
(important — defeats any cached session that might mask a regression).

1. **Landing page renders.** Hero text, "Sign in with Google" CTA. No
   console errors in DevTools.

2. **Google sign-in.** Click the CTA → Google consent screen → land on
   `/dashboard`. The first sign-in shows the seeded "Intro to
   Photosynthesis" demo pack.

3. **Demo doc visible.** Under **Recently uploaded** you see the
   demo PDF row. Under **Materials → Flashcards** the demo deck. Under
   **Materials → Quizzes** the demo quiz.

4. **Tutor stream works.** Click the demo doc → opens the workspace.
   Click **Tutor** in the left rail → ask `what does photosynthesis
   produce?` → answer streams in within ~3s (warm) or ~30s (cold AI
   worker). Answer contains a citation chip you can click.

5. **Citation source preview.** Click any citation chip → right-side
   slide-over opens showing the source chunk + page number. Close it.

6. **Flashcard grade round-trip.** Click **Review** in the top nav →
   grade one card (1 = Again, 4 = Easy). The next card appears within
   ~200ms. No errors.

7. **Quiz attempt.** Click **Materials → Quizzes → demo quiz**. Answer
   2-3 questions, hit Submit. You see your score, the per-question
   review, and the mastery delta appears on the **Mastery** tab.

8. **Cmd-K command palette.** Press Cmd-K (Ctrl-K on Windows). Type
   `photo` → see the demo doc + chunks in results. Hit Enter on a chunk
   → opens that chunk in the right-side preview.

9. **Locale switch persists.** **Settings → Language → Türkçe**. The
   nav re-renders: Panel / Tekrar / Yetkinlik / Eğitmen / Ayarlar.
   Hard-refresh the page (Cmd-R) → locale persists (it's in the
   `NEXT_LOCALE` cookie, not localStorage).

10. **Offline mode.** Turn off Wi-Fi. Reload the dashboard. You see an
    amber "Viewing cached data" banner instead of an error. Pages
    still render from the IndexedDB cache. Reconnect → banner clears
    on next refresh.

## What can't be smoke-tested without paid accounts

- **iOS app on a real iPhone via TestFlight** — needs $99 Apple
  Developer account. You CAN run the Capacitor build on the iOS
  Simulator on a Mac for free; see `apps/mobile/MOBILE.md`.
- **Android app on a real device via Play internal testing** — needs
  $25 Google Play account. You CAN run on the Android emulator on any
  machine with Android Studio for free.
- **iOS personal-sideload to your own phone** — actually free for 7
  days at a time with a free Apple ID (Xcode → "Personal Team"
  signing). Lets you verify the wrapped app feels right on a real
  iPhone before committing $99.

## When something breaks

| Symptom | First place to look |
|---|---|
| Page renders blank / hydration error | Browser DevTools console + Vercel deploy logs |
| API request 5xx | Render API service logs (most app errors land here) |
| Tutor stream hangs | AI worker logs on Render (first request after idle takes 30s) |
| OAuth redirect-URI mismatch | Google Cloud Console → OAuth client → Authorized redirect URIs |
| Pages slow but eventually load | Neon Monitoring → connection pool exhaustion is the usual cause |
| "Cap reached" on first message | The daily AI request cap is per-tenant; add a BYOK key in Settings |

## Re-running this checklist

The 10 steps above haven't drifted significantly since Phase A —
they're the contract for "the app works." If a step starts failing
after a deploy, that's the signal to git-bisect the deploy commits.

The pre-flight probe is safe to script into a cron / uptime monitor
(e.g. UptimeRobot, free tier) so you find out the API is down before
your testers do.
