import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { characterVisualAssets, type CharacterVisualAssetRow } from '../db/schema.js';
import { SEED_CHARACTERS } from '../db/seed-data.js';
import { seedCharacters, seedVisualIdentities } from '../db/seed.js';
import { createVisualAsset } from '../services/visual-asset-service.js';
import { getActiveVisualIdentity } from '../services/visual-identity-service.js';
import { listPublishableCategoryAssets } from '../services/app-merchandising-service.js';
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
 * US-102.2 — content distribution & category merchandising.
 *
 * The rules these exist to hold:
 *
 *  1. ONLY APPROVED CONTENT CAN BE NEWLY ASSIGNED. Every other status is
 *     refused, per asset, with the reason.
 *  2. PUBLIC READS FILTER INDEPENDENTLY. An asset approved, assigned, then
 *     rejected keeps its assignment but disappears from the public result —
 *     and comes back by itself when it is approved again.
 *  3. REMOVING AN ASSIGNMENT NEVER MODIFIES THE ASSET. Asserted by comparing
 *     the entire row before and after, not just its status.
 *  4. ONE ASSET, MANY CATEGORIES, ONE COPY OF THE MEDIA.
 *  5. RATING AND PRIMARY STATUS ARE NOT PUBLISHABILITY GATES.
 *  6. EVERY ROUTE IS ADMIN-ONLY.
 */

const LUNA = SEED_CHARACTERS.find((c) => c.name === 'luna')!;
const OTHER = SEED_CHARACTERS.find((c) => c.name !== 'luna')!;

let on: TestContext;
let adminCookies: Record<string, string>;
let userCookies: Record<string, string>;

beforeAll(async () => {
  migrateTestDb();
  on = await createTestContext();
});
afterAll(async () => destroyTestContext(on));

beforeEach(async () => {
  await truncateAll(on);
  await seedCharacters(on.db);
  await seedVisualIdentities(on.db);
  adminCookies = await register('merch.admin@example.com', 'admin');
  userCookies = await register('merch.user@example.com', 'user');
});

async function register(email: string, role: 'admin' | 'user') {
  const res = await on.app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email, password: 'merchandising-1' },
  });
  const cookie = extractSessionCookie(res)!;
  if (role === 'admin') {
    await on.pool.query(`UPDATE users SET role = 'admin' WHERE email = $1`, [email]);
  }
  return { [cookie.name]: cookie.value };
}

type Body = Record<string, unknown>;

const api = {
  createCategory: async (name: string, cookies = adminCookies) =>
    await on.app.inject({
      method: 'POST',
      url: '/admin/app-categories',
      payload: { name },
      cookies,
    }),
  listCategories: async (cookies = adminCookies) =>
    await on.app.inject({ method: 'GET', url: '/admin/app-categories', cookies }),
  bySlug: async (slug: string, cookies = adminCookies) =>
    await on.app.inject({ method: 'GET', url: `/admin/app-categories/by-slug/${slug}`, cookies }),
  contents: async (categoryId: string, cookies = adminCookies) =>
    await on.app.inject({
      method: 'GET',
      url: `/admin/app-categories/${categoryId}/assets`,
      cookies,
    }),
  candidates: async (query = '', cookies = adminCookies) =>
    await on.app.inject({
      method: 'GET',
      url: `/admin/app-categories/candidates${query}`,
      cookies,
    }),
  add: async (categoryId: string, body: Body, cookies = adminCookies) =>
    await on.app.inject({
      method: 'POST',
      url: `/admin/app-categories/${categoryId}/assets`,
      payload: body,
      cookies,
    }),
  remove: async (categoryId: string, body: Body, cookies = adminCookies) =>
    await on.app.inject({
      method: 'POST',
      url: `/admin/app-categories/${categoryId}/assets/remove`,
      payload: body,
      cookies,
    }),
  order: async (categoryId: string, body: Body, cookies = adminCookies) =>
    await on.app.inject({
      method: 'PUT',
      url: `/admin/app-categories/${categoryId}/assets/order`,
      payload: body,
      cookies,
    }),
  feature: async (categoryId: string, assetId: string, body: Body, cookies = adminCookies) =>
    await on.app.inject({
      method: 'PATCH',
      url: `/admin/app-categories/${categoryId}/assets/${assetId}`,
      payload: body,
      cookies,
    }),
  file: async (assetId: string, cookies = adminCookies) =>
    await on.app.inject({
      method: 'GET',
      url: `/admin/content/assets/${assetId}/file`,
      cookies,
    }),
};

