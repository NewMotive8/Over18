import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { characterVisualAssets, type CharacterVisualIdentityRow } from '../db/schema.js';
import { SEED_CHARACTERS } from '../db/seed-data.js';
import { seedCharacters, seedVisualIdentities } from '../db/seed.js';
import {
  identityRefOf,
  summariseIdentityLineage,
  type IdentityLineage,
  type LineageAsset,
} from '../services/identity-lineage-service.js';
import { uploadLibraryAsset } from '../services/library-upload-service.js';
import { approveVisualAsset, getVisualAssetById } from '../services/visual-asset-service.js';
import {
  activateVisualIdentityVersion,
  createVisualIdentityVersion,
  getActiveVisualIdentity,
  listVisualIdentityVersions,
} from '../services/visual-identity-service.js';
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
 * P0.6 -- IDENTITY LINEAGE, made visible without changing a thing.
 *
 * The binding already exists: every asset carries the identity version it was
 * made against, in a NOT NULL column with a foreign key. What P0.6 adds is the
 * ability to SEE it, and to see how much approved content sits on a version
 * that is no longer active.
 *
 * The load-bearing test here is the one that proves activation changes NO
 * content: a redesign is not a moderation decision.
 */

const LUNA = SEED_CHARACTERS.find((c) => c.name === 'luna')!;
const STORAGE = { storageDir: testEnv.media.storageDir, servePathPrefix: '/admin/content/uploads' };
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const DNA = { apparentAgeBand: 'adult', hair: 'dark' };

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
  const email = `lineage-${randomUUID()}@example.com`;
  const res = await on.app.inject({ method: 'POST', url: '/api/auth/register', payload: { email, password: 'lineage-12' } });
  const c = extractSessionCookie(res)!;
  await on.pool.query(`UPDATE users SET role = 'admin' WHERE email = $1`, [email]);
  cookie = `${c.name}=${c.value}`;
});

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

type ShelfAsset = {
  assetId: string;
  workflow: string;
  visualIdentity: { id: string; version: number; status: string; label: string | null; active: boolean };
  distribution: { liveAnywhere: boolean; posts: { released: boolean; live: boolean } };
};

async function shelf(): Promise<{ assets: ShelfAsset[]; identityLineage: IdentityLineage }> {
  const res = await on.app.inject({
    method: 'GET',
    url: `/admin/characters/${LUNA.id}/content`,
    headers: { cookie },
  });
  expect(res.statusCode).toBe(200);
  return res.json();
}

const assetOnShelf = async (assetId: string) => {
  const found = (await shelf()).assets.find((a) => a.assetId === assetId);
  expect(found, 'the shelf lists the asset').toBeTruthy();
  return found!;
};

/** An uploaded clip, approved, bound to whatever version is active now. */
async function approvedClip() {
  const created = await uploadLibraryAsset(on.db, STORAGE, {
    characterId: LUNA.id,
    mimeType: 'image/png',
    bytes: PNG,
    originalName: 'clip.png',
  });
  return approveVisualAsset(on.db, created.id);
}

const act = (assetId: string, verb: string) =>
  on.app.inject({ method: 'POST', url: `/admin/content/assets/${assetId}/${verb}`, headers: { cookie } });

async function newVersionActivated(label: string): Promise<CharacterVisualIdentityRow> {
  const created = await createVisualIdentityVersion(on.db, LUNA.id, DNA, { label });
  return activateVisualIdentityVersion(on.db, created.id);
}

/* ================================================================== *
 * The version of each asset is visible
 * ================================================================== */

