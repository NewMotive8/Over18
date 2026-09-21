import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { CONTENT_ACCESS_STATES } from '@over18/shared';
import { contentOffers } from '../db/schema.js';
import { SEED_CHARACTERS } from '../db/seed-data.js';
import { seedCharacters, seedVisualIdentities } from '../db/seed.js';
import {
  AGE_FLOOR_MAX,
  AGE_FLOOR_MIN,
  CommercialBoundaryError,
  describeAssetCommercial,
  getAssetCommercial,
  liveOfferFor,
  retireContentOffer,
  setContentOffer,
  type SetContentOfferInput,
} from '../services/commercial-boundary.js';
import { uploadLibraryAsset } from '../services/library-upload-service.js';
import { approveVisualAsset } from '../services/visual-asset-service.js';
import { createTestContext, destroyTestContext, migrateTestDb, testEnv, truncateAll, type TestContext } from './helpers.js';

/**
 * PRD v1.2 P4.1 -- a piece of content's ACCESS TERMS, on its P0.8 offer:
 * the access state (free / premium / credit / unavailable), a whole-Credit
 * price for credit content, and an optional age floor.
 *
 * A foundation only: nothing reads these terms to grant or refuse anyone, no
 * Credit moves, and nothing is written while the economy is off. Content with
 * no offer -- the whole library today -- is FREE with no age floor. Every price
 * and age below is test data.
 */

const LUNA = SEED_CHARACTERS.find((c) => c.name === 'luna')!;
const STORAGE = { storageDir: testEnv.media.storageDir, servePathPrefix: '/admin/content/uploads' };
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const ECONOMY_ON = { enabled: true };
const ECONOMY_OFF = { enabled: false };

let on: TestContext;

beforeAll(async () => {
  migrateTestDb();
  on = await createTestContext();
});
afterAll(async () => destroyTestContext(on));
beforeEach(async () => {
  await truncateAll(on);
  await seedCharacters(on.db);
  await seedVisualIdentities(on.db);
});

async function clip() {
  const created = await uploadLibraryAsset(on.db, STORAGE, { characterId: LUNA.id, mimeType: 'image/png', bytes: PNG, originalName: 'clip.png' });
  return approveVisualAsset(on.db, created.id);
}

const q = <T = Record<string, unknown>>(text: string, params: unknown[] = []) =>
  on.pool.query<T & import('pg').QueryResultRow>(text, params);
const offerCount = async () => (await on.db.select().from(contentOffers)).length;
const terms = async (assetId: string) => {
  const view = await getAssetCommercial(on.db, assetId);
  return { state: view.state, creditPrice: view.creditPrice, ageFloor: view.ageFloor, implicit: view.implicit };
};
const set = (input: SetContentOfferInput) => setContentOffer(on.db, ECONOMY_ON, input);

/* ------------------------------------------------------------------ *
 * The vocabulary, and existing content
 * ------------------------------------------------------------------ */

describe('the access states', () => {
  it('the database holds exactly the four P4.1 states -- the shared vocabulary -- and no other', async () => {
    const { rows } = await q<{ v: string }>(
      `SELECT e.enumlabel AS v FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'commercial_state' ORDER BY e.enumsortorder`,
    );
    expect(rows.map((r) => r.v)).toEqual([...CONTENT_ACCESS_STATES]);
    expect([...CONTENT_ACCESS_STATES]).toEqual(['free', 'premium', 'credit', 'unavailable']);
  });

  /**
   * P4.D2: "for each character, all clips are Premium by default". The default
   * is COMPUTED, so nothing is written or backfilled for existing content --
   * an unclassified clip simply reads Premium, and an operator marking one Free
   * is what writes a row.
   */
  it('unclassified content is PREMIUM by default, with nothing written for it', async () => {
    const a = await clip();
    const b = await clip();
    expect(await offerCount(), 'the default costs no rows').toBe(0);
    const described = await describeAssetCommercial(on.db, [a.id, b.id]);
    for (const id of [a.id, b.id]) {
      expect(described.get(id)).toMatchObject({ state: 'premium', creditPrice: null, ageFloor: null, implicit: true });
    }
  });

  /**
   * ONLY CONTENT IS MERCHANDISE. An identity reference cannot carry an offer,
   * so it must not acquire a default that would lock it: a Premium-by-default
   * portrait would put a padlock on the character's own face.
   */
  it('leaves identity references alone: they are not Premium by default', async () => {
    const reference = (await q<{ id: string }>(
      `SELECT id FROM character_visual_assets WHERE character_id = $1 AND kind = 'reference' LIMIT 1`,
      [LUNA.id],
    )).rows[0];
    expect(reference, 'the seed gives Luna reference assets').toBeTruthy();
    const described = await describeAssetCommercial(on.db, [reference!.id]);
    expect(described.get(reference!.id)).toMatchObject({ state: 'free', implicit: true });
  });

  it('an offer written with no terms is FREE, unpriced and without an age floor, by the column defaults', async () => {
    const c = await clip();
    await q('INSERT INTO content_offers (asset_id, character_id) VALUES ($1, $2)', [c.id, LUNA.id]);
    expect(await terms(c.id)).toEqual({ state: 'free', creditPrice: null, ageFloor: null, implicit: false });
  });
});

