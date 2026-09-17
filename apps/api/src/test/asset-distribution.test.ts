import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { characters } from '../db/schema.js';
import { SEED_CHARACTERS, SEED_VISUAL_ASSETS } from '../db/seed-data.js';
import { seedCharacters, seedVisualIdentities } from '../db/seed.js';
import {
  DISTRIBUTION_CHANNELS,
  describeAssetDistribution,
  distributionBlockerOf,
  type AssetDistribution,
} from '../services/asset-distribution.js';
import { uploadLibraryAsset } from '../services/library-upload-service.js';
import { getPublicAsset } from '../services/public-media-service.js';
import { approveVisualAsset } from '../services/visual-asset-service.js';
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
 * P0.5 -- DISTRIBUTION as one model.
 *
 * Two gates, then a channel:
 *
 *   distributable   approved (P0.4) + content role + media + active character
 *   channel         Posts (published_at) | Hero | a published category |
 *                   a keyword an enabled Discovery category queries
 *
 * The admin read model and the public readers are the SAME model seen from two
 * sides, so the strongest test here is that they never disagree: whatever the
 * Character page says is live is exactly what the public routes serve.
 */

const LUNA = SEED_CHARACTERS.find((c) => c.name === 'luna')!;
const FIXTURES = join(testEnv.media.storageDir, '__distribution_fixtures__');
const STORAGE = { storageDir: testEnv.media.storageDir, servePathPrefix: '/admin/content/uploads' };
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

let on: TestContext;
let cookie: string;

beforeAll(async () => {
  migrateTestDb();
  mkdirSync(FIXTURES, { recursive: true });
  writeFileSync(join(FIXTURES, 'seed.jpg'), Buffer.from('fake-jpeg-bytes'));
  on = await createTestContext();
});
afterAll(async () => {
  await destroyTestContext(on);
  rmSync(FIXTURES, { recursive: true, force: true });
});
beforeEach(async () => {
  await truncateAll(on);
  await seedCharacters(on.db);
  await seedVisualIdentities(on.db);
  const email = `distribution-${randomUUID()}@example.com`;
  const res = await on.app.inject({ method: 'POST', url: '/api/auth/register', payload: { email, password: 'distribution-1' } });
  const c = extractSessionCookie(res)!;
  await on.pool.query(`UPDATE users SET role = 'admin' WHERE email = $1`, [email]);
  cookie = `${c.name}=${c.value}`;
});

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/** An approved content clip belonging to Luna, in no channel at all. */
async function approvedClip(over: Parameters<typeof uploadLibraryAsset>[2] | object = {}) {
  const created = await uploadLibraryAsset(on.db, STORAGE, {
    characterId: LUNA.id,
    mimeType: 'image/png',
    bytes: PNG,
    originalName: 'clip.png',
    ...(over as object),
  });
  return approveVisualAsset(on.db, created.id);
}

const act = (assetId: string, verb: string) =>
  on.app.inject({ method: 'POST', url: `/admin/content/assets/${assetId}/${verb}`, headers: { cookie } });

async function release(assetId: string) {
  expect((await act(assetId, 'publish')).statusCode).toBe(200);
}

async function addToHero(assetId: string, position = 0) {
  await on.pool.query('INSERT INTO home_hero_clips (asset_id, position) VALUES ($1, $2)', [assetId, position]);
}

async function addToCategory(
  assetId: string,
  options: { enabled?: boolean; homePublished?: boolean; slug?: string; name?: string } = {},
) {
  const { enabled = true, homePublished = true, slug = `cat-${randomUUID().slice(0, 8)}`, name = 'Category' } = options;
  const category = (
    await on.pool.query<{ id: string }>(
      `INSERT INTO app_categories (slug, name, enabled, home_published) VALUES ($1, $2, $3, $4) RETURNING id`,
      [slug, name, enabled, homePublished],
    )
  ).rows[0]!.id;
  await on.pool.query('INSERT INTO app_category_assets (category_id, asset_id, position) VALUES ($1, $2, 0)', [category, assetId]);
  return { id: category, slug, name };
}