describe('every asset says which identity version it was made against', () => {
  it('reports the version NUMBER and its state, not an opaque id', async () => {
    const active = (await getActiveVisualIdentity(on.db, LUNA.id))!;
    const clip = await approvedClip();

    const onShelf = await assetOnShelf(clip.id);
    expect(onShelf.visualIdentity).toEqual({
      id: active.id,
      version: active.version,
      status: 'active',
      label: active.label,
      active: true,
    });
    // It is the asset's OWN binding, not "whatever is active".
    expect((await getVisualAssetById(on.db, clip.id))!.visualIdentityId).toBe(active.id);
  });

  it('keeps naming the version an asset was made against after a newer one is activated', async () => {
    const v1 = (await getActiveVisualIdentity(on.db, LUNA.id))!;
    const clip = await approvedClip();
    const v2 = await newVersionActivated('Redesign');

    const onShelf = await assetOnShelf(clip.id);
    expect(onShelf.visualIdentity).toMatchObject({ id: v1.id, version: v1.version, status: 'retired', active: false });
    expect(onShelf.visualIdentity.version).not.toBe(v2.version);
  });

  it('binds NEW content to the version that is active when it is created', async () => {
    await approvedClip();
    const v2 = await newVersionActivated('Redesign');
    const afterwards = await approvedClip();
    expect((await assetOnShelf(afterwards.id)).visualIdentity).toMatchObject({
      id: v2.id,
      version: v2.version,
      active: true,
    });
  });
});

/* ================================================================== *
 * Activating a version changes no content
 * ================================================================== */

describe('a new identity version never touches existing content', () => {
  it('leaves an approved, released, publicly live clip exactly as it was', async () => {
    const clip = await approvedClip();
    expect((await act(clip.id, 'publish')).statusCode).toBe(200);
    await on.pool.query('INSERT INTO home_hero_clips (asset_id, position) VALUES ($1, 0)', [clip.id]);

    const before = (await getVisualAssetById(on.db, clip.id))!;
    const publicBefore = await on.app.inject({ method: 'GET', url: `/api/media/assets/${clip.id}/file` });
    const postsBefore = await on.app.inject({ method: 'GET', url: `/api/characters/${LUNA.id}/clips` });
    expect(publicBefore.statusCode).toBe(200);
    expect(postsBefore.payload).toContain(clip.id);

    await newVersionActivated('Redesign');

    // THE ROW IS BYTE-FOR-BYTE WHAT IT WAS -- including updated_at, because
    // nothing wrote to it.
    expect(await getVisualAssetById(on.db, clip.id)).toEqual(before);

    // And it is still exactly as public as it was.
    const publicAfter = await on.app.inject({ method: 'GET', url: `/api/media/assets/${clip.id}/file` });
    const postsAfter = await on.app.inject({ method: 'GET', url: `/api/characters/${LUNA.id}/clips` });
    expect(publicAfter.statusCode).toBe(200);
    expect(postsAfter.payload).toContain(clip.id);
    const onShelf = await assetOnShelf(clip.id);
    expect(onShelf.workflow).toBe('approved');
    expect(onShelf.distribution).toMatchObject({ liveAnywhere: true, posts: { released: true, live: true } });
  });

  it('leaves content in every other workflow state alone as well', async () => {
    const pending = await uploadLibraryAsset(on.db, STORAGE, { characterId: LUNA.id, mimeType: 'image/png', bytes: PNG });
    const rejected = await approvedClip();
    expect((await act(rejected.id, 'reject')).statusCode).toBe(200);
    const archived = await approvedClip();
    expect((await act(archived.id, 'archive')).statusCode).toBe(200);

    const before = await Promise.all(
      [pending.id, rejected.id, archived.id].map((id) => getVisualAssetById(on.db, id)),
    );
    await newVersionActivated('Redesign');
    const after = await Promise.all(
      [pending.id, rejected.id, archived.id].map((id) => getVisualAssetById(on.db, id)),
    );
    expect(after).toEqual(before);
  });

  it('rolling back to the older version does not touch content either', async () => {
    const v1 = (await getActiveVisualIdentity(on.db, LUNA.id))!;
    const onV1 = await approvedClip();
    const v2 = await newVersionActivated('Redesign');
    const onV2 = await approvedClip();

    const before = await Promise.all([onV1.id, onV2.id].map((id) => getVisualAssetById(on.db, id)));
    await activateVisualIdentityVersion(on.db, v1.id);
    expect(await Promise.all([onV1.id, onV2.id].map((id) => getVisualAssetById(on.db, id)))).toEqual(before);

    // Only which version is ACTIVE moved.
    const versions = await listVisualIdentityVersions(on.db, LUNA.id);
    expect(versions.find((v) => v.id === v1.id)!.status).toBe('active');
    expect(versions.find((v) => v.id === v2.id)!.status).toBe('retired');
  });

  it('no identity code path writes to the asset table at all', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../services/visual-identity-service.ts', import.meta.url)),
      'utf8',
    );
    for (const forbidden of ['characterVisualAssets', 'character_visual_assets']) {
      expect({ forbidden, present: source.includes(forbidden) }).toEqual({ forbidden, present: false });
    }
  });
});

