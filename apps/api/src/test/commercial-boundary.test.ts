import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { characters, characterVisualAssets, contentOffers } from '../db/schema.js';
import { SEED_CHARACTERS, SEED_VISUAL_ASSETS } from '../db/seed-data.js';
import { seedCharacters, seedVisualIdentities } from '../db/seed.js';
import {
  CommercialBoundaryError,
  DEFAULT_COMMERCIAL_STATE,
  describeAssetCommercial,
  getAssetCommercial,
  listOffersForCharacter,
  liveOfferFor,
  retireContentOffer,
  setContentOffer,
} from '../services/commercial-boundary.js';
import { resolveEntitlement } from '../services/entitlement-service.js';
import { uploadLibraryAsset } from '../services/library-upload-service.js';
import { approveVisualAsset, getVisualAssetById } from '../services/visual-asset-service.js';
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
 * P0.8 -- THE COMMERCIAL BOUNDARY.
 *
 *   Asset -> OFFER -> [future] Entitlement -> user access
 *
 * This phase implements no wallet, no payment, no subscription and no access
 * control. What it has to prove is that the SEAM is right: commercial state is
 * its own axis, it changes nothing about moderation, distribution or what a
 * customer sees today, it is off by default, and a commercial record survives
 * the deletion of the content it was about -- because a purchase must outlive
 * what was purchased.
 */

const LUNA = SEED_CHARACTERS.find((c) => c.name === 'luna')!;
const STORAGE = { storageDir: testEnv.media.storageDir, servePathPrefix: '/admin/content/uploads' };
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
/** The economy switched ON -- only ever passed explicitly, in these tests. */
const ECONOMY_ON = { enabled: true };
const ECONOMY_OFF = { enabled: false };

let on: TestContext;
let cookie: string;

beforeAll(async () => {
  migrateTestDb();
  on = await createTestContext();
});
afterAll(async () => destroyTestContext(on));
beforeEach(async () => {
  await truncateAll(on);
  await seedCharacters(on.db);
  await seedVisualIdentities(on.db);
  const email = `commerce-${randomUUID()}@example.com`;
  const res = await on.app.inject({ method: 'POST', url: '/api/auth/register', payload: { email, password: 'commerce-12' } });
  const c = extractSessionCookie(res)!;
  await on.pool.query(`UPDATE users SET role = 'admin' WHERE email = $1`, [email]);
  cookie = `${c.name}=${c.value}`;
});

async function approvedClip(over: object = {}) {
  const created = await uploadLibraryAsset(on.db, STORAGE, {
    characterId: LUNA.id,
    mimeType: 'image/png',
    bytes: PNG,
    originalName: 'clip.png',
    ...over,
  });
  return approveVisualAsset(on.db, created.id);
}

const act = (assetId: string, verb: string) =>
  on.app.inject({ method: 'POST', url: `/admin/content/assets/${assetId}/${verb}`, headers: { cookie } });

/* ================================================================== *
 * Off by default
 * ================================================================== */

