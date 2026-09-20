import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { AdminCharacterContentAccess, CustomerContentAccessResponse } from '@over18/shared';
import { buildApp } from '../app.js';
import { createDb } from '../db/client.js';
import { SEED_CHARACTERS } from '../db/seed-data.js';
import { seedCharacters, seedVisualIdentities } from '../db/seed.js';
import { uploadLibraryAsset } from '../services/library-upload-service.js';
import { approveVisualAsset } from '../services/visual-asset-service.js';
import {
  TEST_DATABASE_URL,
  createTestContext,
  destroyTestContext,
  extractSessionCookie,
  migrateTestDb,
  testEnv,
  truncateAll,
  type TestContext,
} from './helpers.js';

/**
 * PRD v1.2 P4.D2 -- a character's clips are Premium by default, an operator
 * marks individual clips Free, or asks for N Free clips and the system picks
 * them at random.
 *
 * It adds no content management: clips are uploaded, approved and released
 * exactly as before, and the access it writes is ordinary P4.1 offers, read by
 * the P4.2 customer resolver. `live` has the economy on; `dark` is the
 * production default. Every count below is test data.
 */

const LUNA = SEED_CHARACTERS.find((c) => c.name === 'luna')!;
const EMBER = SEED_CHARACTERS.find((c) => c.name !== 'luna')!;
const STORAGE = { storageDir: testEnv.media.storageDir, servePathPrefix: '/admin/content/uploads' };
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

let dark: TestContext;
let live: TestContext;
let enforced: TestContext;
let seq = 0;

async function app(over: Partial<typeof testEnv>): Promise<TestContext> {
  const { db, pool } = createDb(TEST_DATABASE_URL);
  return { app: await buildApp({ ...testEnv, ...over }, db), db, pool };
}

beforeAll(async () => {
  migrateTestDb();
  dark = await createTestContext();
  live = await app({ commerce: { ...testEnv.commerce, enabled: true } });
  enforced = await app({ commerce: { ...testEnv.commerce, enabled: true }, admin: { ...testEnv.admin, permissionsEnforced: true } });
});
afterAll(async () => {
  for (const ctx of [dark, live, enforced]) await destroyTestContext(ctx);
});
beforeEach(async () => {
  await truncateAll(dark);
  await seedCharacters(dark.db);
  await seedVisualIdentities(dark.db);
});

const q = <T = Record<string, unknown>>(text: string, params: unknown[] = []) =>
  dark.pool.query<T & import('pg').QueryResultRow>(text, params);

interface Account {
  id: string;
  cookies: Record<string, string>;
}

async function account(roles?: string[]): Promise<Account> {
  const email = `p4d2-${process.pid}-${++seq}@example.com`;
  const res = await dark.app.inject({ method: 'POST', url: '/api/auth/register', payload: { email, password: 'clips-pass-1' } });
  expect(res.statusCode).toBe(201);
  const id = (await q<{ id: string }>('SELECT id FROM users WHERE email = $1', [email])).rows[0]!.id;
  if (roles) {
    await q(`UPDATE users SET role = 'admin' WHERE id = $1`, [id]);
    for (const role of roles) await q('INSERT INTO admin_role_grants (user_id, role) VALUES ($1, $2)', [id, role]);
  }
  const cookie = extractSessionCookie(res)!;
  return { id, cookies: { [cookie.name]: cookie.value } };
}

/** A clip of hers, through the existing upload/approve/release workflow. */
async function clip(operator: Account, characterId = LUNA.id, release = true): Promise<string> {
  const created = await uploadLibraryAsset(dark.db, STORAGE, { characterId, mimeType: 'image/png', bytes: PNG, originalName: 'clip.png' });
  const approved = await approveVisualAsset(dark.db, created.id);
  if (release) {
    const res = await dark.app.inject({ method: 'POST', url: `/admin/content/assets/${approved.id}/publish`, cookies: operator.cookies });
    expect(res.statusCode, res.body).toBe(200);
  }
  return approved.id;
}
const clips = async (operator: Account, count: number): Promise<string[]> => {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) ids.push(await clip(operator));
  return ids;
};

/* ---- the endpoints ---- */

const ACCESS = (characterId: string) => `/admin/characters/${characterId}/content-access`;
const view = async (who: Account, characterId = LUNA.id, ctx: TestContext = live) => {
  const res = await ctx.app.inject({ method: 'GET', url: ACCESS(characterId), cookies: who.cookies });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as AdminCharacterContentAccess;
};
const allocate = (who: Account, freeClipCount: unknown, characterId = LUNA.id, ctx: TestContext = live) =>
  ctx.app.inject({
    method: 'PUT',
    url: `${ACCESS(characterId)}/allocation`,
    cookies: who.cookies,
    payload: { freeClipCount, reason: 'Launch allocation' },
  });
