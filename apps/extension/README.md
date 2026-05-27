# StudyForge browser extension

One-click "save this page / selection / linked PDF to my StudyForge folder."
Built for Chrome / Edge / Chromium (Manifest V3). No separate sign-in — the
extension piggybacks on the StudyForge web app's session cookie, so being
signed in at `localhost:3000` (or your deployment) is the only prerequisite.

## Build

```bash
cd apps/extension
pnpm install
pnpm build
```

This produces `dist/` with the manifest, popup, and background bundle. For
production, point the build at your deployed API/web URLs:

```bash
STUDYFORGE_API_URL=https://api.studyforge.ai \
STUDYFORGE_WEB_URL=https://studyforge.ai \
pnpm build
```

For active development, `pnpm watch` re-bundles on file change.

## Load in Chrome

1. Run `pnpm build` in this directory.
2. Open `chrome://extensions` and toggle **Developer mode** (top-right).
3. Click **Load unpacked** and select `apps/extension/dist/`.
4. The extension shows up in the toolbar. Click it to open the popup.
5. If it says "Not signed in," open the StudyForge web app, sign in, then
   re-open the popup. The cookie travels.

## What it does

**Toolbar popup**
- Probes `/v1/auth/me` to confirm sign-in.
- Loads your folders from `/v1/folders`.
- Captures the active tab's readable text (or current selection, if any)
  via a one-shot `chrome.scripting.executeScript` call.
- POSTs `/v1/uploads/text` with `{ title, text, folderId, sourceUrl }`.
- Caches the last-used folder id in `chrome.storage.local` so it
  pre-selects on the next open.

**Right-click context menus**
- **On a text selection** → "Send selection to StudyForge".
- **On a link** → "Send link as material". Fetches the linked URL from
  the service-worker context, strips HTML, sends as text. Binary content
  (PDFs, DOCX) opens in a new tab instead — click the toolbar icon to
  capture it via the popup.

## Why no Chrome Web Store yet?

Store distribution is a publish-time concern. v1 ships as an unpacked
dev load — that's enough to validate the flow with real users and
classmates without committing to a store review cycle. Icons live as a
TODO; the manifest currently relies on Chrome's default puzzle-piece
glyph in the toolbar.

## Permissions explained

- `activeTab` + `scripting`: required to extract the current tab's text
  on demand. Only fires when the user explicitly clicks the popup or a
  context-menu item — never passively.
- `contextMenus`: registers the two right-click items.
- `storage`: caches the last-used folder id.
- `cookies`: not strictly required (we use `credentials: 'include'`),
  but included so future enhancements (e.g. revoking the session from
  the extension menu) work without re-asking.
- `host_permissions`: limited to the StudyForge API/web hosts the build
  was configured with. No wildcard.
