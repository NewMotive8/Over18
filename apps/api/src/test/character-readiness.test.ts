import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { characterVisualAssets, characterVisualIdentities, characters } from '../db/schema.js';
import { SEED_CHARACTERS } from '../db/seed-data.js';
import { seedCharacters, seedVisualIdentities } from '../db/seed.js';
import { createCharacterDraft } from '../services/character-service.js';
import {
  computePublishability,
  computeReadiness,
  type AssessmentInputs,
} from '../services/character-readiness-service.js';
import type { CharacterRequirementStatus } from '../services/requirement-status-service.js';
import { createVisualAsset } from '../services/visual-asset-service.js';
import { getActiveVisualIdentity } from '../services/visual-identity-service.js';
import {
  createTestContext,
  destroyTestContext,
  extractSessionCookie,
  migrateTestDb,
  resetContentRequirements,
  truncateAll,
  type TestContext,
} from './helpers.js';

/**
 * P0.1 -- Character Readiness and Publishability: two authoritative, separate,
 * server-side answers, derived on every read.
 */

let on: TestContext;
let adminCookies: Record<string, string>;
const LUNA = SEED_CHARACTERS.find((c) => c.name === 'luna')!;
const REQUIREMENT = 'test_portraits';

beforeAll(async () => {
  migrateTestDb();
  on = await createTestContext();
});
afterAll(async () => {
  // content_requirements is NOT in truncateAll, so the controlled requirement
  // set below would otherwise outlive this file and change what every later
  // suite sees (it disabled the primary-reference requirement for them).
  await resetContentRequirements(on);
  await destroyTestContext(on);
});

beforeEach(async () => {
  await truncateAll(on);
  await resetContentRequirements(on);
  await seedCharacters(on.db);
  await seedVisualIdentities(on.db);
  // One small, controlled requirement instead of the seeded production set, so
  // each test decides exactly what "complete" means.
  await on.pool.query('UPDATE content_requirements SET enabled = false');
  await on.pool.query(
    `INSERT INTO content_requirements (key, label, media_type, required_quantity, enabled, assign_primary_reference, position)
     VALUES ($1, 'Test portraits', 'image', 2, true, false, 99)`,
    [REQUIREMENT],
  );

  const email = `readiness-admin-${Date.now()}@example.com`;
  const res = await on.app.inject({ method: 'POST', url: '/api/auth/register', payload: { email, password: 'readiness-1' } });
  const cookie = extractSessionCookie(res)!;
  await on.pool.query(`UPDATE users SET role = 'admin' WHERE email = $1`, [email]);
  adminCookies = { [cookie.name]: cookie.value };
});

type Detail = {
  readiness: { ready: boolean; blockers: Array<Record<string, unknown> & { code: string; message: string }>; requirements: Record<string, unknown> };
  publishability: { publishable: boolean; blockers: Array<Record<string, unknown> & { code: string; message: string }> };
};

async function detail(characterId: string): Promise<Detail> {
  const res = await on.app.inject({ method: 'GET', url: `/admin/characters/${characterId}`, cookies: adminCookies });
  expect(res.statusCode).toBe(200);
  return res.json() as Detail;
}
const codes = (list: Array<{ code: string }>) => list.map((b) => b.code);

/** Content toward the test requirement: an image asset of the active identity. */
async function portrait(characterId: string, status: 'approved' | 'under_review' | 'generated' | 'rejected' = 'approved') {
  const identity = (await getActiveVisualIdentity(on.db, characterId))!;
  const asset = await createVisualAsset(on.db, {
    characterId,
    visualIdentityId: identity.id,
    kind: 'generated',
    status,
    contentRating: 'sfw',
  });
  await on.db
    .update(characterVisualAssets)
    .set({ requirementKey: REQUIREMENT, storageKey: `/test/${asset.id}.png` })
    .where(eq(characterVisualAssets.id, asset.id));
  return asset.id;
}

/* ------------------------------------------------------------------ *
 * Fixture sanity -- every scenario below starts from this
 * ------------------------------------------------------------------ */

describe('the seeded baseline', () => {
  it('Luna is active, has a complete profile, an active identity and an approved primary reference', async () => {
    const d = await detail(LUNA.id);
    expect(codes(d.publishability.blockers)).toEqual([]);
    expect(codes(d.readiness.blockers)).toEqual(['requirement_unmet']);
  });
});

/* ------------------------------------------------------------------ *
 * The required scenarios, through the real admin API
 * ------------------------------------------------------------------ */