async function makeCategory(name: string) {
  const res = await api.createCategory(name);
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string; slug: string; name: string };
}

async function makeAsset(
  overrides: Partial<{
    status: 'generated' | 'under_review' | 'approved' | 'rejected';
    contentRating: 'sfw' | 'explicit';
    isCanonical: boolean;
    characterId: string;
  }> = {},
) {
  const characterId = overrides.characterId ?? LUNA.id;
  const identity = (await getActiveVisualIdentity(on.db, characterId))!;
  const asset = await createVisualAsset(on.db, {
    characterId,
    visualIdentityId: identity.id,
    kind: 'generated',
    status: overrides.status ?? 'approved',
    contentRating: overrides.contentRating ?? 'sfw',
    storageKey: `/admin/content/uploads/x/file`,
  });
  if (overrides.isCanonical) {
    await on.db
      .update(characterVisualAssets)
      .set({ isCanonical: true })
      .where(eq(characterVisualAssets.id, asset.id));
  }
  if ((overrides.status ?? 'approved') === 'approved') {
    await on.db
      .update(characterVisualAssets)
      .set({ approvedAt: new Date() })
      .where(eq(characterVisualAssets.id, asset.id));
  }
  return asset;
}

async function assetRow(id: string): Promise<CharacterVisualAssetRow | undefined> {
  const [row] = await on.db
    .select()
    .from(characterVisualAssets)
    .where(eq(characterVisualAssets.id, id));
  return row;
}

async function setStatus(id: string, status: 'approved' | 'rejected' | 'under_review') {
  await on.db
    .update(characterVisualAssets)
    .set({ status })
    .where(eq(characterVisualAssets.id, id));
}

/* ------------------------------------------------------------------ *
 * 1. Only approved content can be assigned
 * ------------------------------------------------------------------ */

describe('only approved content can be newly assigned', () => {
  it('adds an approved asset', async () => {
    const category = await makeCategory('Trending');
    const asset = await makeAsset({ status: 'approved' });

    const res = await api.add(category.id, { assetIds: [asset.id] });
    expect(res.statusCode).toBe(200);
    expect(res.json().added).toBe(1);
    expect(res.json().outcomes).toEqual([{ assetId: asset.id, added: true }]);
  });

  it.each(['generated', 'under_review', 'rejected'] as const)(
    'refuses a %s asset and names the status',
    async (status) => {
      const category = await makeCategory(`Cat ${status}`);
      const asset = await makeAsset({ status });

      const res = await api.add(category.id, { assetIds: [asset.id] });
      expect(res.statusCode).toBe(200);
      expect(res.json().added).toBe(0);
      expect(res.json().outcomes[0]).toMatchObject({
        assetId: asset.id,
        added: false,
        reason: 'not_approved',
        status,
      });
      expect((await api.contents(category.id)).json().assets).toEqual([]);
    },
  );

  it('reports an unknown asset id rather than failing the batch', async () => {
    const category = await makeCategory('Trending');
    const good = await makeAsset();
    const res = await api.add(category.id, {
      assetIds: [good.id, '11111111-1111-4111-8111-111111111111'],
    });
    expect(res.json().added).toBe(1);
    expect(res.json().outcomes[1]).toMatchObject({ added: false, reason: 'not_found' });
  });

  it('PARTIALLY succeeds: one bad asset never discards the good ones', async () => {
    const category = await makeCategory('Trending');
    const good = [await makeAsset(), await makeAsset(), await makeAsset()];
    const bad = await makeAsset({ status: 'under_review' });

    const res = await api.add(category.id, {
      assetIds: [good[0]!.id, bad.id, good[1]!.id, good[2]!.id],
    });
    expect(res.json()).toMatchObject({ added: 3, refused: 1 });
    expect((await api.contents(category.id)).json().assets).toHaveLength(3);
  });

  it('is idempotent — re-adding reports already_present, never a duplicate', async () => {
    const category = await makeCategory('Trending');
    const asset = await makeAsset();
    await api.add(category.id, { assetIds: [asset.id] });

    const res = await api.add(category.id, { assetIds: [asset.id] });
    expect(res.json().outcomes[0]).toMatchObject({ added: false, reason: 'already_present' });
    expect((await api.contents(category.id)).json().assets).toHaveLength(1);
  });

  /**
   * Scoped by id rather than by length: seedVisualIdentities creates approved
   * reference assets, and per the product decision those ARE assignable, so the
   * picker legitimately contains more than this test made.
   */
  it('the picker only ever offers approved content', async () => {
    const approved = await makeAsset({ status: 'approved' });
    const pending = await makeAsset({ status: 'under_review' });
    const rejected = await makeAsset({ status: 'rejected' });
    const raw = await makeAsset({ status: 'generated' });

    const offered = ((await api.candidates()).json().assets as Array<{ assetId: string }>).map(
      (a) => a.assetId,
    );
    expect(offered).toContain(approved.id);
    expect(offered).not.toContain(pending.id);
    expect(offered).not.toContain(rejected.id);
    expect(offered).not.toContain(raw.id);
  });
});

