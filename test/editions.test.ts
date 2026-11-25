import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// @ts-expect-error - plain .mjs script without type declarations
import { toEditionManifest } from '../scripts/make-edition-manifest.mjs';

const manifest = readFileSync('manifest.yml', 'utf8');
const dash = JSON.parse(readFileSync('editions/dash-internal.json', 'utf8').replace(/^﻿/, ''));

describe('Dash internal edition manifest', () => {
  const out: string = toEditionManifest(manifest, dash);

  it('uses its own app id and titles', () => {
    expect(out).toContain(`id: ${dash.appId}`);
    expect(out).not.toMatch(/app\/a0d4fe36-6fe6-4769-bb22-bf862feb520a/);
    expect(out.match(/title: ScopeGuard \(Dash\)$/gm)).toHaveLength(manifest.match(/title: ScopeGuard$/gm)!.length);
  });

  it('changes nothing else (modules, scopes, resources stay identical)', () => {
    const strip = (s: string) =>
      s
        .split('\n')
        .filter((l) => !/^\s+(title|id):/.test(l))
        .join('\n');
    expect(strip(out)).toBe(strip(manifest));
  });

  it('is a different app from the Marketplace edition', () => {
    expect(manifest).not.toContain(dash.appId);
  });

  it('rejects an edition without a registered app id', () => {
    expect(() => toEditionManifest(manifest, { title: 'X', appId: '' })).toThrow(/appId/);
  });
});