describe('the economy stays dark', () => {
  it('refuses to write commercial state while ECONOMY_ENABLED is off', async () => {
    const clip = await approvedClip();
    await expect(setContentOffer(on.db, ECONOMY_OFF, { assetId: clip.id, state: 'credit', creditPrice: 50 })).rejects.toBeInstanceOf(
      CommercialBoundaryError,
    );
    await expect(retireContentOffer(on.db, ECONOMY_OFF, randomUUID())).rejects.toBeInstanceOf(
      CommercialBoundaryError,
    );
    expect(await on.db.select().from(contentOffers)).toEqual([]);
  });

  it('answers FREE for content nobody priced -- which is the whole library today', async () => {
    const clip = await approvedClip();
    expect(await getAssetCommercial(on.db, clip.id)).toEqual({
      offerId: null,
      state: DEFAULT_COMMERCIAL_STATE,
      creditPrice: null,
      ageFloor: null,
      implicit: true,
      economyRef: null,
    });
    expect(DEFAULT_COMMERCIAL_STATE).toBe('free');
  });

  it('leaves the viewer-side resolver exactly as P0 left it: everyone free, economy off', async () => {
    const state = await resolveEntitlement(on.db, null, { enabled: false });
    expect(state).toMatchObject({ tier: 'free', subscription: null, economyEnabled: false });
    expect(state.wallet).toEqual({ included: 0, earned: 0, purchased: 0, held: 0, spendable: 0 });
  });

  /**
   * The offers table stays behind the boundary. The reviewed ways in are the
   * P4.2 customer resolver, P4.D2's admin allocation (with its route, for the
   * boundary's own error type) and P8.2's ownership and unlock -- and nothing
   * names the table for itself.
   */
  it('is reached only through the boundary service, by the reviewed callers alone', () => {
    const srcRoot = fileURLToPath(new URL('..', import.meta.url));
    const tableReaders: string[] = [];
    const serviceReaders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) {
          if (name !== 'test') walk(full);
        } else if (name.endsWith('.ts')) {
          const rel = relative(srcRoot, full).split('\\').join('/');
          if (rel === 'db/schema.ts' || rel === 'services/commercial-boundary.ts') continue;
          const code = readFileSync(full, 'utf8');
          if (/contentOffers|content_offers/.test(code)) tableReaders.push(rel);
          if (/['/]commercial-boundary\.js'/.test(code)) serviceReaders.push(rel);
        }
      }
    };
    walk(srcRoot);
    expect(tableReaders).toEqual([]);
    expect(serviceReaders.sort()).toEqual([
      'routes/admin-content-access.ts',
      'services/admin-content-access-service.ts',
      'services/content-access.ts',
      'services/content-ownership.ts',
      'services/content-unlock-service.ts',
    ]);
  });
});

/* ================================================================== *
 * The offer itself
 * ================================================================== */