/* ------------------------------------------------------------------ *
 * 2. Rating and Primary are NOT publishability gates
 * ------------------------------------------------------------------ */

describe('rating and Primary status never gate publishability', () => {
  it('an approved EXPLICIT asset can be assigned and is offered by the picker', async () => {
    const category = await makeCategory('Explicit');
    const asset = await makeAsset({ contentRating: 'explicit' });

    expect((await api.add(category.id, { assetIds: [asset.id] })).json().added).toBe(1);
    const offered = (await api.candidates()).json().assets as Array<{ assetId: string }>;
    expect(offered.map((a) => a.assetId)).toContain(asset.id);
  });

  it('an approved PRIMARY reference can be assigned', async () => {
    const category = await makeCategory('Faces');
    const asset = await makeAsset({ isCanonical: true });

    expect((await api.add(category.id, { assetIds: [asset.id] })).json().added).toBe(1);
    const contents = (await api.contents(category.id)).json().assets;
    expect(contents[0]).toMatchObject({ assetId: asset.id, isPrimary: true, publishable: true });
  });

  it('exposes rating as a visible fact, and can filter by it without gating', async () => {
    const sfw = await makeAsset({ contentRating: 'sfw' });
    const explicit = await makeAsset({ contentRating: 'explicit' });

    const all = ((await api.candidates()).json().assets as Array<{ assetId: string }>).map(
      (a) => a.assetId,
    );
    expect(all).toEqual(expect.arrayContaining([sfw.id, explicit.id]));

    const onlyExplicit = (
      (await api.candidates('?contentRating=explicit')).json().assets as Array<{ assetId: string }>
    ).map((a) => a.assetId);
    expect(onlyExplicit).toContain(explicit.id);
    expect(onlyExplicit).not.toContain(sfw.id);
  });
});

/* ------------------------------------------------------------------ *
 * 3. Public reads filter independently
 * ------------------------------------------------------------------ */

