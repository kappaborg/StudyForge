# Telemetry catalogue

Every event the StudyForge web app fires through `track()` (in `apps/web/lib/analytics.ts`). Adding a new event without a real "what dashboard or question does this feed" answer is a mistake we don't want to make twice — the catalogue stays small and intentional.

PostHog is the destination today; the typed wrapper in `analytics.ts` makes the destination swappable.

## Naming convention

- `noun.past_verb` — `upload.completed`, `srs.reviewed`, `scope.forked`.
- snake-case nouns, lowercase, dotted.
- Past tense for events that already happened (everything `track()` is called for).

## Property hygiene

- **Never log free-form user text** — no query strings, document content, chat messages.
- Counts and durations are numbers, not strings.
- IDs are always UUIDs. Never log filenames, URLs, or paths that could carry course or org names.
- Boolean flags for branches (`multipart: true | false`) instead of stringly-typed states.

## Events

### Funnel

| Event | Props | Fires from | What it answers |
|---|---|---|---|
| `signup.completed` | `userId` | `app/signup/page.tsx` | Daily new accounts, signup→activation funnel |

### Materials

| Event | Props | Fires from | What it answers |
|---|---|---|---|
| `upload.started` | `mime`, `sizeBytes`, `multipart` | `upload-drop-zone.tsx` | Distribution of file types/sizes; multipart adoption |
| `upload.completed` | `documentId`, `chunkCount`, `durationMs`, `multipart` | same | p50/p95 upload latency; chunk-per-doc stats |
| `youtube.ingested` | `documentId`, `chunkCount` | `youtube-ingest-modal.tsx` | How many students ingest video transcripts |
| `text.ingested` | `documentId`, `chunkCount`, `source` | (reserved for browser-extension wiring) | Extension adoption |
| `multipart.part_failed` | `partNumber`, `partCount`, `sizeBytes` | `upload-drop-zone.tsx` | Reliability of the new multipart path; CORS misconfig signals |

### Active learning

| Event | Props | Fires from | What it answers |
|---|---|---|---|
| `tutor.asked` | `courseId`, `retrievedChunks`, `refusal` | `tutor-ask.tsx` | Tutor usage; refusal rate (retrieval health) |
| `srs.reviewed` | `flashcardId`, `quality`, `intervalDays` | `review-session.tsx` | Retention curve; quality distribution |
| `flashcards.generated` | `courseId`, `deckSize`, `deckId` | `flashcards-panel.tsx` | Generation usage |
| `quizzes.generated` | `courseId`, `itemCount`, `quizId` | `quizzes-panel.tsx` | Generation usage |
| `quizzes.submitted` | `quizId`, `score`, `items` | same | Mean score; quiz-completion rate |
| `roadmap.generated` | `courseId`, `weeks`, `roadmapId` | `roadmap-panel.tsx` | Roadmap adoption |
| `concepts.extracted` | `courseId`, `conceptCount`, `edgeCount` | `knowledge-graph.tsx` | Concept-map adoption |
| `diagram.generated` | `courseId`, `kind` | `diagrams-panel.tsx` | Diagram-kind distribution |

### Scopes & sharing

| Event | Props | Fires from | What it answers |
|---|---|---|---|
| `scope.created` | `scopeId`, `entryCount`, `hasExamDate` | `exam-scope-modal.tsx` | Scope-prep adoption; how often students set exam dates |
| `scope.forked` | `scopeId` | `accept-scope-view.tsx` | Virality of share links |
| `folder.published` | `folderId` | `publish-folder-panel.tsx` | Instructor-share adoption |
| `folder.subscribed` | `sharedFolderId` | `subscriptions-panel.tsx` | Acceptor side of the same |

### Misc

| Event | Props | Fires from | What it answers |
|---|---|---|---|
| `search.queried` | `hits` | `command-palette.tsx` | Search usage. **Does not log the query string.** |

## What we deliberately don't track

- **`flashcards.flipped`** — retired. Card-flip events are too noisy and `srs.reviewed` carries the same signal with intent attached.
- **Tutor question content** — privacy-load-bearing. `tutor.asked` carries shape (chunk count, refusal) but no message body.
- **Document content** — same as above. `upload.completed` is shape only.
- **Page views** — PostHog autocapture is off; we rely on `capture_pageview: true` in `posthog.init` for the default page event. Avoids ad-hoc per-page `track()` calls.
- **Hover / focus / scroll** — never. Action events only.

## Adding a new event

1. Add the name to `EventName` and the props shape to `EventPropsMap` in `apps/web/lib/analytics.ts`.
2. Document the entry in the table above — name, props, fires-from, and what dashboard or question it feeds.
3. Wire `track('your.event', {...})` at the call site.
4. If the answer in column 4 is "I dunno, it might be useful," delete the event.