describe('an offer is the only place commercial state lives', () => {
  it('records the state, the economy reference and a snapshot of what was offered', async () => {
    const clip = await approvedClip();
    const offer = await setContentOffer(on.db, ECONOMY_ON, {
      assetId: clip.id,
      state: 'credit',
      creditPrice: 50,
      economyRef: { packCode: 'starter_pack' },
    });

    expect(offer).toMatchObject({ assetId: clip.id, characterId: LUNA.id, state: 'credit', creditPrice: 50, ageFloor: null, retiredAt: null });
    expect(offer.economyRef).toEqual({ packCode: 'starter_pack' });
    expect(offer.snapshot).toMatchObject({
      characterName: LUNA.name,
      assetKind: 'generated',
      role: 'content',
      mediaType: 'image',
      contentRating: 'sfw',
    });
    // The snapshot describes the content only: the price is the offer's own column (P4.1).
    for (const forbidden of ['price', 'priceMinor', 'credits', 'currency', 'amount']) {
      expect({ forbidden, present: forbidden in (offer.snapshot as object) }).toEqual({ forbidden, present: false });
    }
  });

  it('never writes anything onto the asset itself', async () => {
    const clip = await approvedClip();
    const before = (await getVisualAssetById(on.db, clip.id))!;
    await setContentOffer(on.db, ECONOMY_ON, { assetId: clip.id, state: 'premium' });
    expect(await getVisualAssetById(on.db, clip.id)).toEqual(before);
  });

  it('is content-only: identity references and chat media cannot be sold', async () => {
    const reference = SEED_VISUAL_ASSETS.find((a) => a.characterId === LUNA.id)!;
    await expect(
      setContentOffer(on.db, ECONOMY_ON, { assetId: reference.id, state: 'credit', creditPrice: 50 }),
    ).rejects.toMatchObject({ kind: 'not_content' });

    const chat = await approvedClip({ kind: 'chat' });
    await expect(setContentOffer(on.db, ECONOMY_ON, { assetId: chat.id, state: 'credit', creditPrice: 50 })).rejects.toMatchObject({
      kind: 'not_content',
    });

    await expect(
      setContentOffer(on.db, ECONOMY_ON, { assetId: randomUUID(), state: 'credit', creditPrice: 50 }),
    ).rejects.toMatchObject({ kind: 'asset_not_found' });
    expect(await on.db.select().from(contentOffers)).toEqual([]);
  });

  it('keeps ONE live offer per asset, and updates it in place', async () => {
    const clip = await approvedClip();
    const first = await setContentOffer(on.db, ECONOMY_ON, { assetId: clip.id, state: 'premium' });
    const second = await setContentOffer(on.db, ECONOMY_ON, { assetId: clip.id, state: 'credit', creditPrice: 50 });
    expect(second.id).toBe(first.id);
    expect(second).toMatchObject({ state: 'credit', creditPrice: 50 });
    expect(await on.db.select().from(contentOffers)).toHaveLength(1);

    // The database holds that rule too, not just the service.
    await expect(
      on.pool.query('INSERT INTO content_offers (asset_id, character_id, state) VALUES ($1, $2, $3)', [
        clip.id,
        LUNA.id,
        'premium',
      ]),
    ).rejects.toThrow(/content_offers_live_asset_idx/);
  });

  it('retires an offer instead of deleting it, and frees the slot for a new one', async () => {
    const clip = await approvedClip();
    const original = await setContentOffer(on.db, ECONOMY_ON, { assetId: clip.id, state: 'credit', creditPrice: 50 });
    const retired = await retireContentOffer(on.db, ECONOMY_ON, original.id);
    // Retired, with the terms it had: the history an entitlement needs (P4.1).
    expect(retired).toMatchObject({ id: original.id, state: 'credit', creditPrice: 50 });
    expect(retired!.retiredAt).not.toBeNull();
    expect(await liveOfferFor(on.db, clip.id)).toBeNull();
    expect(await getAssetCommercial(on.db, clip.id)).toMatchObject({ state: 'free', implicit: true });

    const replacement = await setContentOffer(on.db, ECONOMY_ON, { assetId: clip.id, state: 'premium' });
    expect(replacement.id).not.toBe(original.id);
    // Both rows remain: the retired one is the history an entitlement needs.
    expect(await on.db.select().from(contentOffers)).toHaveLength(2);
    expect(await retireContentOffer(on.db, ECONOMY_ON, original.id)).toBeNull();
  });

  it('marks retirement by retired_at, not by a state: there is no retired access state (P4.1)', async () => {
    const clip = await approvedClip();
    const offer = await setContentOffer(on.db, ECONOMY_ON, { assetId: clip.id, state: 'credit', creditPrice: 50 });
    await expect(
      on.pool.query(`UPDATE content_offers SET state = 'retired' WHERE id = $1`, [offer.id]),
    ).rejects.toThrow(/invalid input value for enum commercial_state/);
  });

  it('describes many assets at once, defaulting the ones without offers', async () => {
    const priced = await approvedClip();
    const free = await approvedClip();
    await setContentOffer(on.db, ECONOMY_ON, { assetId: priced.id, state: 'premium' });
    const described = await describeAssetCommercial(on.db, [priced.id, free.id]);
    expect(described.get(priced.id)).toMatchObject({ state: 'premium', implicit: false });
    expect(described.get(free.id)).toMatchObject({ state: 'free', implicit: true });
  });
});

/* ================================================================== *
 * Four axes, still separate
 * ================================================================== */