const mark = (who: Account, assetId: string, state: unknown, characterId = LUNA.id, ctx: TestContext = live) =>
  ctx.app.inject({
    method: 'PUT',
    url: `${ACCESS(characterId)}/clips/${assetId}`,
    cookies: who.cookies,
    payload: { state, reason: 'Chosen as a taster' },
  });
const clear = (who: Account, characterId = LUNA.id, ctx: TestContext = live) =>
  ctx.app.inject({ method: 'POST', url: `${ACCESS(characterId)}/clear`, cookies: who.cookies, payload: { reason: 'Back to free' } });

const applied = async (res: Awaited<ReturnType<typeof allocate>>) => {
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as AdminCharacterContentAccess;
};
const stateOf = (page: AdminCharacterContentAccess, assetId: string) => page.clips.find((c) => c.assetId === assetId);
const offerCount = async () => (await q<{ n: number }>('SELECT count(*)::int AS n FROM content_offers')).rows[0]!.n;
const allocationRows = async () => (await q<{ n: number }>('SELECT count(*)::int AS n FROM character_clip_allocation')).rows[0]!.n;
const accessAudits = async () =>
  (await q<{ action: string; object_id: string; reason: string; after: unknown }>(
    `SELECT action, object_id, reason, after FROM audit_log WHERE object_type = 'content_access' ORDER BY id`,
  )).rows;

/* ------------------------------------------------------------------ *
 * Who may
 * ------------------------------------------------------------------ */

describe('who may set a character\'s Free clips', () => {
  it('refuses an anonymous caller (401) and a customer (403), and writes nothing', async () => {
    const operator = await account([]);
    await clip(operator);
    expect((await live.app.inject({ method: 'GET', url: ACCESS(LUNA.id) })).statusCode).toBe(401);
    const customer = await account();
    expect((await live.app.inject({ method: 'GET', url: ACCESS(LUNA.id), cookies: customer.cookies })).statusCode).toBe(403);
    expect((await allocate(customer, 1)).statusCode).toBe(403);
    expect(await offerCount()).toBe(0);
    expect(await allocationRows()).toBe(0);
  });

  it('with enforcement on: it is the existing access.manage permission, no new one', async () => {
    const operator = await account([]);
    await clips(operator, 2);
    const economyEditor = await account(['economy_editor']);
    const refused = await allocate(economyEditor, 1, LUNA.id, enforced);
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ error: 'forbidden', permission: 'access.manage' });

    // §34.1 gives access.manage to the content editor, and the administrator has everything.
    for (const role of ['content_editor', 'administrator']) {
      const editor = await account([role]);
      expect((await allocate(editor, 1, LUNA.id, enforced)).statusCode, role).toBe(200);
    }
  });
});

/* ------------------------------------------------------------------ *
 * The default, and the two operator actions
 * ------------------------------------------------------------------ */

describe('a character nobody has allocated', () => {
  it('is exactly as she is today: every clip Free, by default, with nothing written', async () => {
    const operator = await account([]);
    const ids = await clips(operator, 3);
    const page = await view(operator);
    expect(page).toMatchObject({ characterId: LUNA.id, allocation: { configured: false, freeClipCount: null }, counts: { clips: 3, free: 3, premium: 0 } });
    for (const id of ids) expect(stateOf(page, id)).toMatchObject({ state: 'free', byDefault: true, creditPrice: null, ageFloor: null });
    expect(await offerCount()).toBe(0);
  });
});