describe('readiness and publishability on the admin character detail', () => {
  it('a complete, active character is ready and publishable, with no blockers', async () => {
    await portrait(LUNA.id);
    await portrait(LUNA.id);
    const d = await detail(LUNA.id);
    expect(d.readiness).toEqual({
      ready: true,
      blockers: [],
      requirements: { required: 2, approved: 2, pending: 0, missing: 0, complete: true },
    });
    expect(d.publishability).toEqual({ publishable: true, blockers: [] });
  });

  it('missing required content: NOT ready, naming the requirement -- and still publishable', async () => {
    await portrait(LUNA.id);
    const d = await detail(LUNA.id);
    expect(d.readiness.ready).toBe(false);
    expect(d.readiness.blockers).toEqual([
      {
        code: 'requirement_unmet',
        message: 'Test portraits: 1 of 2 approved.',
        requirementKey: REQUIREMENT,
        label: 'Test portraits',
        mediaType: 'image',
        required: 2,
        approved: 1,
        pending: 0,
        remaining: 1,
      },
    ]);
    // Separate concepts: an unfinished requirement never hides a live character.
    expect(d.publishability.publishable).toBe(true);
  });

  it('an inactive character is NOT publishable -- and readiness is unaffected', async () => {
    await portrait(LUNA.id);
    await portrait(LUNA.id);
    await on.db.update(characters).set({ status: 'inactive' }).where(eq(characters.id, LUNA.id));
    const d = await detail(LUNA.id);
    expect(d.publishability.publishable).toBe(false);
    expect(codes(d.publishability.blockers)).toEqual(['character_inactive']);
    expect(d.readiness.ready).toBe(true);
  });

  it('content pending review does not count, and the blocker says it is awaiting review', async () => {
    await portrait(LUNA.id);
    await portrait(LUNA.id, 'under_review');
    await portrait(LUNA.id, 'generated');
    await portrait(LUNA.id, 'rejected');
    const d = await detail(LUNA.id);
    expect(d.readiness.ready).toBe(false);
    expect(d.readiness.blockers[0]).toMatchObject({
      code: 'requirement_unmet',
      approved: 1,
      pending: 2,
      remaining: 1,
      message: 'Test portraits: 1 of 2 approved; 2 items awaiting review.',
    });
  });

  it('a primary reference still in review blocks BOTH -- it is not yet an approved identity image', async () => {
    await portrait(LUNA.id);
    await portrait(LUNA.id);
    await on.pool.query(
      `UPDATE character_visual_assets SET status = 'under_review'
        WHERE character_id = $1 AND kind = 'reference' AND is_canonical = true`,
      [LUNA.id],
    );
    const d = await detail(LUNA.id);
    expect(codes(d.readiness.blockers)).toEqual(['no_approved_primary_reference']);
    expect(codes(d.publishability.blockers)).toEqual(['no_approved_primary_reference']);
  });

  it('no active visual identity blocks BOTH, and is not also reported as a missing primary reference', async () => {
    await portrait(LUNA.id);
    await portrait(LUNA.id);
    await on.db
      .update(characterVisualIdentities)
      .set({ status: 'retired' })
      .where(eq(characterVisualIdentities.characterId, LUNA.id));
    const d = await detail(LUNA.id);
    expect(codes(d.readiness.blockers)).toEqual(['no_active_visual_identity']);
    expect(codes(d.publishability.blockers)).toEqual(['no_active_visual_identity']);
  });

  it('an empty, newly created character is neither ready nor publishable, and says every reason', async () => {
    const created = await createCharacterDraft(on.db, { name: 'brand-new' });
    const d = await detail(created.id);
    expect(d.readiness.ready).toBe(false);
    expect(codes(d.readiness.blockers)).toEqual(['no_active_visual_identity', 'requirement_unmet']);
    expect(d.publishability.publishable).toBe(false);
    expect(codes(d.publishability.blockers)).toEqual([
      'character_inactive',
      'profile_incomplete',
      'no_active_visual_identity',
    ]);
    expect(d.publishability.blockers[1]).toMatchObject({
      fields: ['shortBio', 'personality', 'conversationStyle', 'systemPrompt'],
      message: 'Her profile is incomplete: 4 fields still empty.',
    });
  });

  /**
   * DISTRIBUTION IS SEPARATE. Approved content that is not released to Posts
   * and not placed anywhere makes her ready and publishable -- and neither
   * verdict put it anywhere.
   */
  it('approved content with no distribution placement: ready and publishable, and still placed nowhere', async () => {
    const a = await portrait(LUNA.id);
    const b = await portrait(LUNA.id);
    const d = await detail(LUNA.id);
    expect([d.readiness.ready, d.publishability.publishable]).toEqual([true, true]);

    const { rows } = await on.pool.query<{ published: number; placed: number }>(
      `SELECT count(*) FILTER (WHERE a.published_at IS NOT NULL)::int AS published,
              (SELECT count(*)::int FROM app_category_assets c WHERE c.asset_id = ANY($1::uuid[]))
            + (SELECT count(*)::int FROM home_hero_clips h WHERE h.asset_id = ANY($1::uuid[]))
            + (SELECT count(*)::int FROM asset_keywords k WHERE k.asset_id = ANY($1::uuid[])) AS placed
         FROM character_visual_assets a WHERE a.id = ANY($1::uuid[])`,
      [[a, b]],
    );
    expect(rows[0]).toEqual({ published: 0, placed: 0 });
    const posts = await on.app.inject({ method: 'GET', url: `/api/characters/${LUNA.id}/clips` });
    const postIds = (posts.json().clips as Array<{ id: string }>).map((c) => c.id);
    expect(postIds).not.toContain(a);
    expect(postIds).not.toContain(b);
  });
});