/* ------------------------------------------------------------------ *
 * Writing terms
 * ------------------------------------------------------------------ */

describe('writing the terms (economy on)', () => {
  it('free, premium and unavailable carry no price; credit carries a whole-Credit price', async () => {
    for (const state of ['free', 'premium', 'unavailable'] as const) {
      const c = await clip();
      await set({ assetId: c.id, state });
      expect(await terms(c.id), state).toEqual({ state, creditPrice: null, ageFloor: null, implicit: false });
    }
    const credit = await clip();
    await set({ assetId: credit.id, state: 'credit', creditPrice: 50 });
    expect(await terms(credit.id)).toEqual({ state: 'credit', creditPrice: 50, ageFloor: null, implicit: false });
  });

  it('takes an optional age floor on any state', async () => {
    for (const [state, ageFloor, creditPrice] of [
      ['free', AGE_FLOOR_MIN, null],
      ['premium', 21, null],
      ['credit', AGE_FLOOR_MAX, 7],
      ['unavailable', 30, null],
    ] as const) {
      const c = await clip();
      await set({ assetId: c.id, state, creditPrice, ageFloor });
      expect(await terms(c.id), state).toMatchObject({ state, ageFloor, creditPrice });
    }
  });

  it('refuses credit content without a valid whole-Credit price, and a price on any other state -- writing nothing', async () => {
    const c = await clip();
    const refusals: SetContentOfferInput[] = [
      { assetId: c.id, state: 'credit' },
      { assetId: c.id, state: 'credit', creditPrice: null },
      { assetId: c.id, state: 'credit', creditPrice: 0 },
      { assetId: c.id, state: 'credit', creditPrice: -5 },
      { assetId: c.id, state: 'credit', creditPrice: 12.5 },
      { assetId: c.id, state: 'credit', creditPrice: Number.NaN },
      { assetId: c.id, state: 'credit', creditPrice: Number.POSITIVE_INFINITY },
      { assetId: c.id, state: 'credit', creditPrice: 2 ** 31 },
      { assetId: c.id, state: 'credit', creditPrice: '50' as never },
      { assetId: c.id, state: 'premium', creditPrice: 50 },
      { assetId: c.id, state: 'free', creditPrice: 1 },
      { assetId: c.id, state: 'unavailable', creditPrice: 10 },
    ];
    for (const input of refusals) {
      await expect(set(input), JSON.stringify(input)).rejects.toMatchObject({ name: 'CommercialBoundaryError', kind: 'invalid_price' });
    }
    expect(await offerCount()).toBe(0);
  });

  it('refuses an age floor that is not whole years from 18 to 99 -- writing nothing', async () => {
    const c = await clip();
    for (const ageFloor of [17, 0, -1, 100, 18.5, Number.NaN, '21' as never]) {
      await expect(set({ assetId: c.id, state: 'premium', ageFloor }), String(ageFloor)).rejects.toMatchObject({ kind: 'invalid_age_floor' });
    }
    expect(await offerCount()).toBe(0);
  });

  it('refuses any state outside the four -- including the P0.8 names', async () => {
    const c = await clip();
    for (const state of ['locked', 'paid', 'retired', 'FREE', 'Premium', '']) {
      await expect(set({ assetId: c.id, state: state as never }), state).rejects.toMatchObject({ kind: 'invalid_state' });
    }
    expect(await offerCount()).toBe(0);
  });

  it('changing the terms updates the one live offer: leaving credit clears the price', async () => {
    const c = await clip();
    const first = await set({ assetId: c.id, state: 'credit', creditPrice: 50, ageFloor: 21 });
    const second = await set({ assetId: c.id, state: 'premium' });
    expect(second.id).toBe(first.id);
    expect(await terms(c.id)).toEqual({ state: 'premium', creditPrice: null, ageFloor: null, implicit: false });
    await set({ assetId: c.id, state: 'credit', creditPrice: 75 });
    expect(await terms(c.id)).toMatchObject({ state: 'credit', creditPrice: 75 });
    expect(await offerCount()).toBe(1);
  });

  it('retiring keeps the terms it had, as history -- and the content returns to the default', async () => {
    const c = await clip();
    const offer = await set({ assetId: c.id, state: 'credit', creditPrice: 50, ageFloor: 21 });
    const retired = await retireContentOffer(on.db, ECONOMY_ON, offer.id);
    expect(retired).toMatchObject({ id: offer.id, state: 'credit', creditPrice: 50, ageFloor: 21 });
    expect(retired!.retiredAt).not.toBeNull();
    expect(await liveOfferFor(on.db, c.id)).toBeNull();
    // Retiring removes the operator's decision; what is left is P4.D2's default.
    expect(await terms(c.id)).toEqual({ state: 'premium', creditPrice: null, ageFloor: null, implicit: true });
  });
});

