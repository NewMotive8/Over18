import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { bannerCreatives, characters, homeBanners } from '../db/schema.js';
import { SEED_CHARACTERS } from '../db/seed-data.js';
import { seedCharacters, seedVisualIdentities } from '../db/seed.js';
import { createVisualAsset } from '../services/visual-asset-service.js';
import { getActiveVisualIdentity } from '../services/visual-identity-service.js';
import { listEligibleHomeBanners } from '../services/home-banner-service.js';
import { characterVisualAssets } from '../db/schema.js';
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
 * US-102.3 — banner management & scheduling.
 *
 * The rules these exist to hold:
 *
 *  1. A DRAFT IS NEVER PUBLIC. Nothing a caller can send makes a new banner
 *     public, and no edit can change lifecycle state.
 *  2. SCHEDULING IS DERIVED, and its boundaries are exact: start inclusive,
 *     end exclusive. Tested with an injected clock, not by waiting.
 *  3. A BROKEN DEPENDENCY MEANS NEEDS ATTENTION, NOT DELETION. All four
 *     destination kinds, plus a missing creative.
 *  4. DELETING A BANNER KEEPS ITS CREATIVE — row AND file.
 *  5. BANNER CREATIVES NEVER ENTER THE CHARACTER LIFECYCLE.
 *  6. EVERY ROUTE IS ADMIN-ONLY.
 */

const LUNA = SEED_CHARACTERS.find((c) => c.name === 'luna')!;
const STORAGE = { storageDir: testEnv.media.storageDir };

// Smallest valid PNG (1x1), so uploads exercise the real validator.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

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
  adminCookies = await register('banner.admin@example.com', 'admin');
  userCookies = await register('banner.user@example.com', 'user');
});

async function register(email: string, role: 'admin' | 'user') {
  const res = await on.app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email, password: 'home-banners-1' },
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
    await on.app.inject({ method: 'GET', url: '/admin/home-banners', cookies }),
  create: async (payload: Body, cookies = adminCookies) =>
    await on.app.inject({ method: 'POST', url: '/admin/home-banners', payload, cookies }),
  get: async (id: string, cookies = adminCookies) =>
    await on.app.inject({ method: 'GET', url: `/admin/home-banners/${id}`, cookies }),
  patch: async (id: string, payload: Body, cookies = adminCookies) =>
    await on.app.inject({ method: 'PATCH', url: `/admin/home-banners/${id}`, payload, cookies }),
  publish: async (id: string, cookies = adminCookies) =>
    await on.app.inject({ method: 'POST', url: `/admin/home-banners/${id}/publish`, cookies }),
  unpublish: async (id: string, cookies = adminCookies) =>
    await on.app.inject({ method: 'POST', url: `/admin/home-banners/${id}/unpublish`, cookies }),
  remove: async (id: string, cookies = adminCookies) =>
    await on.app.inject({ method: 'DELETE', url: `/admin/home-banners/${id}`, cookies }),
  // US-102.4 made ordering per SLOT: position is an order within a slot, so the
  // request names which one. Every banner these tests create lands in the
  // default 'before_search' slot.
  order: async (orderedIds: unknown, cookies = adminCookies, slot = 'before_search') =>
    await on.app.inject({
      method: 'PUT',
      url: '/admin/home-banners/order',
      payload: { slot, orderedIds },
      cookies,
    }),
  destinations: async (cookies = adminCookies) =>
    await on.app.inject({ method: 'GET', url: '/admin/home-banners/destinations', cookies }),
  requirements: async (cookies = adminCookies) =>
    await on.app.inject({
      method: 'GET',
      url: '/admin/home-banners/creative-requirements',
      cookies,
    }),
  creativeFile: async (id: string, cookies = adminCookies) =>
    await on.app.inject({
      method: 'GET',
      url: `/admin/home-banners/creatives/${id}/file`,
      cookies,
    }),
};

