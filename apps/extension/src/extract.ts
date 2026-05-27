/**
 * Page-content extractor. Must be self-contained — ``chrome.scripting
 * .executeScript({ func })`` serializes the function and runs it inside
 * the target page's context, so it can't reference any imports, module
 * scope, or closures. Everything it needs has to be inline.
 *
 * Both popup.ts and background.ts call this via:
 *
 *   chrome.scripting.executeScript({
 *     target: { tabId },
 *     func: extractPageContent,
 *   })
 *
 * The result lands as ``results[0].result``.
 */

export function extractPageContent(): {
  title: string;
  url: string;
  text: string;
  selection: string | null;
} {
  const selection = (window.getSelection?.()?.toString() ?? '').trim() || null;

  const clone = document.cloneNode(true) as Document;
  const noisy = clone.querySelectorAll(
    'script, style, noscript, iframe, svg, ' +
      'nav, header, footer, aside, ' +
      '[role="navigation"], [role="banner"], [role="contentinfo"], ' +
      '[aria-hidden="true"]',
  );
  for (const el of Array.from(noisy)) el.remove();

  const root =
    clone.querySelector('article') ??
    clone.querySelector('main') ??
    clone.body;

  const raw = (root?.textContent ?? '').replace(/[ \t]+/g, ' ');
  const lines = raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  return {
    title: (document.title || window.location.hostname).slice(0, 400),
    url: window.location.href,
    text: lines.join('\n\n'),
    selection,
  };
}
