import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { characterVisualAssets, contentRequirements } from '../db/schema.js';
import { SEED_CHARACTERS } from '../db/seed-data.js';
import { seedCharacters, seedVisualIdentities } from '../db/seed.js';
import { createVisualAsset } from '../services/visual-asset-service.js';
import { getActiveVisualIdentity } from '../services/visual-identity-service.js';
import {
  linkAssetToCategory,
  listCategoryAssetIds,
  slugFromName,
} from '../services/app-category-service.js';
import {
  createContentRequirement,
  requirementKeyFromLabel,
} from '../services/content-requirements-service.js';
import {
  createTestContext,
  destroyTestContext,
  extractSessionCookie,
  migrateTestDb,
  truncateAll,
  type TestContext,
} from './helpers.js';

/**
 * US-102.1 — App Category Management & Ordering.
 *
 * The properties these tests exist to hold, in priority order:
 *
 *  1. DELETING A CATEGORY NEVER DELETES CONTENT. The headline product rule.
 *     Proven against real link rows, by counting asset rows before and after
 *     and re-reading each one — not by trusting a comment about cascades.
 *  2. RENAMING NEVER CHANGES IDENTITY. The slug is what references hold.
 *  3. REORDERING IS ALL-OR-NOTHING. A stale client cannot silently drop a
 *     category someone else just added.
 *  4. APP CATEGORIES AND CONTENT REQUIREMENTS ARE UNRELATED. They share a word
 *     and nothing else; operations on one must not perturb the other.
 *  5. EVERY ROUTE IS ADMIN-ONLY.
 */

const LUNA = SEED_CHARACTERS.find((c) => c.name === 'luna')!;

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
  adminCookies = await register('cat.admin@example.com', 'admin');
  userCookies = await register('cat.user@example.com', 'user');
});

async function register(email: string, role: 'admin' | 'user') {
  const res = await on.app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email, password: 'app-categories-1' },
  });
  const cookie = extractSessionCookie(res)!;
  if (role === 'admin') {
    await on.pool.query(`UPDATE users SET role = 'admin' WHERE email = $1`, [email]);
  }
  return { [cookie.name]: cookie.value };
}

type Body = Record<string, unknown>;

const api = {
  list: async (cookies = adminCookies) =>
    await on.app.inject({ method: 'GET', url: '/admin/app-categories', cookies }),
  create: async (payload: Body, cookies = adminCookies) =>
    await on.app.inject({ method: 'POST', url: '/admin/app-categories', payload, cookies }),
  patch: async (id: string, payload: Body, cookies = adminCookies) =>
    await on.app.inject({ method: 'PATCH', url: `/admin/app-categories/${id}`, payload, cookies }),
  remove: async (id: string, cookies = adminCookies) =>
    await on.app.inject({ method: 'DELETE', url: `/admin/app-categories/${id}`, cookies }),
  reorder: async (orderedIds: unknown, cookies = adminCookies) =>
    await on.app.inject({
      method: 'PUT',
      url: '/admin/app-categories/order',
      payload: { orderedIds },
      cookies,
    }),
};

async function makeCategory(name: string, extra: Record<string, unknown> = {}) {
  const res = await api.create({ name, ...extra });
  expect(res.statusCode).toBe(201);
  return res.json() as {
    id: string;
    slug: string;
    name: string;
    tagline: string | null;
    enabled: boolean;
    position: number;
  };
}

/** A real approved Library asset, so link rows point at something genuine. */
async function makeApprovedAsset() {
  const identity = (await getActiveVisualIdentity(on.db, LUNA.id))!;
  return createVisualAsset(on.db, {
    characterId: LUNA.id,
    visualIdentityId: identity.id,
    kind: 'generated',
    status: 'approved',
    contentRating: 'sfw',
  });
}

async function countAssetRows(): Promise<number> {
  const { rows } = await on.pool.query<{ total: string }>(
    'SELECT count(*)::text AS total FROM character_visual_assets',
  );
  return Number(rows[0]!.total);
}

/* ------------------------------------------------------------------ *
 * Creating
 * ------------------------------------------------------------------ */