async function tagForDiscovery(
  assetId: string,
  options: { keyword?: string; enabled?: boolean; inCategory?: boolean } = {},
) {
  const { keyword = `kw-${randomUUID().slice(0, 6)}`, enabled = true, inCategory = true } = options;
  const keywordId = (
    await on.pool.query<{ id: string }>(`INSERT INTO content_keywords (key, label) VALUES ($1, $1) RETURNING id`, [keyword])
  ).rows[0]!.id;
  await on.pool.query('INSERT INTO asset_keywords (asset_id, keyword_id) VALUES ($1, $2)', [assetId, keywordId]);
  if (!inCategory) return { keyword, categoryName: null };
  const categoryName = 'Summer';
  const discovery = (
    await on.pool.query<{ id: string }>(
      `INSERT INTO discovery_categories (slug, name, enabled) VALUES ($1, $2, $3) RETURNING id`,
      [`disc-${randomUUID().slice(0, 8)}`, categoryName, enabled],
    )
  ).rows[0]!.id;
  await on.pool.query('INSERT INTO discovery_category_keywords (discovery_category_id, keyword_id) VALUES ($1, $2)', [discovery, keywordId]);
  return { keyword, categoryName };
}

/** The shelf the Character page reads. */
async function shelfDistribution(assetId: string): Promise<AssetDistribution> {
  const res = await on.app.inject({ method: 'GET', url: `/admin/characters/${LUNA.id}/content`, headers: { cookie } });
  expect(res.statusCode).toBe(200);
  const found = (res.json().assets as Array<{ assetId: string; distribution: AssetDistribution }>).find(
    (a) => a.assetId === assetId,
  );
  expect(found, 'the shelf lists the asset').toBeTruthy();
  return found!.distribution;
}

const get = (url: string) => on.app.inject({ method: 'GET', url });

/** Does the PUBLIC side serve this asset's bytes right now? */
async function publiclyServed(assetId: string) {
  return (await get(`/api/media/assets/${assetId}/file`)).statusCode === 200;
}

/** Which public listings currently contain the id. */
async function publicListings(assetId: string) {
  const urls = [
    '/api/home',
    `/api/characters/${LUNA.id}/clips`,
    '/api/browse/clips',
    '/api/play-with-me',
    '/api/discovery/clips',
  ];
  const showing: string[] = [];
  for (const url of urls) {
    const res = await get(url);
    expect({ url, status: res.statusCode }).toEqual({ url, status: 200 });
    if (res.payload.includes(assetId)) showing.push(url);
  }
  return showing;
}

/* ================================================================== *
 * The asset-level gate
 * ================================================================== */

describe('the distributable gate', () => {
  const row = (over: Partial<Parameters<typeof distributionBlockerOf>[0]> = {}) => ({
    status: 'approved',
    kind: 'generated',
    storageKey: '/media/luna/clip.mp4',
    characterStatus: 'active',
    ...over,
  });

  it('passes only approved content of an active character that has media', () => {
    expect(distributionBlockerOf(row())).toBeNull();
  });

  it('names the reason, and reports the workflow state exactly (P0.4 vocabulary)', () => {
    expect(distributionBlockerOf(row({ status: 'generated' }))).toBe('pending_review');
    expect(distributionBlockerOf(row({ status: 'under_review' }))).toBe('pending_review');
    expect(distributionBlockerOf(row({ status: 'rejected' }))).toBe('rejected');
    expect(distributionBlockerOf(row({ status: 'archived' }))).toBe('archived');
    expect(distributionBlockerOf(row({ kind: 'chat' }))).toBe('not_content');
    expect(distributionBlockerOf(row({ kind: 'reference' }))).toBe('not_content');
    expect(distributionBlockerOf(row({ storageKey: null }))).toBe('no_media');
    expect(distributionBlockerOf(row({ storageKey: '' }))).toBe('no_media');
    expect(distributionBlockerOf(row({ characterStatus: 'inactive' }))).toBe('character_inactive');
  });

  it('reports the FIRST failure, so an operator is told the decision to make', () => {
    // Archived, chat, no bytes, retired character: the workflow answer is the
    // one that matters first.
    expect(distributionBlockerOf({ status: 'archived', kind: 'chat', storageKey: null, characterStatus: 'inactive' })).toBe('archived');
  });
});

/* ================================================================== *
 * Each channel, as the admin sees it and as the public reads it
 * ================================================================== */

