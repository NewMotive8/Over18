import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MARIA_PORTRAIT_URL, SEED_CHARACTERS, SEED_VISUAL_ASSETS } from '../db/seed-data.js';
import { resolveMediaFile } from '../services/message-media-service.js';
import type { CharacterVisualAssetRow } from '../db/schema.js';

/**
 * P0.9 -- the legacy storage audit, pinned.
 *
 * `docs/legacy-storage-audit.md` is the map. These tests hold the two findings
 * that code can protect:
 *
 *   1. The bundled demo media left in the repository is exactly the set with a
 *      PROVEN consumer. Anything that loses its consumer shows up here rather
 *      than sitting in the web bundle for another year; anything still needed
 *      cannot be deleted quietly.
 *   2. `characters.profile_image` is legacy and still read, but has no writer
 *      other than the seed -- which is what makes the file removals safe and
 *      what a future column removal (P0.2) has to preserve.
 */

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url));
const BUNDLED_MEDIA = join(REPO_ROOT, 'apps', 'web', 'public', 'media');
const API_SRC = fileURLToPath(new URL('..', import.meta.url));

/** Every file still shipped in the bundled tree, as `character/file`. */
function bundledFiles(): string[] {
  if (!existsSync(BUNDLED_MEDIA)) return [];
  const out: string[] = [];
  for (const dir of readdirSync(BUNDLED_MEDIA)) {
    const full = join(BUNDLED_MEDIA, dir);
    if (!statSync(full).isDirectory()) continue;
    for (const file of readdirSync(full)) out.push(`${dir}/${file}`);
  }
  return out.sort();
}

describe('the bundled demo media tree holds only what is still consumed', () => {
  /**
   * Each retained file, with the consumer that keeps it. Removing a consumer
   * without removing the file (or the reverse) fails here.
   */
  const RETAINED: Record<string, string> = {
    'maria/portrait.png': 'seed: Maria profile_image and her canonical reference storage_key',
    'luna/profile-04.jpg': 'mock provider image fixture default (services/media-providers.ts)',
    'luna/profile-04.mp4': 'mock provider video fixture default (services/media-providers.ts)',
    'ember/hero.jpg': 'media-pipeline QA fixture: a real first-frame poster',
    'ember/hero.mp4': 'media-pipeline QA fixture: a real portrait H.264 clip',
  };

  it('contains exactly the retained set', () => {
    expect(bundledFiles()).toEqual(Object.keys(RETAINED).sort());
  });

  it('every retained file is actually on disk where its consumer looks', () => {
    for (const file of Object.keys(RETAINED)) {
      expect({ file, present: existsSync(join(BUNDLED_MEDIA, ...file.split('/'))) }).toEqual({
        file,
        present: true,
      });
    }
  });

  it('the seed still points at the portrait it ships', () => {
    const maria = SEED_CHARACTERS.find((c) => c.name === 'maria')!;
    expect(maria.profileImage).toBe(MARIA_PORTRAIT_URL);
    expect(MARIA_PORTRAIT_URL).toBe('/media/maria/portrait.png');
    const portrait = SEED_VISUAL_ASSETS.find((a) => a.storageKey === MARIA_PORTRAIT_URL);
    expect(portrait, 'her canonical reference uses the same file').toBeTruthy();
    expect(existsSync(join(BUNDLED_MEDIA, 'maria', 'portrait.png'))).toBe(true);
  });

  it('the mock provider fixture defaults name files that exist', () => {
    const source = readFileSync(join(API_SRC, 'services', 'media-providers.ts'), 'utf8');
    const defaults = [...source.matchAll(/'(apps\/web\/public\/media\/[^']+)'/g)].map((m) => m[1]!);
    expect(defaults.length).toBeGreaterThan(0);
    for (const rel of defaults) {
      expect({ rel, present: existsSync(join(REPO_ROOT, rel)) }).toEqual({ rel, present: true });
    }
  });

  it('no source outside the fixtures and the seed reaches into the bundled tree', () => {
    const allowed = new Set([
      'services/media-providers.ts',
      'media-pipeline/cli.ts',
      'db/seed-data.ts',
    ]);
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) {
          if (name !== 'test') walk(full);
          continue;
        }
        if (!name.endsWith('.ts')) continue;
        const rel = relative(API_SRC, full).split('\\').join('/');
        if (allowed.has(rel)) continue;
        const code = readFileSync(full, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/(^|[^:])\/\/.*$/gm, '$1');
        if (/['"`]\/media\/[a-z]+\//i.test(code) || /public\/media/.test(code)) offenders.push(rel);
      }
    };
    walk(API_SRC);
    expect(offenders).toEqual([]);
  });
});

