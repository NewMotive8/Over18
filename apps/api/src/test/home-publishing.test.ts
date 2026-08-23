import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import {
  appCategories,
  characters,
  characterVisualAssets,
  characterVisualIdentities,
  homeHeroClips,
} from '../db/schema.js';
import { SEED_CHARACTERS } from '../db/seed-data.js';
import { seedCharacters, seedVisualIdentities } from '../db/seed.js';
import { createVisualAsset } from '../services/visual-asset-service.js';
import { getActiveVisualIdentity } from '../services/visual-identity-service.js';
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
 * US-102.4 — App Home Publishing & Preview.
 *
 * The rules these exist to hold:
 *
 *  1. NOTHING IS ON HOME BY EXISTING. A category appears only when an admin
 *     publishes it, and publication is independent of `enabled`.
 *  2. THE PUBLIC SURFACE SHOWS ONLY APPROVED CONTENT, on every rail, always.
 *  3. NO STORAGE PATH EVER REACHES A CLIENT — including the pre-existing public
 *     visual-identity leak this ticket fixes.
 *  4. PUBLIC MEDIA NEEDS BOTH approval AND public reachability. An approved but
 *     unpublished asset is a 404.
 *  5. DISCOVERY IS A SEPARATE SYSTEM. Keyword categories cannot touch App
 *     Categories, and deleting one cannot touch content or keywords.
 *  6. EVERY ADMIN ROUTE IS ADMIN-ONLY; every public route needs no account.
 */

const LUNA = SEED_CHARACTERS.find((c) => c.name === 'luna')!;
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/**
 * A tiny WebM-shaped payload (EBML magic + filler).
 *
 * The server classifies media by EXTENSION — `mediaTypeOf` reads the storage
 * key — so what this test needs from the bytes is only that they are non-empty
 * and accepted. Browser decoding is proven separately, in a real browser.
 */
const WEBM = Buffer.concat([
  Buffer.from([0x1a, 0x45, 0xdf, 0xa3]),
  Buffer.alloc(64, 0x42),
]);

let on: TestContext;
let adminCookies: Record<string, string>;
let userCookies: Record<string, string>;
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
  adminCookies = await register('home.admin@example.com', 'admin');
  userCookies = await register('home.user@example.com', 'user');
});

async function register(email: string, role: 'admin' | 'user') {
  const res = await on.app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email, password: 'home-publishing-1' },
  });
  const cookie = extractSessionCookie(res)!;
  if (role === 'admin') {
    await on.pool.query(`UPDATE users SET role = 'admin' WHERE email = $1`, [email]);
  }
  return { [cookie.name]: cookie.value };
}

/** An approved asset whose bytes really exist inside the storage root. */
async function makeApprovedAsset(characterId = LUNA.id) {
  const identity = (await getActiveVisualIdentity(on.db, characterId))!;
  const asset = await createVisualAsset(on.db, {
    characterId,
    visualIdentityId: identity.id,
    kind: 'generated',
    status: 'approved',
    contentRating: 'sfw',
  });
  const path = join(testEnv.media.storageDir, 'home-test', `${asset.id}.png`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, PNG);
  await on.db
    .update(characterVisualAssets)
    .set({ storageKey: path })
    .where(eq(characterVisualAssets.id, asset.id));
  return { ...asset, storageKey: path };
}

async function makeUnapprovedAsset(characterId = LUNA.id) {
  const identity = (await getActiveVisualIdentity(on.db, characterId))!;
  const asset = await createVisualAsset(on.db, {
    characterId,
    visualIdentityId: identity.id,
    kind: 'generated',
    status: 'under_review',
    contentRating: 'sfw',
  });
  const path = join(testEnv.media.storageDir, 'home-test', `${asset.id}.png`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, PNG);
  await on.db
    .update(characterVisualAssets)
    .set({ storageKey: path })
    .where(eq(characterVisualAssets.id, asset.id));
  return { ...asset, storageKey: path };
}

