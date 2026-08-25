import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { eq } from 'drizzle-orm';
import { characterVisualAssets, characterVisualIdentities } from '../db/schema.js';
import { SEED_CHARACTERS } from '../db/seed-data.js';
import { seedCharacters, seedVisualIdentities } from '../db/seed.js';
import { createVisualAsset } from '../services/visual-asset-service.js';
import { getActiveVisualIdentity } from '../services/visual-identity-service.js';
import { mediaTypeOf, videoAssetCondition } from '../services/content-review-service.js';
import {
  CATEGORY_RAIL_LIMIT,
  HOME_CLIP_GRID_LIMIT,
} from '../services/home-composition-service.js';
import {
  createTestContext,
  destroyTestContext,
  extractSessionCookie,
  migrateTestDb,
  testEnv,
  truncateAll,
  type TestContext,
} from './helpers.js';

/**
 * HOME PERFORMANCE — the work Home stopped doing, pinned so it cannot come back.
 *
 * Every change this file guards was a reduction, and a reduction is exactly the
 * kind of change that regresses silently: nothing breaks when a query starts
 * fetching a thousand rows again, or when a card starts issuing its own request
 * again. The page simply gets slower. So each one is asserted here as a fact
 * about the payload or about the rows the database returns, never as a timing.
 *
 * WHAT IS PROVEN:
 *
 *  1. The apparent-age band travels IN the Home payload, and it is byte-identical
 *     to the string `/api/characters/:id/visual-identity` reports — which is what
 *     makes deleting the six per-card requests safe rather than merely cheaper.
 *  2. Home's card carries NOTHING ELSE from visual identity. No DNA, no canonical
 *     assets, no identity version.
 *  3. Home's card no longer carries `name`, `shortBio` or `profileImage`, while
 *     `/api/browse/characters` still does — the optimisation is Home-only.
 *  4. The pills in the Home payload are exactly `/api/categories`.
 *  5. The representative clip is still the newest eligible video, now chosen by
 *     the database rather than by a JavaScript loop over every asset.
 *  6. A category rail still stops at 24, now enforced in SQL, per category.
 *  7. The SQL media-type translation agrees with `mediaTypeOf` case for case.
 */

const LUNA = SEED_CHARACTERS.find((c) => c.name === 'luna')!;
const EMBER = SEED_CHARACTERS.find((c) => c.name === 'ember')!;

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(64, 0x42)]);

let on: TestContext;
let adminCookies: Record<string, string>;
let seq = 0;

beforeAll(async () => {
  migrateTestDb();
  on = await createTestContext();
});
afterAll(async () => destroyTestContext(on));

beforeEach(async () => {
  await truncateAll(on);
  await seedCharacters(on.db);
  await seedVisualIdentities(on.db);
  const res = await on.app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email: 'home.perf@example.com', password: 'home-performance-1' },
  });
  const cookie = extractSessionCookie(res)!;
  await on.pool.query(`UPDATE users SET role = 'admin' WHERE email = $1`, [
    'home.perf@example.com',
  ]);
  adminCookies = { [cookie.name]: cookie.value };
});

async function makeAsset(
  characterId: string,
  extension: 'png' | 'webm',
  provenance?: Record<string, unknown>,
) {
  const identity = (await getActiveVisualIdentity(on.db, characterId))!;
  const asset = await createVisualAsset(on.db, {
    characterId,
    visualIdentityId: identity.id,
    kind: 'generated',
    status: 'approved',
    contentRating: 'sfw',
  });
  const path = join(testEnv.media.storageDir, 'home-perf', `${asset.id}.${extension}`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, extension === 'webm' ? WEBM : PNG);
  await on.db
    .update(characterVisualAssets)
    .set({ storageKey: path, ...(provenance ? { provenance } : {}) })
    .where(eq(characterVisualAssets.id, asset.id));
  return { ...asset, storageKey: path };
}

