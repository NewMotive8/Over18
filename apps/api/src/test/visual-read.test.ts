import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SEED_CHARACTERS } from '../db/seed-data.js';
import { seedCharacters, seedVisualIdentities } from '../db/seed.js';
import { createVisualIdentityVersion } from '../services/visual-identity-service.js';
import { createVisualAsset } from '../services/visual-asset-service.js';
import {
  createTestContext,
  destroyTestContext,
  migrateTestDb,
  truncateAll,
  type TestContext,
} from './helpers.js';

/**
 * US-16B — public Visual Identity read surface. Verifies the projection is
 * correct, isolated per character, empty-state clean, and — critically —
 * leaks NO internal fields (provenance, content_rating, status, kind,
 * is_canonical, storage internals, raw DNA) and never surfaces draft, rejected,
 * generated, or non-canonical assets.
 */

const LUNA = SEED_CHARACTERS.find((c) => c.name === 'luna')!;
const EMBER = SEED_CHARACTERS.find((c) => c.name === 'ember')!;
const SAGE = SEED_CHARACTERS.find((c) => c.name === 'sage')!;
const MARIA = SEED_CHARACTERS.find((c) => c.name === 'maria')!;

let ctx: TestContext;

beforeAll(async () => {
  migrateTestDb();
  ctx = await createTestContext();
});

afterAll(async () => {
  await destroyTestContext(ctx);
});

beforeEach(async () => {
  await truncateAll(ctx);
  await seedCharacters(ctx.db);
});

function getVisual(characterId: string) {
  return ctx.app.inject({
    method: 'GET',
    url: `/api/characters/${characterId}/visual-identity`,
  });
}

describe('GET /api/characters/:id/visual-identity (seeded)', () => {
  beforeEach(async () => {
    await seedVisualIdentities(ctx.db);
  });

  it('returns Luna’s active identity and her canonical gallery (public, no auth)', async () => {
    const res = await getVisual(LUNA.id);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.identity).not.toBeNull();
    expect(body.identity.characterId).toBe(LUNA.id);
    expect(body.identity.version).toBe(1);
    // Curated, display-ready attributes derived from Visual DNA.
    const ageAttr = body.identity.attributes.find((a: { label: string }) => a.label === 'Apparent age');
    expect(ageAttr.value.toLowerCase()).toContain('adult');
    expect(body.identity.attributes.some((a: { label: string }) => a.label === 'Hair')).toBe(true);
    // Canonical gallery present and ordered by position.
    expect(body.canonicalAssets).toHaveLength(3);
    expect(body.canonicalAssets.map((a: { position: number }) => a.position)).toEqual([1, 2, 3]);
    // US-102.4: imageUrl is an OPAQUE, id-keyed route. It used to be the raw
    // storage_key — an absolute server path handed to every anonymous browser.
    for (const asset of body.canonicalAssets as Array<{ id: string; imageUrl: string }>) {
      expect(asset.imageUrl).toBe(`/api/media/assets/${asset.id}/file`);
    }
  });

  it('NEVER leaks internal fields on the wire', async () => {
    const res = await getVisual(LUNA.id);
    const raw = res.body; // raw JSON string
    for (const forbidden of [
      'provenance',
      'seed-placeholder',
      'content_rating',
      'contentRating',
      'is_canonical',
      'isCanonical',
      'storage_key',
      'storageKey',
      'approved_by',
      'approvedBy',
      'system_prompt',
      'visual_dna',
      'visualDna',
      '"status"',
      '"kind"',
    ]) {
      expect(raw).not.toContain(forbidden);
    }
    // The projection exposes only these asset keys.
    const asset = res.json().canonicalAssets[0];
    expect(Object.keys(asset).sort()).toEqual(['id', 'imageUrl', 'position']);
  });

  // US-88: Sage is retired, so the public surface no longer reaches her
  // identity — the active roster is Luna, Ember and Maria.
  it('isolates identities per character (Luna ≠ Ember ≠ Maria)', async () => {
    const luna = (await getVisual(LUNA.id)).json();
    const ember = (await getVisual(EMBER.id)).json();
    const maria = (await getVisual(MARIA.id)).json();
    expect(luna.identity.characterId).toBe(LUNA.id);
    expect(ember.identity.characterId).toBe(EMBER.id);
    expect(maria.identity.characterId).toBe(MARIA.id);
    // Each gallery belongs to its own character. Identity is checked by ASSET
    // ID now rather than by reading a character name out of a storage path —
    // the path is no longer on the wire (US-102.4), which is the point.
    const lunaIds = luna.canonicalAssets.map((a: { id: string }) => a.id);
    const emberIds = ember.canonicalAssets.map((a: { id: string }) => a.id);
    expect(lunaIds.length).toBeGreaterThan(0);
    expect(emberIds.length).toBeGreaterThan(0);
    for (const id of lunaIds) expect(emberIds).not.toContain(id);
    // And the locator carries the asset's own id, nothing else.
    expect(luna.canonicalAssets[0].imageUrl).toBe(`/api/media/assets/${lunaIds[0]}/file`);
  });

  /**
   * ── US-88 — Maria's visual identity ───────────────────────────────────
   */
  it('AC2/AC4 — Maria exposes her approved Visual DNA and her one real canonical portrait', async () => {
    const res = await getVisual(MARIA.id);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.identity).not.toBeNull();
    expect(body.identity.characterId).toBe(MARIA.id);
    expect(body.identity.version).toBe(1);

    const attr = (label: string) =>
      body.identity.attributes.find((a: { label: string }) => a.label === label);

    // Adult age band via the existing mechanism, with no invented number.
    expect(attr('Apparent age').value).toBe('adult');
    expect(attr('Apparent age').value).not.toMatch(/\d/);
    // Approved identity attributes are present and are Maria's own.
    expect(attr('Eyes').value).toContain('brown');
    expect(attr('Eyes').value).toContain('almond');
    expect(attr('Hair').value).toContain('dark brown');
    expect(attr('Hair').value).toContain('waves');
    expect(attr('Skin').value).toContain('warm-neutral');
    expect(attr('Lips').value).toContain('full');
    expect(attr('Face').value).toContain('oval');
    // No body attributes were supplied, so none were invented.
    expect(attr('Body')).toBeUndefined();

    // Exactly ONE canonical reference — the real supplied portrait. No
    // fabricated Selfie/Mirror shots padding the usual three slots.
    expect(body.canonicalAssets).toHaveLength(1);
    expect(body.canonicalAssets[0].position).toBe(1);
    // The stored path is '/media/maria/portrait.png'. It must NOT be the URL:
    // US-102.4 replaced the raw storage key with an opaque id-keyed route.
    expect(body.canonicalAssets[0].imageUrl).toBe(
      `/api/media/assets/${body.canonicalAssets[0].id}/file`,
    );
    expect(res.body).not.toContain('/media/maria/portrait.png');
  });

  it('AC6 — Sage\'s visual identity and canonical assets survive her retirement', async () => {
    // The public route correctly refuses a retired character...
    expect((await getVisual(SAGE.id)).statusCode).toBe(404);
    // ...but the underlying records are all still there, untouched.
    const identities = await ctx.pool.query(
      `SELECT id, status, visual_dna FROM character_visual_identities WHERE character_id = $1`,
      [SAGE.id],
    );
    expect(identities.rowCount).toBe(1);
    expect(identities.rows[0].visual_dna).toBeTruthy();
    const assets = await ctx.pool.query(
      `SELECT id, is_canonical, storage_key, provenance FROM character_visual_assets WHERE character_id = $1`,
      [SAGE.id],
    );
    expect(assets.rowCount).toBe(3);
    expect(assets.rows.every((r) => r.is_canonical === true)).toBe(true);
    expect(assets.rows.every((r) => String(r.storage_key).length > 0)).toBe(true);
    expect(assets.rows.every((r) => r.provenance && Object.keys(r.provenance).length > 0)).toBe(true);
  });
});

