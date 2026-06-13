#!/usr/bin/env node
// Verifies every locale bundle under ``apps/web/messages/`` has the
// same key shape as ``en.json``. Catches the bug class that bit us
// twice (footer ``c925c75`` + settings ``fbb1411``): a multi-bundle
// Edit silently fails on one locale, and the consumer ships calling
// a key that resolves to a fallback string. Now CI fails loudly with
// a per-locale "missing"/"extra" report before the bundle merges.

import { readFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const MESSAGES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'messages');
const SOURCE_LOCALE = 'en';

function flatten(obj, prefix = '') {
  const out = new Map();
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      for (const [k, v] of flatten(value, path)) out.set(k, v);
    } else {
      out.set(path, typeof value);
    }
  }
  return out;
}

async function loadBundle(locale) {
  const raw = await readFile(join(MESSAGES_DIR, `${locale}.json`), 'utf8');
  return JSON.parse(raw);
}

const sourceBundle = await loadBundle(SOURCE_LOCALE);
const sourceKeys = flatten(sourceBundle);

const allFiles = await readdir(MESSAGES_DIR);
const locales = allFiles
  .filter((f) => f.endsWith('.json'))
  .map((f) => f.replace(/\.json$/, ''))
  .filter((l) => l !== SOURCE_LOCALE)
  .sort();

let mismatched = 0;
for (const locale of locales) {
  const bundle = await loadBundle(locale);
  const keys = flatten(bundle);

  const missing = [...sourceKeys.keys()].filter((k) => !keys.has(k));
  const extra = [...keys.keys()].filter((k) => !sourceKeys.has(k));
  const typeMismatch = [...sourceKeys.entries()]
    .filter(([k, t]) => keys.has(k) && keys.get(k) !== t)
    .map(([k, t]) => `${k} (en: ${t}, ${locale}: ${keys.get(k)})`);

  if (missing.length || extra.length || typeMismatch.length) {
    mismatched += 1;
    console.error(`\n${locale}.json out of parity with ${SOURCE_LOCALE}.json:`);
    if (missing.length) {
      console.error(`  missing ${missing.length} key(s):`);
      for (const k of missing) console.error(`    - ${k}`);
    }
    if (extra.length) {
      console.error(`  extra ${extra.length} key(s) not in ${SOURCE_LOCALE}:`);
      for (const k of extra) console.error(`    + ${k}`);
    }
    if (typeMismatch.length) {
      console.error(`  type mismatch on ${typeMismatch.length} key(s):`);
      for (const m of typeMismatch) console.error(`    ! ${m}`);
    }
  }
}

if (mismatched > 0) {
  console.error(
    `\n${mismatched} of ${locales.length} non-source bundle(s) drifted from ${SOURCE_LOCALE}.json.`,
  );
  console.error(
    'Add the missing keys (or remove the extras) so every locale resolves the same set.',
  );
  process.exit(1);
}

console.log(
  `i18n parity OK · ${SOURCE_LOCALE} + ${locales.length} locale(s) · ${sourceKeys.size} keys each`,
);