/** Multipart body, mirroring the shape the Library upload tests use. */
function multipart(filename: string, mimeType: string, bytes: Buffer) {
  const boundary = '----banner-test-boundary';
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: ${mimeType}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    payload: Buffer.concat([head, bytes, tail]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

async function uploadCreative(
  filename = 'promo.png',
  mimeType = 'image/png',
  bytes: Buffer = PNG,
  cookies = adminCookies,
) {
  const { payload, headers } = multipart(filename, mimeType, bytes);
  return on.app.inject({
    method: 'POST',
    url: '/admin/home-banners/creatives',
    headers,
    cookies,
    payload,
  });
}

async function makeCategory(name: string) {
  const res = await on.app.inject({
    method: 'POST',
    url: '/admin/app-categories',
    payload: { name },
    cookies: adminCookies,
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string; name: string };
}

async function makeApprovedAsset() {
  const identity = (await getActiveVisualIdentity(on.db, LUNA.id))!;
  const asset = await createVisualAsset(on.db, {
    characterId: LUNA.id,
    visualIdentityId: identity.id,
    kind: 'generated',
    status: 'approved',
    contentRating: 'sfw',
  });
  return asset;
}

/** A complete, publishable banner: real creative, valid destination. */
async function makeBanner(overrides: Body = {}) {
  const creative = (await uploadCreative()).json() as { id: string };
  const category = await makeCategory(`Cat ${Math.abs(Date.parse('2026-01-01'))}${Math.random()}`);
  const res = await api.create({
    title: 'Autumn feature',
    subtitle: 'Hand-picked',
    ctaLabel: 'Explore',
    creativeId: creative.id,
    destinationKind: 'category',
    destinationCategoryId: category.id,
    ...overrides,
  });
  expect(res.statusCode).toBe(201);
  return { banner: res.json(), creative, category };
}

/* ------------------------------------------------------------------ *
 * 1. Lifecycle
 * ------------------------------------------------------------------ */

describe('Draft → Publish → Unpublish', () => {
  it('creates as a draft, and a draft is never eligible', async () => {
    const { banner } = await makeBanner();
    expect(banner.status).toBe('draft');
    expect(banner.state).toBe('draft');
    expect(banner.publishedAt).toBeNull();

    const eligible = await listEligibleHomeBanners(on.db, STORAGE, {
      now: new Date(),
      viewer: { isReturning: true },
    });
    expect(eligible).toEqual([]);
  });

  it('IGNORES a status a caller tries to send at creation', async () => {
    // additionalProperties strips it; the service hard-codes 'draft' anyway.
    const creative = (await uploadCreative()).json();
    const category = await makeCategory('Sneaky');
    const res = await api.create({
      title: 'Sneaky',
      creativeId: creative.id,
      destinationKind: 'category',
      destinationCategoryId: category.id,
      status: 'published',
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().status).toBe('draft');
  });

  it('publishes explicitly and becomes eligible', async () => {
    const { banner } = await makeBanner();
    const res = await api.publish(banner.id);

    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('published');
    expect(res.json().state).toBe('live');
    expect(res.json().publishedAt).not.toBeNull();

    const eligible = await listEligibleHomeBanners(on.db, STORAGE, {
      now: new Date(),
      viewer: { isReturning: false },
    });
    expect(eligible.map((b) => b.id)).toEqual([banner.id]);
  });

  it('unpublishes without deleting anything, and republishes intact', async () => {
    const { banner, creative } = await makeBanner();
    await api.publish(banner.id);

    const off = await api.unpublish(banner.id);
    expect(off.json().state).toBe('unpublished');
    expect(off.json().creative.id).toBe(creative.id);
    expect(off.json().title).toBe('Autumn feature');
    expect(
      await listEligibleHomeBanners(on.db, STORAGE, {
        now: new Date(),
        viewer: { isReturning: true },
      }),
    ).toEqual([]);

    const back = await api.publish(banner.id);
    expect(back.json().state).toBe('live');
  });

  it('refuses to change lifecycle through an edit', async () => {
    const { banner } = await makeBanner();
    const res = await api.patch(banner.id, { status: 'published' });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('immutable_field');
    expect((await api.get(banner.id)).json().status).toBe('draft');
  });

  it('editing a PUBLISHED banner changes the live banner immediately', async () => {
    // No versioned publishing: this is the product decision, pinned.
    const { banner } = await makeBanner();
    await api.publish(banner.id);

    await api.patch(banner.id, { title: 'Changed while live' });

    const eligible = await listEligibleHomeBanners(on.db, STORAGE, {
      now: new Date(),
      viewer: { isReturning: true },
    });
    expect(eligible[0]!.title).toBe('Changed while live');
    expect(eligible[0]!.state).toBe('live');
  });

  it('refuses to publish a banner that is already broken', async () => {
    const { banner, category } = await makeBanner();
    await on.app.inject({
      method: 'DELETE',
      url: `/admin/app-categories/${category.id}`,
      cookies: adminCookies,
    });

    const res = await api.publish(banner.id);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('not_publishable');
    expect(res.json().problems).toContain('destination_missing');
  });
});

/* ------------------------------------------------------------------ *
 * 2. Scheduling — exact boundaries, injected clock
 * ------------------------------------------------------------------ */

describe('scheduling', () => {
  const START = '2026-09-01T09:00:00.000Z';
  const END = '2026-09-08T09:00:00.000Z';

  async function scheduled() {
    const { banner } = await makeBanner({ startsAt: START, endsAt: END });
    await api.publish(banner.id);
    return banner;
  }

  it('an unscheduled published banner is immediately live', async () => {
    const { banner } = await makeBanner();
    await api.publish(banner.id);
    expect((await api.get(banner.id)).json().state).toBe('live');
  });

  it('is Scheduled before the start', async () => {
    const banner = await scheduled();
    const eligible = await listEligibleHomeBanners(on.db, STORAGE, {
      now: new Date('2026-08-31T23:59:59.999Z'),
      viewer: { isReturning: true },
    });
    expect(eligible).toEqual([]);
    expect((await api.get(banner.id)).json().status).toBe('published');
  });

  it('is Live EXACTLY at the start — the boundary is inclusive', async () => {
    const banner = await scheduled();
    const eligible = await listEligibleHomeBanners(on.db, STORAGE, {
      now: new Date(START),
      viewer: { isReturning: true },
    });
    expect(eligible.map((b) => b.id)).toEqual([banner.id]);
  });

  it('is Live inside the window', async () => {
    const banner = await scheduled();
    const eligible = await listEligibleHomeBanners(on.db, STORAGE, {
      now: new Date('2026-09-04T12:00:00.000Z'),
      viewer: { isReturning: false },
    });
    expect(eligible.map((b) => b.id)).toEqual([banner.id]);
  });

  it('is Ended EXACTLY at the end — the boundary is exclusive', async () => {
    await scheduled();
    const eligible = await listEligibleHomeBanners(on.db, STORAGE, {
      now: new Date(END),
      viewer: { isReturning: true },
    });
    expect(eligible).toEqual([]);
  });

  it('deactivates automatically after the end, with no job having run', async () => {
    await scheduled();
    const eligible = await listEligibleHomeBanners(on.db, STORAGE, {
      now: new Date('2027-01-01T00:00:00.000Z'),
      viewer: { isReturning: true },
    });
    expect(eligible).toEqual([]);
  });

  it('accepts a start with no end, and an end with no start', async () => {
    const a = await makeBanner({ startsAt: START });
    expect(a.banner.startsAt).toBe(START);
    expect(a.banner.endsAt).toBeNull();
    const b = await makeBanner({ endsAt: END });
    expect(b.banner.endsAt).toBe(END);
  });

  it('rejects an end that is not after the start', async () => {
    const creative = (await uploadCreative()).json();
    const category = await makeCategory('Backwards');
    const res = await api.create({
      title: 'Backwards',
      creativeId: creative.id,
      destinationKind: 'category',
      destinationCategoryId: category.id,
      startsAt: END,
      endsAt: START,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().field).toBe('endsAt');
  });

  it('stores a valid IANA timezone and rejects an unknown one', async () => {
    const { banner } = await makeBanner({ scheduleTimezone: 'Europe/London' });
    expect(banner.scheduleTimezone).toBe('Europe/London');

    const bad = await api.patch(banner.id, { scheduleTimezone: 'Mars/Olympus_Mons' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().field).toBe('scheduleTimezone');
  });

  it('rejects an unparseable date', async () => {
    const { banner } = await makeBanner();
    const res = await api.patch(banner.id, { startsAt: 'next tuesday' });
    expect(res.statusCode).toBe(400);
    expect(res.json().field).toBe('startsAt');
  });

  /**
   * The window is a PAIR. Validating only the fields one request happened to
   * carry lets a single-sided edit invert a window that was valid when saved —
   * and an inverted window is not a visible error. It is a banner that reports
   * "Scheduled" or "Ended" forever, never appears, and shows nothing on screen
   * to say why.
   */
  describe('a one-sided edit is checked against the STORED window', () => {
    it('refuses an end moved before the stored start', async () => {
      const { banner } = await makeBanner({ startsAt: END });
      const res = await api.patch(banner.id, { endsAt: START });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('invalid_banner');
      expect(res.json().field).toBe('endsAt');
      // And the stored window is untouched.
      const after = (await api.get(banner.id)).json();
      expect(after.startsAt).toBe(END);
      expect(after.endsAt).toBeNull();
    });

    it('refuses a start moved after the stored end', async () => {
      const { banner } = await makeBanner({ endsAt: START });
      const res = await api.patch(banner.id, { startsAt: END });
      expect(res.statusCode).toBe(400);
      expect(res.json().field).toBe('endsAt');
      expect((await api.get(banner.id)).json().endsAt).toBe(START);
    });

    it('refuses an end EQUAL to the stored start — the end is exclusive', async () => {
      const { banner } = await makeBanner({ startsAt: START });
      expect((await api.patch(banner.id, { endsAt: START })).statusCode).toBe(400);
    });

    it('still allows a one-sided edit that leaves the window ordered', async () => {
      const { banner } = await makeBanner({ startsAt: START, endsAt: END });
      const later = '2026-10-01T09:00:00.000Z';
      const res = await api.patch(banner.id, { endsAt: later });
      expect(res.statusCode).toBe(200);
      expect(res.json().endsAt).toBe(later);
      expect(res.json().startsAt).toBe(START);
    });

    it('allows clearing one side, which removes the constraint entirely', async () => {
      const { banner } = await makeBanner({ startsAt: START, endsAt: END });
      const cleared = await api.patch(banner.id, { startsAt: null });
      expect(cleared.statusCode).toBe(200);
      expect(cleared.json().startsAt).toBeNull();
      // With no start there is nothing for an end to precede.
      expect((await api.patch(banner.id, { endsAt: '2020-01-01T00:00:00.000Z' })).statusCode).toBe(
        200,
      );
    });

    it('leaves no route into an inverted window, so no banner is silently stranded', async () => {
      const { banner } = await makeBanner({ startsAt: START, endsAt: END });
      await api.publish(banner.id);
      expect((await api.patch(banner.id, { endsAt: '2026-08-01T00:00:00.000Z' })).statusCode).toBe(
        400,
      );
      expect((await api.patch(banner.id, { startsAt: '2027-01-01T00:00:00.000Z' })).statusCode).toBe(
        400,
      );
      const eligible = await listEligibleHomeBanners(on.db, STORAGE, {
        now: new Date('2026-09-04T00:00:00.000Z'),
        viewer: { isReturning: true },
      });
      expect(eligible.map((b) => b.id)).toEqual([banner.id]);
    });
  });
});

/* ------------------------------------------------------------------ *
 * 2b. A bad identifier is a validation error, never a database error
 * ------------------------------------------------------------------ */

/**
 * Every id this API accepts names a uuid column. Left unchecked, a malformed
 * one reaches the driver as `22P02 invalid input syntax for type uuid` and a
 * well-formed-but-absent one as a `23503` foreign-key violation — and because
 * the app installs no error handler of its own, Fastify turns both into a 500
 * whose body echoes the database's message, constraint names included.
 *
 * The contract these pin: a bad id is a 400 invalid_banner naming the field,
 * exactly like every other bad field.
 */
describe('identifier validation', () => {
  const ABSENT = '11111111-1111-4111-8111-111111111111';
  const MALFORMED = ['not-a-uuid', '123', "'; DROP TABLE home_banners;--", '../../etc/passwd'];

  async function base(overrides: Body = {}): Promise<Body> {
    const creative = (await uploadCreative()).json() as { id: string };
    const category = await makeCategory(`Ids ${process.pid} ${Math.random()}`);
    return {
      title: 'Ids',
      creativeId: creative.id,
      destinationKind: 'category',
      destinationCategoryId: category.id,
      ...overrides,
    };
  }

  it('a malformed creativeId is a 400, not a 500', async () => {
    for (const bad of MALFORMED) {
      const res = await api.create(await base({ creativeId: bad }));
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('invalid_banner');
      expect(res.json().field).toBe('creativeId');
    }
  });

  it('a malformed destination id is a 400 for every kind that takes one', async () => {
    const cases: Array<[string, string]> = [
      ['category', 'destinationCategoryId'],
      ['character', 'destinationCharacterId'],
      ['content', 'destinationAssetId'],
    ];
    for (const [kind, field] of cases) {
      const res = await api.create(
        await base({ destinationKind: kind, destinationCategoryId: null, [field]: 'not-a-uuid' }),
      );
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('invalid_banner');
      expect(res.json().field).toBe(field);
    }
  });

  it('a well-formed id naming nothing is a 400, not a foreign-key 500', async () => {
    const creativeRes = await api.create(await base({ creativeId: ABSENT }));
    expect(creativeRes.statusCode).toBe(400);
    expect(creativeRes.json().field).toBe('creativeId');

    const categoryRes = await api.create(await base({ destinationCategoryId: ABSENT }));
    expect(categoryRes.statusCode).toBe(400);
    expect(categoryRes.json().field).toBe('destinationCategoryId');

    const characterRes = await api.create(
      await base({
        destinationKind: 'character',
        destinationCategoryId: null,
        destinationCharacterId: ABSENT,
      }),
    );
    expect(characterRes.statusCode).toBe(400);
    expect(characterRes.json().field).toBe('destinationCharacterId');

    const assetRes = await api.create(
      await base({
        destinationKind: 'content',
        destinationCategoryId: null,
        destinationAssetId: ABSENT,
      }),
    );
    expect(assetRes.statusCode).toBe(400);
    expect(assetRes.json().field).toBe('destinationAssetId');
  });

  it('PATCH refuses a bad id the same way CREATE does', async () => {
    const { banner } = await makeBanner();
    for (const payload of [
      { creativeId: 'not-a-uuid' },
      { creativeId: ABSENT },
      { destinationKind: 'category', destinationCategoryId: 'not-a-uuid' },
      { destinationKind: 'category', destinationCategoryId: ABSENT },
      { destinationKind: 'character', destinationCharacterId: ABSENT },
      { destinationKind: 'content', destinationAssetId: ABSENT },
    ]) {
      const res = await api.patch(banner.id, payload);
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('invalid_banner');
    }
  });

  it('no database error text ever reaches the client', async () => {
    const res = await api.create(await base({ creativeId: ABSENT }));
    for (const leak of ['violates', 'constraint', 'syntax for type', 'banner_creatives', '_fk']) {
      expect(res.payload).not.toContain(leak);
    }
  });

  it('a rejected create writes nothing', async () => {
    const before = (await api.list()).json().banners.length;
    await api.create(await base({ creativeId: 'not-a-uuid' }));
    await api.create(await base({ destinationCategoryId: ABSENT }));
    expect((await api.list()).json().banners.length).toBe(before);
  });

  it('a rejected patch leaves the banner exactly as it was', async () => {
    const { banner } = await makeBanner();
    const before = (await api.get(banner.id)).json();
    await api.patch(banner.id, { title: 'Renamed', creativeId: ABSENT });
    const after = (await api.get(banner.id)).json();
    expect(after.title).toBe(before.title);
    expect(after.creative?.id).toBe(before.creative?.id);
    expect(after.updatedAt).toBe(before.updatedAt);
  });

  it('a real id still works — the guard rejects nothing valid', async () => {
    const created = await api.create(await base());
    expect(created.statusCode).toBe(201);
    const second = (await uploadCreative()).json() as { id: string };
    const patched = await api.patch(created.json().id, { creativeId: second.id });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().creative.id).toBe(second.id);
  });

  it('an unknown banner id is still a 404, not a validation error', async () => {
    expect((await api.patch(ABSENT, { title: 'x' })).statusCode).toBe(404);
    expect((await api.get(ABSENT)).statusCode).toBe(404);
  });
});

/* ------------------------------------------------------------------ *
 * 3. Destinations and Needs attention
 * ------------------------------------------------------------------ */

describe('destinations', () => {
  it('accepts all four kinds and clears the other columns', async () => {
    const creative = (await uploadCreative()).json();
    const category = await makeCategory('Dest');
    const asset = await makeApprovedAsset();

    const cat = await api.create({
      title: 'A',
      creativeId: creative.id,
      destinationKind: 'category',
      destinationCategoryId: category.id,
    });
    expect(cat.json().destination).toMatchObject({ kind: 'category', label: 'Dest' });

    const chr = await api.create({
      title: 'B',
      creativeId: creative.id,
      destinationKind: 'character',
      destinationCharacterId: LUNA.id,
    });
    expect(chr.json().destination).toMatchObject({ kind: 'character', categoryId: null });

    const content = await api.create({
      title: 'C',
      creativeId: creative.id,
      destinationKind: 'content',
      destinationAssetId: asset.id,
    });
    expect(content.json().destination).toMatchObject({ kind: 'content', characterId: null });

    const ext = await api.create({
      title: 'D',
      creativeId: creative.id,
      destinationKind: 'external',
      destinationUrl: 'https://example.com/promo',
    });
    expect(ext.json().destination).toMatchObject({
      kind: 'external',
      url: 'https://example.com/promo',
      categoryId: null,
    });
  });

  it.each([
    ['http://example.com', 'insecure scheme'],
    ['javascript:alert(1)', 'script scheme'],
    ['https://user:pw@example.com', 'embedded credentials'],
    ['not a url', 'malformed'],
    ['', 'empty'],
  ])('rejects %s (%s)', async (url) => {
    const creative = (await uploadCreative()).json();
    const res = await api.create({
      title: 'Bad link',
      creativeId: creative.id,
      destinationKind: 'external',
      destinationUrl: url,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().field).toBe('destinationUrl');
  });

  it('requires a selected entity for each internal kind', async () => {
    const creative = (await uploadCreative()).json();
    for (const kind of ['category', 'character', 'content'] as const) {
      const res = await api.create({ title: kind, creativeId: creative.id, destinationKind: kind });
      expect(res.statusCode).toBe(400);
    }
  });

  it('offers only usable entities in the picker', async () => {
    const enabled = await makeCategory('Enabled');
    const disabled = await makeCategory('Disabled');
    await on.app.inject({
      method: 'PATCH',
      url: `/admin/app-categories/${disabled.id}`,
      payload: { enabled: false },
      cookies: adminCookies,
    });
    await makeApprovedAsset();

    const body = (await api.destinations()).json();
    expect(body.categories.map((c: { id: string }) => c.id)).toEqual([enabled.id]);
    expect(body.characters.length).toBeGreaterThan(0);
    expect(body.content.length).toBeGreaterThan(0);
  });
});

describe('a broken dependency means Needs attention, never deletion', () => {
  it('a DELETED category breaks the banner but keeps it whole', async () => {
    const { banner, category, creative } = await makeBanner();
    await api.publish(banner.id);

    await on.app.inject({
      method: 'DELETE',
      url: `/admin/app-categories/${category.id}`,
      cookies: adminCookies,
    });

    const after = (await api.get(banner.id)).json();
    expect(after.state).toBe('needs_attention');
    expect(after.problems).toContain('destination_missing');
    // Retained and editable — nothing was silently removed.
    expect(after.title).toBe('Autumn feature');
    expect(after.creative.id).toBe(creative.id);
    expect(after.status).toBe('published');
    expect(
      await listEligibleHomeBanners(on.db, STORAGE, {
        now: new Date(),
        viewer: { isReturning: true },
      }),
    ).toEqual([]);
  });

  it('a DISABLED category is unavailable rather than missing, and repair restores it', async () => {
    const { banner, category } = await makeBanner();
    await api.publish(banner.id);

    await on.app.inject({
      method: 'PATCH',
      url: `/admin/app-categories/${category.id}`,
      payload: { enabled: false },
      cookies: adminCookies,
    });
    expect((await api.get(banner.id)).json().problems).toContain('destination_unavailable');

    // Repairing the DESTINATION is enough — no banner action needed.
    await on.app.inject({
      method: 'PATCH',
      url: `/admin/app-categories/${category.id}`,
      payload: { enabled: true },
      cookies: adminCookies,
    });
    expect((await api.get(banner.id)).json().state).toBe('live');
  });

  it('a DEACTIVATED character breaks a character banner', async () => {
    const creative = (await uploadCreative()).json();
    const created = await api.create({
      title: 'Meet Luna',
      creativeId: creative.id,
      destinationKind: 'character',
      destinationCharacterId: LUNA.id,
    });
    await api.publish(created.json().id);

    await on.db
      .update(characters)
      .set({ status: 'inactive' })
      .where(eq(characters.id, LUNA.id));

    const after = (await api.get(created.json().id)).json();
    expect(after.state).toBe('needs_attention');
    expect(after.problems).toContain('destination_unavailable');
  });

  it('content that loses approval breaks a content banner', async () => {
    const creative = (await uploadCreative()).json();
    const asset = await makeApprovedAsset();
    const created = await api.create({
      title: 'Look at this',
      creativeId: creative.id,
      destinationKind: 'content',
      destinationAssetId: asset.id,
    });
    await api.publish(created.json().id);

    await on.db
      .update(characterVisualAssets)
      .set({ status: 'rejected' })
      .where(eq(characterVisualAssets.id, asset.id));

    const after = (await api.get(created.json().id)).json();
    expect(after.state).toBe('needs_attention');
    expect(after.problems).toContain('destination_unavailable');
  });

  it('a MISSING creative breaks the banner', async () => {
    const { banner, creative } = await makeBanner();
    await api.publish(banner.id);

    await on.db.delete(bannerCreatives).where(eq(bannerCreatives.id, creative.id));

    const after = (await api.get(banner.id)).json();
    expect(after.state).toBe('needs_attention');
    expect(after.problems).toContain('creative_missing');
    expect(
      await listEligibleHomeBanners(on.db, STORAGE, {
        now: new Date(),
        viewer: { isReturning: true },
      }),
    ).toEqual([]);
  });

  it('a creative whose FILE is gone breaks the banner', async () => {
    const { banner, creative } = await makeBanner();
    await api.publish(banner.id);

    await on.db
      .update(bannerCreatives)
      .set({ storagePath: null })
      .where(eq(bannerCreatives.id, creative.id));

    expect((await api.get(banner.id)).json().problems).toContain('creative_invalid');
  });

  it('a DRAFT with problems is still just a draft', async () => {
    // An operator part-way through building one has asserted nothing yet.
    const creative = (await uploadCreative()).json();
    const category = await makeCategory('Later');
    const created = await api.create({
      title: 'WIP',
      creativeId: creative.id,
      destinationKind: 'category',
      destinationCategoryId: category.id,
    });
    await on.app.inject({
      method: 'DELETE',
      url: `/admin/app-categories/${category.id}`,
      cookies: adminCookies,
    });
    expect((await api.get(created.json().id)).json().state).toBe('draft');
  });
});

/* ------------------------------------------------------------------ *
 * 4. Audience
 * ------------------------------------------------------------------ */

describe('audience', () => {
  async function published(audience: string) {
    const { banner } = await makeBanner({ audience });
    await api.publish(banner.id);
    return banner.id;
  }

  it('everyone matches both viewers', async () => {
    const id = await published('everyone');
    for (const isReturning of [true, false]) {
      const eligible = await listEligibleHomeBanners(on.db, STORAGE, {
        now: new Date(),
        viewer: { isReturning },
      });
      expect(eligible.map((b) => b.id)).toEqual([id]);
    }
  });

  it('new_users matches only a first-time viewer', async () => {
    const id = await published('new_users');
    expect(
      (
        await listEligibleHomeBanners(on.db, STORAGE, {
          now: new Date(),
          viewer: { isReturning: false },
        })
      ).map((b) => b.id),
    ).toEqual([id]);
    expect(
      await listEligibleHomeBanners(on.db, STORAGE, {
        now: new Date(),
        viewer: { isReturning: true },
      }),
    ).toEqual([]);
  });

  it('returning_users matches only a returning viewer', async () => {
    const id = await published('returning_users');
    expect(
      (
        await listEligibleHomeBanners(on.db, STORAGE, {
          now: new Date(),
          viewer: { isReturning: true },
        })
      ).map((b) => b.id),
    ).toEqual([id]);
    expect(
      await listEligibleHomeBanners(on.db, STORAGE, {
        now: new Date(),
        viewer: { isReturning: false },
      }),
    ).toEqual([]);
  });

  it('rejects an audience outside the MVP set', async () => {
    const { banner } = await makeBanner();
    const res = await api.patch(banner.id, { audience: 'lapsed_whales' });
    expect(res.statusCode).toBe(400);
  });
});

/* ------------------------------------------------------------------ *
 * 5. Creatives
 * ------------------------------------------------------------------ */

describe('banner creatives', () => {
  it('publishes the requirements as data, from the authoritative list', async () => {
    const body = (await api.requirements()).json();
    expect(body.acceptedMimeTypes).toEqual(
      expect.arrayContaining([
        'image/jpeg',
        'image/png',
        'image/webp',
        'video/mp4',
        'video/webm',
        'video/quicktime',
      ]),
    );
    expect(body.acceptedMimeTypes).not.toContain('image/gif');
    expect(body.maxLabel).toBe('100MB');
    expect(body.dimensionsEnforced).toBe(false);
    expect(body.recommendedAspect).toBe('16:9');
  });

  it('uploads a PNG, reads its dimensions and serves it back', async () => {
    const res = await uploadCreative();
    expect(res.statusCode).toBe(201);
    const creative = res.json();
    expect(creative.mediaType).toBe('image');
    expect(creative).toMatchObject({ width: 1, height: 1 });
    expect(creative.fileUrl).toBe(`/admin/home-banners/creatives/${creative.id}/file`);

    const file = await api.creativeFile(creative.id);
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toBe('image/png');
  });

  it('never puts a storage path on the wire', async () => {
    const res = await uploadCreative();
    expect(res.body).not.toContain('storagePath');
    expect(res.body).not.toContain(testEnv.media.storageDir);
  });

  it('rejects an unsupported type with an actionable message', async () => {
    const res = await uploadCreative('anim.gif', 'image/gif', PNG);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('unsupported_type');
    expect(res.json().message).toContain('image/png');
  });

  it('rejects an empty file', async () => {
    const res = await uploadCreative('empty.png', 'image/png', Buffer.alloc(0));
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('empty_file');
  });

  it('is stored outside the character library and enters no review queue', async () => {
    const creative = (await uploadCreative()).json();

    // Not a character asset...
    const assets = await on.db.select().from(characterVisualAssets);
    expect(assets.map((a) => a.id)).not.toContain(creative.id);

    // ...and the review queue never sees it.
    const review = await on.app.inject({
      method: 'GET',
      url: '/admin/content/review',
      cookies: adminCookies,
    });
    expect(review.body).not.toContain(creative.id);
  });

  it('404s an unknown creative and a malformed id', async () => {
    expect((await api.creativeFile('11111111-1111-4111-8111-111111111111')).statusCode).toBe(404);
    expect((await api.creativeFile('nope')).statusCode).toBe(404);
  });
});

/* ------------------------------------------------------------------ *
 * 6. Deleting a banner keeps its creative
 * ------------------------------------------------------------------ */

describe('deleting a banner', () => {
  it('keeps the creative row AND its file', async () => {
    const { banner, creative } = await makeBanner();
    const [before] = await on.db
      .select()
      .from(bannerCreatives)
      .where(eq(bannerCreatives.id, creative.id));
    expect(existsSync(before!.storagePath!)).toBe(true);

    const res = await api.remove(banner.id);
    expect(res.json()).toEqual({ deleted: true, creativeKept: true });

    const [after] = await on.db
      .select()
      .from(bannerCreatives)
      .where(eq(bannerCreatives.id, creative.id));
    expect(after).toEqual(before);
    expect(existsSync(after!.storagePath!)).toBe(true);
    expect((await api.creativeFile(creative.id)).statusCode).toBe(200);
  });

  it('leaves the destination untouched', async () => {
    const { banner, category } = await makeBanner();
    await api.remove(banner.id);
    const categories = (
      await on.app.inject({ method: 'GET', url: '/admin/app-categories', cookies: adminCookies })
    ).json();
    expect(categories.categories.map((c: { id: string }) => c.id)).toContain(category.id);
  });

  it('404s an unknown id', async () => {
    expect((await api.remove('11111111-1111-4111-8111-111111111111')).statusCode).toBe(404);
  });
});

/* ------------------------------------------------------------------ *
 * 7. Ordering
 * ------------------------------------------------------------------ */

describe('ordering', () => {
  async function three() {
    const a = (await makeBanner({ title: 'A' })).banner;
    const b = (await makeBanner({ title: 'B' })).banner;
    const c = (await makeBanner({ title: 'C' })).banner;
    return [a, b, c];
  }

  it('creates in order and applies a new one', async () => {
    const [a, b, c] = await three();
    expect([a.position, b.position, c.position]).toEqual([0, 1, 2]);

    const res = await api.order([c.id, a.id, b.id]);
    expect(res.statusCode).toBe(200);
    expect(res.json().banners.map((x: { id: string }) => x.id)).toEqual([c.id, a.id, b.id]);
    expect(res.json().banners.map((x: { position: number }) => x.position)).toEqual([0, 1, 2]);
  });

  it('refuses an incomplete order and changes nothing', async () => {
    const [a, b, c] = await three();
    const res = await api.order([c.id]);
    expect(res.statusCode).toBe(409);
    expect(res.json().reason).toBe('incomplete');
    expect((await api.list()).json().banners.map((x: { id: string }) => x.id)).toEqual([
      a.id,
      b.id,
      c.id,
    ]);
  });

  it('refuses an unknown id and a duplicate', async () => {
    const [a, b, c] = await three();
    expect(
      (await api.order([a.id, b.id, '11111111-1111-4111-8111-111111111111'])).statusCode,
    ).toBe(409);
    expect((await api.order([a.id, a.id, b.id, c.id])).statusCode).toBe(409);
  });

  it('eligible banners come back in the saved order', async () => {
    const [a, b, c] = await three();
    for (const banner of [a, b, c]) await api.publish(banner.id);
    await api.order([b.id, c.id, a.id]);

    const eligible = await listEligibleHomeBanners(on.db, STORAGE, {
      now: new Date(),
      viewer: { isReturning: true },
    });
    expect(eligible.map((x) => x.id)).toEqual([b.id, c.id, a.id]);
  });

  it('does not treat "order" as a banner id', async () => {
    await three();
    expect((await api.remove('order')).statusCode).toBe(404);
    expect((await api.list()).json().banners).toHaveLength(3);
  });
});

/* ------------------------------------------------------------------ *
 * 8. Authorization
 * ------------------------------------------------------------------ */

describe('authorization', () => {
  const UNKNOWN = '11111111-1111-4111-8111-111111111111';

  it('rejects anonymous callers on every route', async () => {
    const none = {};
    expect((await api.list(none)).statusCode).toBe(401);
    expect((await api.create({ title: 'x', destinationKind: 'external' }, none)).statusCode).toBe(401);
    expect((await api.get(UNKNOWN, none)).statusCode).toBe(401);
    expect((await api.patch(UNKNOWN, { title: 'x' }, none)).statusCode).toBe(401);
    expect((await api.publish(UNKNOWN, none)).statusCode).toBe(401);
    expect((await api.unpublish(UNKNOWN, none)).statusCode).toBe(401);
    expect((await api.remove(UNKNOWN, none)).statusCode).toBe(401);
    expect((await api.order([], none)).statusCode).toBe(401);
    expect((await api.destinations(none)).statusCode).toBe(401);
    expect((await api.requirements(none)).statusCode).toBe(401);
    expect((await api.creativeFile(UNKNOWN, none)).statusCode).toBe(401);
    expect((await uploadCreative('a.png', 'image/png', PNG, none)).statusCode).toBe(401);
  });

  it('rejects signed-in non-admins on every route', async () => {
    expect((await api.list(userCookies)).statusCode).toBe(403);
    expect(
      (await api.create({ title: 'x', destinationKind: 'external' }, userCookies)).statusCode,
    ).toBe(403);
    expect((await api.get(UNKNOWN, userCookies)).statusCode).toBe(403);
    expect((await api.patch(UNKNOWN, { title: 'x' }, userCookies)).statusCode).toBe(403);
    expect((await api.publish(UNKNOWN, userCookies)).statusCode).toBe(403);
    expect((await api.unpublish(UNKNOWN, userCookies)).statusCode).toBe(403);
    expect((await api.remove(UNKNOWN, userCookies)).statusCode).toBe(403);
    expect((await api.order([], userCookies)).statusCode).toBe(403);
    expect((await api.destinations(userCookies)).statusCode).toBe(403);
    expect((await api.requirements(userCookies)).statusCode).toBe(403);
    expect((await api.creativeFile(UNKNOWN, userCookies)).statusCode).toBe(403);
    expect((await uploadCreative('a.png', 'image/png', PNG, userCookies)).statusCode).toBe(403);
  });

  it('a non-admin cannot create a banner even with a valid body', async () => {
    const creative = (await uploadCreative()).json();
    const category = await makeCategory('Guarded');
    await api.create(
      {
        title: 'Sneaky',
        creativeId: creative.id,
        destinationKind: 'category',
        destinationCategoryId: category.id,
      },
      userCookies,
    );
    expect((await api.list()).json().banners).toEqual([]);
  });

  it('exposes NO public banner route', async () => {
    // US-102.4 consumes the service function; nothing is served publicly here.
    for (const url of ['/api/home-banners', '/api/banners', '/home-banners']) {
      const res = await on.app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(404);
    }
  });
});

/* ------------------------------------------------------------------ *
 * 9. Isolation from other systems
 * ------------------------------------------------------------------ */

describe('isolation', () => {
  it('banner work leaves categories, characters and assets untouched', async () => {
    const { banner, category } = await makeBanner();
    const asset = await makeApprovedAsset();

    const [assetBefore] = await on.db
      .select()
      .from(characterVisualAssets)
      .where(eq(characterVisualAssets.id, asset.id));

    await api.publish(banner.id);
    await api.patch(banner.id, { title: 'Edited' });
    await api.unpublish(banner.id);
    await api.remove(banner.id);

    const [assetAfter] = await on.db
      .select()
      .from(characterVisualAssets)
      .where(eq(characterVisualAssets.id, asset.id));
    expect(assetAfter).toEqual(assetBefore);

    const categories = (
      await on.app.inject({ method: 'GET', url: '/admin/app-categories', cookies: adminCookies })
    ).json();
    expect(categories.categories.map((c: { id: string }) => c.id)).toContain(category.id);
  });

  it('no banner row survives its own deletion', async () => {
    const { banner } = await makeBanner();
    await api.remove(banner.id);
    const rows = await on.db.select().from(homeBanners).where(eq(homeBanners.id, banner.id));
    expect(rows).toEqual([]);
  });
});