describe('GET /api/characters/:id/visual-identity (edge cases)', () => {
  it('returns a clean empty state for a character with no visual identity', async () => {
    // Characters seeded, but visual identities NOT seeded.
    const res = await getVisual(LUNA.id);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ identity: null, canonicalAssets: [] });
  });

  it('404s for unknown and malformed character ids', async () => {
    expect((await getVisual('00000000-0000-4000-8000-999999999999')).statusCode).toBe(404);
    expect((await getVisual('not-a-uuid')).statusCode).toBe(404);
  });

  it('excludes non-canonical, draft, rejected and generated assets from the projection', async () => {
    // Build an identity by hand and attach assets in every non-canonical state.
    const identity = await createVisualIdentityVersion(ctx.db, LUNA.id, {
      apparentAgeBand: 'adult',
      hair: { color: 'black' },
    });
    // Activate it so it is the public active identity.
    const { activateVisualIdentityVersion } = await import(
      '../services/visual-identity-service.js'
    );
    await activateVisualIdentityVersion(ctx.db, identity.id);

    // under_review reference (not yet approved) → excluded
    await createVisualAsset(ctx.db, { characterId: LUNA.id, visualIdentityId: identity.id, kind: 'reference' });
    // generated asset, even if later approved → never canonical → excluded
    const gen = await createVisualAsset(ctx.db, { characterId: LUNA.id, visualIdentityId: identity.id, kind: 'generated' });
    const { approveVisualAsset, rejectVisualAsset } = await import(
      '../services/visual-asset-service.js'
    );
    await approveVisualAsset(ctx.db, gen.id);
    // rejected reference → excluded
    const rej = await createVisualAsset(ctx.db, { characterId: LUNA.id, visualIdentityId: identity.id, kind: 'reference' });
    await rejectVisualAsset(ctx.db, rej.id);

    const body = (await getVisual(LUNA.id)).json();
    expect(body.identity).not.toBeNull();
    expect(body.canonicalAssets).toHaveLength(0); // nothing canonical yet

    // Now approve a reference → it becomes the only canonical asset shown.
    const ref = await createVisualAsset(ctx.db, {
      characterId: LUNA.id,
      visualIdentityId: identity.id,
      kind: 'reference',
      storageKey: 'https://placehold.co/640x800?text=approved',
    });
    await approveVisualAsset(ctx.db, ref.id);
    const after = (await getVisual(LUNA.id)).json();
    expect(after.canonicalAssets).toHaveLength(1);
    expect(after.canonicalAssets[0].id).toBe(ref.id);
  });

  it('only reflects the ACTIVE identity version', async () => {
    const v1 = await createVisualIdentityVersion(ctx.db, LUNA.id, { apparentAgeBand: 'adult', label: 'one' } as never);
    const { activateVisualIdentityVersion } = await import('../services/visual-identity-service.js');
    await activateVisualIdentityVersion(ctx.db, v1.id);
    const v2 = await createVisualIdentityVersion(ctx.db, LUNA.id, { apparentAgeBand: 'adult' });
    await activateVisualIdentityVersion(ctx.db, v2.id); // v1 retired

    const body = (await getVisual(LUNA.id)).json();
    expect(body.identity.version).toBe(v2.version);
  });
});