describe('losing approval hides an item without losing the assignment', () => {
  it('disappears from the public read, stays in the admin read, and returns on re-approval', async () => {
    const category = await makeCategory('Trending');
    const keeper = await makeAsset();
    const loser = await makeAsset();
    await api.add(category.id, { assetIds: [keeper.id, loser.id] });

    expect(await listPublishableCategoryAssets(on.db, category.id)).toHaveLength(2);

    // Rejected in Review, AFTER it was assigned.
    await setStatus(loser.id, 'rejected');

    // Gone from the public result...
    const publicNow = await listPublishableCategoryAssets(on.db, category.id);
    expect(publicNow.map((a) => a.assetId)).toEqual([keeper.id]);

    // ...but the assignment survives and the admin sees it, flagged.
    const admin = (await api.contents(category.id)).json();
    expect(admin.assets).toHaveLength(2);
    expect(admin.totals).toMatchObject({ assigned: 2, publishable: 1 });
    const flagged = admin.assets.find((a: { assetId: string }) => a.assetId === loser.id);
    expect(flagged).toMatchObject({ publishable: false, status: 'rejected' });

    // Approving again restores it with no merchandising action at all.
    await setStatus(loser.id, 'approved');
    const restored = await listPublishableCategoryAssets(on.db, category.id);
    expect(restored.map((a) => a.assetId).sort()).toEqual([keeper.id, loser.id].sort());
  });

  it('an under_review asset assigned before is hidden too', async () => {
    const category = await makeCategory('Trending');
    const asset = await makeAsset();
    await api.add(category.id, { assetIds: [asset.id] });

    await setStatus(asset.id, 'under_review');
    expect(await listPublishableCategoryAssets(on.db, category.id)).toEqual([]);
    expect((await api.contents(category.id)).json().assets).toHaveLength(1);
  });

  it('the category list reports publishable separately from assigned', async () => {
    const category = await makeCategory('Trending');
    const a = await makeAsset();
    const b = await makeAsset();
    await api.add(category.id, { assetIds: [a.id, b.id] });
    await setStatus(b.id, 'rejected');

    const row = (await api.listCategories()).json().categories[0];
    expect(row).toMatchObject({ assignedAssetCount: 2, publishableAssetCount: 1 });
  });
});

/* ------------------------------------------------------------------ *
 * 4. Removal never modifies the asset
 * ------------------------------------------------------------------ */

describe('removing an assignment never modifies the Library asset', () => {
  it('leaves the entire asset row byte-identical', async () => {
    const category = await makeCategory('Trending');
    const asset = await makeAsset({ contentRating: 'explicit', isCanonical: true });
    await api.add(category.id, { assetIds: [asset.id] });

    const before = await assetRow(asset.id);

    const res = await api.remove(category.id, { assetIds: [asset.id] });
    expect(res.statusCode).toBe(200);
    expect(res.json().removed).toBe(1);

    const after = await assetRow(asset.id);
    expect(after).toEqual(before); // status, approvedAt, isCanonical, storageKey, everything
    expect((await api.contents(category.id)).json().assets).toEqual([]);
  });

  it('removing from one category leaves the asset in every other', async () => {
    const a = await makeCategory('Alpha');
    const b = await makeCategory('Bravo');
    const asset = await makeAsset();
    await api.add(a.id, { assetIds: [asset.id] });
    await api.add(b.id, { assetIds: [asset.id] });

    await api.remove(a.id, { assetIds: [asset.id] });

    expect((await api.contents(a.id)).json().assets).toEqual([]);
    expect((await api.contents(b.id)).json().assets).toHaveLength(1);
    expect(await assetRow(asset.id)).toBeDefined();
  });

  it('bulk removal reports what it removed and ignores what was not there', async () => {
    const category = await makeCategory('Trending');
    const assets = [await makeAsset(), await makeAsset()];
    const absent = await makeAsset();
    await api.add(category.id, { assetIds: assets.map((a) => a.id) });

    const res = await api.remove(category.id, {
      assetIds: [...assets.map((a) => a.id), absent.id],
    });
    expect(res.json().removed).toBe(2);
    expect(await assetRow(absent.id)).toBeDefined();
  });
});

/* ------------------------------------------------------------------ *
 * 5. Multi-category membership, one copy of the media
 * ------------------------------------------------------------------ */

