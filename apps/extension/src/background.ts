import { sendText } from './api';
import { extractPageContent } from './extract';

/**
 * Service worker:
 *  • Registers two context-menu items on install.
 *  • Handles their click events by either capturing the current selection
 *    (when the user right-clicks on highlighted text) or fetching the
 *    linked URL's content (right-click on a link).
 *
 * Status feedback for context-menu actions is delivered as a Chrome
 * notification — the popup isn't open when the user triggers these.
 *
 * For "send link", we naively ``fetch`` the URL from the service worker
 * context. That works for HTML and PDFs hosted with permissive CORS,
 * which covers most academic-style content. For sites that block it,
 * we fall back to opening the link in a new tab — the user can then
 * click the toolbar button to send THAT tab.
 */

const MENU_SELECTION = 'sf-send-selection';
const MENU_LINK = 'sf-send-link';

chrome.runtime.onInstalled.addListener(() => {
  // ``contexts: ['selection']`` only shows the item when there's a real
  // text selection — Chrome handles the visibility for us.
  chrome.contextMenus.create({
    id: MENU_SELECTION,
    title: 'Send selection to StudyForge',
    contexts: ['selection'],
  });
  chrome.contextMenus.create({
    id: MENU_LINK,
    title: 'Send link as material',
    contexts: ['link'],
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === MENU_SELECTION) {
    void handleSelection(info, tab);
  } else if (info.menuItemId === MENU_LINK) {
    void handleLink(info);
  }
});

async function handleSelection(
  info: chrome.contextMenus.OnClickData,
  tab: chrome.tabs.Tab | undefined,
): Promise<void> {
  if (!tab?.id) return notify('No active tab.', 'error');
  // selectionText is provided directly by Chrome; if it's missing we
  // re-extract from the page to be safe.
  let text = (info.selectionText ?? '').trim();
  let pageTitle = tab.title ?? 'Selection';
  let pageUrl = info.pageUrl ?? tab.url ?? '';
  if (text.length < 20) {
    try {
      const [out] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: extractPageContent,
      });
      const page = out?.result;
      if (page) {
        text = page.selection ?? '';
        pageTitle = page.title;
        pageUrl = page.url;
      }
    } catch {
      /* ignore — error below */
    }
  }
  if (!text || text.length < 5) {
    return notify('No selection captured.', 'error');
  }
  await postAndNotify({
    title: `Selection · ${pageTitle}`.slice(0, 400),
    text,
    sourceUrl: pageUrl,
  });
}

async function handleLink(info: chrome.contextMenus.OnClickData): Promise<void> {
  const url = info.linkUrl;
  if (!url || !/^https?:/i.test(url)) {
    return notify('Only http(s) links can be sent.', 'error');
  }
  try {
    const res = await fetch(url, { credentials: 'omit' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const contentType = res.headers.get('content-type') ?? '';
    let text = '';
    let title = new URL(url).pathname.split('/').pop() || url;

    if (contentType.includes('text/html')) {
      const html = await res.text();
      // Cheap HTML → text — no DOMParser inside a service worker, so
      // strip tags with a regex. Good enough for "save this article".
      const stripped = html
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
      if (titleMatch?.[1]) title = titleMatch[1].trim();
      text = stripped;
    } else if (contentType.includes('text/')) {
      text = await res.text();
    } else {
      // Binary content (PDF / DOCX). Service worker can't process those
      // — open the link in a tab so the user can use the toolbar action.
      const tab = await chrome.tabs.create({ url, active: false });
      void tab;
      return notify(
        'Opened the link in a tab. Click the StudyForge icon to capture it.',
        'info',
      );
    }
    if (!text || text.length < 20) {
      return notify('Linked page had no readable text.', 'error');
    }
    await postAndNotify({ title: title.slice(0, 400), text, sourceUrl: url });
  } catch (err) {
    notify(
      err instanceof Error ? `Fetch failed: ${err.message}` : 'Fetch failed',
      'error',
    );
  }
}

async function postAndNotify(payload: {
  title: string;
  text: string;
  sourceUrl: string;
}): Promise<void> {
  try {
    const last = await chrome.storage.local.get('sf:lastFolderId');
    const folderId = (last['sf:lastFolderId'] as string | undefined) ?? null;
    const res = await sendText({
      title: payload.title,
      text: payload.text,
      folderId,
      sourceUrl: payload.sourceUrl,
    });
    notify(`Saved "${res.title}" · ${res.chunkCount} chunks.`, 'success');
  } catch (err) {
    notify(
      err instanceof Error ? `Send failed: ${err.message}` : 'Send failed',
      'error',
    );
  }
}

function notify(message: string, kind: 'success' | 'error' | 'info'): void {
  // chrome.notifications requires the "notifications" permission, which we
  // intentionally don't request to keep the install prompt minimal. Fall
  // back to a console log; the popup surfaces the same errors when the
  // user opens it.
  // eslint-disable-next-line no-console
  console.log(`[StudyForge ext] ${kind}: ${message}`);
}
