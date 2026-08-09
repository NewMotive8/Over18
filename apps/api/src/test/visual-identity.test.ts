import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { VisualDna } from '@over18/shared';
import { characterVisualIdentities } from '../db/schema.js';
import { SEED_CHARACTERS } from '../db/seed-data.js';
import { seedCharacters } from '../db/seed.js';
import { eq } from 'drizzle-orm';
import {
  activateVisualIdentityVersion,
  createVisualIdentityVersion,
  getActiveVisualIdentity,
  getVisualIdentityById,
  isAdultAgeBand,
  listVisualIdentityVersions,
  retireVisualIdentityVersion,
  rollbackToVisualIdentityVersion,
  validateVisualDna,
  VisualDnaValidationError,
} from '../services/visual-identity-service.js';
import {
  approveVisualAsset,
  createVisualAsset,
  getVisualAssetById,
  listCanonicalReferences,
  listVisualAssets,
  rejectVisualAsset,
  setVisualAssetPosition,
  VisualAssetScopeError,
  VisualAssetTransitionError,
} from '../services/visual-asset-service.js';
import {
  createTestContext,
  destroyTestContext,
  migrateTestDb,
  truncateAll,
  type TestContext,
} from './helpers.js';

const LUNA = SEED_CHARACTERS.find((c) => c.name === 'luna')!;
const EMBER = SEED_CHARACTERS.find((c) => c.name === 'ember')!;

const validDna: VisualDna = {
  apparentAgeBand: 'adult',
  face: { shape: 'heart', jaw: 'soft', cheeks: 'high', proportions: 'balanced' },
  eyes: 'green, almond-shaped',
  nose: 'straight',
  lips: 'full',
  skin: { tone: 'warm', texture: 'smooth', marks: ['freckle on left cheek'] },
  hair: { color: 'black', length: 'long', texture: 'wavy' },
  body: { build: 'slim', proportions: 'athletic' },
  distinctiveFeatures: ['dimples'],
};

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

// ───────────────────────── Visual DNA validation ─────────────────────────

describe('Visual DNA validation', () => {
  it('persists and round-trips the Visual DNA verbatim', async () => {
    const created = await createVisualIdentityVersion(ctx.db, LUNA.id, validDna);
    const readBack = await getVisualIdentityById(ctx.db, created.id);
    expect(readBack).not.toBeNull();
    expect(readBack!.visualDna).toEqual(validDna);
  });

  it('requires an adult apparentAgeBand', () => {
    // adult / age ≥ 18 / decade bands accepted
    for (const band of ['adult', 'adult (mid-20s)', '25', '30-40', '20s', 'mature']) {
      expect(isAdultAgeBand(band)).toBe(true);
    }
    // minors / sub-18 / ambiguous rejected
    for (const band of ['teen', 'teenager', '16', '17', 'child', 'underage', 'schoolgirl', '']) {
      expect(isAdultAgeBand(band)).toBe(false);
    }
  });

  it('rejects creation when apparentAgeBand is missing or non-adult', async () => {
    await expect(
      createVisualIdentityVersion(ctx.db, LUNA.id, { face: 'x' } as unknown as VisualDna),
    ).rejects.toBeInstanceOf(VisualDnaValidationError);
    await expect(
      createVisualIdentityVersion(ctx.db, LUNA.id, { apparentAgeBand: '16' }),
    ).rejects.toBeInstanceOf(VisualDnaValidationError);
    await expect(
      createVisualIdentityVersion(ctx.db, LUNA.id, { apparentAgeBand: 'teenager' }),
    ).rejects.toBeInstanceOf(VisualDnaValidationError);
  });

  it('rejects presentation attributes inside Visual DNA', () => {
    for (const key of [
      'clothing',
      'pose',
      'makeup',
      'expression',
      'environment',
      'lighting',
      'camera',
      'composition',
      'photographicStyle',
      'accessories',
      'hairstyle',
    ]) {
      expect(() =>
        validateVisualDna({ apparentAgeBand: 'adult', [key]: 'something' }),
      ).toThrow(VisualDnaValidationError);
    }
  });

  it('accepts flexible identity attribute structures (nested objects, arrays, extra keys)', () => {
    expect(() =>
      validateVisualDna({
        apparentAgeBand: 'adult',
        face: { shape: 'oval', bone_structure: { cheekbones: 'high' } },
        distinctiveFeatures: ['scar', 'tattoo: star on wrist'],
        someFutureIdentityAttribute: { anything: [1, 2, 3] },
      }),
    ).not.toThrow();
  });

  it('allows the identity "hair" attribute but not the presentation "hairstyle"', () => {
    expect(() => validateVisualDna({ apparentAgeBand: 'adult', hair: { color: 'red' } })).not.toThrow();
    expect(() => validateVisualDna({ apparentAgeBand: 'adult', hairstyle: 'ponytail' })).toThrow(
      VisualDnaValidationError,
    );
  });
});