/* ------------------------------------------------------------------ *
 * Derived, never stored
 * ------------------------------------------------------------------ */

describe('both verdicts are derived on every read', () => {
  it('follow a Settings change immediately, with no write to the character or her content', async () => {
    await portrait(LUNA.id);
    await portrait(LUNA.id);
    expect((await detail(LUNA.id)).readiness.ready).toBe(true);

    await on.pool.query('UPDATE content_requirements SET required_quantity = 3 WHERE key = $1', [REQUIREMENT]);
    expect((await detail(LUNA.id)).readiness.ready).toBe(false);

    await on.pool.query('UPDATE content_requirements SET enabled = false WHERE key = $1', [REQUIREMENT]);
    const none = await detail(LUNA.id);
    // Configuration is the source of truth: asking for nothing means nothing is missing.
    expect(none.readiness).toMatchObject({ ready: true, blockers: [], requirements: { required: 0 } });
  });

  it('adds no persisted ready or publishable column anywhere', async () => {
    const { rows } = await on.pool.query(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name ~ '(ready|readiness|publishab)'`,
    );
    expect(rows).toEqual([]);
  });

  it('stays staff-only', async () => {
    const res = await on.app.inject({ method: 'GET', url: `/admin/characters/${LUNA.id}` });
    expect(res.statusCode).toBe(401);
  });
});

/* ------------------------------------------------------------------ *
 * The rules, pure
 * ------------------------------------------------------------------ */

describe('the rules, as pure functions', () => {
  const noRequirements: CharacterRequirementStatus = {
    characterId: 'c',
    entries: [],
    triage: [],
    totals: { required: 0, approved: 0, pending: 0, missing: 0, complete: true },
  };
  const inputs = (over: Partial<AssessmentInputs> = {}): AssessmentInputs => ({
    character: { status: 'active', missingProfileFields: [] },
    activeIdentity: { id: 'i', version: 1 },
    approvedPrimaryReferenceCount: 1,
    requirements: noRequirements,
    ...over,
  });

  it('keeps blockers empty exactly when the verdict is positive', () => {
    for (const over of [
      {},
      { character: { status: 'inactive' as const, missingProfileFields: [] } },
      { activeIdentity: null },
      { approvedPrimaryReferenceCount: 0 },
      { character: { status: 'active' as const, missingProfileFields: ['systemPrompt' as const] } },
    ]) {
      const r = computeReadiness(inputs(over));
      const p = computePublishability(inputs(over));
      expect(r.ready).toBe(r.blockers.length === 0);
      expect(p.publishable).toBe(p.blockers.length === 0);
    }
  });

  it('never lets profile or lifecycle state affect readiness, nor requirements affect publishability', () => {
    const unfinished: CharacterRequirementStatus = {
      ...noRequirements,
      totals: { required: 1, approved: 0, pending: 0, missing: 1, complete: false },
      entries: [
        {
          requirement: {
            id: 'r',
            key: 'k',
            label: 'K',
            mediaType: 'video',
            requiredQuantity: 1,
            contentRating: null,
            enabled: true,
            assignPrimaryReference: false,
            position: 1,
          } as never,
          required: 1,
          approved: 0,
          pending: 0,
          remaining: 1,
          surplus: 0,
          satisfied: false,
          assets: [],
        },
      ],
    };
    const offlineAndBlank = inputs({ character: { status: 'inactive', missingProfileFields: ['shortBio'] } });
    expect(computeReadiness(offlineAndBlank).ready).toBe(true);
    expect(computePublishability(inputs({ requirements: unfinished })).publishable).toBe(true);
  });
});