describe('allocating N Free clips', () => {
  it('makes exactly N Free and every other clip Premium, and records what it chose', async () => {
    const operator = await account([]);
    const ids = await clips(operator, 5);
    const page = await applied(await allocate(operator, 2));

    expect(page.allocation).toEqual({ configured: true, freeClipCount: 2 });
    expect(page.counts).toEqual({ clips: 5, free: 2, premium: 3 });
    const free = page.clips.filter((c) => c.state === 'free').map((c) => c.assetId);
    expect(free).toHaveLength(2);
    for (const id of ids) expect(page.clips.some((c) => c.assetId === id)).toBe(true);
    // Every clip now says what it is, explicitly.
    for (const c of page.clips) expect(c.byDefault).toBe(false);

    const audits = await accessAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ action: 'content.access.allocate', object_id: LUNA.id, reason: 'Launch allocation' });
    expect(audits[0]!.after).toMatchObject({ freeClipCount: 2, clips: 5 });
    expect((audits[0]!.after as { free: string[] }).free.sort()).toEqual([...free].sort());
  });

  it('chooses them at random: asked repeatedly, it does not always pick the same clip', async () => {
    const operator = await account([]);
    await clips(operator, 6);
    const chosen = new Set<string>();
    for (let round = 0; round < 12; round++) {
      const page = await applied(await allocate(operator, 1));
      const free = page.clips.filter((c) => c.state === 'free');
      expect(free, `round ${round}`).toHaveLength(1);
      chosen.add(free[0]!.assetId);
    }
    expect(chosen.size).toBeGreaterThan(1);
  });

  it('asking for more Free clips than she has makes them all Free; asking for none locks them all', async () => {
    const operator = await account([]);
    await clips(operator, 3);
    expect((await applied(await allocate(operator, 99))).counts).toEqual({ clips: 3, free: 3, premium: 0 });
    expect((await applied(await allocate(operator, 0))).counts).toEqual({ clips: 3, free: 0, premium: 3 });
  });

  it('a clip uploaded afterwards is Premium, with nothing written for it', async () => {
    const operator = await account([]);
    await clips(operator, 2);
    await applied(await allocate(operator, 2));
    const later = await clip(operator);

    const page = await view(operator);
    expect(stateOf(page, later)).toMatchObject({ state: 'premium', byDefault: true });
    expect(page.counts).toEqual({ clips: 3, free: 2, premium: 1 });
  });

  it('only that character: another character is untouched', async () => {
    const operator = await account([]);
    await clips(operator, 2);
    const hers = await clip(operator, EMBER.id);
    await applied(await allocate(operator, 0));
    expect(stateOf(await view(operator, EMBER.id), hers)).toMatchObject({ state: 'free', byDefault: true });
  });
});

describe('marking one clip', () => {
  it('makes just that clip Free, leaving the rest as they were', async () => {
    const operator = await account([]);
    const ids = await clips(operator, 3);
    await applied(await allocate(operator, 0));

    const res = await mark(operator, ids[1]!, 'free');
    expect(res.statusCode, res.body).toBe(200);
    const page = res.json() as AdminCharacterContentAccess;
    expect(stateOf(page, ids[1]!)).toMatchObject({ state: 'free', byDefault: false });
    expect(page.counts).toEqual({ clips: 3, free: 1, premium: 2 });

    // And back again.
    const premium = (await mark(operator, ids[1]!, 'premium')).json() as AdminCharacterContentAccess;
    expect(stateOf(premium, ids[1]!)).toMatchObject({ state: 'premium' });
    expect((await accessAudits()).map((a) => a.action)).toEqual(['content.access.allocate', 'content.access.free', 'content.access.premium']);
  });

  it('works for a character with no allocation at all: one Free clip among Free clips', async () => {
    const operator = await account([]);
    const ids = await clips(operator, 2);
    expect((await mark(operator, ids[0]!, 'premium')).statusCode).toBe(200);
    const page = await view(operator);
    expect(stateOf(page, ids[0]!)).toMatchObject({ state: 'premium', byDefault: false });
    expect(stateOf(page, ids[1]!)).toMatchObject({ state: 'free', byDefault: true });
  });
});

describe('taking a character back out', () => {
  it('clears the allocation and retires the offers: her clips read Free again, as they did before', async () => {
    const operator = await account([]);
    const ids = await clips(operator, 3);
    await applied(await allocate(operator, 1));
    expect(await offerCount()).toBe(3);

    const res = await clear(operator);
    expect(res.statusCode, res.body).toBe(200);
    const page = res.json() as AdminCharacterContentAccess;
    expect(page.allocation).toEqual({ configured: false, freeClipCount: null });
    expect(page.counts).toEqual({ clips: 3, free: 3, premium: 0 });
    for (const id of ids) expect(stateOf(page, id)).toMatchObject({ state: 'free', byDefault: true });

    // The offers stay as history, retired -- never deleted.
    expect(await offerCount()).toBe(3);
    expect((await q<{ n: number }>('SELECT count(*)::int AS n FROM content_offers WHERE retired_at IS NOT NULL')).rows[0]!.n).toBe(3);
    expect(await allocationRows()).toBe(0);
    // A clip uploaded now is Free again, like the rest of the library.
    const later = await clip(operator);
    expect(stateOf(await view(operator), later)).toMatchObject({ state: 'free', byDefault: true });
  });
});

/* ------------------------------------------------------------------ *
 * What a customer then sees (P4.2)
 * ------------------------------------------------------------------ */