async function makeCategory(base = 'Perf') {
  const res = await on.app.inject({
    method: 'POST',
    url: '/admin/app-categories',
    payload: { name: `${base} ${process.pid} ${++seq}` },
    cookies: adminCookies,
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string; slug: string; name: string };
}

const api = {
  home: () => on.app.inject({ method: 'GET', url: '/api/home' }),
  browseClips: (qs = '') => on.app.inject({ method: 'GET', url: `/api/browse/clips${qs}` }),
  categories: () => on.app.inject({ method: 'GET', url: '/api/categories' }),
  browseCharacters: () => on.app.inject({ method: 'GET', url: '/api/browse/characters' }),
  visualIdentity: (characterId: string) =>
    on.app.inject({ method: 'GET', url: `/api/characters/${characterId}/visual-identity` }),
  assign: (categoryId: string, assetIds: string[]) =>
    on.app.inject({
      method: 'POST',
      url: `/admin/app-categories/${categoryId}/assets`,
      payload: { assetIds },
      cookies: adminCookies,
    }),
  publish: (categoryId: string) =>
    on.app.inject({
      method: 'PATCH',
      url: `/admin/home/categories/${categoryId}`,
      payload: { homePublished: true },
      cookies: adminCookies,
    }),
};

/** One character on the rail, with a real publicly reachable video. */
async function railCharacter(characterId: string) {
  const asset = await makeAsset(characterId, 'webm');
  const category = await makeCategory();
  await api.assign(category.id, [asset.id]);
  await api.publish(category.id);
  return { asset, category };
}

type Card = {
  id: string;
  displayName: string;
  apparentAgeBand: string | null;
  categories: Array<{ slug: string; name: string }>;
  clip: { id: string; mediaType: string } | null;
};

const playWithMe = async (): Promise<Card[]> => (await api.home()).json().playWithMe;

/* ------------------------------------------------------------------ *
 * 1. The age label no longer costs a request per card
 * ------------------------------------------------------------------ */

describe('the apparent-age band travels with the Home card', () => {
  it('is the SAME string the visual-identity endpoint reports', async () => {
    // This is the whole safety argument for deleting the six per-card requests:
    // the browser is handed the identical input it used to fetch for itself, so
    // the age arithmetic — which is unchanged, and still runs in the browser —
    // cannot produce a different label.
    await railCharacter(LUNA.id);

    const card = (await playWithMe()).find((c) => c.id === LUNA.id)!;
    const identity = (await api.visualIdentity(LUNA.id)).json();
    const attribute = identity.identity.attributes.find(
      (a: { label: string }) => a.label.trim().toLowerCase() === 'apparent age',
    );

    expect(card.apparentAgeBand).toBe(attribute.value);
    // And it is the seeded band, not something derived or defaulted.
    expect(card.apparentAgeBand).toBe('adult (mid-20s)');
  });

  it('is null when the character has no ACTIVE identity, rather than dropping her card', async () => {
    // The old behaviour when the per-card fetch returned nothing usable was a
    // null visual and the client's own default age. A missing band has to land
    // in exactly that state — a card that renders, with no band.
    await railCharacter(LUNA.id);
    await on.db
      .update(characterVisualIdentities)
      .set({ status: 'retired' })
      .where(eq(characterVisualIdentities.characterId, LUNA.id));

    const card = (await playWithMe()).find((c) => c.id === LUNA.id);
    expect(card).toBeDefined();
    expect(card!.apparentAgeBand).toBeNull();
  });

  it('reads the ACTIVE identity, never a draft or a retired one', async () => {
    await railCharacter(LUNA.id);
    const active = (await getActiveVisualIdentity(on.db, LUNA.id))!;
    await on.db
      .update(characterVisualIdentities)
      .set({ visualDna: { apparentAgeBand: 'adult (late-30s)' } })
      .where(eq(characterVisualIdentities.id, active.id));

    const card = (await playWithMe()).find((c) => c.id === LUNA.id)!;
    expect(card.apparentAgeBand).toBe('adult (late-30s)');
  });

  it('carries NOTHING ELSE from visual identity', async () => {
    // The point of sending a band rather than an object: Home must not become a
    // second, unowned copy of the visual-identity projection.
    await railCharacter(LUNA.id);
    const card = (await playWithMe()).find((c) => c.id === LUNA.id)!;

    expect(Object.keys(card).sort()).toEqual(
      ['apparentAgeBand', 'categories', 'clip', 'displayName', 'id'].sort(),
    );

    const payload = (await api.home()).payload;
    expect(payload).not.toContain('canonicalAssets');
    expect(payload).not.toContain('visualDna');
    expect(payload).not.toContain('distinctiveFeatures');
    expect(payload).not.toContain('visualIdentityId');
  });
});

/* ------------------------------------------------------------------ *
 * 2. Home's card is Home's card — the browse contract is untouched
 * ------------------------------------------------------------------ */

describe('the trimmed Home card is Home-only', () => {
  it('no longer sends name, shortBio or profileImage on the rail', async () => {
    await railCharacter(LUNA.id);
    const card = (await playWithMe()).find((c) => c.id === LUNA.id)!;
    expect(card).not.toHaveProperty('name');
    expect(card).not.toHaveProperty('shortBio');
    expect(card).not.toHaveProperty('profileImage');
  });

  it('/api/browse/characters still sends all three, unchanged', async () => {
    // The optimisation is scoped to Home. A public endpoint with its own
    // contract does not get quietly narrowed to make a different page faster.
    await railCharacter(LUNA.id);
    const row = (await api.browseCharacters())
      .json()
      .characters.find((c: { id: string }) => c.id === LUNA.id)!;
    expect(row).toHaveProperty('name', LUNA.name);
    expect(row).toHaveProperty('shortBio');
    expect(row).toHaveProperty('profileImage');
  });
});

/* ------------------------------------------------------------------ *
 * 3. One request for Home, pills included
 * ------------------------------------------------------------------ */

describe('the category pills ride along with Home', () => {
  it('are exactly what /api/categories serves', async () => {
    const a = await makeCategory('Pill A');
    const b = await makeCategory('Pill B');
    await api.publish(a.id);
    await api.publish(b.id);

    const pills = (await api.home()).json().categoryPills;
    const standalone = (await api.categories()).json().categories;
    expect(pills).toEqual(standalone);
    expect(pills.length).toBe(2);
  });

  it('exclude an unpublished category, exactly as the endpoint does', async () => {
    const published = await makeCategory('Shown');
    await makeCategory('Hidden');
    await api.publish(published.id);

    const pills = (await api.home()).json().categoryPills as Array<{ id: string }>;
    expect(pills.map((p) => p.id)).toEqual([published.id]);
    expect(pills).toEqual((await api.categories()).json().categories);
  });

  it('carry only id, slug and name — never the tagline or the clips', async () => {
    const category = await makeCategory('Shape');
    await api.publish(category.id);
    const [pill] = (await api.home()).json().categoryPills;
    expect(Object.keys(pill).sort()).toEqual(['id', 'name', 'slug']);
  });
});

/* ------------------------------------------------------------------ *
 * 4. The representative clip is unchanged — chosen by SQL now
 * ------------------------------------------------------------------ */

describe('the representative clip is still the newest eligible video', () => {
  it('prefers the NEWER video when a character has two', async () => {
    const category = await makeCategory('Newest');
    const older = await makeAsset(LUNA.id, 'webm');
    const newer = await makeAsset(LUNA.id, 'webm');
    await api.assign(category.id, [older.id, newer.id]);
    await api.publish(category.id);
    await on.db
      .update(characterVisualAssets)
      .set({ createdAt: new Date('2020-01-01T00:00:00Z') })
      .where(eq(characterVisualAssets.id, older.id));
    await on.db
      .update(characterVisualAssets)
      .set({ createdAt: new Date('2026-01-01T00:00:00Z') })
      .where(eq(characterVisualAssets.id, newer.id));

    const card = (await playWithMe()).find((c) => c.id === LUNA.id)!;
    expect(card.clip!.id).toBe(newer.id);
  });

  it('SKIPS a newer image and keeps looking for a video', async () => {
    // The behaviour the old JavaScript loop had, and the reason a plain
    // `distinct on` without the media-type condition would have been wrong: the
    // newest asset is an image, and the card must still be the older video.
    const category = await makeCategory('SkipImage');
    const video = await makeAsset(LUNA.id, 'webm');
    const image = await makeAsset(LUNA.id, 'png');
    await api.assign(category.id, [video.id, image.id]);
    await api.publish(category.id);
    await on.db
      .update(characterVisualAssets)
      .set({ createdAt: new Date('2020-01-01T00:00:00Z') })
      .where(eq(characterVisualAssets.id, video.id));
    await on.db
      .update(characterVisualAssets)
      .set({ createdAt: new Date('2026-01-01T00:00:00Z') })
      .where(eq(characterVisualAssets.id, image.id));

    const card = (await playWithMe()).find((c) => c.id === LUNA.id)!;
    expect(card.clip!.id).toBe(video.id);
    expect(card.clip!.mediaType).toBe('video');
  });

  it('classifies an extensionless upload by its recorded provenance', async () => {
    // A manual upload's storage key has no extension, so only provenance says
    // it is a video. The SQL translation has to honour that, or every uploaded
    // clip would vanish from the rail.
    const category = await makeCategory('Provenance');
    const asset = await makeAsset(LUNA.id, 'png', { mediaType: 'video' });
    await api.assign(category.id, [asset.id]);
    await api.publish(category.id);

    const card = (await playWithMe()).find((c) => c.id === LUNA.id)!;
    expect(card.clip!.id).toBe(asset.id);
    expect(card.clip!.mediaType).toBe('video');
  });

  it('gives one card per character, never two', async () => {
    const category = await makeCategory('OnePer');
    const a = await makeAsset(LUNA.id, 'webm');
    const b = await makeAsset(LUNA.id, 'webm');
    const c = await makeAsset(EMBER.id, 'webm');
    await api.assign(category.id, [a.id, b.id, c.id]);
    await api.publish(category.id);

    const rail = await playWithMe();
    expect(rail.filter((card) => card.id === LUNA.id)).toHaveLength(1);
    expect(rail.filter((card) => card.id === EMBER.id)).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ *
 * 5. The rail limit is enforced by the database, per category
 * ------------------------------------------------------------------ */

describe('a category rail stops at its limit', () => {
  it('returns at most 24 clips, and the FIRST 24 in assignment order', async () => {
    const category = await makeCategory('Big');
    const assets = [];
    for (let i = 0; i < CATEGORY_RAIL_LIMIT + 6; i++) {
      assets.push(await makeAsset(LUNA.id, 'webm'));
    }
    await api.assign(
      category.id,
      assets.map((a) => a.id),
    );
    await api.publish(category.id);

    const rail = (await api.home())
      .json()
      .categories.find((r: { id: string }) => r.id === category.id)!;
    expect(rail.clips).toHaveLength(CATEGORY_RAIL_LIMIT);
    // The overflow is the TAIL that was dropped, not an arbitrary subset.
    const kept = rail.clips.map((c: { id: string }) => c.id);
    expect(kept).toEqual(assets.slice(0, CATEGORY_RAIL_LIMIT).map((a) => a.id));
  });

  it('limits EACH category independently, never the result set as a whole', async () => {
    // The failure a plain `limit 24` would have caused: the first rail fills up
    // and every rail after it renders empty.
    const first = await makeCategory('First');
    const second = await makeCategory('Second');
    const firstAssets = [];
    for (let i = 0; i < CATEGORY_RAIL_LIMIT + 2; i++) {
      firstAssets.push(await makeAsset(LUNA.id, 'webm'));
    }
    const secondAsset = await makeAsset(EMBER.id, 'webm');
    await api.assign(
      first.id,
      firstAssets.map((a) => a.id),
    );
    await api.assign(second.id, [secondAsset.id]);
    await api.publish(first.id);
    await api.publish(second.id);

    const rails = (await api.home()).json().categories as Array<{
      id: string;
      clips: Array<{ id: string }>;
    }>;
    expect(rails.find((r) => r.id === first.id)!.clips).toHaveLength(CATEGORY_RAIL_LIMIT);
    expect(rails.find((r) => r.id === second.id)!.clips.map((c) => c.id)).toEqual([
      secondAsset.id,
    ]);
  });
});

/* ------------------------------------------------------------------ *
 * 6. The SQL media-type translation agrees with the TypeScript one
 * ------------------------------------------------------------------ */

describe('videoAssetCondition is a translation of mediaTypeOf, not a second opinion', () => {
  const CASES: Array<{ storageKey: string | null; provenance: Record<string, unknown> }> = [
    { storageKey: '/m/a.mp4', provenance: {} },
    { storageKey: '/m/a.WEBM', provenance: {} },
    { storageKey: '/m/a.MoV', provenance: {} },
    { storageKey: '/m/a.m4v', provenance: {} },
    { storageKey: '/m/a.png', provenance: {} },
    { storageKey: '/m/a.mp4.png', provenance: {} },
    { storageKey: '/m/mp4', provenance: {} },
    { storageKey: '/m/assets/x/file', provenance: {} },
    { storageKey: '/m/assets/x/file', provenance: { mediaType: 'video' } },
    { storageKey: '/m/a.mp4', provenance: { mediaType: 'image' } },
    { storageKey: '/m/a.png', provenance: { mediaType: 'video' } },
    { storageKey: '/m/a.mp4', provenance: { mediaType: null } },
    { storageKey: '/m/a.mp4', provenance: { mediaType: 7 } },
    { storageKey: '/m/a.png', provenance: { mediaType: 'audio' } },
    { storageKey: null, provenance: {} },
    { storageKey: null, provenance: { mediaType: 'video' } },
  ];

  it('agrees on every case, including provenance overrides and odd keys', async () => {
    const identity = (await getActiveVisualIdentity(on.db, LUNA.id))!;
    const expected = new Map<string, boolean>();

    for (const testCase of CASES) {
      const asset = await createVisualAsset(on.db, {
        characterId: LUNA.id,
        visualIdentityId: identity.id,
        kind: 'generated',
        status: 'approved',
        contentRating: 'sfw',
      });
      await on.db
        .update(characterVisualAssets)
        .set({ storageKey: testCase.storageKey, provenance: testCase.provenance })
        .where(eq(characterVisualAssets.id, asset.id));
      expected.set(
        asset.id,
        mediaTypeOf(testCase.storageKey, testCase.provenance) === 'video',
      );
    }

    const rows = await on.db
      .select({ id: characterVisualAssets.id })
      .from(characterVisualAssets)
      .where(videoAssetCondition());
    const sqlSaysVideo = new Set(rows.map((r) => r.id));

    for (const [id, isVideo] of expected) {
      expect(sqlSaysVideo.has(id)).toBe(isVideo);
    }
    // And the fixture actually exercised both answers.
    expect([...expected.values()]).toContain(true);
    expect([...expected.values()]).toContain(false);
  });
});

/* ------------------------------------------------------------------ *
 * 7. The results grid keeps its content without fetching the corpus
 * ------------------------------------------------------------------ */

describe('the Home payload seeds the results grid', () => {
  it('is exactly what an unfiltered /api/browse/clips returns, in the same order', async () => {
    // The grid under the search box renders these. If this list ever stopped
    // matching the browse endpoint, Home would quietly show different content
    // on arrival than it shows the moment someone clears a search.
    const category = await makeCategory('Grid');
    const assets = [];
    for (let i = 0; i < 5; i++) assets.push(await makeAsset(LUNA.id, 'webm'));
    assets.push(await makeAsset(EMBER.id, 'webm'));
    await api.assign(
      category.id,
      assets.map((a) => a.id),
    );
    await api.publish(category.id);

    const seeded = (await api.home()).json().browseClips;
    const browsed = (await api.browseClips()).json().clips;
    expect(seeded).toEqual(browsed);
    expect(seeded.length).toBe(assets.length);
  });

  it('is capped, and the cap keeps the NEWEST page', async () => {
    const category = await makeCategory('GridBig');
    const assets = [];
    for (let i = 0; i < HOME_CLIP_GRID_LIMIT + 5; i++) {
      assets.push(await makeAsset(LUNA.id, 'webm'));
    }
    await api.assign(
      category.id,
      assets.map((a) => a.id),
    );
    await api.publish(category.id);
    // Oldest first in creation order, so the newest page is the tail.
    for (let i = 0; i < assets.length; i++) {
      await on.db
        .update(characterVisualAssets)
        .set({ createdAt: new Date(Date.UTC(2020, 0, 1 + i)) })
        .where(eq(characterVisualAssets.id, assets[i]!.id));
    }

    const seeded = (await api.home()).json().browseClips as Array<{ id: string }>;
    expect(seeded).toHaveLength(HOME_CLIP_GRID_LIMIT);

    const newestFirst = assets.slice().reverse().map((a) => a.id);
    expect(seeded.map((c) => c.id)).toEqual(newestFirst.slice(0, HOME_CLIP_GRID_LIMIT));
  });

  it('leaves /api/browse/clips itself UNBOUNDED — a search is never truncated', async () => {
    // The cap belongs to the seed, not to the endpoint. Someone who actually
    // searches still gets every match, exactly as before.
    const category = await makeCategory('GridSearch');
    const assets = [];
    for (let i = 0; i < HOME_CLIP_GRID_LIMIT + 5; i++) {
      assets.push(await makeAsset(LUNA.id, 'webm'));
    }
    await api.assign(
      category.id,
      assets.map((a) => a.id),
    );
    await api.publish(category.id);

    expect((await api.browseClips()).json().clips).toHaveLength(assets.length);
    // And a name query still matches the whole set for that character.
    const searched = (await api.browseClips(`?q=${encodeURIComponent(LUNA.displayName)}`)).json();
    expect(searched.clips).toHaveLength(assets.length);
  });

  it('carries videos only, exactly as the grid always rendered', async () => {
    const category = await makeCategory('GridImage');
    const video = await makeAsset(LUNA.id, 'webm');
    const image = await makeAsset(LUNA.id, 'png');
    await api.assign(category.id, [video.id, image.id]);
    await api.publish(category.id);

    const seeded = (await api.home()).json().browseClips as Array<{
      id: string;
      mediaType: string;
    }>;
    expect(seeded.map((c) => c.id)).toEqual([video.id]);
    expect(seeded.every((c) => c.mediaType === 'video')).toBe(true);
  });

  it('shows nothing when nothing is publicly reachable', async () => {
    // An approved asset that no public surface references is not content the
    // grid may advertise — the same rule the media route enforces.
    await makeAsset(LUNA.id, 'webm');
    expect((await api.home()).json().browseClips).toEqual([]);
    expect((await api.browseClips()).json().clips).toEqual([]);
  });
});