describe('one asset, many categories, one copy of the media', () => {
  it('the same asset id appears in several categories with no new asset rows', async () => {
    const categories = [
      await makeCategory('Alpha'),
      await makeCategory('Bravo'),
      await makeCategory('Charlie'),
    ];
    const asset = await makeAsset();

    const { rows: before } = await on.pool.query<{ total: string }>(
      'SELECT count(*)::text AS total FROM character_visual_assets',
    );

    for (const category of categories) {
      await api.add(category.id, { assetIds: [asset.id] });
    }

    const { rows: after } = await on.pool.query<{ total: string }>(
      'SELECT count(*)::text AS total FROM character_visual_assets',
    );
    expect(after[0]!.total).toBe(before[0]!.total); // no duplication

    for (const category of categories) {
      const contents = (await api.contents(category.id)).json().assets;
      expect(contents.map((a: { assetId: string }) => a.assetId)).toEqual([asset.id]);
    }
  });

  it('the picker says how many other categories already use a candidate', async () => {
    const a = await makeCategory('Alpha');
    const b = await makeCategory('Bravo');
    const asset = await makeAsset();
    await api.add(a.id, { assetIds: [asset.id] });
    await api.add(b.id, { assetIds: [asset.id] });

    const offered = (
      (await api.candidates(`?categoryId=${a.id}`)).json().assets as Array<{ assetId: string }>
    ).find((row) => row.assetId === asset.id);
    expect(offered).toMatchObject({ categoryCount: 2, inThisCategory: true });
  });

  it('can hide what is already in the category being merchandised', async () => {
    const category = await makeCategory('Alpha');
    const inside = await makeAsset();
    const outside = await makeAsset();
    await api.add(category.id, { assetIds: [inside.id] });

    const offered = (
      (await api.candidates(`?categoryId=${category.id}&excludeAssigned=true`)).json()
        .assets as Array<{ assetId: string }>
    ).map((a) => a.assetId);
    expect(offered).toContain(outside.id);
    expect(offered).not.toContain(inside.id);
  });
});

/* ------------------------------------------------------------------ *
 * 6. Ordering and featuring
 * ------------------------------------------------------------------ */