describe('the four channels', () => {
  it('names them in one place, so nothing invents a fifth', () => {
    expect([...DISTRIBUTION_CHANNELS]).toEqual(['posts', 'hero', 'category', 'discovery']);
  });

  it('POSTS: releasing puts it on her page and nowhere else', async () => {
    const asset = await approvedClip();
    expect((await shelfDistribution(asset.id)).posts).toEqual({ released: false, releasedAt: null, live: false });

    await release(asset.id);
    const distribution = await shelfDistribution(asset.id);
    expect(distribution.posts.released).toBe(true);
    expect(distribution.posts.live).toBe(true);
    expect(distribution.liveAnywhere).toBe(true);
    expect(await publiclyServed(asset.id)).toBe(true);
    // Her own page lists it; the placement surfaces do not -- Posts is not a placement.
    expect(await publicListings(asset.id)).toEqual([`/api/characters/${LUNA.id}/clips`]);
  });

  it('HERO: an assigned clip is live, and shows on Home', async () => {
    const asset = await approvedClip();
    await addToHero(asset.id);
    const distribution = await shelfDistribution(asset.id);
    expect(distribution.hero).toEqual({ placed: true, position: 0, live: true });
    expect(distribution.liveAnywhere).toBe(true);
    expect(await publiclyServed(asset.id)).toBe(true);
    expect(await publicListings(asset.id)).toContain('/api/home');
  });

  it('CATEGORY: live only while the category is enabled AND on Home', async () => {
    const live = await approvedClip();
    const category = await addToCategory(live.id, { name: 'Sexy' });
    const first = await shelfDistribution(live.id);
    expect(first.categories).toEqual([
      { id: category.id, slug: category.slug, name: 'Sexy', position: 0, live: true, reason: null },
    ]);
    expect(await publiclyServed(live.id)).toBe(true);

    const unpublished = await approvedClip();
    await addToCategory(unpublished.id, { homePublished: false, name: 'Draft rail' });
    const second = await shelfDistribution(unpublished.id);
    expect(second.categories[0]).toMatchObject({ live: false, reason: 'category_unpublished' });
    expect(second.liveAnywhere).toBe(false);
    expect(second.placedAnywhere).toBe(true);
    expect(await publiclyServed(unpublished.id)).toBe(false);

    const disabled = await approvedClip();
    await addToCategory(disabled.id, { enabled: false, name: 'Off' });
    const third = await shelfDistribution(disabled.id);
    expect(third.categories[0]).toMatchObject({ live: false, reason: 'category_disabled' });
    expect(await publiclyServed(disabled.id)).toBe(false);
  });

  it('DISCOVERY: a keyword is a channel only when an enabled category queries it', async () => {
    const reachable = await approvedClip();
    const tag = await tagForDiscovery(reachable.id, { keyword: 'beach' });
    const distribution = await shelfDistribution(reachable.id);
    expect(distribution.discovery).toEqual([{ keyword: 'beach', categories: [tag.categoryName], live: true }]);
    expect(distribution.liveAnywhere).toBe(true);
    expect(await publiclyServed(reachable.id)).toBe(true);

    // A tag no discovery category queries is an operator's private vocabulary.
    const tagged = await approvedClip();
    await tagForDiscovery(tagged.id, { keyword: 'internal-review', inCategory: false });
    const priv = await shelfDistribution(tagged.id);
    expect(priv.discovery).toEqual([{ keyword: 'internal-review', categories: [], live: false }]);
    expect(priv.liveAnywhere).toBe(false);
    expect(await publiclyServed(tagged.id)).toBe(false);

    // Nor does a DISABLED discovery category reach it.
    const disabled = await approvedClip();
    await tagForDiscovery(disabled.id, { keyword: 'winter', enabled: false });
    const off = await shelfDistribution(disabled.id);
    expect(off.discovery[0]).toMatchObject({ live: false, categories: [] });
    expect(await publiclyServed(disabled.id)).toBe(false);
  });

  it('approval alone is not a channel: an approved clip nobody placed is served nowhere', async () => {
    const asset = await approvedClip();
    const distribution = await shelfDistribution(asset.id);
    expect({ blocker: distribution.blocker, live: distribution.liveAnywhere, placed: distribution.placedAnywhere }).toEqual({
      blocker: null,
      live: false,
      placed: false,
    });
    expect(await publiclyServed(asset.id)).toBe(false);
    expect(await publicListings(asset.id)).toEqual([]);
  });
});

/* ================================================================== *
 * The gate closes every channel at once
 * ================================================================== */