describe('commercial state is not moderation, publication or distribution', () => {
  it('a premium or credit clip is still approved, still released, still live', async () => {
    const clip = await approvedClip();
    expect((await act(clip.id, 'publish')).statusCode).toBe(200);
    const shelfBefore = await on.app.inject({
      method: 'GET',
      url: `/admin/characters/${LUNA.id}/content`,
      headers: { cookie },
    });
    const distributionBefore = (shelfBefore.json().assets as Array<{ assetId: string; distribution: unknown; workflow: string }>).find(
      (a) => a.assetId === clip.id,
    );

    await setContentOffer(on.db, ECONOMY_ON, { assetId: clip.id, state: 'credit', creditPrice: 50 });

    const shelfAfter = await on.app.inject({
      method: 'GET',
      url: `/admin/characters/${LUNA.id}/content`,
      headers: { cookie },
    });
    const distributionAfter = (shelfAfter.json().assets as Array<{ assetId: string; distribution: unknown; workflow: string }>).find(
      (a) => a.assetId === clip.id,
    );
    expect(distributionAfter).toEqual(distributionBefore);

    // And a customer still reaches it exactly as before: locking is a condition
    // on access, which no phase has implemented, not a way of hiding content.
    expect((await on.app.inject({ method: 'GET', url: `/api/media/assets/${clip.id}/file` })).statusCode).toBe(200);
    expect((await on.app.inject({ method: 'GET', url: `/api/characters/${LUNA.id}/clips` })).payload).toContain(clip.id);
  });

  it('moderation and release decisions never touch an offer', async () => {
    const clip = await approvedClip();
    const offer = await setContentOffer(on.db, ECONOMY_ON, { assetId: clip.id, state: 'credit', creditPrice: 50 });

    for (const verb of ['publish', 'unpublish', 'archive', 'unarchive']) {
      expect((await act(clip.id, verb)).statusCode).toBe(200);
      const current = await liveOfferFor(on.db, clip.id);
      expect({ verb, id: current?.id, state: current?.state }).toEqual({ verb, id: offer.id, state: 'credit' });
    }

    // Even rejection, which takes content out of the workflow entirely.
    expect((await act(clip.id, 'reject')).statusCode).toBe(200);
    expect(await liveOfferFor(on.db, clip.id)).toMatchObject({ id: offer.id, state: 'credit' });
  });
});

/* ================================================================== *
 * A purchase must outlive what was purchased
 * ================================================================== */

describe('commercial records survive the content they were about', () => {
  it('keeps the offer, its state and its snapshot when the asset is deleted', async () => {
    const clip = await approvedClip();
    const offer = await setContentOffer(on.db, ECONOMY_ON, {
      assetId: clip.id,
      state: 'credit',
      creditPrice: 50,
      economyRef: { packCode: 'starter_pack' },
    });

    await on.db.delete(characterVisualAssets).where(eq(characterVisualAssets.id, clip.id));

    const [surviving] = await on.db.select().from(contentOffers).where(eq(contentOffers.id, offer.id));
    expect(surviving).toBeTruthy();
    expect(surviving!.assetId).toBeNull();
    expect(surviving!.characterId).toBe(LUNA.id);
    expect(surviving!).toMatchObject({ state: 'credit', creditPrice: 50 });
    expect(surviving!.economyRef).toEqual({ packCode: 'starter_pack' });
    // The snapshot is what a purchase history reads once the media is gone.
    expect(surviving!.snapshot).toMatchObject({ characterName: LUNA.name, mediaType: 'image' });
  });

  it('keeps it when the whole character is permanently deleted (the P9.4 case)', async () => {
    const clip = await approvedClip();
    const offer = await setContentOffer(on.db, ECONOMY_ON, { assetId: clip.id, state: 'credit', creditPrice: 50 });

    await on.db.delete(characters).where(eq(characters.id, LUNA.id));

    const [surviving] = await on.db.select().from(contentOffers).where(eq(contentOffers.id, offer.id));
    expect(surviving).toBeTruthy();
    expect({ asset: surviving!.assetId, character: surviving!.characterId, state: surviving!.state }).toEqual({
      asset: null,
      character: null,
      state: 'credit',
    });
    expect(surviving!.snapshot).toMatchObject({ characterName: LUNA.name });
  });

  it('never cascades: the offer table has no delete path from content', async () => {
    const { rows } = await on.pool.query<{ column_name: string; delete_rule: string }>(
      `SELECT kcu.column_name, rc.delete_rule
         FROM information_schema.referential_constraints rc
         JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = rc.constraint_name
        WHERE kcu.table_name = 'content_offers'`,
    );
    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (const row of rows) {
      expect({ column: row.column_name, rule: row.delete_rule }).toEqual({
        column: row.column_name,
        rule: 'SET NULL',
      });
    }
  });

  it('still lists a character offers after her content is gone', async () => {
    const clip = await approvedClip();
    await setContentOffer(on.db, ECONOMY_ON, { assetId: clip.id, state: 'premium' });
    await on.db.delete(characterVisualAssets).where(eq(characterVisualAssets.id, clip.id));
    const offers = await listOffersForCharacter(on.db, LUNA.id);
    expect(offers).toHaveLength(1);
    expect(offers[0]!.assetId).toBeNull();
  });
});