describe('ordering and featuring within a category', () => {
  async function threeAssigned() {
    const category = await makeCategory('Trending');
    const assets = [await makeAsset(), await makeAsset(), await makeAsset()];
    await api.add(category.id, { assetIds: assets.map((a) => a.id) });
    return { category, assets };
  }

  it('applies a new order and renumbers', async () => {
    const { category, assets } = await threeAssigned();
    const reversed = [assets[2]!.id, assets[1]!.id, assets[0]!.id];

    const res = await api.order(category.id, { orderedAssetIds: reversed });
    expect(res.statusCode).toBe(200);
    expect(res.json().assets.map((a: { assetId: string }) => a.assetId)).toEqual(reversed);

    const reread = (await api.contents(category.id)).json().assets;
    expect(reread.map((a: { assetId: string }) => a.assetId)).toEqual(reversed);
  });

  it('refuses an incomplete order and changes nothing', async () => {
    const { category, assets } = await threeAssigned();
    const res = await api.order(category.id, { orderedAssetIds: [assets[0]!.id] });

    expect(res.statusCode).toBe(409);
    expect(res.json().reason).toBe('incomplete');
    const after = (await api.contents(category.id)).json().assets;
    expect(after.map((a: { assetId: string }) => a.assetId)).toEqual(assets.map((a) => a.id));
  });

  it('refuses an id that is not in this category', async () => {
    const { category, assets } = await threeAssigned();
    const stranger = await makeAsset();
    const res = await api.order(category.id, {
      orderedAssetIds: [assets[0]!.id, assets[1]!.id, stranger.id],
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().reason).toBe('unknown_id');
  });

  /**
   * FEATURED IS A BADGE, NOT A SORT KEY.
   *
   * It used to be the leading ORDER BY term, which made the drag an operator
   * most obviously wants — pull an ordinary item to the front — impossible: the
   * save wrote the requested positions and the next read sorted them straight
   * back, while the UI reported success.
   */
  it('featuring sets the flag and moves nothing', async () => {
    const { category, assets } = await threeAssigned();
    const before = await assetRow(assets[2]!.id);
    const orderBefore = (await api.contents(category.id)).json().assets.map(
      (a: { assetId: string }) => a.assetId,
    );

    const res = await api.feature(category.id, assets[2]!.id, { featured: true });
    expect(res.statusCode).toBe(200);

    const after = res.json().assets as Array<{ assetId: string; featured: boolean }>;
    expect(after.map((a) => a.assetId)).toEqual(orderBefore); // unmoved
    expect(after.find((a) => a.assetId === assets[2]!.id)!.featured).toBe(true);
    expect(await assetRow(assets[2]!.id)).toEqual(before);
  });

  it('an UNFEATURED item can be dragged ahead of a featured one, and it sticks', async () => {
    const { category, assets } = await threeAssigned();
    const [a, b, c] = assets;
    await api.feature(category.id, a!.id, { featured: true });

    // The exact move that used to silently revert.
    const wanted = [c!.id, a!.id, b!.id];
    const saved = await api.order(category.id, { orderedAssetIds: wanted });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().assets.map((x: { assetId: string }) => x.assetId)).toEqual(wanted);

    // ...and it survives a fresh read, which is where it used to snap back.
    const reread = (await api.contents(category.id)).json().assets;
    expect(reread.map((x: { assetId: string }) => x.assetId)).toEqual(wanted);
    expect(reread[1].featured).toBe(true); // still featured, just not first
  });

  it('featured and unfeatured items interleave in whatever order was saved', async () => {
    const category = await makeCategory('Mixed');
    const assets = [
      await makeAsset(),
      await makeAsset(),
      await makeAsset(),
      await makeAsset(),
    ];
    await api.add(category.id, { assetIds: assets.map((x) => x.id) });
    await api.feature(category.id, assets[1]!.id, { featured: true });
    await api.feature(category.id, assets[3]!.id, { featured: true });

    // featured, plain, plain, featured — an arrangement no featured-first sort
    // could produce.
    const wanted = [assets[1]!.id, assets[0]!.id, assets[2]!.id, assets[3]!.id];
    await api.order(category.id, { orderedAssetIds: wanted });

    const reread = (await api.contents(category.id)).json().assets as Array<{
      assetId: string;
      featured: boolean;
      position: number;
    }>;
    expect(reread.map((x) => x.assetId)).toEqual(wanted);
    expect(reread.map((x) => x.featured)).toEqual([true, false, false, true]);
    expect(reread.map((x) => x.position)).toEqual([0, 1, 2, 3]);
  });

  it('un-featuring also moves nothing', async () => {
    const { category, assets } = await threeAssigned();
    await api.feature(category.id, assets[0]!.id, { featured: true });
    const wanted = [assets[1]!.id, assets[0]!.id, assets[2]!.id];
    await api.order(category.id, { orderedAssetIds: wanted });

    await api.feature(category.id, assets[0]!.id, { featured: false });

    const reread = (await api.contents(category.id)).json().assets;
    expect(reread.map((x: { assetId: string }) => x.assetId)).toEqual(wanted);
  });

  it('the publishable read keeps the saved order too', async () => {
    const { category, assets } = await threeAssigned();
    await api.feature(category.id, assets[0]!.id, { featured: true });
    const wanted = [assets[2]!.id, assets[1]!.id, assets[0]!.id];
    await api.order(category.id, { orderedAssetIds: wanted });

    const publishable = await listPublishableCategoryAssets(on.db, category.id);
    expect(publishable.map((x) => x.assetId)).toEqual(wanted);
  });

  it('featuring is per category, not per asset', async () => {
    const a = await makeCategory('Alpha');
    const b = await makeCategory('Bravo');
    const asset = await makeAsset();
    await api.add(a.id, { assetIds: [asset.id] });
    await api.add(b.id, { assetIds: [asset.id] });

    await api.feature(a.id, asset.id, { featured: true });

    expect((await api.contents(a.id)).json().assets[0].featured).toBe(true);
    expect((await api.contents(b.id)).json().assets[0].featured).toBe(false);
  });

  it('404s when featuring an asset that is not in the category', async () => {
    const category = await makeCategory('Trending');
    const stranger = await makeAsset();
    expect((await api.feature(category.id, stranger.id, { featured: true })).statusCode).toBe(404);
  });

  it('adding appends after what is already arranged', async () => {
    const { category, assets } = await threeAssigned();
    await api.order(category.id, {
      orderedAssetIds: [assets[2]!.id, assets[0]!.id, assets[1]!.id],
    });
    const late = await makeAsset();
    await api.add(category.id, { assetIds: [late.id] });

    const order = (await api.contents(category.id)).json().assets.map(
      (a: { assetId: string }) => a.assetId,
    );
    expect(order).toEqual([assets[2]!.id, assets[0]!.id, assets[1]!.id, late.id]);
  });
});