describe('characters.profile_image is legacy: written only by the seed, read in one place', () => {
  it('no route or service writes it', () => {
    const writers: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) {
          if (name !== 'test') walk(full);
          continue;
        }
        if (!name.endsWith('.ts')) continue;
        const rel = relative(API_SRC, full).split('\\').join('/');
        // The seed writes it; the schema declares it.
        if (rel === 'db/seed.ts' || rel === 'db/seed-data.ts' || rel === 'db/schema.ts') continue;
        const code = readFileSync(full, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/(^|[^:])\/\/.*$/gm, '$1');
        if (/profileImage\s*[:=]/.test(code)) writers.push(rel);
      }
    };
    walk(API_SRC);
    // P0.2 removed character-service's exemption: it no longer accepts the
    // field on create/update, so no service assigns it at all. The two
    // survivors only READ it — `character-portrait` as the deprecated fallback,
    // and the two projections that name it as an OUTPUT field whose value comes
    // from that resolver.
    expect(writers.sort()).toEqual([
      'services/character-portrait.ts',
      'services/character-service.ts',
      'services/home-composition-service.ts',
    ]);
  });

  /**
   * P0.2 — THE INVARIANT FLIPPED, so this test did too.
   *
   * It used to assert `profileImage: row.profileImage` in character-service:
   * the column reaching the public payload untouched. That line is now the
   * defect, not the contract. The payload field survives (clients are
   * unchanged) but its value is resolved from the canonical asset model, and
   * the column is reachable from exactly one module.
   */
  it('reaches the public payload only through the canonical portrait resolver', () => {
    const characterService = readFileSync(join(API_SRC, 'services', 'character-service.ts'), 'utf8');
    expect(characterService).not.toContain('profileImage: row.profileImage');
    expect(characterService).toContain('character-portrait.js');

    const portrait = readFileSync(join(API_SRC, 'services', 'character-portrait.ts'), 'utf8');
    expect(portrait).toContain('legacy-profile-image');
  });
});

describe('media resolution stays inside MEDIA_STORAGE_DIR, whichever convention a row uses', () => {
  const asset = (over: Partial<CharacterVisualAssetRow>): CharacterVisualAssetRow =>
    ({
      id: 'a1',
      characterId: 'c1',
      visualIdentityId: 'v1',
      kind: 'generated',
      origin: 'generated',
      status: 'approved',
      isCanonical: false,
      position: null,
      storageKey: null,
      provenance: {},
      contentRating: 'sfw',
      requirementKey: null,
      approvedBy: null,
      approvedAt: null,
      publishedAt: null,
      archivedAt: null,
      archivedBy: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...over,
    }) as CharacterVisualAssetRow;

  const ROOT = '/app/var/media';

  it('refuses a generated key that points outside the root', () => {
    expect(resolveMediaFile(asset({ storageKey: '/etc/passwd' }), ROOT)).toEqual({
      failure: 'outside_storage_root',
    });
  });

  it('refuses an upload whose recorded path escapes the root', () => {
    const escaping = asset({
      storageKey: '/admin/content/uploads/a1/file',
      provenance: { source: 'manual-upload', storagePath: '/tmp/elsewhere.png', mimeType: 'image/png' },
    });
    expect(resolveMediaFile(escaping, ROOT)).toEqual({ failure: 'outside_storage_root' });
  });

  /**
   * The seeded placeholders carry http URLs in `storage_key`. Nothing fetches
   * them: they fail the containment check like any other foreign path, so the
   * media route answers 404 rather than reaching a third party.
   */
  it('refuses an external URL in storage_key rather than fetching it', () => {
    const seeded = SEED_VISUAL_ASSETS.find((a) => a.storageKey?.startsWith('http'));
    expect(seeded, 'the seed still has at least one placeholder URL').toBeTruthy();
    expect(resolveMediaFile(asset({ storageKey: seeded!.storageKey! }), ROOT)).toEqual({
      failure: 'outside_storage_root',
    });
  });
});