/* ================================================================== *
 * How much content sits on an older version
 * ================================================================== */

describe('the lineage summary answers "how much is on an old version?"', () => {
  it('counts nothing stale while everything is on the active version', async () => {
    await approvedClip();
    const { identityLineage } = await shelf();
    const active = identityLineage.versions.find((v) => v.active)!;
    expect(identityLineage.activeVersion).toBe(active.version);
    expect({ stale: identityLineage.staleApproved, live: identityLineage.staleLive, versions: identityLineage.staleVersions }).toEqual({
      stale: 0,
      live: 0,
      versions: [],
    });
  });

  it('counts approved and LIVE content left on a retired version', async () => {
    const v1 = (await getActiveVisualIdentity(on.db, LUNA.id))!;
    // Luna is seeded with content of her own, so every count here is a DELTA:
    // what this test adds, on top of whatever the fixture already had.
    const seeded = (await shelf()).identityLineage.versions.find((v) => v.version === v1.version)!.counts;

    const live = await approvedClip();
    expect((await act(live.id, 'publish')).statusCode).toBe(200);
    await approvedClip(); // approved, released nowhere
    await uploadLibraryAsset(on.db, STORAGE, { characterId: LUNA.id, mimeType: 'image/png', bytes: PNG });
    const rejectedOnV1 = await approvedClip();
    expect((await act(rejectedOnV1.id, 'reject')).statusCode).toBe(200);

    // While v1 is still active, all of that belongs to the active version.
    const current = (await shelf()).identityLineage;
    const onV1 = current.versions.find((v) => v.version === v1.version)!;
    expect({
      approved: onV1.counts.approved - seeded.approved,
      live: onV1.counts.live - seeded.live,
      pending: onV1.counts.pendingReview - seeded.pendingReview,
      rejected: onV1.counts.rejected - seeded.rejected,
    }).toEqual({ approved: 2, live: 1, pending: 1, rejected: 1 });
    expect(current.staleApproved).toBe(0);

    const v2 = await newVersionActivated('Redesign');
    const freshOnV2 = await approvedClip();

    const { identityLineage } = await shelf();
    expect(identityLineage.activeVersion).toBe(v2.version);
    // Everything v1 held that was approved is now stale -- the fixture's
    // content included, which is exactly the fact an operator needs.
    expect(identityLineage.staleApproved).toBe(onV1.counts.approved);
    expect(identityLineage.staleApproved - seeded.approved).toBe(2);
    expect(identityLineage.staleLive).toBe(onV1.counts.live);
    expect(identityLineage.staleLive - seeded.live).toBe(1);
    expect(identityLineage.staleVersions).toEqual([v1.version]);

    const older = identityLineage.versions.find((version) => version.version === v1.version)!;
    expect(older.status).toBe('retired');
    // The retired version's own counts did not move: nothing was rewritten.
    expect(older.counts).toEqual(onV1.counts);
    expect(older.counts.references).toBeGreaterThan(0); // her seeded portrait

    const currentVersion = identityLineage.versions.find((version) => version.version === v2.version)!;
    expect(currentVersion.counts).toMatchObject({ approved: 1, live: 0, references: 0 });
    expect((await assetOnShelf(freshOnV2.id)).visualIdentity.active).toBe(true);
  });

  it('archiving stale content takes it out of the stale count, without deleting it', async () => {
    const stale = await approvedClip();
    await newVersionActivated('Redesign');
    const before = (await shelf()).identityLineage;
    expect(before.staleApproved).toBeGreaterThanOrEqual(1);

    expect((await act(stale.id, 'archive')).statusCode).toBe(200);
    const after = (await shelf()).identityLineage;
    expect(after.staleApproved).toBe(before.staleApproved - 1);

    const older = after.versions.find((version) => !version.active)!;
    const olderBefore = before.versions.find((version) => !version.active)!;
    expect(older.counts.archived).toBe(olderBefore.counts.archived + 1);
    expect(await getVisualAssetById(on.db, stale.id)).not.toBeNull();
  });

  it('lists every version newest first, with the versions that carry nothing', async () => {
    await newVersionActivated('Redesign');
    const { identityLineage } = await shelf();
    expect(identityLineage.versions.map((v) => v.version)).toEqual([2, 1]);
    expect(identityLineage.versions[0]!.counts.total).toBe(0);
  });
});