describe('the customer sees the allocation through the existing access model', () => {
  it('Free clips open, Premium clips need Premium -- including one uploaded after the allocation', async () => {
    const operator = await account([]);
    await clips(operator, 2);
    const page = await applied(await allocate(operator, 1));
    const free = page.clips.find((c) => c.state === 'free')!.assetId;
    const locked = page.clips.find((c) => c.state === 'premium')!.assetId;
    const later = await clip(operator);

    const customer = await account();
    const res = await live.app.inject({
      method: 'GET',
      url: `/api/content/access?assetIds=${[free, locked, later].join(',')}`,
      cookies: customer.cookies,
    });
    expect(res.statusCode, res.body).toBe(200);
    const items = (res.json() as CustomerContentAccessResponse).items;
    expect(items.map((i) => [i.state, i.decision])).toEqual([
      ['free', 'open'],
      ['premium', 'premium_required'],
      ['premium', 'premium_required'],
    ]);
  });
});

/* ------------------------------------------------------------------ *
 * Dark, refusals, and the content workflow
 * ------------------------------------------------------------------ */

describe('while the economy is off', () => {
  it('reading works and says so; every change is refused (503) with nothing written', async () => {
    const operator = await account([]);
    const ids = await clips(operator, 2);
    const page = await view(operator, LUNA.id, dark);
    expect(page).toMatchObject({ economyEnabled: false, allocation: { configured: false }, counts: { clips: 2, free: 2 } });

    for (const res of [
      await allocate(operator, 1, LUNA.id, dark),
      await mark(operator, ids[0]!, 'free', LUNA.id, dark),
      await clear(operator, LUNA.id, dark),
    ]) {
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ error: 'economy_unavailable' });
    }
    expect(await offerCount()).toBe(0);
    expect(await allocationRows()).toBe(0);
    expect(await accessAudits()).toEqual([]);
  });
});

describe('a refused change writes nothing', () => {
  it('unknown character or clip (404), and a malformed request (400)', async () => {
    const operator = await account([]);
    const ids = await clips(operator, 1);
    const hers = await clip(operator, EMBER.id);

    expect((await allocate(operator, 1, randomUUID())).statusCode).toBe(404);
    expect((await live.app.inject({ method: 'GET', url: ACCESS(randomUUID()), cookies: operator.cookies })).statusCode).toBe(404);
    // A clip of another character is not one of hers.
    expect((await mark(operator, hers, 'free')).statusCode).toBe(404);
    expect((await mark(operator, randomUUID(), 'free')).statusCode).toBe(404);

    for (const count of [-1, 1.5, '2', null, undefined]) {
      expect((await allocate(operator, count)).statusCode, String(count)).toBe(400);
    }
    // Credit pricing is a separate decision (P4.1), not one of the two states here.
    for (const state of ['credit', 'unavailable', 'locked', '']) {
      expect((await mark(operator, ids[0]!, state)).statusCode, state).toBe(400);
    }
    const noReason = await live.app.inject({
      method: 'PUT',
      url: `${ACCESS(LUNA.id)}/allocation`,
      cookies: operator.cookies,
      payload: { freeClipCount: 1 },
    });
    expect(noReason.statusCode).toBe(400);

    expect(await offerCount()).toBe(0);
    expect(await allocationRows()).toBe(0);
    expect(await accessAudits()).toEqual([]);
  });
});

describe('the content workflow is untouched', () => {
  it('allocating changes no asset, character or any other row -- only offers and the allocation', async () => {
    const operator = await account([]);
    const ids = await clips(operator, 3);
    const OWN = new Set(['content_offers', 'character_clip_allocation', 'audit_log']);
    const snapshot = async () => {
      const tables = (await q<{ t: string }>(`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1`)).rows.map((r) => r.t);
      const out: Record<string, string> = {};
      for (const t of tables.filter((name) => !OWN.has(name))) {
        out[t] = (await q<{ h: string }>(`SELECT md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) AS h FROM "${t}" x`)).rows[0]!.h;
      }
      return out;
    };
    const before = await snapshot();
    await applied(await allocate(operator, 1));
    await mark(operator, ids[0]!, 'free');
    await clear(operator);
    expect(await snapshot()).toEqual(before);

    // The admin content shelf still reports every clip exactly as before.
    const shelf = await dark.app.inject({ method: 'GET', url: `/admin/characters/${LUNA.id}/content`, cookies: operator.cookies });
    expect(shelf.statusCode).toBe(200);
    expect((shelf.json() as { assets: Array<{ assetId: string; workflow: string }> }).assets.filter((a) => ids.includes(a.assetId))).toHaveLength(3);
  });
});