/* ------------------------------------------------------------------ *
 * 7. Filtering the picker
 * ------------------------------------------------------------------ */

describe('finding content to assign', () => {
  it('filters by character and by media type', async () => {
    const mine = await makeAsset({ characterId: LUNA.id });
    await makeAsset({ characterId: OTHER.id });

    const byCharacter = (
      (await api.candidates(`?characterId=${LUNA.id}`)).json().assets as Array<{
        assetId: string;
        characterId: string;
      }>
    );
    expect(byCharacter.map((a) => a.assetId)).toContain(mine.id);
    expect(byCharacter.every((a) => a.characterId === LUNA.id)).toBe(true);

    const images = (await api.candidates('?mediaType=image')).json().assets as Array<{
      mediaType: string;
    }>;
    expect(images.length).toBeGreaterThan(0);
    expect(images.every((a) => a.mediaType === 'image')).toBe(true);
  });

  it('searches by character name, case-insensitively', async () => {
    await makeAsset({ characterId: LUNA.id });
    const found = (await api.candidates(`?search=${LUNA.name.toUpperCase()}`)).json()
      .assets as unknown[];
    expect(found.length).toBeGreaterThan(0);
    const missing = (await api.candidates('?search=zzzznotacharacter')).json().assets;
    expect(missing).toEqual([]);
  });

  it('never returns a storage key or a filesystem path', async () => {
    await makeAsset();
    const body = (await api.candidates()).body;
    expect(body).not.toContain('storageKey');
    expect(body).not.toContain('/app/var/media');
    expect(body).toContain('/admin/content/assets/');
  });
});

/* ------------------------------------------------------------------ *
 * 8. The opaque media route
 * ------------------------------------------------------------------ */

describe('the opaque asset media route', () => {
  it('404s an unknown or malformed id', async () => {
    expect((await api.file('11111111-1111-4111-8111-111111111111')).statusCode).toBe(404);
    expect((await api.file('not-a-uuid')).statusCode).toBe(404);
  });

  it('refuses a storage key that escapes the media root', async () => {
    // makeAsset stores an upload-style ROUTE with no provenance.storagePath, so
    // it resolves as a path and fails containment — refused, not served.
    const asset = await makeAsset();
    const res = await api.file(asset.id);
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('not_found');
  });

  it('reports a missing file distinctly from a missing row', async () => {
    const asset = await makeAsset();
    await on.db
      .update(characterVisualAssets)
      .set({ storageKey: join(testEnv.media.storageDir, 'nope.png') })
      .where(eq(characterVisualAssets.id, asset.id));

    const res = await api.file(asset.id);
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('file_missing');
  });

  it('requires an admin', async () => {
    const asset = await makeAsset();
    expect((await api.file(asset.id, {})).statusCode).toBe(401);
    expect((await api.file(asset.id, userCookies)).statusCode).toBe(403);
  });

  it('the library response no longer carries a storage key', async () => {
    await makeAsset();
    const res = await on.app.inject({
      method: 'GET',
      url: '/admin/content/library',
      cookies: adminCookies,
    });
    expect(res.body).not.toContain('storageKey');
    expect(res.body).toContain('previewUrl');
  });
});