// ───────────────────────── Version lifecycle ─────────────────────────────

describe('Visual identity versioning', () => {
  it('creates sequential versions starting as draft', async () => {
    const v1 = await createVisualIdentityVersion(ctx.db, LUNA.id, validDna);
    const v2 = await createVisualIdentityVersion(ctx.db, LUNA.id, validDna, { label: 'redesign' });
    expect(v1.version).toBe(1);
    expect(v1.status).toBe('draft');
    expect(v2.version).toBe(2);
    expect(v2.status).toBe('draft');
    expect(v2.label).toBe('redesign');
  });

  it('preserves previous versions when a new one is created and activated', async () => {
    const v1 = await createVisualIdentityVersion(ctx.db, LUNA.id, validDna);
    await activateVisualIdentityVersion(ctx.db, v1.id);
    const v2 = await createVisualIdentityVersion(ctx.db, LUNA.id, validDna);
    await activateVisualIdentityVersion(ctx.db, v2.id);

    const history = await listVisualIdentityVersions(ctx.db, LUNA.id);
    expect(history.map((h) => h.version)).toEqual([2, 1]); // newest first
    const v1After = await getVisualIdentityById(ctx.db, v1.id);
    expect(v1After!.status).toBe('retired'); // preserved, not overwritten
  });

  it('activation is transactional: activating v2 retires the previously-active v1', async () => {
    const v1 = await createVisualIdentityVersion(ctx.db, LUNA.id, validDna);
    await activateVisualIdentityVersion(ctx.db, v1.id);
    const v2 = await createVisualIdentityVersion(ctx.db, LUNA.id, validDna);
    await activateVisualIdentityVersion(ctx.db, v2.id);

    expect((await getVisualIdentityById(ctx.db, v1.id))!.status).toBe('retired');
    expect((await getVisualIdentityById(ctx.db, v2.id))!.status).toBe('active');
    const active = await getActiveVisualIdentity(ctx.db, LUNA.id);
    expect(active!.id).toBe(v2.id);
  });

  it('enforces exactly one active version at the DATABASE level (partial unique index)', async () => {
    const v1 = await createVisualIdentityVersion(ctx.db, LUNA.id, validDna);
    await activateVisualIdentityVersion(ctx.db, v1.id);
    const v2 = await createVisualIdentityVersion(ctx.db, LUNA.id, validDna);

    // Bypassing the service to force a second active row must be rejected by
    // the partial unique index character_visual_identities_active_uq.
    await expect(
      ctx.pool.query("UPDATE character_visual_identities SET status='active' WHERE id=$1", [v2.id]),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('activation is idempotent when the version is already active', async () => {
    const v1 = await createVisualIdentityVersion(ctx.db, LUNA.id, validDna);
    await activateVisualIdentityVersion(ctx.db, v1.id);
    const again = await activateVisualIdentityVersion(ctx.db, v1.id);
    expect(again.status).toBe('active');
    const actives = await ctx.db
      .select()
      .from(characterVisualIdentities)
      .where(eq(characterVisualIdentities.status, 'active'));
    expect(actives).toHaveLength(1);
  });

  it('supports rollback: reactivating a retired version retires the current one', async () => {
    const v1 = await createVisualIdentityVersion(ctx.db, LUNA.id, validDna);
    await activateVisualIdentityVersion(ctx.db, v1.id);
    const v2 = await createVisualIdentityVersion(ctx.db, LUNA.id, validDna);
    await activateVisualIdentityVersion(ctx.db, v2.id);

    await rollbackToVisualIdentityVersion(ctx.db, v1.id);
    expect((await getActiveVisualIdentity(ctx.db, LUNA.id))!.id).toBe(v1.id);
    expect((await getVisualIdentityById(ctx.db, v2.id))!.status).toBe('retired');
  });

  it('can explicitly retire the active version, leaving none active', async () => {
    const v1 = await createVisualIdentityVersion(ctx.db, LUNA.id, validDna);
    await activateVisualIdentityVersion(ctx.db, v1.id);
    await retireVisualIdentityVersion(ctx.db, v1.id);
    expect(await getActiveVisualIdentity(ctx.db, LUNA.id)).toBeNull();
  });
});

// ───────────────────────── Asset lifecycle ───────────────────────────────

describe('Visual asset lifecycle', () => {
  async function identityFor(characterId: string) {
    return createVisualIdentityVersion(ctx.db, characterId, validDna);
  }

  it('creates a reference asset under_review and a generated asset generated — never canonical', async () => {
    const identity = await identityFor(LUNA.id);
    const ref = await createVisualAsset(ctx.db, {
      characterId: LUNA.id,
      visualIdentityId: identity.id,
      kind: 'reference',
    });
    const gen = await createVisualAsset(ctx.db, {
      characterId: LUNA.id,
      visualIdentityId: identity.id,
      kind: 'generated',
    });
    expect(ref.status).toBe('under_review');
    expect(ref.isCanonical).toBe(false);
    expect(gen.status).toBe('generated');
    expect(gen.isCanonical).toBe(false);
  });

  it('NEVER auto-promotes a generated asset to canonical, even on approval', async () => {
    const identity = await identityFor(LUNA.id);
    const gen = await createVisualAsset(ctx.db, {
      characterId: LUNA.id,
      visualIdentityId: identity.id,
      kind: 'generated',
    });
    const approved = await approveVisualAsset(ctx.db, gen.id, LUNA.id);
    expect(approved.status).toBe('approved');
    expect(approved.isCanonical).toBe(false); // generated is never canonical
  });

  it('promotes a reference to canonical ONLY through the explicit approval transition', async () => {
    const identity = await identityFor(LUNA.id);
    const ref = await createVisualAsset(ctx.db, {
      characterId: LUNA.id,
      visualIdentityId: identity.id,
      kind: 'reference',
    });
    expect(ref.isCanonical).toBe(false); // not canonical on creation
    const approved = await approveVisualAsset(ctx.db, ref.id, LUNA.id);
    expect(approved.status).toBe('approved');
    expect(approved.isCanonical).toBe(true);
    expect(approved.approvedBy).toBe(LUNA.id);
    expect(approved.approvedAt).toBeInstanceOf(Date);
  });

  it('rejects a reference and refuses to approve a rejected asset', async () => {
    const identity = await identityFor(LUNA.id);
    const ref = await createVisualAsset(ctx.db, {
      characterId: LUNA.id,
      visualIdentityId: identity.id,
      kind: 'reference',
    });
    const rejected = await rejectVisualAsset(ctx.db, ref.id);
    expect(rejected.status).toBe('rejected');
    expect(rejected.isCanonical).toBe(false);
    await expect(approveVisualAsset(ctx.db, ref.id)).rejects.toBeInstanceOf(
      VisualAssetTransitionError,
    );
  });

  it('orders the canonical set by position (nulls last), then creation time', async () => {
    const identity = await identityFor(LUNA.id);
    const a = await createVisualAsset(ctx.db, { characterId: LUNA.id, visualIdentityId: identity.id, kind: 'reference' });
    const b = await createVisualAsset(ctx.db, { characterId: LUNA.id, visualIdentityId: identity.id, kind: 'reference' });
    const c = await createVisualAsset(ctx.db, { characterId: LUNA.id, visualIdentityId: identity.id, kind: 'reference' });
    for (const x of [a, b, c]) await approveVisualAsset(ctx.db, x.id);
    await setVisualAssetPosition(ctx.db, a.id, 2);
    await setVisualAssetPosition(ctx.db, b.id, 1);
    // c left with null position → sorts after positioned ones

    const canonical = await listCanonicalReferences(ctx.db, LUNA.id, identity.id);
    expect(canonical.map((r) => r.id)).toEqual([b.id, a.id, c.id]);
  });

  it('persists provenance verbatim', async () => {
    const identity = await identityFor(LUNA.id);
    const provenance = { provider: 'benchmark-x', model: 'model-y', seed: 42, refSetVersion: 1 };
    const gen = await createVisualAsset(ctx.db, {
      characterId: LUNA.id,
      visualIdentityId: identity.id,
      kind: 'generated',
      provenance,
    });
    const readBack = await getVisualAssetById(ctx.db, gen.id);
    expect(readBack!.provenance).toEqual(provenance);
  });

  it('carries the content_rating 18+ plug-point, defaulting to sfw', async () => {
    const identity = await identityFor(LUNA.id);
    const def = await createVisualAsset(ctx.db, { characterId: LUNA.id, visualIdentityId: identity.id, kind: 'generated' });
    expect(def.contentRating).toBe('sfw');
    const explicit = await createVisualAsset(ctx.db, {
      characterId: LUNA.id,
      visualIdentityId: identity.id,
      kind: 'generated',
      contentRating: 'explicit',
    });
    expect(explicit.contentRating).toBe('explicit');
  });

  it('refuses to attach an asset to an identity that belongs to a different character', async () => {
    const lunaIdentity = await identityFor(LUNA.id);
    await expect(
      createVisualAsset(ctx.db, {
        characterId: EMBER.id, // mismatch
        visualIdentityId: lunaIdentity.id,
        kind: 'reference',
      }),
    ).rejects.toBeInstanceOf(VisualAssetScopeError);
  });
});

// ───────────────────────── Isolation ─────────────────────────────────────

describe('Character and identity-version isolation', () => {
  it('never returns one character’s assets under another character', async () => {
    const lunaId = await createVisualIdentityVersion(ctx.db, LUNA.id, validDna);
    const emberId = await createVisualIdentityVersion(ctx.db, EMBER.id, validDna);
    await createVisualAsset(ctx.db, { characterId: LUNA.id, visualIdentityId: lunaId.id, kind: 'reference' });
    await createVisualAsset(ctx.db, { characterId: EMBER.id, visualIdentityId: emberId.id, kind: 'reference' });

    const lunaAssets = await listVisualAssets(ctx.db, LUNA.id, lunaId.id);
    const emberAssets = await listVisualAssets(ctx.db, EMBER.id, emberId.id);
    expect(lunaAssets).toHaveLength(1);
    expect(emberAssets).toHaveLength(1);
    expect(lunaAssets.every((a) => a.characterId === LUNA.id)).toBe(true);
    expect(emberAssets.every((a) => a.characterId === EMBER.id)).toBe(true);
    // Cross-scope query returns nothing.
    expect(await listVisualAssets(ctx.db, EMBER.id, lunaId.id)).toHaveLength(0);
  });

  it('never returns one identity version’s assets under another version', async () => {
    const v1 = await createVisualIdentityVersion(ctx.db, LUNA.id, validDna);
    const v2 = await createVisualIdentityVersion(ctx.db, LUNA.id, validDna);
    const asset = await createVisualAsset(ctx.db, {
      characterId: LUNA.id,
      visualIdentityId: v1.id,
      kind: 'reference',
    });

    expect((await listVisualAssets(ctx.db, LUNA.id, v1.id)).map((a) => a.id)).toEqual([asset.id]);
    expect(await listVisualAssets(ctx.db, LUNA.id, v2.id)).toHaveLength(0);
  });

  it('scopes canonical references to the correct character and version', async () => {
    const lunaId = await createVisualIdentityVersion(ctx.db, LUNA.id, validDna);
    const emberId = await createVisualIdentityVersion(ctx.db, EMBER.id, validDna);
    const lunaRef = await createVisualAsset(ctx.db, { characterId: LUNA.id, visualIdentityId: lunaId.id, kind: 'reference' });
    const emberRef = await createVisualAsset(ctx.db, { characterId: EMBER.id, visualIdentityId: emberId.id, kind: 'reference' });
    await approveVisualAsset(ctx.db, lunaRef.id);
    await approveVisualAsset(ctx.db, emberRef.id);

    const lunaCanon = await listCanonicalReferences(ctx.db, LUNA.id, lunaId.id);
    expect(lunaCanon.map((r) => r.id)).toEqual([lunaRef.id]);
    expect(lunaCanon.every((r) => r.characterId === LUNA.id)).toBe(true);
  });
});