describe('lifecycle and character state close every channel together', () => {
  /** Released, on the Hero, in a published category and tagged for Discovery. */
  async function everywhere() {
    const asset = await approvedClip();
    await release(asset.id);
    await addToHero(asset.id);
    await addToCategory(asset.id, { name: 'Sexy' });
    await tagForDiscovery(asset.id, { keyword: 'beach' });
    const distribution = await shelfDistribution(asset.id);
    expect(distribution.liveAnywhere).toBe(true);
    expect(await publiclyServed(asset.id)).toBe(true);
    return asset;
  }

  it('ARCHIVING hides every channel, keeps every record, and says why', async () => {
    const asset = await everywhere();
    expect((await act(asset.id, 'archive')).statusCode).toBe(200);

    const distribution = await shelfDistribution(asset.id);
    expect(distribution.blocker).toBe('archived');
    expect(distribution.liveAnywhere).toBe(false);
    // Nothing was removed: the records are all still there, just not live.
    expect(distribution.placedAnywhere).toBe(true);
    expect(distribution.posts.released).toBe(true);
    expect(distribution.hero.placed).toBe(true);
    expect(distribution.categories).toHaveLength(1);
    expect(distribution.discovery).toHaveLength(1);
    expect([distribution.posts.live, distribution.hero.live, distribution.categories[0]!.live, distribution.discovery[0]!.live]).toEqual([
      false,
      false,
      false,
      false,
    ]);
    expect(await publiclyServed(asset.id)).toBe(false);
    expect(await publicListings(asset.id)).toEqual([]);
  });

  it('UNARCHIVING returns it to approved with no distribution at all (P0.4)', async () => {
    const asset = await everywhere();
    expect((await act(asset.id, 'archive')).statusCode).toBe(200);
    expect((await act(asset.id, 'unarchive')).statusCode).toBe(200);

    const distribution = await shelfDistribution(asset.id);
    expect(distribution.blocker).toBeNull();
    expect(distribution.placedAnywhere).toBe(false);
    expect(distribution.liveAnywhere).toBe(false);
    expect(await publiclyServed(asset.id)).toBe(false);
    expect(await publicListings(asset.id)).toEqual([]);
  });

  it('REJECTING closes every channel while the records stay', async () => {
    const asset = await everywhere();
    expect((await act(asset.id, 'reject')).statusCode).toBe(200);
    const distribution = await shelfDistribution(asset.id);
    expect(distribution.blocker).toBe('rejected');
    expect(distribution.liveAnywhere).toBe(false);
    expect(distribution.placedAnywhere).toBe(true);
    expect(await publiclyServed(asset.id)).toBe(false);
    expect(await publicListings(asset.id)).toEqual([]);
  });

  it('TAKING HER OFFLINE closes every channel, and publishing her opens them again', async () => {
    const asset = await everywhere();
    await on.db.update(characters).set({ status: 'inactive' }).where(eq(characters.id, LUNA.id));

    const hidden = await shelfDistribution(asset.id);
    expect(hidden.blocker).toBe('character_inactive');
    expect(hidden.liveAnywhere).toBe(false);
    expect(hidden.placedAnywhere).toBe(true);
    expect(await publiclyServed(asset.id)).toBe(false);

    await on.db.update(characters).set({ status: 'active' }).where(eq(characters.id, LUNA.id));
    const back = await shelfDistribution(asset.id);
    expect(back.blocker).toBeNull();
    expect(back.liveAnywhere).toBe(true);
    expect(await publiclyServed(asset.id)).toBe(true);
  });
});

/* ================================================================== *
 * Admin and public never disagree
 * ================================================================== */