/* ------------------------------------------------------------------ *
 * 9. Authorization
 * ------------------------------------------------------------------ */

describe('authorization', () => {
  const UNKNOWN = '11111111-1111-4111-8111-111111111111';

  it('rejects anonymous callers on every merchandising route', async () => {
    const none = {};
    expect((await api.candidates('', none)).statusCode).toBe(401);
    expect((await api.bySlug('trending', none)).statusCode).toBe(401);
    expect((await api.contents(UNKNOWN, none)).statusCode).toBe(401);
    expect((await api.add(UNKNOWN, { assetIds: [] }, none)).statusCode).toBe(401);
    expect((await api.remove(UNKNOWN, { assetIds: [] }, none)).statusCode).toBe(401);
    expect((await api.order(UNKNOWN, { orderedAssetIds: [] }, none)).statusCode).toBe(401);
    expect((await api.feature(UNKNOWN, UNKNOWN, { featured: true }, none)).statusCode).toBe(401);
  });

  it('rejects signed-in non-admins on every merchandising route', async () => {
    expect((await api.candidates('', userCookies)).statusCode).toBe(403);
    expect((await api.bySlug('trending', userCookies)).statusCode).toBe(403);
    expect((await api.contents(UNKNOWN, userCookies)).statusCode).toBe(403);
    expect((await api.add(UNKNOWN, { assetIds: [] }, userCookies)).statusCode).toBe(403);
    expect((await api.remove(UNKNOWN, { assetIds: [] }, userCookies)).statusCode).toBe(403);
    expect((await api.order(UNKNOWN, { orderedAssetIds: [] }, userCookies)).statusCode).toBe(403);
    expect(
      (await api.feature(UNKNOWN, UNKNOWN, { featured: true }, userCookies)).statusCode,
    ).toBe(403);
  });

  it('a non-admin cannot assign content even with a valid body', async () => {
    const category = await makeCategory('Trending');
    const asset = await makeAsset();
    await api.add(category.id, { assetIds: [asset.id] }, userCookies);
    expect((await api.contents(category.id)).json().assets).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * 10. Routing and lookup
 * ------------------------------------------------------------------ */

describe('routing', () => {
  it('resolves a category by its stable slug', async () => {
    const category = await makeCategory('Girlfriend Experience');
    const res = await api.bySlug('girlfriend-experience');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: category.id, slug: 'girlfriend-experience' });
  });

  it('404s an unknown slug', async () => {
    expect((await api.bySlug('nope')).statusCode).toBe(404);
  });

  it('does not treat "candidates" or "by-slug" as a category id', async () => {
    await makeCategory('Trending');
    expect((await api.candidates()).statusCode).toBe(200);
    expect(
      (await on.app.inject({
        method: 'DELETE',
        url: '/admin/app-categories/candidates',
        cookies: adminCookies,
      })).statusCode,
    ).toBe(404);
    expect((await api.listCategories()).json().categories).toHaveLength(1);
  });

  it('404s content operations on an unknown category', async () => {
    const asset = await makeAsset();
    const UNKNOWN = '11111111-1111-4111-8111-111111111111';
    expect((await api.contents(UNKNOWN)).statusCode).toBe(404);
    expect((await api.add(UNKNOWN, { assetIds: [asset.id] })).statusCode).toBe(404);
    expect((await api.remove(UNKNOWN, { assetIds: [asset.id] })).statusCode).toBe(404);
  });

  it('deleting a category releases its assignments and keeps every asset', async () => {
    // US-102.1's guarantee, re-checked now that assignments actually exist.
    const category = await makeCategory('Trending');
    const assets = [await makeAsset(), await makeAsset()];
    await api.add(category.id, { assetIds: assets.map((a) => a.id) });

    const res = await on.app.inject({
      method: 'DELETE',
      url: `/admin/app-categories/${category.id}`,
      cookies: adminCookies,
    });
    expect(res.json()).toEqual({ deleted: true, releasedAssetCount: 2 });
    for (const asset of assets) expect(await assetRow(asset.id)).toBeDefined();
  });
});