describe('creating a category', () => {
  it('derives a stable slug from the name', async () => {
    const created = await makeCategory('Girlfriend Experience');
    expect(created.slug).toBe('girlfriend-experience');
    expect(created.position).toBe(0);
  });

  it('accepts an explicit slug', async () => {
    const created = await makeCategory('Most Popular', { slug: 'trending' });
    expect(created.slug).toBe('trending');
  });

  it('normalises accents and punctuation into a usable identifier', () => {
    expect(slugFromName('  Café  Noir!! ')).toBe('cafe-noir');
    expect(slugFromName('Милые')).toBe('');
  });

  it('rejects a blank name', async () => {
    const res = await api.create({ name: '   ' });
    expect(res.statusCode).toBe(400);
    expect(res.json().field).toBe('name');
  });

  it('rejects a name that yields no usable identifier', async () => {
    const res = await api.create({ name: '!!!' });
    expect(res.statusCode).toBe(400);
    expect(res.json().field).toBe('slug');
  });

  it('refuses a duplicate identifier with 409 rather than a 500', async () => {
    await makeCategory('Trending');
    const res = await api.create({ name: 'Trending' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('slug_taken');
    expect(res.json().slug).toBe('trending');
  });

  it('stores an empty tagline as absent rather than as an empty string', async () => {
    const created = await makeCategory('New', { tagline: '   ' });
    expect(created.tagline).toBeNull();
  });

  it('appends to the end, never renumbering what is already arranged', async () => {
    const a = await makeCategory('Alpha');
    const b = await makeCategory('Bravo');
    const c = await makeCategory('Charlie');
    expect([a.position, b.position, c.position]).toEqual([0, 1, 2]);
  });

  it('starts from an empty list', async () => {
    const res = await api.list();
    expect(res.statusCode).toBe(200);
    expect(res.json().categories).toEqual([]);
    expect(res.json().totals).toEqual({ categories: 0, enabled: 0, assignedAssets: 0 });
  });
});

/* ------------------------------------------------------------------ *
 * Identity stability — the reason a slug exists at all
 * ------------------------------------------------------------------ */

describe('identity is the slug, not the name', () => {
  it('renaming leaves the slug untouched', async () => {
    const created = await makeCategory('Girlfriend');
    const res = await api.patch(created.id, { name: 'Girlfriends' });

    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe('Girlfriends');
    expect(res.json().slug).toBe('girlfriend'); // unchanged — references survive
  });

  it('refuses an attempt to change the slug, with an explanation', async () => {
    const created = await makeCategory('Trending');
    const res = await api.patch(created.id, { slug: 'hot-right-now' });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('immutable_field');
    expect(res.json().message).toMatch(/identifier cannot change/i);

    // ...and nothing was written on the way to refusing.
    const after = await api.list();
    expect(after.json().categories[0].slug).toBe('trending');
  });

  it('a rename does not disturb assignments', async () => {
    const category = await makeCategory('Trending');
    const asset = await makeApprovedAsset();
    await linkAssetToCategory(on.db, category.id, asset.id);

    await api.patch(category.id, { name: 'Hot Right Now' });

    expect(await listCategoryAssetIds(on.db, category.id)).toEqual([asset.id]);
  });
});

/* ------------------------------------------------------------------ *
 * Enable / disable
 * ------------------------------------------------------------------ */

describe('enabling and disabling', () => {
  it('round-trips without touching anything else', async () => {
    const category = await makeCategory('Cosplay', { tagline: 'Dress-up' });

    const off = await api.patch(category.id, { enabled: false });
    expect(off.json().enabled).toBe(false);
    expect(off.json().tagline).toBe('Dress-up');
    expect(off.json().slug).toBe('cosplay');

    const on_ = await api.patch(category.id, { enabled: true });
    expect(on_.json().enabled).toBe(true);
  });

  it('a disabled category still counts as a category but not as enabled', async () => {
    const a = await makeCategory('Alpha');
    await makeCategory('Bravo');
    await api.patch(a.id, { enabled: false });

    const totals = (await api.list()).json().totals;
    expect(totals).toMatchObject({ categories: 2, enabled: 1 });
  });

  it('rejects a non-boolean enabled', async () => {
    const category = await makeCategory('Alpha');
    const res = await api.patch(category.id, { enabled: 'yes' });
    expect(res.statusCode).toBe(400);
  });
});

/* ------------------------------------------------------------------ *
 * DELETION — the headline guarantee
 * ------------------------------------------------------------------ */

describe('deleting a category never deletes content', () => {
  it('releases the assignments and leaves every asset in the Library', async () => {
    const category = await makeCategory('Trending');
    const other = await makeCategory('New');
    const assets = [await makeApprovedAsset(), await makeApprovedAsset(), await makeApprovedAsset()];

    for (const [index, asset] of assets.entries()) {
      await linkAssetToCategory(on.db, category.id, asset.id, index);
    }
    // One asset lives in TWO categories — deleting one must not affect the other.
    await linkAssetToCategory(on.db, other.id, assets[0]!.id);

    const assetsBefore = await countAssetRows();
    expect(await listCategoryAssetIds(on.db, category.id)).toHaveLength(3);

    const res = await api.remove(category.id);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ deleted: true, releasedAssetCount: 3 });

    // The assets are ALL still there, byte for byte, still approved.
    expect(await countAssetRows()).toBe(assetsBefore);
    for (const asset of assets) {
      const [row] = await on.db
        .select()
        .from(characterVisualAssets)
        .where(eq(characterVisualAssets.id, asset.id));
      expect(row).toBeDefined();
      expect(row!.status).toBe('approved');
      expect(row!.characterId).toBe(LUNA.id);
    }

    // Only the links went, and only this category's links.
    expect(await listCategoryAssetIds(on.db, category.id)).toEqual([]);
    expect(await listCategoryAssetIds(on.db, other.id)).toEqual([assets[0]!.id]);
  });

  it('reports zero released when nothing was assigned', async () => {
    const category = await makeCategory('Empty');
    const res = await api.remove(category.id);
    expect(res.json()).toEqual({ deleted: true, releasedAssetCount: 0 });
  });

  it('closes the gap in the order so positions stay contiguous', async () => {
    const a = await makeCategory('Alpha');
    const b = await makeCategory('Bravo');
    const c = await makeCategory('Charlie');

    await api.remove(b.id);

    const rows = (await api.list()).json().categories as Array<{ id: string; position: number }>;
    expect(rows.map((r) => r.id)).toEqual([a.id, c.id]);
    expect(rows.map((r) => r.position)).toEqual([0, 1]);
  });

  it('404s for an unknown or malformed id, and changes nothing', async () => {
    await makeCategory('Alpha');
    expect((await api.remove('11111111-1111-4111-8111-111111111111')).statusCode).toBe(404);
    expect((await api.remove('not-a-uuid')).statusCode).toBe(404);
    expect((await api.list()).json().categories).toHaveLength(1);
  });

  it('deleting the ASSET instead releases the link and leaves the category', async () => {
    const category = await makeCategory('Trending');
    const asset = await makeApprovedAsset();
    await linkAssetToCategory(on.db, category.id, asset.id);

    await on.db.delete(characterVisualAssets).where(eq(characterVisualAssets.id, asset.id));

    expect(await listCategoryAssetIds(on.db, category.id)).toEqual([]);
    expect((await api.list()).json().categories).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ *
 * Ordering
 * ------------------------------------------------------------------ */

describe('reordering', () => {
  async function threeCategories() {
    return [await makeCategory('Alpha'), await makeCategory('Bravo'), await makeCategory('Charlie')];
  }

  it('applies a new order and renumbers to 0..n-1', async () => {
    const [a, b, c] = await threeCategories();
    const res = await api.reorder([c!.id, a!.id, b!.id]);

    expect(res.statusCode).toBe(200);
    const rows = res.json().categories as Array<{ id: string; position: number }>;
    expect(rows.map((r) => r.id)).toEqual([c!.id, a!.id, b!.id]);
    expect(rows.map((r) => r.position)).toEqual([0, 1, 2]);

    // ...and it survives a fresh read, not just the response.
    const reread = (await api.list()).json().categories as Array<{ id: string }>;
    expect(reread.map((r) => r.id)).toEqual([c!.id, a!.id, b!.id]);
  });

  it('refuses an incomplete list — the stale-browser case — and changes nothing', async () => {
    const [a, b, c] = await threeCategories();
    const res = await api.reorder([c!.id, a!.id]);

    expect(res.statusCode).toBe(409);
    expect(res.json().reason).toBe('incomplete');

    const rows = (await api.list()).json().categories as Array<{ id: string }>;
    expect(rows.map((r) => r.id)).toEqual([a!.id, b!.id, c!.id]); // untouched
  });

  it('refuses an unknown id', async () => {
    const [a, b, c] = await threeCategories();
    const res = await api.reorder([a!.id, b!.id, '11111111-1111-4111-8111-111111111111']);
    expect(res.statusCode).toBe(409);
    expect(res.json().reason).toBe('unknown_id');
    const rows = (await api.list()).json().categories as Array<{ id: string }>;
    expect(rows.map((r) => r.id)).toEqual([a!.id, b!.id, c!.id]);
  });

  it('refuses a duplicated id', async () => {
    const [a, b] = await threeCategories();
    const res = await api.reorder([a!.id, a!.id, b!.id]);
    expect(res.statusCode).toBe(409);
    expect(res.json().reason).toBe('duplicate');
  });

  it('does not treat "order" as a category id', async () => {
    await threeCategories();
    // The DELETE route shares the prefix; "order" must not reach it as an id.
    expect((await api.remove('order')).statusCode).toBe(404);
    expect((await api.list()).json().categories).toHaveLength(3);
  });

  it('reordering never touches assignments', async () => {
    const [a, b] = await threeCategories();
    const asset = await makeApprovedAsset();
    await linkAssetToCategory(on.db, b!.id, asset.id);
    const before = await countAssetRows();

    await api.reorder([b!.id, a!.id, (await api.list()).json().categories[2].id]);

    expect(await listCategoryAssetIds(on.db, b!.id)).toEqual([asset.id]);
    expect(await countAssetRows()).toBe(before);
  });
});

/* ------------------------------------------------------------------ *
 * Two different things called "category"
 * ------------------------------------------------------------------ */

describe('app categories and content requirements are unrelated', () => {
  /**
   * truncateAll deliberately leaves content_requirements alone (they are
   * configuration seeded by the migration), so these tests must not depend on
   * a particular requirement being absent. A per-run unique label keeps them
   * independent of whatever else the suite has created.
   */
  let seq = 0;
  const uniqueLabel = (base: string) => `${base} ${process.pid} ${++seq}`;

  it('managing app categories leaves content requirements untouched', async () => {
    const label = uniqueLabel('Beach Day');
    const requirement = await createContentRequirement(on.db, {
      label,
      mediaType: 'video',
      requiredQuantity: 2,
    });

    // Same words, different world.
    const category = await makeCategory(label);
    await api.patch(category.id, { name: `${label} renamed`, enabled: false });
    await api.remove(category.id);

    const [row] = await on.db
      .select()
      .from(contentRequirements)
      .where(eq(contentRequirements.id, requirement.id));
    expect(row).toBeDefined();
    expect(row!.label).toBe(label);
    expect(row!.key).toBe(requirementKeyFromLabel(label));
    expect(row!.requiredQuantity).toBe(2);
    expect(row!.enabled).toBe(true);
  });

  it('an app category slug and a requirement key may coexist harmlessly', async () => {
    const label = uniqueLabel('Rooftop');
    const requirement = await createContentRequirement(on.db, { label, mediaType: 'video' });
    const category = await makeCategory(label);

    // Two identifiers derived from the same words, in two unrelated systems.
    expect(requirement.key).toBe(requirementKeyFromLabel(label)); // underscores
    expect(category.slug).toBe(slugFromName(label)); // hyphens
    expect((await api.list()).json().categories).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ *
 * Authorization
 * ------------------------------------------------------------------ */

describe('authorization', () => {
  it('every route rejects an anonymous caller with 401', async () => {
    const none = {};
    expect((await api.list(none)).statusCode).toBe(401);
    expect((await api.create({ name: 'X' }, none)).statusCode).toBe(401);
    expect(
      (await api.patch('11111111-1111-4111-8111-111111111111', { name: 'X' }, none)).statusCode,
    ).toBe(401);
    expect((await api.remove('11111111-1111-4111-8111-111111111111', none)).statusCode).toBe(401);
    expect((await api.reorder([], none)).statusCode).toBe(401);
  });

  it('every route rejects a signed-in non-admin with 403', async () => {
    expect((await api.list(userCookies)).statusCode).toBe(403);
    expect((await api.create({ name: 'X' }, userCookies)).statusCode).toBe(403);
    expect(
      (await api.patch('11111111-1111-4111-8111-111111111111', { name: 'X' }, userCookies))
        .statusCode,
    ).toBe(403);
    expect(
      (await api.remove('11111111-1111-4111-8111-111111111111', userCookies)).statusCode,
    ).toBe(403);
    expect((await api.reorder([], userCookies)).statusCode).toBe(403);
  });

  it('a non-admin cannot create a category even with a valid body', async () => {
    await api.create({ name: 'Sneaky' }, userCookies);
    expect((await api.list()).json().categories).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * Request shape
 * ------------------------------------------------------------------ */

describe('request validation', () => {
  /**
   * Fastify's default AJV runs with removeAdditional, so an unknown field is
   * STRIPPED rather than rejected. That is the safe outcome — it can never
   * reach the service or the database — but it is worth pinning, because the
   * property that matters is "cannot be persisted", not the status code.
   */
  it('never persists a field the schema does not declare', async () => {
    const res = await api.create({ name: 'Alpha', featured: true, position: 99 });
    expect(res.statusCode).toBe(201);
    expect(res.json()).not.toHaveProperty('featured');
    expect(res.json().position).toBe(0); // ours, not theirs
  });

  it('rejects a reorder body that cannot be a list of ids', async () => {
    const res = await api.reorder({ nope: true });
    expect(res.statusCode).toBe(400);
  });

  /**
   * AJV also coerces a bare scalar into a single-element array, so a malformed
   * "a,b,c" arrives as ["a,b,c"] — one unknown id, refused as out of date
   * rather than silently applied.
   */
  it('treats a coerced scalar as an unknown id, never as an order', async () => {
    await makeCategory('Alpha');
    const res = await api.reorder('a,b,c');
    expect(res.statusCode).toBe(409);
    expect((await api.list()).json().categories).toHaveLength(1);
  });

  it('an empty reorder on an empty list is a no-op, not an error', async () => {
    const res = await api.reorder([]);
    expect(res.statusCode).toBe(200);
    expect(res.json().categories).toEqual([]);
  });
});