describe('the admin read model and the public readers are one model', () => {
  it('liveAnywhere matches what the public route serves, across every combination', async () => {
    type Case = { name: string; assetId: string };
    const cases: Case[] = [];

    const plain = await approvedClip();
    cases.push({ name: 'approved, nowhere', assetId: plain.id });

    const released = await approvedClip();
    await release(released.id);
    cases.push({ name: 'released', assetId: released.id });

    const hero = await approvedClip();
    await addToHero(hero.id);
    cases.push({ name: 'hero', assetId: hero.id });

    const category = await approvedClip();
    await addToCategory(category.id, { name: 'Live rail' });
    cases.push({ name: 'published category', assetId: category.id });

    const hiddenCategory = await approvedClip();
    await addToCategory(hiddenCategory.id, { homePublished: false, name: 'Hidden rail' });
    cases.push({ name: 'unpublished category', assetId: hiddenCategory.id });

    const discovery = await approvedClip();
    await tagForDiscovery(discovery.id, { keyword: 'sun' });
    cases.push({ name: 'discovery keyword', assetId: discovery.id });

    const privateTag = await approvedClip();
    await tagForDiscovery(privateTag.id, { keyword: 'internal', inCategory: false });
    cases.push({ name: 'private keyword', assetId: privateTag.id });

    const pending = await uploadLibraryAsset(on.db, STORAGE, { characterId: LUNA.id, mimeType: 'image/png', bytes: PNG });
    await addToHero(pending.id, 1);
    cases.push({ name: 'pending but placed on the Hero', assetId: pending.id });

    const archived = await approvedClip();
    await release(archived.id);
    expect((await act(archived.id, 'archive')).statusCode).toBe(200);
    cases.push({ name: 'archived after release', assetId: archived.id });

    const chat = await approvedClip({ characterId: LUNA.id, mimeType: 'image/png', bytes: PNG, kind: 'chat' });
    await addToHero(chat.id, 2);
    cases.push({ name: 'chat forced onto the Hero', assetId: chat.id });

    for (const item of cases) {
      const distribution = await shelfDistribution(item.assetId);
      const served = await publiclyServed(item.assetId);
      expect({ case: item.name, live: distribution.liveAnywhere, served }).toEqual({
        case: item.name,
        live: served,
        served,
      });
    }
  });

  it('a primary reference is identity, not distribution -- public, and live on no channel', async () => {
    const reference = SEED_VISUAL_ASSETS.find((a) => a.characterId === LUNA.id)!;
    const distribution = await shelfDistribution(reference.id);
    expect(distribution.blocker).toBe('not_content');
    expect(distribution.liveAnywhere).toBe(false);
    // Her portrait is still PUBLIC: the gallery is its own arm, not a channel.
    // Asked of the authorisation rule rather than the file route, because the
    // seeded portrait's bytes are not on disk in tests.
    expect(await getPublicAsset(on.db, reference.id)).not.toBeNull();
  });

  it('describes many assets without asking the database per asset', async () => {
    const assets = [await approvedClip(), await approvedClip(), await approvedClip()];
    await release(assets[0]!.id);
    await addToHero(assets[1]!.id);
    const described = await describeAssetDistribution(
      on.db,
      assets.map((a) => ({
        id: a.id,
        status: 'approved',
        kind: a.kind,
        storageKey: a.storageKey,
        publishedAt: a.id === assets[0]!.id ? new Date() : null,
        characterStatus: 'active',
      })),
    );
    expect(described.size).toBe(3);
    expect(described.get(assets[0]!.id)!.posts.released).toBe(true);
    expect(described.get(assets[1]!.id)!.hero.placed).toBe(true);
    expect(described.get(assets[2]!.id)!.placedAnywhere).toBe(false);
  });
});

/* ================================================================== *
 * One definition
 * ================================================================== */

describe('the distribution rule has one definition', () => {
  it('no other service builds its own asset-status gate for a public read', () => {
    const srcRoot = fileURLToPath(new URL('..', import.meta.url));
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) {
          if (name !== 'test') walk(full);
        } else if (name.endsWith('.ts')) files.push(full);
      }
    };
    walk(srcRoot);

    /**
     * Files that legitimately compare an asset's status are the ones that own
     * MODERATION (the review queue, the Library filter, the transitions) and
     * the private chat selector. Every DISTRIBUTION reader must ask this
     * module instead.
     */
    const moderationOwners = [
      'services/asset-distribution.ts',
      'services/asset-lifecycle.ts',
      'services/content-review-service.ts',
      'services/visual-asset-service.ts',
      'services/requirement-status-service.ts',
      'services/message-media-service.ts',
      'services/character-readiness-service.ts',
    ];
    const offenders: string[] = [];
    for (const file of files) {
      const rel = relative(srcRoot, file).split('\\').join('/');
      if (moderationOwners.includes(rel)) continue;
      const code = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');
      if (/eq\(\s*characterVisualAssets\.status\s*,/.test(code)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  it('the guard would catch a reader that restated it', () => {
    const planted = "const rows = db.select().where(eq(characterVisualAssets.status, 'approved'));";
    expect(/eq\(\s*characterVisualAssets\.status\s*,/.test(planted)).toBe(true);
  });
});
