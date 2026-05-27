// Single-pass esbuild for the extension bundles.
//
// MV3 has three execution contexts and each one has its own bundle:
//   background.ts → service worker (event-driven, no DOM)
//   popup.ts      → toolbar popup (DOM, but no chrome.scripting from here)
//   content.ts    → injected into pages on demand (DOM, no chrome.* API)
//
// We also copy ``static/`` (manifest.json, popup.html, icons) into dist so
// the unpacked-load path is just ``chrome://extensions → load dist``.

import { build, context } from 'esbuild';
import { cpSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = __dirname;
const out = resolve(root, 'dist');
const watch = process.argv.includes('--watch');

if (existsSync(out)) rmSync(out, { recursive: true });
mkdirSync(out, { recursive: true });

cpSync(resolve(root, 'static'), out, { recursive: true });

const opts = {
  entryPoints: {
    background: resolve(root, 'src/background.ts'),
    popup: resolve(root, 'src/popup.ts'),
  },
  bundle: true,
  format: 'esm',
  target: 'chrome120',
  outdir: out,
  platform: 'browser',
  minify: !watch,
  sourcemap: watch ? 'inline' : false,
  // Default API base for development. Override at build time:
  //   STUDYFORGE_API_URL=https://api.studyforge.ai npm run build
  define: {
    'process.env.STUDYFORGE_API_URL': JSON.stringify(
      process.env.STUDYFORGE_API_URL ?? 'http://localhost:3001',
    ),
    'process.env.STUDYFORGE_WEB_URL': JSON.stringify(
      process.env.STUDYFORGE_WEB_URL ?? 'http://localhost:3000',
    ),
  },
};

if (watch) {
  const ctx = await context(opts);
  await ctx.watch();
  console.log('extension build: watching for changes…');
} else {
  await build(opts);
  console.log('extension built →', out);
}
