import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { appCategories, characters, characterVisualAssets } from '../db/schema.js';
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
    expect((await api.home()).json().hero).toEqual([]);
  });

  it('a Hero clip that loses approval disappears from Home but stays assigned', async () => {
    const asset = await makeApprovedAsset();
    await api.addHero([asset.id]);
    expect((await api.home()).json().hero).toHaveLength(1);

    await on.db
      .update(characterVisualAssets)
      .set({ status: 'rejected' })
      .where(eq(characterVisualAssets.id, asset.id));

    expect((await api.home()).json().hero).toEqual([]);
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
    expect(home.hero).toEqual([]);
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

  it('a curated rail still drops a character who becomes inactive', async () => {
    const target = (await api.recent()).json().characters[0].characterId;
    await api.addRecent(target); // materialise
    await on.db.update(characters).set({ status: 'inactive' }).where(eq(characters.id, target));
    const home = (await api.home()).json();
    expect(home.recentlyAdded.map((c: { id: string }) => c.id)).not.toContain(target);
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

  it('the Hero is admin-assigned and empty until an admin fills it', async () => {
    await makeApprovedAsset();
    expect((await api.home()).json().hero).toEqual([]);
  });
});