/* ------------------------------------------------------------------ *
 * The database holds the same rules
 * ------------------------------------------------------------------ */

describe('the database holds the rules too', () => {
  it('refuses a price without credit, credit without a price, a price below 1, a fraction, and an age floor out of range', async () => {
    const c = await clip();
    const insert = (state: string, price: unknown, age: unknown = null) =>
      q('INSERT INTO content_offers (asset_id, character_id, state, credit_price, age_floor) VALUES ($1, $2, $3, $4, $5)', [c.id, LUNA.id, state, price, age]);
    await expect(insert('credit', null)).rejects.toThrow(/content_offers_credit_price/);
    await expect(insert('premium', 50)).rejects.toThrow(/content_offers_credit_price/);
    await expect(insert('credit', 0)).rejects.toThrow(/content_offers_credit_price_positive/);
    await expect(insert('credit', '12.5')).rejects.toThrow(/invalid input syntax for type integer/);
    await expect(insert('free', null, 17)).rejects.toThrow(/content_offers_age_floor/);
    await expect(insert('free', null, 100)).rejects.toThrow(/content_offers_age_floor/);
    await expect(insert('retired', null)).rejects.toThrow(/invalid input value for enum commercial_state/);
    expect(await offerCount()).toBe(0);

    // A valid row is accepted, and a later update cannot break the rules either.
    await insert('credit', 50, 21);
    await expect(q("UPDATE content_offers SET state = 'free' WHERE asset_id = $1", [c.id])).rejects.toThrow(/content_offers_credit_price/);
    await expect(q('UPDATE content_offers SET credit_price = NULL WHERE asset_id = $1', [c.id])).rejects.toThrow(/content_offers_credit_price/);
  });
});

/* ------------------------------------------------------------------ *
 * Still dark, and nothing else changes
 * ------------------------------------------------------------------ */

describe('a foundation only', () => {
  it('writes nothing while the economy is off', async () => {
    const c = await clip();
    await expect(setContentOffer(on.db, ECONOMY_OFF, { assetId: c.id, state: 'credit', creditPrice: 50, ageFloor: 21 })).rejects.toBeInstanceOf(
      CommercialBoundaryError,
    );
    await expect(setContentOffer(on.db, ECONOMY_OFF, { assetId: c.id, state: 'premium' })).rejects.toMatchObject({ kind: 'economy_disabled' });
    expect(await offerCount()).toBe(0);
  });

  it('setting terms changes no asset, wallet, ledger, subscription, entitlement or any other row -- only the offer', async () => {
    const c = await clip();
    const snapshot = async () => {
      const tables = (await q<{ t: string }>(`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1`)).rows.map((r) => r.t);
      const out: Record<string, string> = {};
      for (const t of tables.filter((name) => name !== 'content_offers')) {
        out[t] = (await q<{ h: string }>(`SELECT md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) AS h FROM "${t}" x`)).rows[0]!.h;
      }
      return out;
    };
    const before = await snapshot();
    const offer = await set({ assetId: c.id, state: 'credit', creditPrice: 50, ageFloor: 21 });
    await set({ assetId: c.id, state: 'unavailable' });
    await retireContentOffer(on.db, ECONOMY_ON, offer.id);
    expect(await snapshot()).toEqual(before);
  });

  it('refuses terms for anything that is not content, or does not exist', async () => {
    await expect(set({ assetId: randomUUID(), state: 'credit', creditPrice: 5 })).rejects.toMatchObject({ kind: 'asset_not_found' });
    expect(await offerCount()).toBe(0);
  });
});