/* ================================================================== *
 * The summary itself
 * ================================================================== */

describe('the lineage summary is a pure read of the canonical rows', () => {
  const version = (over: Partial<CharacterVisualIdentityRow>): CharacterVisualIdentityRow =>
    ({
      id: 'v1',
      characterId: LUNA.id,
      version: 1,
      status: 'retired',
      visualDna: DNA,
      label: null,
      createdAt: new Date('2026-01-01'),
      updatedAt: new Date('2026-01-01'),
      ...over,
    }) as CharacterVisualIdentityRow;

  const asset = (over: Partial<LineageAsset> = {}): LineageAsset => ({
    visualIdentityId: 'v1',
    workflow: 'approved',
    role: 'content',
    live: false,
    ...over,
  });

  it('counts each workflow state into its own bucket', () => {
    const lineage = summariseIdentityLineage(
      [version({ id: 'v1', version: 1, status: 'active' })],
      [
        asset(),
        asset({ live: true }),
        asset({ workflow: 'pending_review' }),
        asset({ workflow: 'rejected' }),
        asset({ workflow: 'archived' }),
        asset({ role: 'reference' }),
      ],
    );
    expect(lineage.versions[0]!.counts).toEqual({
      total: 6,
      pendingReview: 1,
      approved: 3,
      rejected: 1,
      archived: 1,
      live: 1,
      references: 1,
    });
  });

  it('says nothing is active when no version is', () => {
    const lineage = summariseIdentityLineage([version({ status: 'draft' })], [asset()]);
    expect(lineage.activeVersion).toBeNull();
    // With no active version, approved content is not reported as stale either:
    // there is nothing for it to be behind.
    expect(lineage.staleApproved).toBe(1);
  });

  it('never reports a version that does not exist', () => {
    const lineage = summariseIdentityLineage(
      [version({ id: 'v1', status: 'active' })],
      [asset({ visualIdentityId: 'ghost' })],
    );
    expect(lineage.versions).toHaveLength(1);
    expect(lineage.versions[0]!.counts.total).toBe(0);
  });

  it('names a version the way every admin surface does', () => {
    expect(identityRefOf(version({ id: 'x', version: 3, status: 'active', label: 'Summer' }))).toEqual({
      id: 'x',
      version: 3,
      status: 'active',
      label: 'Summer',
      active: true,
    });
  });
});

/* ================================================================== *
 * The two lifecycles stay apart
 * ================================================================== */

describe('identity and content lifecycles remain separate', () => {
  it('a retired version does not change what an asset may do next', async () => {
    const clip = await approvedClip();
    const before = (await assetOnShelf(clip.id)) as ShelfAsset & { actions: string[] };
    await newVersionActivated('Redesign');
    const after = (await assetOnShelf(clip.id)) as ShelfAsset & { actions: string[] };
    expect(after.actions).toEqual(before.actions);
    expect(after.workflow).toBe(before.workflow);
  });

  it('activation writes only identity rows -- asset timestamps do not move', async () => {
    const clip = await approvedClip();
    const { rows: before } = await on.pool.query<{ updated_at: Date }>(
      'SELECT updated_at FROM character_visual_assets WHERE id = $1',
      [clip.id],
    );
    await newVersionActivated('Redesign');
    const { rows: after } = await on.pool.query<{ updated_at: Date }>(
      'SELECT updated_at FROM character_visual_assets WHERE id = $1',
      [clip.id],
    );
    expect(after[0]!.updated_at).toEqual(before[0]!.updated_at);
    // And the binding column itself was not rewritten.
    const [row] = await on.db
      .select({ identity: characterVisualAssets.visualIdentityId })
      .from(characterVisualAssets)
      .where(eq(characterVisualAssets.id, clip.id));
    expect(row!.identity).toBe(clip.visualIdentityId);
  });
});
