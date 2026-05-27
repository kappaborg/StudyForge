import { ApiError, WEB_URL, fetchFolders, fetchMe, sendText, type FolderRow } from './api';
import { extractPageContent } from './extract';

/**
 * Popup boot:
 *  1. Probe /v1/auth/me. If unauthenticated, show the sign-in CTA.
 *  2. Load folders. Cache the last-used folder id in chrome.storage.local
 *     so re-opening the popup defaults to it.
 *  3. Show current tab title + url.
 *  4. On "Send", run ``extractPageContent`` in the active tab and POST
 *     the result to /v1/uploads/text.
 *
 * Errors surface inline. Cross-origin login flow (the user has to be
 * signed in on the StudyForge web app for the sf_session cookie to
 * exist) is handled by the signed-out state with a deep link.
 */

const LAST_FOLDER_KEY = 'sf:lastFolderId';

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el as T;
};

function show(id: string) { $(id).classList.remove('hidden'); }
function hide(id: string) { $(id).classList.add('hidden'); }

function setStatus(msg: string) { ($('status') as HTMLParagraphElement).textContent = msg; }

async function getActiveTab(): Promise<chrome.tabs.Tab | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab ?? null;
}

async function loadLastFolderId(): Promise<string | null> {
  const result = await chrome.storage.local.get(LAST_FOLDER_KEY);
  return (result[LAST_FOLDER_KEY] as string | undefined) ?? null;
}

async function saveLastFolderId(id: string): Promise<void> {
  await chrome.storage.local.set({ [LAST_FOLDER_KEY]: id });
}

function paintFolders(folders: FolderRow[], preferredId: string | null) {
  const select = $('folder') as HTMLSelectElement;
  select.innerHTML = '';
  // Inbox first, then materials folders alphabetical, then Trash last.
  const order = (f: FolderRow) =>
    f.kind === 'inbox' ? 0 : f.kind === 'materials' ? 1 : 2;
  folders
    .slice()
    .filter((f) => f.kind !== 'trash')
    .sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name))
    .forEach((f) => {
      const opt = document.createElement('option');
      opt.value = f.id;
      opt.textContent = f.name;
      select.append(opt);
    });
  if (preferredId && folders.some((f) => f.id === preferredId)) {
    select.value = preferredId;
  }
}

async function send() {
  hide('error');
  hide('result');
  const btn = $('send') as HTMLButtonElement;
  btn.disabled = true;
  const originalLabel = btn.textContent;
  btn.textContent = 'Capturing…';

  try {
    const tab = await getActiveTab();
    if (!tab?.id || !tab.url) throw new Error('No active tab.');
    if (!/^https?:/i.test(tab.url)) {
      throw new Error('Only http(s) pages can be sent.');
    }

    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractPageContent,
    });
    const page = result?.result;
    if (!page || !page.text || page.text.trim().length < 20) {
      throw new Error('Page has no readable text content.');
    }

    btn.textContent = 'Sending…';
    const folderId = ($('folder') as HTMLSelectElement).value || null;
    const title = (page.selection ? `Selection · ${page.title}` : page.title).slice(0, 400);
    const textToSend = page.selection ?? page.text;

    const res = await sendText({
      title,
      text: textToSend,
      folderId,
      sourceUrl: page.url,
    });

    if (folderId) await saveLastFolderId(folderId);

    ($('result-msg') as HTMLParagraphElement).textContent =
      `Saved "${res.title}" · ${res.chunkCount} chunk${res.chunkCount === 1 ? '' : 's'}.`;
    const link = $('open-doc') as HTMLAnchorElement;
    link.href = `${WEB_URL}/folders/${folderId ?? ''}`;
    show('result');
    hide('form');
  } catch (err) {
    const msg =
      err instanceof ApiError ? err.message :
      err instanceof Error ? err.message : 'Send failed';
    ($('error-msg') as HTMLParagraphElement).textContent = msg;
    show('error');
  } finally {
    btn.disabled = false;
    btn.textContent = originalLabel ?? 'Send to StudyForge';
  }
}

async function boot() {
  try {
    const me = await fetchMe();
    if (!me) {
      setStatus('Not signed in');
      ($('signin-link') as HTMLAnchorElement).href = `${WEB_URL}/login?next=/dashboard`;
      show('signed-out');
      return;
    }

    setStatus(`Signed in as ${me.email}`);
    const [folders, lastId, tab] = await Promise.all([
      fetchFolders(),
      loadLastFolderId(),
      getActiveTab(),
    ]);

    paintFolders(folders, lastId);
    if (tab) {
      ($('page-title') as HTMLParagraphElement).textContent = tab.title ?? '(untitled)';
      ($('page-url') as HTMLParagraphElement).textContent = tab.url ?? '';
      show('page-meta');
    }
    show('form');
    $('send').addEventListener('click', () => { void send(); });
  } catch (err) {
    setStatus('Something went wrong.');
    ($('error-msg') as HTMLParagraphElement).textContent =
      err instanceof Error ? err.message : 'Boot failed';
    show('error');
  }
}

void boot();
