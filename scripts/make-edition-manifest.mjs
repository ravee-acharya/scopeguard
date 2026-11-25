// Turns the Marketplace manifest.yml into the manifest of another edition (e.g. the
// Dash-internal clone), so modules, scopes and resources can never drift between apps.
// Only the app id and the module titles differ.
//
//   node scripts/make-edition-manifest.mjs editions/dash-internal.json [outFile]
//   (default outFile: overwrite ./manifest.yml, which is what CI does on a throwaway checkout)
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_ID_RE = /^ari:cloud:ecosystem::app\/[0-9a-f-]{36}$/;
const BASE_TITLE = 'ScopeGuard';

/** Pure transform, exported for tests. Throws if the manifest does not look as expected. */
export function toEditionManifest(manifest, edition) {
  if (!APP_ID_RE.test(edition.appId ?? '')) throw new Error('Edition has no valid appId. Register it with `forge register` first.');
  if (!edition.title || /[\r\n:]/.test(edition.title)) throw new Error('Edition needs a one-line title without colons.');

  const titleRe = new RegExp(`^([ \\t]+title:[ \\t]*)${BASE_TITLE}[ \\t]*$`, 'gm');
  const titleCount = (manifest.match(titleRe) ?? []).length;
  if (titleCount === 0) throw new Error(`No "title: ${BASE_TITLE}" lines found in manifest.yml.`);

  const out = manifest
    .replace(titleRe, `$1${edition.title}`)
    .replace(/^([ \t]+id:[ \t]*)ari:cloud:ecosystem::app\/[0-9a-f-]+[ \t]*$/m, `$1${edition.appId}`);

  if (!out.includes(`id: ${edition.appId}`)) throw new Error('Could not replace the app id in manifest.yml.');
  return out;
}

// CLI
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [editionFile, outFile] = process.argv.slice(2);
  if (!editionFile) {
    console.error('Usage: node scripts/make-edition-manifest.mjs <edition.json> [outFile]');
    process.exit(2);
  }
  // Strip a byte-order mark: some Windows editors add one and JSON.parse rejects it.
  const read = (p) => readFileSync(p, 'utf8').replace(/^﻿/, '');
  const edition = JSON.parse(read(editionFile));
  try {
    writeFileSync(outFile ?? 'manifest.yml', toEditionManifest(read('manifest.yml'), edition));
    console.log(`manifest.yml written for ${edition.title} (${edition.appId}).`);
  } catch (err) {
    console.error(String(err.message ?? err));
    process.exit(1);
  }
}