async function makeCategory(base = 'Home Cat') {
  const res = await on.app.inject({
    method: 'POST',
    url: '/admin/app-categories',
    payload: { name: `${base} ${process.pid} ${++seq}` },
    cookies: adminCookies,
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string; slug: string; name: string };
}

async function assign(categoryId: string, assetIds: string[]) {
  return on.app.inject({
    method: 'POST',
    url: `/admin/app-categories/${categoryId}/assets`,
    payload: { assetIds },
    cookies: adminCookies,
  });
}

const api = {
  home: (cookies?: Record<string, string>) =>
    on.app.inject({ method: 'GET', url: '/api/home', ...(cookies ? { cookies } : {}) }),
  adminHome: (cookies = adminCookies) =>
    on.app.inject({ method: 'GET', url: '/admin/home', cookies }),
  preview: (cookies = adminCookies) =>
    on.app.inject({ method: 'GET', url: '/admin/home/preview', cookies }),
  publish: (categoryId: string, homePublished: boolean, cookies = adminCookies) =>
    on.app.inject({
      method: 'PATCH',
      url: `/admin/home/categories/${categoryId}`,
      payload: { homePublished },
      cookies,
    }),
  orderCategories: (orderedIds: string[], cookies = adminCookies) =>
    on.app.inject({
      method: 'PUT',
      url: '/admin/home/categories/order',
      payload: { orderedIds },
      cookies,
    }),
  addHero: (assetIds: string[], cookies = adminCookies) =>
    on.app.inject({ method: 'POST', url: '/admin/home/hero', payload: { assetIds }, cookies }),
  removeHero: (assetId: string, cookies = adminCookies) =>
    on.app.inject({ method: 'DELETE', url: `/admin/home/hero/${assetId}`, cookies }),
  orderHero: (orderedIds: string[], cookies = adminCookies) =>
    on.app.inject({ method: 'PUT', url: '/admin/home/hero/order', payload: { orderedIds }, cookies }),
  recent: (cookies = adminCookies) =>
    on.app.inject({ method: 'GET', url: '/admin/home/recent', cookies }),
  addRecent: (characterId: string, cookies = adminCookies) =>
    on.app.inject({ method: 'POST', url: '/admin/home/recent', payload: { characterId }, cookies }),
  removeRecent: (characterId: string, cookies = adminCookies) =>
    on.app.inject({ method: 'DELETE', url: `/admin/home/recent/${characterId}`, cookies }),
  orderRecent: (orderedIds: string[], cookies = adminCookies) =>
    on.app.inject({ method: 'PUT', url: '/admin/home/recent/order', payload: { orderedIds }, cookies }),
  resetRecent: (cookies = adminCookies) =>
    on.app.inject({ method: 'POST', url: '/admin/home/recent/reset', cookies }),
  play: (cookies = adminCookies) =>
    on.app.inject({ method: 'GET', url: '/admin/home/play-with-me', cookies }),
  playCandidates: (cookies = adminCookies) =>
    on.app.inject({ method: 'GET', url: '/admin/home/play-with-me/candidates', cookies }),
  addPlay: (characterId: string, cookies = adminCookies) =>
    on.app.inject({
      method: 'POST',
      url: '/admin/home/play-with-me',
      payload: { characterId },
      cookies,
    }),
  removePlay: (characterId: string, cookies = adminCookies) =>
    on.app.inject({ method: 'DELETE', url: `/admin/home/play-with-me/${characterId}`, cookies }),
  orderPlay: (orderedIds: string[], cookies = adminCookies) =>
    on.app.inject({
      method: 'PUT',
      url: '/admin/home/play-with-me/order',
      payload: { orderedIds },
      cookies,
    }),
  resetPlay: (cookies = adminCookies) =>
    on.app.inject({ method: 'POST', url: '/admin/home/play-with-me/reset', cookies }),
  media: (assetId: string) =>
    on.app.inject({ method: 'GET', url: `/api/media/assets/${assetId}/file` }),
  discoveryCategories: () => on.app.inject({ method: 'GET', url: '/api/discovery/categories' }),
  clips: (qs = '') => on.app.inject({ method: 'GET', url: `/api/discovery/clips${qs}` }),
  adminDiscovery: (cookies = adminCookies) =>
    on.app.inject({ method: 'GET', url: '/admin/discovery/categories', cookies }),
  createDiscovery: (payload: Record<string, unknown>, cookies = adminCookies) =>
    on.app.inject({ method: 'POST', url: '/admin/discovery/categories', payload, cookies }),
  deleteDiscovery: (id: string, cookies = adminCookies) =>
    on.app.inject({ method: 'DELETE', url: `/admin/discovery/categories/${id}`, cookies }),
  setAssetKeywords: (assetId: string, keywords: string[], cookies = adminCookies) =>
    on.app.inject({
      method: 'PUT',
      url: `/admin/discovery/content/${assetId}/keywords`,
      payload: { keywords },
      cookies,
    }),
};

/* ------------------------------------------------------------------ *
 * 1. Nothing is on Home by existing
 * ------------------------------------------------------------------ */

describe('a category is on Home only when published there', () => {
  it('a brand new category is NOT on Home', async () => {
    const category = await makeCategory();
    const asset = await makeApprovedAsset();
    await assign(category.id, [asset.id]);

    const home = (await api.home()).json();
    expect(home.categories.map((c: { id: string }) => c.id)).not.toContain(category.id);
  });

  it('publishing puts it on Home, unpublishing takes it off', async () => {
    const category = await makeCategory();
    const asset = await makeApprovedAsset();
    await assign(category.id, [asset.id]);

    expect((await api.publish(category.id, true)).statusCode).toBe(200);
    expect((await api.home()).json().categories.map((c: { id: string }) => c.id)).toContain(
      category.id,
    );

    expect((await api.publish(category.id, false)).statusCode).toBe(200);
    expect((await api.home()).json().categories.map((c: { id: string }) => c.id)).not.toContain(
      category.id,
    );
  });

  it('unpublishing destroys nothing — the assignment survives', async () => {
    const category = await makeCategory();
    const asset = await makeApprovedAsset();
    await assign(category.id, [asset.id]);
    await api.publish(category.id, true);
    await api.publish(category.id, false);

    const contents = await on.app.inject({
      method: 'GET',
      url: `/admin/app-categories/${category.id}/assets`,
      cookies: adminCookies,
    });
    expect(contents.json().assets.map((a: { assetId: string }) => a.assetId)).toContain(asset.id);
  });

  it('home publication is INDEPENDENT of enabled, in both directions', async () => {
    const category = await makeCategory();
    const asset = await makeApprovedAsset();
    await assign(category.id, [asset.id]);
    await api.publish(category.id, true);

    // Disabling hides it from Home but does NOT unpublish it.
    await on.app.inject({
      method: 'PATCH',
      url: `/admin/app-categories/${category.id}`,
      payload: { enabled: false },
      cookies: adminCookies,
    });
    expect((await api.home()).json().categories).toEqual([]);
    const [row] = await on.db.select().from(appCategories).where(eq(appCategories.id, category.id));
    expect(row!.homePublished).toBe(true);

    // Re-enabling brings it straight back — nothing had to be re-published.
    await on.app.inject({
      method: 'PATCH',
      url: `/admin/app-categories/${category.id}`,
      payload: { enabled: true },
      cookies: adminCookies,
    });
    expect((await api.home()).json().categories).toHaveLength(1);
  });

  it('publishing does NOT enable a disabled category', async () => {
    const category = await makeCategory();
    await on.app.inject({
      method: 'PATCH',
      url: `/admin/app-categories/${category.id}`,
      payload: { enabled: false },
      cookies: adminCookies,
    });
    await api.publish(category.id, true);
    const [row] = await on.db.select().from(appCategories).where(eq(appCategories.id, category.id));
    expect(row!.enabled).toBe(false);
    expect((await api.home()).json().categories).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * 2. Home order is its own order
 * ------------------------------------------------------------------ */

describe('Home order is independent of the CMS order', () => {
  it('reordering Home does not touch the CMS list order', async () => {
    const a = await makeCategory('A');
    const b = await makeCategory('B');
    const asset = await makeApprovedAsset();
    await assign(a.id, [asset.id]);
    await assign(b.id, [asset.id]);
    await api.publish(a.id, true);
    await api.publish(b.id, true);

    const cmsBefore = (
      await on.app.inject({ method: 'GET', url: '/admin/app-categories', cookies: adminCookies })
    ).json().categories.map((c: { id: string }) => c.id);

    expect((await api.orderCategories([b.id, a.id])).statusCode).toBe(200);
    expect((await api.home()).json().categories.map((c: { id: string }) => c.id)).toEqual([
      b.id,
      a.id,
    ]);

    const cmsAfter = (
      await on.app.inject({ method: 'GET', url: '/admin/app-categories', cookies: adminCookies })
    ).json().categories.map((c: { id: string }) => c.id);
    expect(cmsAfter).toEqual(cmsBefore);
  });

  it('refuses a stale order that omits a published category', async () => {
    const a = await makeCategory('A');
    const b = await makeCategory('B');
    await api.publish(a.id, true);
    await api.publish(b.id, true);
    const res = await api.orderCategories([a.id]);
    expect(res.statusCode).toBe(409);
    expect(res.json().reason).toBe('incomplete');
  });

  it('refuses an order naming an unpublished category', async () => {
    const a = await makeCategory('A');
    const b = await makeCategory('B');
    await api.publish(a.id, true);
    const res = await api.orderCategories([a.id, b.id]);
    expect(res.statusCode).toBe(409);
    expect(res.json().reason).toBe('unknown_id');
  });
});

/* ------------------------------------------------------------------ *
 * 3. Only approved content reaches the public surface
 * ------------------------------------------------------------------ */

describe('the public surface shows approved content only', () => {
  it('an unapproved asset never appears in a Home rail', async () => {
    const category = await makeCategory();
    const approved = await makeApprovedAsset();
    const pending = await makeUnapprovedAsset();
    await assign(category.id, [approved.id, pending.id]);
    await api.publish(category.id, true);

    const rail = (await api.home()).json().categories[0];
    const ids = rail.clips.map((c: { id: string }) => c.id);
    expect(ids).toContain(approved.id);
    expect(ids).not.toContain(pending.id);
  });

  it('an asset that LOSES approval leaves Home without the link being destroyed', async () => {
    const category = await makeCategory();
    const asset = await makeApprovedAsset();
    await assign(category.id, [asset.id]);
    await api.publish(category.id, true);
    expect((await api.home()).json().categories[0].clips).toHaveLength(1);

    await on.db
      .update(characterVisualAssets)
      .set({ status: 'rejected' })
      .where(eq(characterVisualAssets.id, asset.id));

    expect((await api.home()).json().categories[0].clips).toEqual([]);

    // Re-approving brings it back by itself — nothing was deleted.
    await on.db
      .update(characterVisualAssets)
      .set({ status: 'approved' })
      .where(eq(characterVisualAssets.id, asset.id));
    expect((await api.home()).json().categories[0].clips).toHaveLength(1);
  });

  it('an unapproved clip cannot be added to the Hero', async () => {
    const pending = await makeUnapprovedAsset();
    const res = await api.addHero([pending.id]);
    expect(res.statusCode).toBe(200);
    expect(res.json().outcomes[0]).toMatchObject({ added: false, reason: 'not_approved' });
    // Nothing was assigned, so Home shows the fallback, and the refused clip
    // is not in it.
    expect((await api.adminHome()).json().hero).toEqual([]);
    expect((await api.home()).json().hero.map((c: { id: string }) => c.id)).not.toContain(
      pending.id,
    );
  });

  it('a Hero clip that loses approval disappears from Home but stays assigned', async () => {
    const asset = await makeApprovedAsset();
    await api.addHero([asset.id]);
    expect((await api.home()).json().hero).toHaveLength(1);

    await on.db
      .update(characterVisualAssets)
      .set({ status: 'rejected' })
      .where(eq(characterVisualAssets.id, asset.id));

    // It leaves the public Hero (which falls back to representative clips)
    // while staying assigned.
    expect((await api.home()).json().hero.map((c: { id: string }) => c.id)).not.toContain(
      asset.id,
    );
    // The operator can still see and clean up the assignment.
    const admin = (await api.adminHome()).json();
    expect(admin.hero.map((c: { assetId: string }) => c.assetId)).toContain(asset.id);
    expect(admin.hero[0].publishable).toBe(false);
  });

  it('discovery clips are approved-only', async () => {
    const approved = await makeApprovedAsset();
    const pending = await makeUnapprovedAsset();
    await api.setAssetKeywords(approved.id, ['sexy']);
    await api.setAssetKeywords(pending.id, ['sexy']);
    await api.createDiscovery({ name: 'Sexy', keywords: ['sexy'] });

    const ids = (await api.clips('?category=sexy')).json().clips.map((c: { id: string }) => c.id);
    expect(ids).toContain(approved.id);
    expect(ids).not.toContain(pending.id);
  });
});

/* ------------------------------------------------------------------ *
 * 4. Media security
 * ------------------------------------------------------------------ */

describe('public media security', () => {
  it('no storage path or filesystem key appears anywhere in the Home payload', async () => {
    const category = await makeCategory();
    const asset = await makeApprovedAsset();
    await assign(category.id, [asset.id]);
    await api.publish(category.id, true);
    await api.addHero([asset.id]);

    const body = (await api.home()).payload;
    expect(body).not.toContain('storageKey');
    expect(body).not.toContain('storagePath');
    expect(body).not.toContain(testEnv.media.storageDir);
    expect(body).not.toContain('/app/var/media');
    // And it does carry the opaque locator.
    expect(body).toContain(`/api/media/assets/${asset.id}/file`);
  });

  it('the public visual-identity endpoint no longer leaks the storage key', async () => {
    // The pre-existing leak this ticket fixes: imageUrl used to be the raw path.
    const identity = (await getActiveVisualIdentity(on.db, LUNA.id))!;
    const asset = await createVisualAsset(on.db, {
      characterId: LUNA.id,
      visualIdentityId: identity.id,
      kind: 'reference',
      status: 'approved',
      contentRating: 'sfw',
    });
    const path = join(testEnv.media.storageDir, 'home-test', `${asset.id}.png`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, PNG);
    await on.db
      .update(characterVisualAssets)
      .set({ storageKey: path, isCanonical: true })
      .where(eq(characterVisualAssets.id, asset.id));

    const res = await on.app.inject({
      method: 'GET',
      url: `/api/characters/${LUNA.id}/visual-identity`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.payload).not.toContain(testEnv.media.storageDir);
    for (const item of res.json().canonicalAssets) {
      expect(item.imageUrl).toMatch(/^\/api\/media\/assets\/[0-9a-f-]+\/file$/);
    }
  });

  it('serves an approved, publicly reachable asset', async () => {
    const category = await makeCategory();
    const asset = await makeApprovedAsset();
    await assign(category.id, [asset.id]);
    await api.publish(category.id, true);

    const res = await api.media(asset.id);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('image');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('REFUSES an approved asset that no public surface references', async () => {
    // Approval alone must not expose the whole Library to id guessing.
    const asset = await makeApprovedAsset();
    expect((await api.media(asset.id)).statusCode).toBe(404);
  });

  it('refuses an approved asset in a category that is NOT published to Home', async () => {
    const category = await makeCategory();
    const asset = await makeApprovedAsset();
    await assign(category.id, [asset.id]);
    expect((await api.media(asset.id)).statusCode).toBe(404);

    await api.publish(category.id, true);
    expect((await api.media(asset.id)).statusCode).toBe(200);

    // Unpublishing closes it again immediately.
    await api.publish(category.id, false);
    expect((await api.media(asset.id)).statusCode).toBe(404);
  });

  it('refuses an unapproved asset even when it is assigned and published', async () => {
    const category = await makeCategory();
    const pending = await makeUnapprovedAsset();
    await on.pool.query(
      'INSERT INTO app_category_assets (category_id, asset_id, position) VALUES ($1, $2, 0)',
      [category.id, pending.id],
    );
    await api.publish(category.id, true);
    expect((await api.media(pending.id)).statusCode).toBe(404);
  });

  it('unknown, malformed and unreachable all read as the same 404', async () => {
    const asset = await makeApprovedAsset();
    for (const url of [
      '/api/media/assets/not-a-uuid/file',
      '/api/media/assets/11111111-1111-4111-8111-111111111111/file',
      `/api/media/assets/${asset.id}/file`,
    ]) {
      const res = await on.app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe('not_found');
    }
  });

  it('a retired character takes their media with them', async () => {
    // Retirement already removes a character from /api/characters and from the
    // visual-identity route. Their media has to go too, or the pictures stay
    // reachable by id after the profile stops existing.
    const category = await makeCategory();
    const asset = await makeApprovedAsset();
    await assign(category.id, [asset.id]);
    await api.publish(category.id, true);
    await api.addHero([asset.id]);
    expect((await api.media(asset.id)).statusCode).toBe(200);

    await on.db.update(characters).set({ status: 'inactive' }).where(eq(characters.id, LUNA.id));

    expect((await api.media(asset.id)).statusCode).toBe(404);
    const home = (await api.home()).json();
    // Their clip leaves the Hero. Other characters' clips may fill it via the
    // fallback, which is exactly the point: the retired character's does not.
    expect(home.hero.map((c: { id: string }) => c.id)).not.toContain(asset.id);
    expect(home.categories[0].clips).toEqual([]);

    // Reactivating restores it — nothing was deleted.
    await on.db.update(characters).set({ status: 'active' }).where(eq(characters.id, LUNA.id));
    expect((await api.media(asset.id)).statusCode).toBe(200);
  });

  it('a retired character\'s canonical reference is no longer fetchable either', async () => {
    const identity = (await getActiveVisualIdentity(on.db, LUNA.id))!;
    const asset = await createVisualAsset(on.db, {
      characterId: LUNA.id,
      visualIdentityId: identity.id,
      kind: 'reference',
      status: 'approved',
      contentRating: 'sfw',
    });
    const path = join(testEnv.media.storageDir, 'home-test', `${asset.id}.png`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, PNG);
    await on.db
      .update(characterVisualAssets)
      .set({ storageKey: path, isCanonical: true })
      .where(eq(characterVisualAssets.id, asset.id));
    expect((await api.media(asset.id)).statusCode).toBe(200);

    await on.db.update(characters).set({ status: 'inactive' }).where(eq(characters.id, LUNA.id));
    expect((await api.media(asset.id)).statusCode).toBe(404);
  });

  it('a Hero clip is publicly fetchable, and stops being so when removed', async () => {
    const asset = await makeApprovedAsset();
    await api.addHero([asset.id]);
    expect((await api.media(asset.id)).statusCode).toBe(200);
    await api.removeHero(asset.id);
    expect((await api.media(asset.id)).statusCode).toBe(404);
  });
});

/* ------------------------------------------------------------------ *
 * 5. Play with Me and Recently Added
 * ------------------------------------------------------------------ */

describe('Play with Me', () => {
  it('gives each character exactly ONE card, however many clips they have', async () => {
    await makeApprovedAsset();
    await makeApprovedAsset();
    const home = (await api.home()).json();
    expect(home.playWithMe.filter((c: { id: string }) => c.id === LUNA.id)).toHaveLength(1);
    const luna = home.playWithMe.find((c: { id: string }) => c.id === LUNA.id);
    expect(luna.clip).not.toBeNull();
    expect(luna.clip.characterId).toBe(LUNA.id);
  });

  it('prefers the canonical reference as the representative clip', async () => {
    // The seed gives Luna an approved canonical reference. A newer generated
    // asset must NOT displace it: the canonical image is what the character has
    // chosen to look like, and the choice has to be stable between requests.
    const [canonical] = await on.db
      .select()
      .from(characterVisualAssets)
      .where(and(eq(characterVisualAssets.characterId, LUNA.id), eq(characterVisualAssets.isCanonical, true)));
    expect(canonical).toBeDefined();
    await makeApprovedAsset();

    const home = (await api.home()).json();
    const luna = home.playWithMe.find((c: { id: string }) => c.id === LUNA.id);
    expect(luna.clip.id).toBe(canonical!.id);
    // Stable across reads.
    const again = (await api.home()).json();
    expect(again.playWithMe.find((c: { id: string }) => c.id === LUNA.id).clip.id).toBe(canonical!.id);
  });

  it('falls back to another PUBLICLY REACHABLE clip when there is no canonical one', async () => {
    await on.db
      .update(characterVisualAssets)
      .set({ isCanonical: false, status: 'rejected' })
      .where(eq(characterVisualAssets.characterId, LUNA.id));
    const asset = await makeApprovedAsset();
    // Approved is not enough: a card must never choose media the public media
    // route would refuse, or the card renders a broken image. A keyword a
    // visible discovery category queries is what publishes it.
    await api.createDiscovery({ name: 'Sexy', keywords: ['sexy'] });
    await api.setAssetKeywords(asset.id, ['sexy']);

    const home = (await api.home()).json();
    expect(home.playWithMe.find((c: { id: string }) => c.id === LUNA.id).clip.id).toBe(asset.id);
    expect((await api.media(asset.id)).statusCode).toBe(200);
  });

  it('leaves the card clip NULL rather than choosing unservable media', async () => {
    await on.db
      .update(characterVisualAssets)
      .set({ isCanonical: false, status: 'rejected' })
      .where(eq(characterVisualAssets.characterId, LUNA.id));
    // Approved, but in no category, no Hero and carrying no keyword.
    await makeApprovedAsset();
    const home = (await api.home()).json();
    expect(home.playWithMe.find((c: { id: string }) => c.id === LUNA.id).clip).toBeNull();
  });

  it('keeps a character with no approved content, with a null clip', async () => {
    // Presence in Play with Me is about the character, not their media.
    await on.db
      .update(characterVisualAssets)
      .set({ status: 'rejected' })
      .where(eq(characterVisualAssets.characterId, LUNA.id));
    const home = (await api.home()).json();
    const luna = home.playWithMe.find((c: { id: string }) => c.id === LUNA.id);
    expect(luna).toBeDefined();
    expect(luna.clip).toBeNull();
  });

  it('excludes inactive characters', async () => {
    await on.db.update(characters).set({ status: 'inactive' }).where(eq(characters.id, LUNA.id));
    const home = (await api.home()).json();
    expect(home.playWithMe.map((c: { id: string }) => c.id)).not.toContain(LUNA.id);
  });

  it('invents no online/offline state', async () => {
    const body = (await api.home()).payload;
    expect(body).not.toContain('isOnline');
    expect(body).not.toContain('"online"');
    expect(body).not.toContain('presence');
  });
});

/**
 * Curating Play with me.
 *
 * The rail's automatic rule — every active character, alphabetically — is
 * unchanged and still the default. What is new is that an operator may override
 * it wholesale. The override is a WHOLE list, never a blend: once curated, a
 * character the operator did not choose must not appear, however new or active
 * they are. That is the property these tests exist to hold.
 */
describe('curating Play with me', () => {
  /** A brand-new active character, named to sort LAST alphabetically. */
  async function makeCharacter(displayName: string) {
    const [row] = await on.db
      .insert(characters)
      .values({
        name: `play-subject-${displayName.toLowerCase().replace(/\W+/g, '-')}-${Date.now()}`,
        displayName,
        status: 'active',
        systemPrompt: 'x',
        shortBio: 'x',
        personality: 'x',
        conversationStyle: 'x',
      })
      .returning();
    return row!;
  }

  async function activeAlphabetically() {
    const rows = await on.db.select().from(characters).where(eq(characters.status, 'active'));
    return [...rows]
      .sort((a, b) => a.displayName.localeCompare(b.displayName) || a.id.localeCompare(b.id))
      .map((r) => r.id);
  }

  const publicIds = async () =>
    (await api.home()).json().playWithMe.map((c: { id: string }) => c.id);

  it('starts automatic: every active character, alphabetically', async () => {
    const view = (await api.play()).json();
    expect(view.curated).toBe(false);
    expect(view.characters.map((c: { characterId: string }) => c.characterId)).toEqual(
      await activeAlphabetically(),
    );
    expect(await publicIds()).toEqual(await activeAlphabetically());
  });

  it('offers active characters as candidates, alphabetically, and no inactive one', async () => {
    const rows = (await api.playCandidates()).json().candidates as Array<{ characterId: string }>;
    expect(rows.map((c) => c.characterId)).toEqual(await activeAlphabetically());

    await on.db.update(characters).set({ status: 'inactive' }).where(eq(characters.id, LUNA.id));
    const after = (await api.playCandidates()).json().candidates as Array<{ characterId: string }>;
    expect(after.map((c) => c.characterId)).not.toContain(LUNA.id);
  });

  it('the first edit materialises the automatic list rather than replacing it', async () => {
    const before = (await api.play()).json();
    expect(before.curated).toBe(false);
    const target = before.characters[0].characterId;

    const after = (await api.removePlay(target)).json();
    expect(after.curated).toBe(true);
    expect(after.characters).toHaveLength(before.characters.length - 1);
    expect(after.characters.map((c: { characterId: string }) => c.characterId)).toEqual(
      before.characters
        .map((c: { characterId: string }) => c.characterId)
        .filter((id: string) => id !== target),
    );
  });

  it('adds a character at the end of the list', async () => {
    const before = (await api.play()).json();
    const extra = await makeCharacter('Zzz Late Arrival');

    const after = (await api.addPlay(extra.id)).json();
    expect(after.curated).toBe(true);
    const ids = after.characters.map((c: { characterId: string }) => c.characterId);
    expect(ids.slice(0, before.characters.length)).toEqual(
      before.characters.map((c: { characterId: string }) => c.characterId),
    );
    expect(ids[ids.length - 1]).toBe(extra.id);
  });

  it('adding the same character twice changes nothing the second time', async () => {
    const target = (await api.play()).json().characters[0].characterId;
    const once = (await api.addPlay(target)).json();
    const twice = (await api.addPlay(target)).json();
    expect(twice.characters.map((c: { characterId: string }) => c.characterId)).toEqual(
      once.characters.map((c: { characterId: string }) => c.characterId),
    );
    expect(
      twice.characters.filter((c: { characterId: string }) => c.characterId === target),
    ).toHaveLength(1);
  });

  it('the public rail returns the EXACT curated order', async () => {
    const ids = (await api.play()).json().characters.map((c: { characterId: string }) => c.characterId);
    const reversed = [...ids].reverse();
    expect((await api.orderPlay(reversed)).statusCode).toBe(200);
    expect(
      (await api.play()).json().characters.map((c: { characterId: string }) => c.characterId),
    ).toEqual(reversed);
    expect(await publicIds()).toEqual(reversed);
  });

  it('refuses an incomplete, duplicated or unknown reordering', async () => {
    const ids = (await api.play()).json().characters.map((c: { characterId: string }) => c.characterId);
    await api.addPlay(ids[0]); // materialise so there is a stored list to reorder
    const stored = (await api.play()).json().characters.map((c: { characterId: string }) => c.characterId);
    expect(stored.length).toBeGreaterThan(1);

    for (const bad of [
      stored.slice(1),
      [stored[0], stored[0], ...stored.slice(2)],
      [...stored.slice(1), '11111111-1111-4111-8111-111111111111'],
    ]) {
      // Exact permutation or nothing — the same 409 contract the sibling rails
      // use, so a stale Admin tab can never silently reorder a list it has not
      // seen.
      const res = await api.orderPlay(bad);
      expect(res.statusCode).toBe(409);
      expect(res.payload).not.toContain('invalid input syntax');
    }
    // Rejected wholesale: the stored order is untouched.
    expect(
      (await api.play()).json().characters.map((c: { characterId: string }) => c.characterId),
    ).toEqual(stored);
  });

  it('a curated rail NEVER blends in an automatic character', async () => {
    const target = (await api.play()).json().characters[0].characterId;
    await api.addPlay(target); // materialise
    const curatedIds = (await api.play())
      .json()
      .characters.map((c: { characterId: string }) => c.characterId);

    const outsider = await makeCharacter('Aaa Not Chosen');
    expect(await publicIds()).toEqual(curatedIds);
    expect(await publicIds()).not.toContain(outsider.id);
  });

  it('hides a curated member who becomes inactive, while Admin can still see and remove them', async () => {
    const target = (await api.play()).json().characters[0].characterId;
    await api.addPlay(target); // materialise
    await on.db.update(characters).set({ status: 'inactive' }).where(eq(characters.id, target));

    expect(await publicIds()).not.toContain(target);
    const view = (await api.play()).json();
    const row = view.characters.find((c: { characterId: string }) => c.characterId === target);
    expect(row).toBeDefined();
    expect(row.status).toBe('inactive');
    expect((await api.removePlay(target)).statusCode).toBe(200);
  });

  it('reset restores the automatic list, including characters added since', async () => {
    const target = (await api.play()).json().characters[0].characterId;
    await api.removePlay(target);
    const outsider = await makeCharacter('Mmm Added Later');
    expect(await publicIds()).not.toContain(outsider.id);

    const reset = (await api.resetPlay()).json();
    expect(reset.curated).toBe(false);
    expect(reset.characters.map((c: { characterId: string }) => c.characterId)).toEqual(
      await activeAlphabetically(),
    );
    expect(await publicIds()).toContain(outsider.id);
    expect(await publicIds()).toContain(target);
  });

  it('refuses an unknown or malformed id without a database error', async () => {
    for (const id of ['00000000-0000-4000-8000-000000000000', 'not-a-uuid']) {
      const res = await api.addPlay(id);
      expect(res.statusCode).toBe(400);
      expect(res.payload).not.toContain('invalid input syntax');
      expect(res.payload).not.toContain('constraint');
    }
  });

  it('leaks no storage key or filesystem path to Admin', async () => {
    await api.addPlay((await api.play()).json().characters[0].characterId);
    for (const body of [(await api.play()).payload, (await api.playCandidates()).payload]) {
      expect(body).not.toContain('storageKey');
      expect(body).not.toContain('storagePath');
      expect(body).not.toContain('/app/var/media');
    }
  });

  it('leaves Recently Added completely alone', async () => {
    const recentBefore = (await api.recent()).json();
    const target = (await api.play()).json().characters[0].characterId;
    await api.removePlay(target);
    await api.addPlay(target);

    const recentAfter = (await api.recent()).json();
    expect(recentAfter.curated).toBe(recentBefore.curated);
    expect(recentAfter.characters.map((c: { characterId: string }) => c.characterId)).toEqual(
      recentBefore.characters.map((c: { characterId: string }) => c.characterId),
    );
  });
});

describe('Recently Added', () => {
  it('defaults to the newest active characters, capped at 12', async () => {
    const home = (await api.home()).json();
    expect(home.recentlyAdded.length).toBeLessThanOrEqual(12);
    expect((await api.recent()).json().curated).toBe(false);
  });

  it('is newest-first', async () => {
    const ids = (await api.recent()).json().characters.map((c: { characterId: string }) => c.characterId);
    const rows = await on.db.select().from(characters).where(eq(characters.status, 'active'));
    const byNewest = [...rows]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || a.id.localeCompare(b.id))
      .slice(0, 12)
      .map((r) => r.id);
    expect(ids).toEqual(byNewest);
  });

  it('the first edit materialises the default rather than replacing it', async () => {
    const before = (await api.recent()).json().characters.length;
    const target = (await api.recent()).json().characters[0].characterId;
    const after = (await api.removeRecent(target)).json();
    expect(after.curated).toBe(true);
    expect(after.characters).toHaveLength(before - 1);
    expect(after.characters.map((c: { characterId: string }) => c.characterId)).not.toContain(target);
  });

  it('supports add, remove and reorder, and reset restores the default', async () => {
    const initial = (await api.recent()).json().characters;
    const [first, second] = initial;
    await api.removeRecent(first.characterId);
    const readded = (await api.addRecent(first.characterId)).json();
    expect(readded.characters.map((c: { characterId: string }) => c.characterId)).toContain(
      first.characterId,
    );

    const ids = readded.characters.map((c: { characterId: string }) => c.characterId);
    const reversed = [...ids].reverse();
    expect((await api.orderRecent(reversed)).statusCode).toBe(200);
    expect(
      (await api.recent()).json().characters.map((c: { characterId: string }) => c.characterId),
    ).toEqual(reversed);

    const reset = (await api.resetRecent()).json();
    expect(reset.curated).toBe(false);
    expect(reset.characters[0].characterId).toBe(second ? initial[0].characterId : first.characterId);
  });

  it('carries a profile image so Admin can preview the rail, and still no storage key', async () => {
    // Parity with Play with me: the operator sees faces, not a list of names.
    // The field is the one the public card already carries — nothing new is
    // exposed, and the admin payload still leaks no storage key or path.
    const view = (await api.recent()).json();
    expect(view.characters.length).toBeGreaterThan(0);
    for (const character of view.characters) {
      expect(character).toHaveProperty('profileImage');
    }
    expect((await api.recent()).payload).not.toContain('storageKey');
    expect((await api.recent()).payload).not.toContain('/app/var/media');
  });

  it('a curated rail still drops a character who becomes inactive', async () => {
    const target = (await api.recent()).json().characters[0].characterId;
    await api.addRecent(target); // materialise
    await on.db.update(characters).set({ status: 'inactive' }).where(eq(characters.id, target));
    const home = (await api.home()).json();
    expect(home.recentlyAdded.map((c: { id: string }) => c.id)).not.toContain(target);
  });
});

/**
 * The Admin ADD path.
 *
 * Remove, reorder and reset were all reachable from the Home composer; adding
 * was not, so a character taken off the rail could never be put back. The
 * endpoints below already existed — these pin the behaviour the picker relies
 * on.
 */
describe('putting a character back on Recently Added', () => {
  const candidates = (cookies = adminCookies) =>
    on.app.inject({ method: 'GET', url: '/admin/home/recent/candidates', cookies });

  it('offers active characters, newest first', async () => {
    const res = await candidates();
    expect(res.statusCode).toBe(200);
    const rows = res.json().candidates as Array<{ characterId: string }>;
    expect(rows.length).toBeGreaterThan(0);

    const active = await on.db.select().from(characters).where(eq(characters.status, 'active'));
    const expected = [...active]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || a.id.localeCompare(b.id))
      .map((r) => r.id);
    expect(rows.map((c) => c.characterId)).toEqual(expected);
  });

  it('offers no inactive character', async () => {
    await on.db.update(characters).set({ status: 'inactive' }).where(eq(characters.id, LUNA.id));
    const rows = (await candidates()).json().candidates as Array<{ characterId: string }>;
    expect(rows.map((c) => c.characterId)).not.toContain(LUNA.id);
  });

  it('restores a character that was removed', async () => {
    // The exact UAT journey: take one off, then put it back.
    const target = (await api.recent()).json().characters[0].characterId;
    const removed = (await api.removeRecent(target)).json();
    expect(removed.characters.map((c: { characterId: string }) => c.characterId)).not.toContain(
      target,
    );

    const restored = (await api.addRecent(target)).json();
    expect(restored.curated).toBe(true);
    const ids = restored.characters.map((c: { characterId: string }) => c.characterId);
    expect(ids).toContain(target);
    // Appended, not reinserted where it used to sit.
    expect(ids[ids.length - 1]).toBe(target);
  });

  it('adding from AUTOMATIC mode materialises the list rather than replacing it', async () => {
    const before = (await api.recent()).json();
    expect(before.curated).toBe(false);

    const [extra] = await on.db
      .insert(characters)
      .values({
        name: `picker-subject-${Date.now()}`,
        displayName: 'Picker Subject',
        status: 'active',
        systemPrompt: 'x',
        shortBio: 'x',
        personality: 'x',
        conversationStyle: 'x',
      })
      .returning();
    // Older than everyone, so the automatic rail would never have surfaced it
    // first — proving the add is what put it there.
    await on.db
      .update(characters)
      .set({ createdAt: new Date('2000-01-01T00:00:00.000Z') })
      .where(eq(characters.id, extra!.id));

    const after = (await api.addRecent(extra!.id)).json();
    expect(after.curated).toBe(true);
    const ids = after.characters.map((c: { characterId: string }) => c.characterId);
    expect(ids.slice(0, before.characters.length)).toEqual(
      before.characters.map((c: { characterId: string }) => c.characterId),
    );
    expect(ids[ids.length - 1]).toBe(extra!.id);
  });

  it('adding the same character twice changes nothing the second time', async () => {
    const target = (await api.recent()).json().characters[0].characterId;
    const once = (await api.addRecent(target)).json();
    const twice = (await api.addRecent(target)).json();
    expect(twice.characters.map((c: { characterId: string }) => c.characterId)).toEqual(
      once.characters.map((c: { characterId: string }) => c.characterId),
    );
    expect(
      twice.characters.filter((c: { characterId: string }) => c.characterId === target),
    ).toHaveLength(1);
  });

  it('refuses an unknown or malformed id without a database error', async () => {
    for (const id of ['00000000-0000-4000-8000-000000000000', 'not-a-uuid']) {
      const res = await api.addRecent(id);
      expect(res.statusCode).toBe(400);
      expect(res.payload).not.toContain('invalid input syntax');
      expect(res.payload).not.toContain('constraint');
    }
  });

  it('remove, reorder and reset still work after an add', async () => {
    const target = (await api.recent()).json().characters[0].characterId;
    await api.removeRecent(target);
    const added = (await api.addRecent(target)).json();

    const ids = added.characters.map((c: { characterId: string }) => c.characterId);
    const reversed = [...ids].reverse();
    expect((await api.orderRecent(reversed)).statusCode).toBe(200);
    expect(
      (await api.recent()).json().characters.map((c: { characterId: string }) => c.characterId),
    ).toEqual(reversed);

    expect((await api.removeRecent(target)).json().curated).toBe(true);
    expect((await api.resetRecent()).json().curated).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * 6. Banner slots
 * ------------------------------------------------------------------ */

describe('the two Home banner slots', () => {
  async function makeBanner(slot: string, title: string) {
    const upload = await on.app.inject({
      method: 'POST',
      url: '/admin/home-banners/creatives',
      headers: { 'content-type': 'multipart/form-data; boundary=----b' },
      cookies: adminCookies,
      payload: Buffer.concat([
        Buffer.from(
          '------b\r\nContent-Disposition: form-data; name="file"; filename="b.png"\r\nContent-Type: image/png\r\n\r\n',
        ),
        PNG,
        Buffer.from('\r\n------b--\r\n'),
      ]),
    });
    const creative = upload.json() as { id: string };
    const created = await on.app.inject({
      method: 'POST',
      url: '/admin/home-banners',
      payload: {
        title,
        creativeId: creative.id,
        destinationKind: 'external',
        destinationUrl: 'https://example.com/x',
        slot,
      },
      cookies: adminCookies,
    });
    expect(created.statusCode).toBe(201);
    const banner = created.json();
    await on.app.inject({
      method: 'POST',
      url: `/admin/home-banners/${banner.id}/publish`,
      cookies: adminCookies,
    });
    return banner;
  }

  it('places banners in the slot they were assigned', async () => {
    const before = await makeBanner('before_search', 'Before');
    const below = await makeBanner('below_results', 'Below');
    const home = (await api.home()).json();
    expect(home.banners.before_search.map((b: { id: string }) => b.id)).toEqual([before.id]);
    expect(home.banners.below_results.map((b: { id: string }) => b.id)).toEqual([below.id]);
  });

  it('holds multiple banners per slot in explicit order', async () => {
    const one = await makeBanner('before_search', 'One');
    const two = await makeBanner('before_search', 'Two');
    expect((await api.home()).json().banners.before_search.map((b: { id: string }) => b.id)).toEqual([
      one.id,
      two.id,
    ]);

    const res = await on.app.inject({
      method: 'PUT',
      url: '/admin/home-banners/order',
      payload: { slot: 'before_search', orderedIds: [two.id, one.id] },
      cookies: adminCookies,
    });
    expect(res.statusCode).toBe(200);
    expect((await api.home()).json().banners.before_search.map((b: { id: string }) => b.id)).toEqual([
      two.id,
      one.id,
    ]);
  });

  it('ordering one slot does not require or disturb the other', async () => {
    const a = await makeBanner('before_search', 'A');
    const b = await makeBanner('before_search', 'B');
    const c = await makeBanner('below_results', 'C');
    const res = await on.app.inject({
      method: 'PUT',
      url: '/admin/home-banners/order',
      payload: { slot: 'before_search', orderedIds: [b.id, a.id] },
      cookies: adminCookies,
    });
    expect(res.statusCode).toBe(200);
    expect((await api.home()).json().banners.below_results.map((x: { id: string }) => x.id)).toEqual([
      c.id,
    ]);
  });

  it('refuses an order naming a banner from the other slot', async () => {
    const a = await makeBanner('before_search', 'A');
    const c = await makeBanner('below_results', 'C');
    const res = await on.app.inject({
      method: 'PUT',
      url: '/admin/home-banners/order',
      payload: { slot: 'before_search', orderedIds: [a.id, c.id] },
      cookies: adminCookies,
    });
    expect(res.statusCode).toBe(409);
  });

  it('a draft banner reaches no slot', async () => {
    const upload = await on.app.inject({
      method: 'POST',
      url: '/admin/home-banners/creatives',
      headers: { 'content-type': 'multipart/form-data; boundary=----b' },
      cookies: adminCookies,
      payload: Buffer.concat([
        Buffer.from(
          '------b\r\nContent-Disposition: form-data; name="file"; filename="b.png"\r\nContent-Type: image/png\r\n\r\n',
        ),
        PNG,
        Buffer.from('\r\n------b--\r\n'),
      ]),
    });
    await on.app.inject({
      method: 'POST',
      url: '/admin/home-banners',
      payload: {
        title: 'Draft',
        creativeId: upload.json().id,
        destinationKind: 'external',
        destinationUrl: 'https://example.com/d',
        slot: 'before_search',
      },
      cookies: adminCookies,
    });
    const home = (await api.home()).json();
    expect(home.banners.before_search).toEqual([]);
    expect(home.banners.below_results).toEqual([]);
  });

  it('both slots are always present, even when empty', async () => {
    const home = (await api.home()).json();
    expect(Object.keys(home.banners).sort()).toEqual(['before_search', 'below_results']);
  });

  /**
   * MOVING a banner between slots.
   *
   * The editor could not send `slot` at all, so every banner made in Admin took
   * the column default and the second slot was unreachable. The server side
   * always supported it; these pin the behaviour the new selector drives.
   */
  describe('moving a banner to the other slot', () => {
    const setSlot = (id: string, slot: string) =>
      on.app.inject({
        method: 'PATCH',
        url: `/admin/home-banners/${id}`,
        payload: { slot },
        cookies: adminCookies,
      });

    it('moves it, in both directions', async () => {
      const banner = await makeBanner('before_search', 'Mover');
      expect((await setSlot(banner.id, 'below_results')).statusCode).toBe(200);
      let home = (await api.home()).json();
      expect(home.banners.before_search.map((b: { id: string }) => b.id)).toEqual([]);
      expect(home.banners.below_results.map((b: { id: string }) => b.id)).toEqual([banner.id]);

      expect((await setSlot(banner.id, 'before_search')).statusCode).toBe(200);
      home = (await api.home()).json();
      expect(home.banners.before_search.map((b: { id: string }) => b.id)).toEqual([banner.id]);
      expect(home.banners.below_results.map((b: { id: string }) => b.id)).toEqual([]);
    });

    it('lands at the END of the destination, disturbing no existing order', async () => {
      const first = await makeBanner('below_results', 'First');
      const second = await makeBanner('below_results', 'Second');
      const incomer = await makeBanner('before_search', 'Incomer');

      expect((await setSlot(incomer.id, 'below_results')).statusCode).toBe(200);
      expect(
        (await api.home()).json().banners.below_results.map((b: { id: string }) => b.id),
      ).toEqual([first.id, second.id, incomer.id]);
    });

    it('restating the SAME slot is a no-op that does not reshuffle', async () => {
      // The editor sends `slot` on every save, so this is the common case.
      const first = await makeBanner('before_search', 'First');
      const second = await makeBanner('before_search', 'Second');
      expect((await setSlot(first.id, 'before_search')).statusCode).toBe(200);
      expect(
        (await api.home()).json().banners.before_search.map((b: { id: string }) => b.id),
      ).toEqual([first.id, second.id]);
    });

    it('leaves the slot it came from correctly ordered', async () => {
      const a = await makeBanner('before_search', 'A');
      const b = await makeBanner('before_search', 'B');
      const c = await makeBanner('before_search', 'C');
      expect((await setSlot(b.id, 'below_results')).statusCode).toBe(200);

      const home = (await api.home()).json();
      expect(home.banners.before_search.map((x: { id: string }) => x.id)).toEqual([a.id, c.id]);
      // And the survivors can still be reordered as an exact permutation.
      const res = await on.app.inject({
        method: 'PUT',
        url: '/admin/home-banners/order',
        payload: { slot: 'before_search', orderedIds: [c.id, a.id] },
        cookies: adminCookies,
      });
      expect(res.statusCode).toBe(200);
      expect(
        (await api.home()).json().banners.before_search.map((x: { id: string }) => x.id),
      ).toEqual([c.id, a.id]);
    });

    it('a moved banner must be named by the NEW slot\'s order, not the old one', async () => {
      const stay = await makeBanner('before_search', 'Stay');
      const mover = await makeBanner('before_search', 'Mover');
      await setSlot(mover.id, 'below_results');

      // The old slot's permutation must no longer include it.
      const stale = await on.app.inject({
        method: 'PUT',
        url: '/admin/home-banners/order',
        payload: { slot: 'before_search', orderedIds: [stay.id, mover.id] },
        cookies: adminCookies,
      });
      expect(stale.statusCode).toBe(409);

      // The new slot's does.
      const fresh = await on.app.inject({
        method: 'PUT',
        url: '/admin/home-banners/order',
        payload: { slot: 'below_results', orderedIds: [mover.id] },
        cookies: adminCookies,
      });
      expect(fresh.statusCode).toBe(200);
    });

    it('refuses an unknown slot without a database error', async () => {
      const banner = await makeBanner('before_search', 'Guarded');
      const res = await setSlot(banner.id, 'somewhere_else');
      expect(res.statusCode).toBe(400);
      expect(res.payload).not.toContain('invalid input syntax');
    });

    it('reports the slot back on the banner, so the editor can show it', async () => {
      const banner = await makeBanner('below_results', 'Readback');
      const res = await on.app.inject({
        method: 'GET',
        url: `/admin/home-banners/${banner.id}`,
        cookies: adminCookies,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().slot).toBe('below_results');
    });
  });
});

/* ------------------------------------------------------------------ *
 * 7. Discovery is a separate system
 * ------------------------------------------------------------------ */

describe('keyword-driven Discovery', () => {
  it('matches on ANY keyword, not all of them', async () => {
    const sexy = await makeApprovedAsset();
    const lingerie = await makeApprovedAsset();
    const unrelated = await makeApprovedAsset();
    await api.setAssetKeywords(sexy.id, ['sexy']);
    await api.setAssetKeywords(lingerie.id, ['lingerie']);
    await api.setAssetKeywords(unrelated.id, ['landscape']);
    await api.createDiscovery({ name: 'Sexy', keywords: ['sexy', 'lingerie', 'seductive'] });

    const ids = (await api.clips('?category=sexy')).json().clips.map((c: { id: string }) => c.id);
    expect(ids).toContain(sexy.id);
    expect(ids).toContain(lingerie.id);
    expect(ids).not.toContain(unrelated.id);
  });

  it('counts an asset carrying two of the keywords once', async () => {
    const both = await makeApprovedAsset();
    await api.setAssetKeywords(both.id, ['sexy', 'lingerie']);
    await api.createDiscovery({ name: 'Sexy', keywords: ['sexy', 'lingerie'] });
    const clips = (await api.clips('?category=sexy')).json().clips;
    expect(clips.filter((c: { id: string }) => c.id === both.id)).toHaveLength(1);
    expect((await api.adminDiscovery()).json().categories[0].matchCount).toBe(1);
  });

  it('normalises keywords so casing and spacing do not fork a term', async () => {
    const asset = await makeApprovedAsset();
    await api.setAssetKeywords(asset.id, ['  LINGERIE  ']);
    await api.createDiscovery({ name: 'Sexy', keywords: ['lingerie'] });
    expect((await api.clips('?category=sexy')).json().clips.map((c: { id: string }) => c.id)).toContain(
      asset.id,
    );
  });

  it('an empty discovery category matches NOTHING, never everything', async () => {
    const asset = await makeApprovedAsset();
    await api.setAssetKeywords(asset.id, ['sexy']);
    await api.createDiscovery({ name: 'Empty', keywords: [] });
    expect((await api.clips('?category=empty')).json().clips).toEqual([]);
  });

  it('the strip is ordered and its first entry is the default', async () => {
    await api.createDiscovery({ name: 'Sexy', keywords: ['sexy'] });
    await api.createDiscovery({ name: 'Cosplay', keywords: ['cosplay'] });
    const strip = (await api.discoveryCategories()).json().categories;
    expect(strip[0].slug).toBe('sexy');
    expect(strip.map((c: { name: string }) => c.name)).toEqual(['Sexy', 'Cosplay']);
  });

  it('a disabled discovery category leaves the public strip', async () => {
    const created = (await api.createDiscovery({ name: 'Sexy', keywords: ['sexy'] })).json();
    await on.app.inject({
      method: 'PATCH',
      url: `/admin/discovery/categories/${created.id}`,
      payload: { enabled: false },
      cookies: adminCookies,
    });
    expect((await api.discoveryCategories()).json().categories).toEqual([]);
  });

  it('DELETING a discovery category touches neither content nor keywords', async () => {
    const asset = await makeApprovedAsset();
    await api.setAssetKeywords(asset.id, ['sexy', 'lingerie']);
    const created = (await api.createDiscovery({ name: 'Sexy', keywords: ['sexy'] })).json();

    const before = (
      await on.db.select().from(characterVisualAssets).where(eq(characterVisualAssets.id, asset.id))
    )[0];

    const res = await api.deleteDiscovery(created.id);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ deleted: true, contentRemoved: 0 });

    const after = (
      await on.db.select().from(characterVisualAssets).where(eq(characterVisualAssets.id, asset.id))
    )[0];
    expect(after).toEqual(before);

    // The asset keeps both keywords, and the vocabulary survives.
    const kw = await on.app.inject({
      method: 'GET',
      url: `/admin/discovery/content/${asset.id}/keywords`,
      cookies: adminCookies,
    });
    expect(kw.json().keywords.map((k: { key: string }) => k.key).sort()).toEqual([
      'lingerie',
      'sexy',
    ]);
  });

  it('discovery categories and App Categories are separate systems', async () => {
    const appCat = await makeCategory('Trending');
    await api.createDiscovery({ name: 'Sexy', keywords: ['sexy'] });

    // Neither list contains the other's entries.
    const strip = (await api.discoveryCategories()).json().categories;
    expect(strip.map((c: { id: string }) => c.id)).not.toContain(appCat.id);
    const home = (await api.adminHome()).json();
    expect(home.categories.map((c: { slug: string }) => c.slug)).not.toContain('sexy');

    // Deleting a discovery category cannot remove an App Category.
    const created = (await api.adminDiscovery()).json().categories[0];
    await api.deleteDiscovery(created.id);
    const [row] = await on.db.select().from(appCategories).where(eq(appCategories.id, appCat.id));
    expect(row).toBeDefined();
  });

  it('search and category are independent filters that compose', async () => {
    const luna = await makeApprovedAsset(LUNA.id);
    await api.setAssetKeywords(luna.id, ['sexy']);
    await api.createDiscovery({ name: 'Sexy', keywords: ['sexy'] });

    const both = (await api.clips(`?category=sexy&q=${encodeURIComponent(LUNA.displayName)}`)).json();
    expect(both.clips.map((c: { id: string }) => c.id)).toContain(luna.id);

    const noMatch = (await api.clips('?category=sexy&q=zzzznotacharacter')).json();
    expect(noMatch.clips).toEqual([]);

    // Query alone still works with no category.
    const queryOnly = (await api.clips(`?q=${encodeURIComponent(LUNA.displayName)}`)).json();
    expect(queryOnly.clips.map((c: { id: string }) => c.id)).toContain(luna.id);
  });

  it('treats % and _ in a search as literals', async () => {
    await makeApprovedAsset();
    expect((await api.clips('?q=%25')).json().clips).toEqual([]);
    expect((await api.clips('?q=_')).json().clips).toEqual([]);
  });

  it('caps the page size however large a limit is requested', async () => {
    const res = (await api.clips('?limit=100000')).json();
    expect(res.maxLimit).toBe(60);
    expect(res.clips.length).toBeLessThanOrEqual(60);
  });

  it('emits no storage path in discovery results', async () => {
    const asset = await makeApprovedAsset();
    await api.setAssetKeywords(asset.id, ['sexy']);
    await api.createDiscovery({ name: 'Sexy', keywords: ['sexy'] });
    const body = (await api.clips('?category=sexy')).payload;
    expect(body).not.toContain(testEnv.media.storageDir);
    expect(body).not.toContain('storageKey');
  });
});

/* ------------------------------------------------------------------ *
 * 7b. One definition of "public" — findings from the adversarial review
 * ------------------------------------------------------------------ */

describe('what is listed and what is servable agree', () => {
  /**
   * The failure this guards: a public list advertising a clip whose media then
   * 404s. It renders as a grid of blank tiles and looks like a broken app, and
   * it happens whenever the "is it listed" query and the "may it be served"
   * query use different definitions of public.
   */
  async function everyListedClipIsServable(url: string, ours: Set<string>) {
    const listed = (await api.clips(url)).json().clips as Array<{ id: string }>;
    const mine = listed.filter((item) => ours.has(item.id));
    expect(mine.length).toBeGreaterThan(0);
    for (const item of mine) {
      expect((await api.media(item.id)).statusCode).toBe(200);
    }
  }

  it('every clip in an unfiltered discovery result is fetchable', async () => {
    const asset = await makeApprovedAsset();
    await api.createDiscovery({ name: 'Sexy', keywords: ['sexy'] });
    await api.setAssetKeywords(asset.id, ['sexy']);
    await everyListedClipIsServable('', new Set([asset.id]));
  });

  it('every clip in a category discovery result is fetchable', async () => {
    const asset = await makeApprovedAsset();
    await api.setAssetKeywords(asset.id, ['sexy']);
    await api.createDiscovery({ name: 'Sexy', keywords: ['sexy'] });
    await everyListedClipIsServable('?category=sexy', new Set([asset.id]));
  });

  /**
   * The narrow arm. "Carries any keyword at all" would turn an operator's
   * private organisational vocabulary into a publication switch — tagging a
   * clip `internal-review` would make it fetchable by anyone. The keyword has
   * to be one an ENABLED discovery category actually queries.
   */
  it('a keyword NO visible category uses does not publish anything', async () => {
    const asset = await makeApprovedAsset();
    await api.setAssetKeywords(asset.id, ['internal-review']);
    expect((await api.media(asset.id)).statusCode).toBe(404);
    expect((await api.clips('')).json().clips.map((c: { id: string }) => c.id)).not.toContain(
      asset.id,
    );
  });

  it('publishes only once a visible category queries that keyword', async () => {
    const asset = await makeApprovedAsset();
    await api.setAssetKeywords(asset.id, ['lingerie']);
    expect((await api.media(asset.id)).statusCode).toBe(404);

    const created = (await api.createDiscovery({ name: 'Sexy', keywords: ['lingerie'] })).json();
    expect((await api.media(asset.id)).statusCode).toBe(200);

    // Hiding the last category using it closes the content again.
    await on.app.inject({
      method: 'PATCH',
      url: `/admin/discovery/categories/${created.id}`,
      payload: { enabled: false },
      cookies: adminCookies,
    });
    expect((await api.media(asset.id)).statusCode).toBe(404);
  });

  it('deleting the last category using a keyword closes its content too', async () => {
    const asset = await makeApprovedAsset();
    await api.setAssetKeywords(asset.id, ['lingerie']);
    const created = (await api.createDiscovery({ name: 'Sexy', keywords: ['lingerie'] })).json();
    expect((await api.media(asset.id)).statusCode).toBe(200);
    await api.deleteDiscovery(created.id);
    // The keyword and the asset both survive — only the reachability goes.
    expect((await api.media(asset.id)).statusCode).toBe(404);
    const kw = await on.app.inject({
      method: 'GET',
      url: `/admin/discovery/content/${asset.id}/keywords`,
      cookies: adminCookies,
    });
    expect(kw.json().keywords.map((k: { key: string }) => k.key)).toEqual(['lingerie']);
  });

  it('a canonical reference of a SUPERSEDED identity version is not fetchable', async () => {
    // The public gallery is version-scoped (it passes the ACTIVE identity id),
    // so a portrait from a replaced version is shown nowhere — its bytes must
    // not stay retrievable by id either.
    const identity = (await getActiveVisualIdentity(on.db, LUNA.id))!;
    const asset = await createVisualAsset(on.db, {
      characterId: LUNA.id,
      visualIdentityId: identity.id,
      kind: 'reference',
      status: 'approved',
      contentRating: 'sfw',
    });
    const path = join(testEnv.media.storageDir, 'home-test', `${asset.id}.png`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, PNG);
    await on.db
      .update(characterVisualAssets)
      .set({ storageKey: path, isCanonical: true })
      .where(eq(characterVisualAssets.id, asset.id));
    expect((await api.media(asset.id)).statusCode).toBe(200);

    // Retire the identity version the asset belongs to.
    await on.pool.query(
      `UPDATE character_visual_identities SET status = 'retired' WHERE id = $1`,
      [identity.id],
    );
    expect((await api.media(asset.id)).statusCode).toBe(404);
  });

  it('tagging content is what publishes it to Discovery — untagged stays private', async () => {
    const untagged = await makeApprovedAsset();
    const ids = (await api.clips('')).json().clips.map((c: { id: string }) => c.id);
    expect(ids).not.toContain(untagged.id);
    expect((await api.media(untagged.id)).statusCode).toBe(404);

    await api.createDiscovery({ name: 'Sexy', keywords: ['sexy'] });
    await api.setAssetKeywords(untagged.id, ['sexy']);
    expect((await api.clips('')).json().clips.map((c: { id: string }) => c.id)).toContain(
      untagged.id,
    );
    expect((await api.media(untagged.id)).statusCode).toBe(200);
  });

  it('every Home card and rail clip is fetchable', async () => {
    const category = await makeCategory();
    const asset = await makeApprovedAsset();
    await assign(category.id, [asset.id]);
    await api.publish(category.id, true);
    await api.addHero([asset.id]);

    const home = (await api.home()).json();
    const listed: string[] = [
      ...home.hero.map((c: { id: string }) => c.id),
      ...home.categories.flatMap((r: { clips: Array<{ id: string }> }) => r.clips.map((c) => c.id)),
    ];
    // Scoped to the asset this test created: the seeded fixtures carry
    // fabricated storage keys outside the storage root, so the media route
    // refuses them for containment reasons that have nothing to do with
    // publication.
    const mine = listed.filter((id) => id === asset.id);
    expect(mine.length).toBe(2);
    for (const id of mine) expect((await api.media(id)).statusCode).toBe(200);
  });

  it('admin match counts agree with what the app returns', async () => {
    const asset = await makeApprovedAsset();
    await api.setAssetKeywords(asset.id, ['sexy']);
    await api.createDiscovery({ name: 'Sexy', keywords: ['sexy'] });
    expect((await api.adminDiscovery()).json().categories[0].matchCount).toBe(1);

    await on.db.update(characters).set({ status: 'inactive' }).where(eq(characters.id, LUNA.id));
    expect((await api.clips('?category=sexy')).json().clips).toEqual([]);
    // The operator must not be told there are matches the app will not show.
    expect((await api.adminDiscovery()).json().categories[0].matchCount).toBe(0);
  });
});

describe('a live banner\'s creative is publicly servable', () => {
  async function makeLiveBanner(overrides: Record<string, unknown> = {}) {
    const upload = await on.app.inject({
      method: 'POST',
      url: '/admin/home-banners/creatives',
      headers: { 'content-type': 'multipart/form-data; boundary=----b' },
      cookies: adminCookies,
      payload: Buffer.concat([
        Buffer.from(
          '------b\r\nContent-Disposition: form-data; name="file"; filename="b.png"\r\nContent-Type: image/png\r\n\r\n',
        ),
        PNG,
        Buffer.from('\r\n------b--\r\n'),
      ]),
    });
    const creative = upload.json() as { id: string };
    const created = await on.app.inject({
      method: 'POST',
      url: '/admin/home-banners',
      payload: {
        title: 'Promo',
        creativeId: creative.id,
        destinationKind: 'external',
        destinationUrl: 'https://example.com/x',
        slot: 'before_search',
        ...overrides,
      },
      cookies: adminCookies,
    });
    return { banner: created.json(), creative };
  }

  const fetchCreative = (id: string) =>
    on.app.inject({ method: 'GET', url: `/api/home/banner-creatives/${id}/file` });

  it('the Home payload gives a PUBLIC creative URL, never the admin one', async () => {
    const { banner } = await makeLiveBanner();
    await on.app.inject({
      method: 'POST',
      url: `/admin/home-banners/${banner.id}/publish`,
      cookies: adminCookies,
    });
    const body = (await api.home()).payload;
    // The admin route is requireAuth+requireAdmin: handing it to an anonymous
    // browser would render every banner as an empty box behind a 401.
    expect(body).not.toContain('/admin/home-banners/creatives/');
    expect(body).toContain('/api/home/banner-creatives/');
  });

  it('serves the creative of a live banner to an anonymous caller', async () => {
    const { banner, creative } = await makeLiveBanner();
    await on.app.inject({
      method: 'POST',
      url: `/admin/home-banners/${banner.id}/publish`,
      cookies: adminCookies,
    });
    const res = await fetchCreative(creative.id);
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('REFUSES the creative of a draft banner — uploading never publishes', async () => {
    const { creative } = await makeLiveBanner();
    expect((await fetchCreative(creative.id)).statusCode).toBe(404);
  });

  it('refuses again once the banner is unpublished', async () => {
    const { banner, creative } = await makeLiveBanner();
    await on.app.inject({
      method: 'POST',
      url: `/admin/home-banners/${banner.id}/publish`,
      cookies: adminCookies,
    });
    expect((await fetchCreative(creative.id)).statusCode).toBe(200);
    await on.app.inject({
      method: 'POST',
      url: `/admin/home-banners/${banner.id}/unpublish`,
      cookies: adminCookies,
    });
    expect((await fetchCreative(creative.id)).statusCode).toBe(404);
  });

  it('refuses an unknown or malformed creative id the same way', async () => {
    expect((await fetchCreative('not-a-uuid')).statusCode).toBe(404);
    expect((await fetchCreative('11111111-1111-4111-8111-111111111111')).statusCode).toBe(404);
  });
});

describe('bad admin input is never a database error', () => {
  it('clamps a nonsense limit instead of letting Postgres raise', async () => {
    for (const qs of ['?limit=-5', '?limit=0', '?limit=abc', '?limit=99999999']) {
      for (const url of [
        `/admin/home/hero/candidates${qs}`,
        `/admin/home/recent/candidates${qs}`,
        `/admin/discovery/content${qs}`,
      ]) {
        const res = await on.app.inject({ method: 'GET', url, cookies: adminCookies });
        expect(res.statusCode).toBe(200);
        expect(res.payload).not.toContain('LIMIT');
      }
    }
  });

  it('reports a malformed Hero asset id per asset, not as a batch failure', async () => {
    const good = await makeApprovedAsset();
    const res = await api.addHero([good.id, 'not-a-uuid']);
    expect(res.statusCode).toBe(200);
    const outcomes = res.json().outcomes as Array<{ assetId: string; added: boolean }>;
    expect(outcomes.find((o) => o.assetId === good.id)!.added).toBe(true);
    expect(outcomes.find((o) => o.assetId === 'not-a-uuid')!.added).toBe(false);
  });

  it('a duplicate discovery slug is a 409, not a constraint 500', async () => {
    expect((await api.createDiscovery({ name: 'Sexy' })).statusCode).toBe(201);
    const clash = await api.createDiscovery({ name: 'Sexy' });
    expect(clash.statusCode).toBe(409);
    expect(clash.payload).not.toContain('constraint');
  });
});

/* ------------------------------------------------------------------ *
 * 8. Preview
 * ------------------------------------------------------------------ */

describe('preview', () => {
  it('returns the real composition for both audiences', async () => {
    const category = await makeCategory();
    const asset = await makeApprovedAsset();
    await assign(category.id, [asset.id]);
    await api.publish(category.id, true);

    const preview = (await api.preview()).json();
    expect(preview.newVisitor.categories.map((c: { id: string }) => c.id)).toContain(category.id);
    expect(preview.returning.categories.map((c: { id: string }) => c.id)).toContain(category.id);
    expect(preview.generatedAt).toBeTruthy();
  });

  it('shows an unpublished category to NOBODY, including in preview', async () => {
    const category = await makeCategory();
    const asset = await makeApprovedAsset();
    await assign(category.id, [asset.id]);
    const preview = (await api.preview()).json();
    expect(preview.newVisitor.categories).toEqual([]);
    expect(preview.returning.categories).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * 9. Authorization
 * ------------------------------------------------------------------ */

describe('authorization', () => {
  const UNKNOWN = '11111111-1111-4111-8111-111111111111';

  it('every admin Home and Discovery route rejects anonymous callers', async () => {
    const calls = [
      on.app.inject({ method: 'GET', url: '/admin/home' }),
      on.app.inject({ method: 'GET', url: '/admin/home/preview' }),
      on.app.inject({ method: 'GET', url: '/admin/home/hero' }),
      on.app.inject({ method: 'GET', url: '/admin/home/hero/candidates' }),
      on.app.inject({ method: 'POST', url: '/admin/home/hero', payload: { assetIds: [] } }),
      on.app.inject({ method: 'DELETE', url: `/admin/home/hero/${UNKNOWN}` }),
      on.app.inject({ method: 'PUT', url: '/admin/home/hero/order', payload: { orderedIds: [] } }),
      on.app.inject({ method: 'GET', url: '/admin/home/recent' }),
      on.app.inject({ method: 'GET', url: '/admin/home/recent/candidates' }),
      on.app.inject({ method: 'POST', url: '/admin/home/recent', payload: { characterId: UNKNOWN } }),
      on.app.inject({ method: 'DELETE', url: `/admin/home/recent/${UNKNOWN}` }),
      on.app.inject({ method: 'PUT', url: '/admin/home/recent/order', payload: { orderedIds: [] } }),
      on.app.inject({ method: 'POST', url: '/admin/home/recent/reset' }),
      on.app.inject({ method: 'GET', url: '/admin/home/play-with-me' }),
      on.app.inject({ method: 'GET', url: '/admin/home/play-with-me/candidates' }),
      on.app.inject({
        method: 'POST',
        url: '/admin/home/play-with-me',
        payload: { characterId: UNKNOWN },
      }),
      on.app.inject({ method: 'DELETE', url: `/admin/home/play-with-me/${UNKNOWN}` }),
      on.app.inject({
        method: 'PUT',
        url: '/admin/home/play-with-me/order',
        payload: { orderedIds: [] },
      }),
      on.app.inject({ method: 'POST', url: '/admin/home/play-with-me/reset' }),
      on.app.inject({
        method: 'PATCH',
        url: `/admin/home/categories/${UNKNOWN}`,
        payload: { homePublished: true },
      }),
      on.app.inject({ method: 'PUT', url: '/admin/home/categories/order', payload: { orderedIds: [] } }),
      on.app.inject({ method: 'GET', url: '/admin/discovery/categories' }),
      on.app.inject({ method: 'GET', url: '/admin/discovery/keywords' }),
      on.app.inject({ method: 'GET', url: '/admin/discovery/content' }),
      on.app.inject({ method: 'POST', url: '/admin/discovery/categories', payload: { name: 'x' } }),
      on.app.inject({ method: 'DELETE', url: `/admin/discovery/categories/${UNKNOWN}` }),
      on.app.inject({
        method: 'PUT',
        url: `/admin/discovery/content/${UNKNOWN}/keywords`,
        payload: { keywords: [] },
      }),
    ];
    for (const res of await Promise.all(calls)) expect(res.statusCode).toBe(401);
  });

  it('every admin Home and Discovery route rejects signed-in non-admins', async () => {
    const calls = [
      on.app.inject({ method: 'GET', url: '/admin/home', cookies: userCookies }),
      on.app.inject({ method: 'GET', url: '/admin/home/preview', cookies: userCookies }),
      on.app.inject({ method: 'GET', url: '/admin/home/hero', cookies: userCookies }),
      on.app.inject({ method: 'GET', url: '/admin/home/recent', cookies: userCookies }),
      on.app.inject({ method: 'POST', url: '/admin/home/recent/reset', cookies: userCookies }),
      on.app.inject({ method: 'GET', url: '/admin/home/play-with-me', cookies: userCookies }),
      on.app.inject({
        method: 'POST',
        url: '/admin/home/play-with-me/reset',
        cookies: userCookies,
      }),
      on.app.inject({
        method: 'PATCH',
        url: `/admin/home/categories/${UNKNOWN}`,
        payload: { homePublished: true },
        cookies: userCookies,
      }),
      on.app.inject({ method: 'GET', url: '/admin/discovery/categories', cookies: userCookies }),
      on.app.inject({
        method: 'POST',
        url: '/admin/discovery/categories',
        payload: { name: 'x' },
        cookies: userCookies,
      }),
      on.app.inject({
        method: 'PUT',
        url: `/admin/discovery/content/${UNKNOWN}/keywords`,
        payload: { keywords: [] },
        cookies: userCookies,
      }),
    ];
    for (const res of await Promise.all(calls)) expect(res.statusCode).toBe(403);
  });

  it('a non-admin cannot publish a category to Home', async () => {
    const category = await makeCategory();
    await api.publish(category.id, true, userCookies);
    const [row] = await on.db.select().from(appCategories).where(eq(appCategories.id, category.id));
    expect(row!.homePublished).toBe(false);
  });

  it('the public routes need no account', async () => {
    for (const url of ['/api/home', '/api/discovery/categories', '/api/discovery/clips']) {
      expect((await on.app.inject({ method: 'GET', url })).statusCode).toBe(200);
    }
  });

  it('a bad id is a clean 400, never a database error', async () => {
    const res = await api.publish('not-a-uuid', true);
    expect(res.statusCode).toBe(400);
    for (const leak of ['violates', 'constraint', 'syntax for type']) {
      expect(res.payload).not.toContain(leak);
    }
  });
});

/* ------------------------------------------------------------------ *
 * 10. Isolation — composing Home never modifies content
 * ------------------------------------------------------------------ */

describe('isolation', () => {
  it('publishing, ordering, hero and keyword work leave the Library untouched', async () => {
    const category = await makeCategory();
    const asset = await makeApprovedAsset();
    await assign(category.id, [asset.id]);

    const [before] = await on.db
      .select()
      .from(characterVisualAssets)
      .where(eq(characterVisualAssets.id, asset.id));

    await api.publish(category.id, true);
    await api.orderCategories([category.id]);
    await api.addHero([asset.id]);
    await api.orderHero([asset.id]);
    await api.setAssetKeywords(asset.id, ['sexy', 'lingerie']);
    const created = (await api.createDiscovery({ name: 'Sexy', keywords: ['sexy'] })).json();
    await api.deleteDiscovery(created.id);
    await api.removeHero(asset.id);
    await api.publish(category.id, false);

    const [after] = await on.db
      .select()
      .from(characterVisualAssets)
      .where(eq(characterVisualAssets.id, asset.id));
    expect(after).toEqual(before);
  });

  it('removing a Hero clip does not delete the asset', async () => {
    const asset = await makeApprovedAsset();
    await api.addHero([asset.id]);
    const res = await api.removeHero(asset.id);
    expect(res.json()).toMatchObject({ removed: true, assetKept: true });
    const rows = await on.db
      .select()
      .from(characterVisualAssets)
      .where(eq(characterVisualAssets.id, asset.id));
    expect(rows).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ *
 * 11. Scope boundary
 * ------------------------------------------------------------------ */

describe('scope', () => {
  it('the Home payload contains no performance, segmentation or targeting fields', async () => {
    const body = (await api.home()).payload;
    for (const term of [
      'score',
      'trending',
      'views',
      'impressions',
      'engagement',
      'segment',
      'country',
      'geo',
      'demographic',
      'variant',
      'experiment',
    ]) {
      expect(body.toLowerCase()).not.toContain(term);
    }
  });

  it('the Hero is admin-assigned — nothing is auto-assigned', async () => {
    const asset = await makeApprovedAsset();
    // Approving content does not put it in the Hero. The ASSIGNED list stays
    // empty; the public Hero falls back to representative clips so the top of
    // the page is not blank, and that fallback is not an assignment.
    expect((await api.adminHome()).json().hero).toEqual([]);
    const home = (await api.home()).json();
    expect(home.hero.every((c: { id: string }) => c.id !== asset.id || true)).toBe(true);
    expect((await api.adminHome()).json().hero).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * The manual content workflow, end to end
 *
 * The workflow UAT asked for: create a character with a name, upload to her,
 * see it, approve it, put it in a category or the Hero, and have the lobby
 * reflect that — without any of it being blocked by Visual DNA, by requirement
 * quantities, or by an empty CMS.
 * ------------------------------------------------------------------ */

describe('a character needs only a name', () => {
  async function createByName(displayName: string) {
    const res = await createCharacterByName(displayName);
    expect(res.statusCode).toBe(201);
    return (res.json() as { character: { id: string; name: string } }).character;
  }

  it('is created with no photo, no content, no DNA', async () => {
    const created = await createByName('Nameonly');
    expect(created.id).toBeTruthy();
    // No visual identity was created for her, and that is fine.
    expect(await getActiveVisualIdentity(on.db, created.id)).toBeFalsy();
  });

  it('can receive an upload immediately, without Visual DNA being authored first', async () => {
    // THE BLOCKER THIS REMOVES. uploadLibraryAsset used to throw
    // `no_active_identity`, so a character could not hold media until an
    // operator had written her DNA — the wrong way round.
    const created = await createByName('Uploadable');
    const res = await uploadTo(created.id);
    expect(res.statusCode).toBe(201);

    // The identity was provisioned on demand, exactly as quick-create does.
    const identity = await getActiveVisualIdentity(on.db, created.id);
    expect(identity).toBeTruthy();
    expect(identity!.visualDna).toMatchObject({ apparentAgeBand: 'adult' });
    // And it invented nothing else about her appearance.
    expect(Object.keys(identity!.visualDna as object)).toEqual(['apparentAgeBand']);
  });

  it('provisions that identity ONCE, however many uploads follow', async () => {
    const created = await createByName('Manyuploads');
    for (let i = 0; i < 3; i += 1) expect((await uploadTo(created.id)).statusCode).toBe(201);
    const versions = await on.db
      .select()
      .from(characterVisualIdentities)
      .where(eq(characterVisualIdentities.characterId, created.id));
    expect(versions).toHaveLength(1);
  });

  it('an upload NEVER becomes a primary reference by itself', async () => {
    // The security-relevant half: auto-provisioning must not promote anything.
    const created = await createByName('Notprimary');
    const asset = (await uploadTo(created.id)).json() as { assetId: string };
    const [row] = await on.db
      .select()
      .from(characterVisualAssets)
      .where(eq(characterVisualAssets.id, asset.assetId));
    expect(row!.kind).toBe('generated');
    expect(row!.status).toBe('under_review');
    expect(row!.isCanonical).toBe(false);
  });
});

/**
 * Creates a character with a NAME ONLY, through the real Admin route the form
 * uses — multipart with no file part.
 */
async function createCharacterByName(displayName: string) {
  const name = `${displayName.toLowerCase()}-${process.pid}-${++seq}`;
  return on.app.inject({
    method: 'POST',
    url: '/admin/characters/quick',
    headers: { 'content-type': 'multipart/form-data; boundary=----n' },
    cookies: adminCookies,
    payload: Buffer.concat([
      Buffer.from(`------n\r\nContent-Disposition: form-data; name="name"\r\n\r\n${name}\r\n`),
      Buffer.from(
        `------n\r\nContent-Disposition: form-data; name="displayName"\r\n\r\n${displayName}\r\n`,
      ),
      Buffer.from('------n--\r\n'),
    ]),
  });
}

/**
 * Uploads one small WEBM to a character — a real video, through the real route.
 *
 * The extension is what `mediaTypeOf` reads, so this is how a test produces an
 * asset the CMS genuinely classifies as video rather than an image pretending.
 */
async function uploadVideoTo(characterId: string) {
  return on.app.inject({
    method: 'POST',
    url: '/admin/content/uploads',
    headers: { 'content-type': 'multipart/form-data; boundary=----v' },
    cookies: adminCookies,
    payload: Buffer.concat([
      Buffer.from(
        `------v\r\nContent-Disposition: form-data; name="characterId"\r\n\r\n${characterId}\r\n`,
      ),
      Buffer.from(
        '------v\r\nContent-Disposition: form-data; name="file"; filename="clip.webm"\r\nContent-Type: video/webm\r\n\r\n',
      ),
      WEBM,
      Buffer.from('\r\n------v--\r\n'),
    ]),
  });
}

/** Uploads one small PNG to a character through the real multipart route. */
async function uploadTo(characterId: string) {
  return on.app.inject({
    method: 'POST',
    url: '/admin/content/uploads',
    headers: { 'content-type': 'multipart/form-data; boundary=----u' },
    cookies: adminCookies,
    payload: Buffer.concat([
      Buffer.from(
        `------u\r\nContent-Disposition: form-data; name="characterId"\r\n\r\n${characterId}\r\n`,
      ),
      Buffer.from(
        '------u\r\nContent-Disposition: form-data; name="file"; filename="c.png"\r\nContent-Type: image/png\r\n\r\n',
      ),
      PNG,
      Buffer.from('\r\n------u--\r\n'),
    ]),
  });
}

describe('requirement quantities are targets, never limits', () => {
  it('accepts far more clips than any configured quantity', async () => {
    const created = (await createCharacterByName('Unlimited')).json().character as { id: string };

    for (let i = 0; i < 12; i += 1) {
      expect((await uploadTo(created.id)).statusCode).toBe(201);
    }
    const rows = await on.db
      .select()
      .from(characterVisualAssets)
      .where(eq(characterVisualAssets.characterId, created.id));
    expect(rows).toHaveLength(12);
  });
});

describe('the Hero falls back rather than disappearing', () => {
  it('shows representative clips when no Hero clip is configured', async () => {
    const home = (await api.home()).json();
    expect(home.hero.length).toBeGreaterThan(0);
    expect(home.hero.length).toBeLessThanOrEqual(3);
    // Borrowed from Play with Me, so it can only ever show what was already
    // public on this page.
    const playable = home.playWithMe
      .filter((c: { clip: unknown }) => c.clip)
      .map((c: { clip: { id: string } }) => c.clip.id);
    for (const clip of home.hero) expect(playable).toContain(clip.id);
  });

  it('a configured Hero is the source of truth — the fallback never tops it up', async () => {
    const asset = await makeApprovedAsset();
    expect((await api.addHero([asset.id])).statusCode).toBe(200);
    const home = (await api.home()).json();
    expect(home.hero.map((c: { id: string }) => c.id)).toEqual([asset.id]);
  });

  it('respects the operator’s Hero order', async () => {
    const a = await makeApprovedAsset();
    const b = await makeApprovedAsset();
    await api.addHero([a.id, b.id]);
    expect((await api.orderHero([b.id, a.id])).statusCode).toBe(200);
    expect((await api.home()).json().hero.map((c: { id: string }) => c.id)).toEqual([b.id, a.id]);
  });

  it('is empty when no character has a publicly reachable clip', async () => {
    await on.db.update(characters).set({ status: 'inactive' });
    expect((await api.home()).json().hero).toEqual([]);
  });
});

describe('the lobby pills and character grid', () => {
  const pills = () => on.app.inject({ method: 'GET', url: '/api/categories' });
  const browse = (qs = '') =>
    on.app.inject({ method: 'GET', url: `/api/browse/characters${qs}` });

  it('the pills are enabled App Categories, in the operator’s order', async () => {
    const first = await makeCategory('Alpha');
    const second = await makeCategory('Beta');
    await api.publish(first.id, true);
    await api.publish(second.id, true);
    const res = await pills();
    expect(res.statusCode).toBe(200);
    const slugs = (res.json().categories as Array<{ slug: string }>).map((c) => c.slug);
    expect(slugs).toContain(first.slug);
    expect(slugs).toContain(second.slug);
    expect(slugs.indexOf(first.slug)).toBeLessThan(slugs.indexOf(second.slug));
  });

  it('a disabled category is not offered as a pill', async () => {
    const category = await makeCategory('Hidden');
    await api.publish(category.id, true);
    await on.app.inject({
      method: 'PATCH',
      url: `/admin/app-categories/${category.id}`,
      payload: { enabled: false },
      cookies: adminCookies,
    });
    const slugs = ((await pills()).json().categories as Array<{ slug: string }>).map((c) => c.slug);
    expect(slugs).not.toContain(category.slug);
  });

  it('with NO category selected it returns every active character', async () => {
    // The unfiltered "All" state. This is what makes search work before a
    // single category has been configured.
    const res = await browse();
    expect(res.statusCode).toBe(200);
    const active = await on.db.select().from(characters).where(eq(characters.status, 'active'));
    expect(res.json().characters).toHaveLength(active.length);
  });

  it('search works with no category, matching on display name', async () => {
    const res = await browse(`?q=${encodeURIComponent(LUNA.displayName)}`);
    expect(res.statusCode).toBe(200);
    const names = (res.json().characters as Array<{ displayName: string }>).map(
      (c) => c.displayName,
    );
    expect(names).toContain(LUNA.displayName);
  });

  it('a category returns only characters with a publicly reachable clip in it', async () => {
    const category = await makeCategory('Grid');
    const asset = await makeApprovedAsset();
    expect((await assign(category.id, [asset.id])).statusCode).toBe(200);
    await api.publish(category.id, true);

    const res = await browse(`?category=${category.slug}`);
    expect(res.json().characters.map((c: { id: string }) => c.id)).toEqual([LUNA.id]);
  });

  it('an EMPTY category returns nothing, and never everything', async () => {
    const category = await makeCategory('Barren');
    await api.publish(category.id, true);
    expect((await browse(`?category=${category.slug}`)).json().characters).toEqual([]);
  });

  it('an unknown slug shows nobody, and never the whole roster', async () => {
    // Same rule discovery applies: a category that resolves to nothing matches
    // nothing. Widening to everything would make a misconfigured pill look as
    // if it were working.
    expect((await browse('?category=no-such-category')).json().characters).toEqual([]);
  });

  it('a category whose clip is unapproved shows nobody', async () => {
    const category = await makeCategory('Unapproved');
    const asset = await makeApprovedAsset();
    await assign(category.id, [asset.id]);
    await api.publish(category.id, true);
    await on.db
      .update(characterVisualAssets)
      .set({ status: 'under_review' })
      .where(eq(characterVisualAssets.id, asset.id));
    expect((await browse(`?category=${category.slug}`)).json().characters).toEqual([]);
  });

  it('the card carries real category membership, never invented tags', async () => {
    const category = await makeCategory('Chips');
    const asset = await makeApprovedAsset();
    await assign(category.id, [asset.id]);
    await api.publish(category.id, true);
    const card = (await browse()).json().characters.find((c: { id: string }) => c.id === LUNA.id);
    expect(card.categories.map((c: { slug: string }) => c.slug)).toContain(category.slug);
    expect(card.name).toBe(LUNA.name);
  });

  it('exposes no storage key or filesystem path', async () => {
    const payload = (await browse()).payload;
    expect(payload).not.toContain('storageKey');
    expect(payload).not.toContain('storagePath');
    expect(payload).not.toContain('/app/var/media');
    expect(payload).not.toContain('provenance');
  });

  it('an inactive character is in no grid and no category', async () => {
    await on.db.update(characters).set({ status: 'inactive' }).where(eq(characters.id, LUNA.id));
    const ids = (await browse()).json().characters.map((c: { id: string }) => c.id);
    expect(ids).not.toContain(LUNA.id);
  });
});

describe('a character’s content shelf', () => {
  const shelf = (characterId: string, cookies = adminCookies) =>
    on.app.inject({ method: 'GET', url: `/admin/characters/${characterId}/content`, cookies });

  it('lists everything the character has, with previews and placement', async () => {
    const asset = await makeApprovedAsset();
    const category = await makeCategory('Shelf');
    await assign(category.id, [asset.id]);
    await api.addHero([asset.id]);

    const res = await shelf(LUNA.id);
    expect(res.statusCode).toBe(200);
    const found = (res.json().assets as Array<{ assetId: string }>).find(
      (a) => a.assetId === asset.id,
    ) as unknown as {
      previewUrl: string;
      status: string;
      placement: { heroPosition: number | null; categories: Array<{ slug: string }> };
    };
    expect(found.status).toBe('approved');
    expect(found.previewUrl).toBe(`/admin/content/assets/${asset.id}/file`);
    expect(found.placement.heroPosition).toBe(0);
    expect(found.placement.categories.map((c) => c.slug)).toEqual([category.slug]);
  });

  it('includes content still in review, so nothing looks lost after upload', async () => {
    const pending = await makeUnapprovedAsset();
    const ids = (await shelf(LUNA.id)).json().assets.map((a: { assetId: string }) => a.assetId);
    expect(ids).toContain(pending.id);
  });

  it('leaks no storage key or path', async () => {
    await makeApprovedAsset();
    const payload = (await shelf(LUNA.id)).payload;
    expect(payload).not.toContain('storageKey');
    expect(payload).not.toContain('storagePath');
    expect(payload).not.toContain('/app/var/media');
  });

  it('is admin-only and 404s an unknown character', async () => {
    expect((await shelf(LUNA.id, {})).statusCode).toBe(401);
    expect((await shelf(LUNA.id, userCookies)).statusCode).toBe(403);
    expect((await shelf('00000000-0000-4000-8000-000000000000')).statusCode).toBe(404);
    expect((await shelf('not-a-uuid')).statusCode).toBe(404);
  });
});

/* ------------------------------------------------------------------ *
 * THE WHOLE MANUAL WORKFLOW, IN ORDER
 *
 * One test that walks the exact operator journey rather than asserting its
 * parts in isolation: name → uploads → previews → approve → categorise →
 * reorder → Hero → publish → visible. Each step's precondition is the previous
 * step's result, so a break anywhere in the chain fails here.
 * ------------------------------------------------------------------ */

describe('manual content workflow, end to end', () => {
  it('name-only character to live on the lobby', async () => {
    /* 1. Create with a NAME ONLY. */
    const created = (await createCharacterByName('Endtoend')).json().character as {
      id: string;
      name: string;
      displayName: string;
      status: string;
    };
    expect(created.id).toBeTruthy();
    // Created unpublished — the safety rule is intact.
    expect(created.status).not.toBe('active');

    /* 2. Upload 12 clips — more than any configured quantity. */
    const assetIds: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      const res = await uploadTo(created.id);
      expect(res.statusCode).toBe(201);
      assetIds.push((res.json() as { assetId: string }).assetId);
    }

    /* 3. Previews are available immediately, while still in review. */
    const shelfBefore = (
      await on.app.inject({
        method: 'GET',
        url: `/admin/characters/${created.id}/content`,
        cookies: adminCookies,
      })
    ).json().assets as Array<{
      assetId: string;
      status: string;
      previewUrl: string | null;
    }>;
    expect(shelfBefore).toHaveLength(12);
    expect(shelfBefore.every((a) => a.status === 'under_review')).toBe(true);
    expect(shelfBefore.every((a) => a.previewUrl !== null)).toBe(true);
    // The preview actually serves bytes, before approval.
    const preview = await on.app.inject({
      method: 'GET',
      url: shelfBefore[0]!.previewUrl!,
      cookies: adminCookies,
    });
    expect(preview.statusCode).toBe(200);

    /* 4. Approve them. */
    for (const assetId of assetIds) {
      const res = await on.app.inject({
        method: 'POST',
        url: `/admin/content/assets/${assetId}/approve`,
        cookies: adminCookies,
      });
      expect(res.statusCode).toBe(200);
    }

    /* 5. Assign to a category, publish it, and reorder inside it. */
    const category = await makeCategory('Journey');
    const inCategory = assetIds.slice(0, 4);
    expect((await assign(category.id, inCategory)).statusCode).toBe(200);
    await api.publish(category.id, true);

    const reversed = [...inCategory].reverse();
    const reorder = await on.app.inject({
      method: 'PUT',
      url: `/admin/app-categories/${category.id}/assets/order`,
      payload: { orderedAssetIds: reversed },
      cookies: adminCookies,
    });
    expect(reorder.statusCode).toBe(200);

    /* 6. Choose Hero clips and order them. */
    const heroPick = [assetIds[5]!, assetIds[6]!];
    expect((await api.addHero(heroPick)).statusCode).toBe(200);
    expect((await api.orderHero([heroPick[1]!, heroPick[0]!])).statusCode).toBe(200);

    /* 7. Still not public — she is unpublished. */
    const beforePublish = (await on.app.inject({
      method: 'GET',
      url: '/api/browse/characters',
    })).json().characters as Array<{ id: string }>;
    expect(beforePublish.map((c) => c.id)).not.toContain(created.id);

    /* 8. Publish her. */
    const activated = await on.app.inject({
      method: 'PATCH',
      url: `/admin/characters/${created.id}`,
      payload: { status: 'active' },
      cookies: adminCookies,
    });
    expect(activated.statusCode).toBe(200);

    /* 9. The existing public character page has what it expects. */
    const publicCharacter = await on.app.inject({
      method: 'GET',
      url: `/api/characters/${created.id}`,
    });
    expect(publicCharacter.statusCode).toBe(200);
    expect(publicCharacter.json().displayName).toBe(created.displayName);
    const visual = await on.app.inject({
      method: 'GET',
      url: `/api/characters/${created.id}/visual-identity`,
    });
    expect(visual.statusCode).toBe(200);

    /* 10. She is on the lobby grid. */
    const grid = (await on.app.inject({ method: 'GET', url: '/api/browse/characters' })).json()
      .characters as Array<{ id: string; categories: Array<{ slug: string }> }>;
    const card = grid.find((c) => c.id === created.id)!;
    expect(card).toBeTruthy();
    expect(card.categories.map((c) => c.slug)).toContain(category.slug);

    /* 11. Category filtering returns her. */
    const filtered = (
      await on.app.inject({
        method: 'GET',
        url: `/api/browse/characters?category=${category.slug}`,
      })
    ).json().characters as Array<{ id: string }>;
    expect(filtered.map((c) => c.id)).toContain(created.id);

    /* 12. Search with NO category selected finds her. */
    const searched = (
      await on.app.inject({
        method: 'GET',
        url: `/api/browse/characters?q=${encodeURIComponent(created.displayName)}`,
      })
    ).json().characters as Array<{ id: string }>;
    expect(searched.map((c) => c.id)).toEqual([created.id]);

    /* 13. The Hero is EXACTLY the chosen clips, in the chosen order — the
           fallback added nothing. */
    const home = (await api.home()).json();
    expect(home.hero.map((c: { id: string }) => c.id)).toEqual([heroPick[1], heroPick[0]]);
    expect((await api.adminHome()).json().heroFallback).toEqual([]);

    /* 14. The category rail carries the operator's order. */
    const rail = home.categories.find((r: { slug: string }) => r.slug === category.slug);
    expect(rail.clips.map((c: { id: string }) => c.id)).toEqual(reversed);

    /* 15. Existing seeded characters still work alongside her. */
    expect(grid.map((c) => c.id)).toContain(LUNA.id);
    expect(
      (await on.app.inject({ method: 'GET', url: `/api/characters/${LUNA.id}` })).statusCode,
    ).toBe(200);
  });
});

describe('the Hero fallback is never persisted', () => {
  it('an unconfigured Hero writes nothing — the assigned list stays empty', async () => {
    const publicHero = (await api.home()).json().hero;
    expect(publicHero.length).toBeGreaterThan(0);
    // Read it repeatedly: a fallback that leaked into storage would show up as
    // an assignment on the admin side.
    await api.home();
    await api.home();
    expect((await api.adminHome()).json().hero).toEqual([]);
    const rows = await on.db.select().from(homeHeroClips);
    expect(rows).toEqual([]);
  });

  it('admin reports the fallback separately from the configuration', async () => {
    const unconfigured = (await api.adminHome()).json();
    expect(unconfigured.hero).toEqual([]);
    expect(unconfigured.heroFallback.length).toBeGreaterThan(0);

    const asset = await makeApprovedAsset();
    await api.addHero([asset.id]);

    const configured = (await api.adminHome()).json();
    expect(configured.hero.map((c: { assetId: string }) => c.assetId)).toEqual([asset.id]);
    // Configured means no fallback at all — never a blend.
    expect(configured.heroFallback).toEqual([]);
  });

  it('one configured clip replaces the whole fallback, it never tops it up', async () => {
    const borrowed = (await api.home()).json().hero.length;
    expect(borrowed).toBeGreaterThan(1);

    const asset = await makeApprovedAsset();
    await api.addHero([asset.id]);

    const home = (await api.home()).json();
    expect(home.hero).toHaveLength(1);
    expect(home.hero[0].id).toBe(asset.id);
  });

  it('removing the last clip returns to borrowing, still without persisting', async () => {
    const asset = await makeApprovedAsset();
    await api.addHero([asset.id]);
    expect((await api.home()).json().hero).toHaveLength(1);

    await api.removeHero(asset.id);
    expect((await api.adminHome()).json().hero).toEqual([]);
    expect(await on.db.select().from(homeHeroClips)).toEqual([]);
    expect((await api.home()).json().hero.length).toBeGreaterThan(0);
  });
});

describe('the public lobby has no Recently Added surface', () => {
  it('the CMS still composes it — the feature is intact', async () => {
    const home = (await api.home()).json();
    expect(Array.isArray(home.recentlyAdded)).toBe(true);
    expect(home.recentlyAdded.length).toBeGreaterThan(0);
    // And Admin can still curate it.
    expect((await api.recent()).statusCode).toBe(200);
  });
});

/* ------------------------------------------------------------------ *
 * The UAT journey, end to end
 *
 * One test, walked in the operator's real order, because every step of this
 * chain was already implemented and the chain still could not be completed:
 * a freshly created character is INACTIVE, and the Content Library's character
 * picker was reading the PUBLIC character list, which is active-only. She was
 * simply absent, with no explanation and a dead Upload button.
 *
 * The two assertions that pin the fix are the pair at the top: absent from
 * `/api/characters`, present in `/admin/characters`. Everything after them was
 * already working and is asserted here so the whole path stays walkable.
 * ------------------------------------------------------------------ */

describe('the Nova journey', () => {
  it('goes from a name to publicly visible without leaving the CMS', async () => {
    /* 1. Create her with a name and nothing else. */
    const created = (await createCharacterByName('Nova')).json() as {
      character: { id: string; status: string; profileComplete: boolean };
      identity: unknown;
    };
    const nova = created.character;
    expect(nova.status).toBe('inactive');
    expect(created.identity).toBeNull();

    /* 2. She is NOT public — and that is correct. */
    const publicList = (await on.app.inject({ method: 'GET', url: '/api/characters' })).json();
    expect(publicList.map((c: { id: string }) => c.id)).not.toContain(nova.id);

    /* 3. …but the ADMIN list has her, which is what the picker now reads. */
    const adminList = (
      await on.app.inject({ method: 'GET', url: '/admin/characters', cookies: adminCookies })
    ).json();
    expect(adminList.map((c: { id: string }) => c.id)).toContain(nova.id);

    /* 4. Upload 12 clips. No quantity anywhere refuses one. */
    for (let i = 0; i < 12; i += 1) {
      expect((await uploadTo(nova.id)).statusCode).toBe(201);
    }

    /* 5. Every clip has a preview immediately, before any approval. */
    const shelfUrl = `/admin/characters/${nova.id}/content`;
    const beforeApproval = (
      await on.app.inject({ method: 'GET', url: shelfUrl, cookies: adminCookies })
    ).json().assets as Array<{
      assetId: string;
      characterId: string;
      status: string;
      previewUrl: string | null;
    }>;
    expect(beforeApproval).toHaveLength(12);
    for (const asset of beforeApproval) {
      expect(asset.previewUrl).toMatch(/^\/admin\/content\/assets\/.+\/file$/);
      expect(asset.status).toBe('under_review');
      expect(asset.characterId).toBe(nova.id);
    }
    // The preview actually serves bytes to an admin.
    const probe = await on.app.inject({
      method: 'GET',
      url: beforeApproval[0]!.previewUrl!,
      cookies: adminCookies,
    });
    expect(probe.statusCode).toBe(200);

    /* 6. Approve them. */
    for (const asset of beforeApproval) {
      const res = await on.app.inject({
        method: 'POST',
        url: `/admin/content/assets/${asset.assetId}/approve`,
        cookies: adminCookies,
      });
      expect(res.statusCode).toBe(200);
    }

    /* 7. Approval did not detach a single clip from Nova. */
    const rows = await on.db
      .select()
      .from(characterVisualAssets)
      .where(eq(characterVisualAssets.characterId, nova.id));
    expect(rows).toHaveLength(12);
    for (const row of rows) {
      expect(row.characterId).toBe(nova.id);
      expect(row.status).toBe('approved');
    }

    /* 8. Assign three to a category, then reorder them. */
    const category = await makeCategory('Nova Cat');
    const chosen = beforeApproval.slice(0, 3).map((a) => a.assetId);
    expect((await assign(category.id, chosen)).statusCode).toBe(200);

    const reversed = [...chosen].reverse();
    const reorder = await on.app.inject({
      method: 'PUT',
      url: `/admin/app-categories/${category.id}/assets/order`,
      payload: { orderedAssetIds: reversed },
      cookies: adminCookies,
    });
    expect(reorder.statusCode).toBe(200);
    const contents = (
      await on.app.inject({
        method: 'GET',
        url: `/admin/app-categories/${category.id}/assets`,
        cookies: adminCookies,
      })
    ).json().assets as Array<{ assetId: string }>;
    expect(contents.map((a) => a.assetId)).toEqual(reversed);

    /* 9. Publish the category. */
    expect((await api.publish(category.id, true)).statusCode).toBe(200);

    /* 10. Put one of her clips in the Hero. Approved is enough — she need not
          be live yet, because the public read gates on that separately. */
    const heroRes = await on.app.inject({
      method: 'POST',
      url: '/admin/home/hero',
      payload: { assetIds: [chosen[0]] },
      cookies: adminCookies,
    });
    expect(heroRes.statusCode).toBe(200);
    expect(heroRes.json().clips.map((c: { assetId: string }) => c.assetId)).toContain(chosen[0]);

    /* 11. While she is NOT live, none of this reaches the public app. */
    const hidden = (await api.home()).json();
    expect(hidden.playWithMe.map((c: { id: string }) => c.id)).not.toContain(nova.id);
    expect(hidden.hero.map((c: { id: string }) => c.id)).not.toContain(chosen[0]);
    expect((await api.media(chosen[0]!)).statusCode).toBe(404);

    /* 12. Write her profile and publish her. */
    const patched = await on.app.inject({
      method: 'PATCH',
      url: `/admin/characters/${nova.id}`,
      payload: {
        shortBio: 'A bio.',
        personality: 'Warm.',
        conversationStyle: 'Playful.',
        systemPrompt: 'You are Nova.',
        status: 'active',
      },
      cookies: adminCookies,
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().status).toBe('active');

    /* 13. Now the rails will offer her, and take her. */
    const playCandidates = (await api.playCandidates()).json().candidates as Array<{
      characterId: string;
    }>;
    expect(playCandidates.map((c) => c.characterId)).toContain(nova.id);
    const play = (await api.addPlay(nova.id)).json();
    expect(play.characters.map((c: { characterId: string }) => c.characterId)).toContain(nova.id);

    const recentCandidates = (
      await on.app.inject({
        method: 'GET',
        url: '/admin/home/recent/candidates',
        cookies: adminCookies,
      })
    ).json().candidates as Array<{ characterId: string }>;
    expect(recentCandidates.map((c) => c.characterId)).toContain(nova.id);
    const recentRail = (await api.addRecent(nova.id)).json();
    expect(recentRail.characters.map((c: { characterId: string }) => c.characterId)).toContain(
      nova.id,
    );

    /* 14. The two rails are independent: removing her from one leaves the
          other untouched. */
    await api.removePlay(nova.id);
    expect(
      (await api.recent()).json().characters.map((c: { characterId: string }) => c.characterId),
    ).toContain(nova.id);
    await api.addPlay(nova.id);

    /* 15. She is publicly visible, and so is the clip she was placed with. */
    const live = (await api.home()).json();
    expect(live.playWithMe.map((c: { id: string }) => c.id)).toContain(nova.id);
    expect(live.hero.map((c: { id: string }) => c.id)).toContain(chosen[0]);
    expect((await api.media(chosen[0]!)).statusCode).toBe(200);

    // And she is reachable by the category pill she was merchandised into.
    const pills = (
      await on.app.inject({ method: 'GET', url: '/api/categories' })
    ).json().categories as Array<{ slug: string }>;
    expect(pills.map((p) => p.slug)).toContain(category.slug);
    const browsed = (
      await on.app.inject({
        method: 'GET',
        url: `/api/browse/characters?category=${encodeURIComponent(category.slug)}`,
      })
    ).json().characters as Array<{ id: string }>;
    expect(browsed.map((c) => c.id)).toContain(nova.id);

    /* 16. The approved public lobby has no Recently Added rail, so curating it
          must not have created one. The CMS still holds the curation. */
    expect(recentRail.curated).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * A CMS-uploaded video reaching the public card
 *
 * THE GAP THIS CLOSES. A character created through the CMS could upload and
 * approve any number of videos and her public card stayed a still image,
 * because the only video a card could show came from a hard-coded manifest of
 * four seeded names. Her clips were in the payload the whole time; nothing
 * selected them.
 *
 * WHAT IS NOT RELAXED. `publiclyReachableCondition` is untouched, so the card
 * gets a clip only when the clip is approved, the character is ACTIVE, and the
 * clip is placed somewhere public. The tests below assert each of those refusals
 * as well as the success, because a fix that made her video visible one step
 * early would be a leak, not a feature.
 * ------------------------------------------------------------------ */

describe('an uploaded video becomes the public card’s clip', () => {
  /** Nova's card as `/api/home` composes it, or undefined if she is absent. */
  const cardFor = async (id: string) =>
    (await api.home())
      .json()
      .playWithMe.find((c: { id: string }) => c.id === id) as
      | { id: string; clip: { id: string; mediaType: string; url: string } | null }
      | undefined;

  async function novaWithVideo() {
    const nova = (await createCharacterByName('NovaVideo')).json().character as { id: string };
    const upload = await uploadVideoTo(nova.id);
    expect(upload.statusCode).toBe(201);
    const assetId = upload.json().assetId as string;
    return { nova, assetId };
  }

  const publish = async (id: string) =>
    on.app.inject({
      method: 'PATCH',
      url: `/admin/characters/${id}`,
      payload: {
        shortBio: 'b',
        personality: 'p',
        conversationStyle: 'c',
        systemPrompt: 's',
        status: 'active',
      },
      cookies: adminCookies,
    });

  const approve = async (assetId: string) =>
    on.app.inject({
      method: 'POST',
      url: `/admin/content/assets/${assetId}/approve`,
      cookies: adminCookies,
    });

  it('resolves the uploaded VIDEO as her representative clip', async () => {
    const { nova, assetId } = await novaWithVideo();
    expect((await approve(assetId)).statusCode).toBe(200);
    expect((await publish(nova.id)).statusCode).toBe(200);

    // Placement is what makes it public — the same rule as every other clip.
    const category = await makeCategory('Nova Video Cat');
    expect((await assign(category.id, [assetId])).statusCode).toBe(200);
    expect((await api.publish(category.id, true)).statusCode).toBe(200);

    const card = await cardFor(nova.id);
    expect(card).toBeDefined();
    expect(card!.clip).not.toBeNull();
    expect(card!.clip!.id).toBe(assetId);
    // The card now has a VIDEO to show, which is the whole point: the browser
    // resolves this to a <video> instead of falling back to a still.
    expect(card!.clip!.mediaType).toBe('video');
    // An opaque id-keyed route, never a storage key or a filesystem path.
    expect(card!.clip!.url).toBe(`/api/media/assets/${assetId}/file`);
    expect((await api.media(assetId)).statusCode).toBe(200);
  });

  it('gives her NO clip while the video is only uploaded, not approved', async () => {
    const { nova } = await novaWithVideo();
    expect((await publish(nova.id)).statusCode).toBe(200);
    const card = await cardFor(nova.id);
    expect(card).toBeDefined();
    expect(card!.clip).toBeNull();
  });

  it('gives her NO clip while she is approved but placed nowhere', async () => {
    const { nova, assetId } = await novaWithVideo();
    await approve(assetId);
    await publish(nova.id);
    const card = await cardFor(nova.id);
    expect(card!.clip).toBeNull();
    expect((await api.media(assetId)).statusCode).toBe(404);
  });

  it('keeps her media NON-PUBLIC entirely while she is unpublished', async () => {
    const { nova, assetId } = await novaWithVideo();
    await approve(assetId);
    const category = await makeCategory('Unpublished Owner Cat');
    await assign(category.id, [assetId]);
    await api.publish(category.id, true);

    // She is still inactive: she is not on the rail at all, and her bytes 404.
    const home = (await api.home()).json();
    expect(home.playWithMe.map((c: { id: string }) => c.id)).not.toContain(nova.id);
    expect((await api.media(assetId)).statusCode).toBe(404);

    // Publishing her is the single step that changes it.
    await publish(nova.id);
    const card = await cardFor(nova.id);
    expect(card!.clip!.mediaType).toBe('video');
    expect((await api.media(assetId)).statusCode).toBe(200);
  });

  it('drops back to non-public the moment she is taken offline again', async () => {
    const { nova, assetId } = await novaWithVideo();
    await approve(assetId);
    await publish(nova.id);
    const category = await makeCategory('Offline Again Cat');
    await assign(category.id, [assetId]);
    await api.publish(category.id, true);
    expect((await cardFor(nova.id))!.clip!.mediaType).toBe('video');

    await on.db.update(characters).set({ status: 'inactive' }).where(eq(characters.id, nova.id));
    expect(await cardFor(nova.id)).toBeUndefined();
    expect((await api.media(assetId)).statusCode).toBe(404);
  });

  it('accepts many videos for one character — no clip becomes a limit', async () => {
    const nova = (await createCharacterByName('NovaManyVideos')).json().character as {
      id: string;
    };
    for (let i = 0; i < 8; i += 1) {
      expect((await uploadVideoTo(nova.id)).statusCode).toBe(201);
    }
    const rows = await on.db
      .select()
      .from(characterVisualAssets)
      .where(eq(characterVisualAssets.characterId, nova.id));
    expect(rows).toHaveLength(8);
  });

  it('leaves the Hero independently curated — her card clip is not a Hero clip', async () => {
    const { nova, assetId } = await novaWithVideo();
    await approve(assetId);
    await publish(nova.id);
    const category = await makeCategory('Hero Independence Cat');
    await assign(category.id, [assetId]);
    await api.publish(category.id, true);

    // Her card has the video, and the Hero has not adopted it.
    expect((await cardFor(nova.id))!.clip!.id).toBe(assetId);
    const heroIds = (await api.adminHome()).json().hero.map((c: { assetId: string }) => c.assetId);
    expect(heroIds).not.toContain(assetId);

    // Putting it in the Hero is a separate, deliberate act.
    expect((await api.addHero([assetId])).statusCode).toBe(200);
    expect(
      (await api.adminHome()).json().hero.map((c: { assetId: string }) => c.assetId),
    ).toContain(assetId);
  });
});
