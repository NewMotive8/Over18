import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { characterVisualAssets, contentRequirements, users } from '../db/schema.js';
import { SEED_CHARACTERS } from '../db/seed-data.js';
import { seedCharacters, seedVisualIdentities } from '../db/seed.js';
import { getActiveVisualIdentity } from '../services/visual-identity-service.js';
import { createVisualAsset } from '../services/visual-asset-service.js';
import {
  computeRequirementStatus,
  planMissingContent,
  type RequirementAsset,
} from '../services/requirement-status-service.js';
import type { ContentRequirement } from '../services/content-requirements-service.js';
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
 * Configurable content requirements.
 *
 * The property under test throughout is that the CONFIGURATION is the single
 * source of truth: counts are derived from it plus the actual assets, changing
 * it changes only what counts as missing, and nothing in the product carries a
 * second copy of the categories or quantities.
 */

const LUNA = SEED_CHARACTERS.find((c) => c.name === 'luna')!;
let ctx: TestContext;

beforeAll(async () => {
  migrateTestDb();
  ctx = await createTestContext();
});
afterAll(async () => destroyTestContext(ctx));
beforeEach(async () => {
  await truncateAll(ctx);
  await resetContentRequirements(ctx);
  await seedCharacters(ctx.db);
  await seedVisualIdentities(ctx.db);
});

async function adminCookies(email = 'ops.requirements@example.com') {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email, password: 'requirements-test-pass1' },
  });
  const c = extractSessionCookie(res)!;
  await ctx.db.update(users).set({ role: 'admin' }).where(eq(users.email, email));
  return { [c.name]: c.value };
}

const settings = (cookies: Record<string, string>) =>
  ctx.app
    .inject({ method: 'GET', url: '/admin/settings/content-requirements', cookies })
    .then((r) => r.json());

const statusOf = (cookies: Record<string, string>, characterId = LUNA.id) =>
  ctx.app
    .inject({ method: 'GET', url: `/admin/characters/${characterId}/requirements`, cookies })
    .then((r) => r.json());

const entryFor = (status: { requirements: Array<{ key: string }> }, key: string) =>
  status.requirements.find((r) => r.key === key) as never as {
    key: string;
    required: number;
    approved: number;
    pending: number;
    remaining: number;
    surplus: number;
    satisfied: boolean;
  };

/** Files an asset under a key, in the given lifecycle state. */
async function seedAsset(options: {
  requirementKey: string | null;
  status: 'under_review' | 'approved' | 'rejected';
  mediaType?: 'image' | 'video';
  characterId?: string;
}) {
  const characterId = options.characterId ?? LUNA.id;
  const identity = (await getActiveVisualIdentity(ctx.db, characterId))!;
  return createVisualAsset(ctx.db, {
    characterId,
    visualIdentityId: identity.id,
    kind: 'generated',
    status: options.status,
    requirementKey: options.requirementKey,
    storageKey: `https://example.invalid/a.${options.mediaType === 'video' ? 'mp4' : 'png'}`,
    provenance: { mediaType: options.mediaType ?? 'image' },
  });
}

/** Assets actually filed under a key — the seeded character owns others. */
async function assetsFiledUnder(key: string) {
  return ctx.db
    .select()
    .from(characterVisualAssets)
    .where(eq(characterVisualAssets.requirementKey, key));
}

/* ------------------------------------------------------------------ *
 * The configuration itself
 * ------------------------------------------------------------------ */

describe('the seeded default configuration', () => {
  it('produces the current default requirements — 1/1/2/2/4 across ten items', async () => {
    const cookies = await adminCookies();
    const { requirements, totals } = await settings(cookies);

    const quantities = Object.fromEntries(
      requirements.map((r: ContentRequirement) => [r.key, r.requiredQuantity]),
    );
    expect(quantities).toEqual({
      primary_natural: 1,
      primary_nude: 1,
      selfie: 2,
      sexy: 2,
      explicit: 4,
    });
    expect(totals).toEqual({ items: 10, images: 2, videos: 8 });

    // Category is its own dimension: the rating policy is advisory metadata on
    // the requirement, not the thing that defines the category.
    const byKey = Object.fromEntries(
      requirements.map((r: ContentRequirement) => [r.key, r] as const),
    );
    expect(byKey.primary_natural.mediaType).toBe('image');
    expect(byKey.explicit.mediaType).toBe('video');
    expect(byKey.selfie.contentRating).toBeNull();
  });

  it('is data, not code — a rename or a quantity change needs no deploy', async () => {
    const cookies = await adminCookies();
    const { requirements } = await settings(cookies);
    const selfie = requirements.find((r: ContentRequirement) => r.key === 'selfie');

    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/admin/settings/content-requirements/${selfie.id}`,
      payload: { label: 'Phone selfies', requiredQuantity: 3 },
      cookies,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().label).toBe('Phone selfies');
    // The key never moves, because assets are already filed under it.
    expect(res.json().key).toBe('selfie');

    const status = await statusOf(cookies);
    expect(entryFor(status, 'selfie').required).toBe(3);
  });

  it('refuses to rename a key, since content is filed under it', async () => {
    const cookies = await adminCookies();
    const { requirements } = await settings(cookies);
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/admin/settings/content-requirements/${requirements[0].id}`,
      payload: { key: 'something_else' },
      cookies,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('immutable_field');
  });

  it('adds a new category, which appears on the board with no code change', async () => {
    const cookies = await adminCookies();
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/admin/settings/content-requirements',
      payload: { label: 'Behind the scenes', mediaType: 'video', requiredQuantity: 3 },
      cookies,
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().key).toBe('behind_the_scenes');

    const status = await statusOf(cookies);
    expect(entryFor(status, 'behind_the_scenes').required).toBe(3);
    expect(status.totals.required).toBe(13);
  });

  it('validates rather than storing nonsense', async () => {
    const cookies = await adminCookies();
    const bad = [
      { label: '   ', mediaType: 'video' },
      { label: 'Audio clips', mediaType: 'audio' },
      { label: 'Too many', mediaType: 'video', requiredQuantity: 5000 },
      { label: 'Fractional', mediaType: 'video', requiredQuantity: 1.5 },
      { label: 'Bad rating', mediaType: 'video', contentRating: 'spicy' },
    ];
    for (const payload of bad) {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/admin/settings/content-requirements',
        payload,
        cookies,
      });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
    // ...and a duplicate key is a 409, not a 500.
    const dup = await ctx.app.inject({
      method: 'POST',
      url: '/admin/settings/content-requirements',
      payload: { key: 'selfie', label: 'Another selfie rule', mediaType: 'video' },
      cookies,
    });
    expect(dup.statusCode).toBe(409);
  });

  it('lets exactly one requirement claim the primary reference', async () => {
    const cookies = await adminCookies();
    const { requirements } = await settings(cookies);
    const nude = requirements.find((r: ContentRequirement) => r.key === 'primary_nude');

    await ctx.app.inject({
      method: 'PATCH',
      url: `/admin/settings/content-requirements/${nude.id}`,
      payload: { assignPrimaryReference: true },
      cookies,
    });

    const claimants = (await settings(cookies)).requirements.filter(
      (r: ContentRequirement) => r.assignPrimaryReference,
    );
    expect(claimants).toHaveLength(1);
    expect(claimants[0].key).toBe('primary_nude');
  });
});

/* ------------------------------------------------------------------ *
 * Changing a requirement never touches content
 * ------------------------------------------------------------------ */

describe('requirement changes and existing content', () => {
  it('raising a quantity creates missing capacity and touches nothing', async () => {
    const cookies = await adminCookies();
    await seedAsset({ requirementKey: 'explicit', status: 'approved', mediaType: 'video' });
    const before = await ctx.db.select().from(characterVisualAssets);

    const { requirements } = await settings(cookies);
    const explicit = requirements.find((r: ContentRequirement) => r.key === 'explicit');
    await ctx.app.inject({
      method: 'PATCH',
      url: `/admin/settings/content-requirements/${explicit.id}`,
      payload: { requiredQuantity: 6 },
      cookies,
    });

    const entry = entryFor(await statusOf(cookies), 'explicit');
    expect(entry.required).toBe(6);
    expect(entry.approved).toBe(1);
    expect(entry.remaining).toBe(5);

    // The asset rows are byte-identical: configuration changed, content did not.
    const after = await ctx.db.select().from(characterVisualAssets);
    expect(after).toEqual(before);
    expect(after.length).toBe(before.length);
  });

  it('lowering a quantity deletes nothing and reports the surplus', async () => {
    const cookies = await adminCookies();
    for (let i = 0; i < 4; i++) {
      await seedAsset({ requirementKey: 'explicit', status: 'approved', mediaType: 'video' });
    }
    const { requirements } = await settings(cookies);
    const explicit = requirements.find((r: ContentRequirement) => r.key === 'explicit');
    await ctx.app.inject({
      method: 'PATCH',
      url: `/admin/settings/content-requirements/${explicit.id}`,
      payload: { requiredQuantity: 2 },
      cookies,
    });

    const entry = entryFor(await statusOf(cookies), 'explicit');
    expect(entry.required).toBe(2);
    expect(entry.approved).toBe(4);
    expect(entry.remaining).toBe(0);
    expect(entry.surplus).toBe(2);
    expect(entry.satisfied).toBe(true);
    expect(await assetsFiledUnder('explicit')).toHaveLength(4);
  });

  it('existing qualifying content counts toward a NEW requirement immediately', async () => {
    // Nothing is re-filed or migrated: matching happens at read time, by key.
    const cookies = await adminCookies();
    await seedAsset({ requirementKey: 'bloopers', status: 'approved', mediaType: 'video' });
    expect(entryFor(await statusOf(cookies), 'bloopers')).toBeUndefined();

    await ctx.app.inject({
      method: 'POST',
      url: '/admin/settings/content-requirements',
      payload: { key: 'bloopers', label: 'Bloopers', mediaType: 'video', requiredQuantity: 2 },
      cookies,
    });

    const entry = entryFor(await statusOf(cookies), 'bloopers');
    expect(entry.approved).toBe(1);
    expect(entry.remaining).toBe(1);
  });

  it('disabling retires a requirement without losing its content, and re-enabling restores it', async () => {
    const cookies = await adminCookies();
    await seedAsset({ requirementKey: 'selfie', status: 'approved', mediaType: 'video' });
    const { requirements } = await settings(cookies);
    const selfie = requirements.find((r: ContentRequirement) => r.key === 'selfie');
    const before = await statusOf(cookies);

    await ctx.app.inject({
      method: 'PATCH',
      url: `/admin/settings/content-requirements/${selfie.id}`,
      payload: { enabled: false },
      cookies,
    });
    const disabled = await statusOf(cookies);
    expect(entryFor(disabled, 'selfie')).toBeUndefined();
    expect(disabled.totals.required).toBe(8);
    // The asset kept its key — it is in triage, not deleted.
    expect(await assetsFiledUnder('selfie')).toHaveLength(1);
    expect(disabled.triageCount).toBe(before.triageCount + 1);

    await ctx.app.inject({
      method: 'PATCH',
      url: `/admin/settings/content-requirements/${selfie.id}`,
      payload: { enabled: true },
      cookies,
    });
    const restored = await statusOf(cookies);
    expect(entryFor(restored, 'selfie').approved).toBe(1);
    expect(restored.triageCount).toBe(before.triageCount);
  });

  it('refuses to DELETE a requirement content is filed under, and points at disabling', async () => {
    const cookies = await adminCookies();
    await seedAsset({ requirementKey: 'sexy', status: 'approved', mediaType: 'video' });
    const { requirements } = await settings(cookies);
    const sexy = requirements.find((r: ContentRequirement) => r.key === 'sexy');

    const res = await ctx.app.inject({
      method: 'DELETE',
      url: `/admin/settings/content-requirements/${sexy.id}`,
      cookies,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('requirement_in_use');
    expect(res.json().assignedAssetCount).toBe(1);
    expect(res.json().message).toContain('Disable it instead');
    expect(await assetsFiledUnder('sexy')).toHaveLength(1);

    // A requirement nothing is filed under can still be cleaned up.
    const spare = (
      await ctx.app.inject({
        method: 'POST',
        url: '/admin/settings/content-requirements',
        payload: { label: 'Created by mistake', mediaType: 'image' },
        cookies,
      })
    ).json();
    const deleted = await ctx.app.inject({
      method: 'DELETE',
      url: `/admin/settings/content-requirements/${spare.id}`,
      cookies,
    });
    expect(deleted.statusCode).toBe(204);
  });
});

/* ------------------------------------------------------------------ *
 * Derivation
 * ------------------------------------------------------------------ */

describe('derived status', () => {
  it('separates approved, pending and remaining', async () => {
    const cookies = await adminCookies();
    await seedAsset({ requirementKey: 'explicit', status: 'approved', mediaType: 'video' });
    await seedAsset({ requirementKey: 'explicit', status: 'under_review', mediaType: 'video' });
    await seedAsset({ requirementKey: 'explicit', status: 'rejected', mediaType: 'video' });

    const entry = entryFor(await statusOf(cookies), 'explicit');
    expect(entry.approved).toBe(1);
    expect(entry.pending).toBe(1);
    // Pending is NOT counted as done, and rejected counts as nothing.
    expect(entry.remaining).toBe(3);
    expect(entry.satisfied).toBe(false);
  });

  it('says WHY an asset counts toward nothing', async () => {
    const cookies = await adminCookies();
    const none = await seedAsset({ requirementKey: null, status: 'under_review' });
    const gone = await seedAsset({ requirementKey: 'not_configured', status: 'under_review' });
    // Right category, wrong medium: an image filed under a video requirement.
    const wrong = await seedAsset({
      requirementKey: 'selfie',
      status: 'under_review',
      mediaType: 'image',
    });

    const workspace = (
      await ctx.app.inject({
        method: 'GET',
        url: `/admin/content/review/workspace?characterId=${LUNA.id}`,
        cookies,
      })
    ).json();
    const reasonOf = (id: string) =>
      workspace.selected.triage.find((t: { assetId: string }) => t.assetId === id)?.reason;
    expect(reasonOf(none.id)).toBe('uncategorised');
    expect(reasonOf(gone.id)).toBe('unknown_requirement');
    expect(reasonOf(wrong.id)).toBe('media_mismatch');
  });

  it('never lets surplus in one category mask a shortfall in another', () => {
    // Pure, no database: twelve selfies must not read as a complete character.
    const requirement = (over: Partial<ContentRequirement>): ContentRequirement => ({
      id: over.key!,
      key: over.key!,
      label: over.key!,
      mediaType: 'video',
      requiredQuantity: 2,
      contentRating: null,
      enabled: true,
      assignPrimaryReference: false,
      position: 0,
      createdAt: '',
      updatedAt: '',
      ...over,
    });
    const asset = (key: string, i: number): RequirementAsset =>
      ({
        id: `${key}-${i}`,
        requirementKey: key,
        status: 'approved',
        mediaType: 'video',
        createdAt: new Date(i * 1000),
      }) as never as RequirementAsset;

    const status = computeRequirementStatus(
      'c1',
      [requirement({ key: 'selfie' }), requirement({ key: 'explicit', requiredQuantity: 4 })],
      Array.from({ length: 12 }, (_, i) => asset('selfie', i)),
    );
    expect(status.totals.required).toBe(6);
    expect(status.totals.approved).toBe(2); // capped at the requirement
    expect(status.totals.missing).toBe(4);
    expect(status.totals.complete).toBe(false);

    expect(planMissingContent(status)).toEqual([
      {
        requirementKey: 'explicit',
        label: 'explicit',
        mediaType: 'video',
        quantity: 4,
        contentRating: null,
        needsSourceImage: true,
      },
    ]);
  });
});

/* ------------------------------------------------------------------ *
 * The plan the future Studio consumes
 * ------------------------------------------------------------------ */

describe('generate missing content', () => {
  it('answers "what is missing?" from the same source the board renders', async () => {
    const cookies = await adminCookies();
    await seedAsset({ requirementKey: 'sexy', status: 'approved', mediaType: 'video' });
    for (let i = 0; i < 2; i++) {
      await seedAsset({ requirementKey: 'selfie', status: 'approved', mediaType: 'video' });
    }

    const { missing } = (
      await ctx.app.inject({
        method: 'GET',
        url: `/admin/characters/${LUNA.id}/requirements/plan`,
        cookies,
      })
    ).json();

    const byKey = Object.fromEntries(
      missing.map((m: { requirementKey: string; quantity: number }) => [m.requirementKey, m.quantity]),
    );
    expect(byKey).toEqual({
      primary_natural: 1,
      primary_nude: 1,
      sexy: 1,
      explicit: 4,
    });
    expect(byKey.selfie).toBeUndefined();

    // Video needs a source still: the planner REPORTS that rather than guessing.
    const explicit = missing.find((m: { requirementKey: string }) => m.requirementKey === 'explicit');
    expect(explicit.needsSourceImage).toBe(true);
    expect(explicit.contentRating).toBe('explicit');
    const image = missing.find((m: { requirementKey: string }) => m.requirementKey === 'primary_natural');
    expect(image.needsSourceImage).toBe(false);
  });

  it('follows the configuration when it changes', async () => {
    const cookies = await adminCookies();
    const { requirements } = await settings(cookies);
    const explicit = requirements.find((r: ContentRequirement) => r.key === 'explicit');
    await ctx.app.inject({
      method: 'PATCH',
      url: `/admin/settings/content-requirements/${explicit.id}`,
      payload: { requiredQuantity: 7 },
      cookies,
    });

    const { missing } = (
      await ctx.app.inject({
        method: 'GET',
        url: `/admin/characters/${LUNA.id}/requirements/plan`,
        cookies,
      })
    ).json();
    expect(
      missing.find((m: { requirementKey: string }) => m.requirementKey === 'explicit').quantity,
    ).toBe(7);
  });
});

/* ------------------------------------------------------------------ *
 * The Review workspace
 * ------------------------------------------------------------------ */

describe('review workspace', () => {
  it('renders the board from the configuration, with the assets filling it', async () => {
    const cookies = await adminCookies();
    await seedAsset({ requirementKey: 'selfie', status: 'approved', mediaType: 'video' });
    await seedAsset({ requirementKey: 'selfie', status: 'under_review', mediaType: 'video' });

    const board = (
      await ctx.app.inject({
        method: 'GET',
        url: `/admin/content/review/workspace?characterId=${LUNA.id}`,
        cookies,
      })
    ).json();

    expect(board.selected.character.id).toBe(LUNA.id);
    expect(board.requirements.map((r: ContentRequirement) => r.key)).toEqual([
      'primary_natural',
      'primary_nude',
      'selfie',
      'sexy',
      'explicit',
    ]);
    const selfie = board.selected.requirements.find((r: { key: string }) => r.key === 'selfie');
    expect(selfie.required).toBe(2);
    expect(selfie.assets).toHaveLength(2);
    // Approved first, so the slots fill in a stable order.
    expect(selfie.assets[0].status).toBe('approved');
    expect(selfie.assets[1].status).toBe('under_review');
    expect(board.characters.find((c: { characterId: string }) => c.characterId === LUNA.id).required).toBe(10);
  });

  it('reflects a configuration change on the very next load', async () => {
    const cookies = await adminCookies();
    const { requirements } = await settings(cookies);
    const nude = requirements.find((r: ContentRequirement) => r.key === 'primary_nude');
    await ctx.app.inject({
      method: 'PATCH',
      url: `/admin/settings/content-requirements/${nude.id}`,
      payload: { requiredQuantity: 4 },
      cookies,
    });

    const board = (
      await ctx.app.inject({
        method: 'GET',
        url: `/admin/content/review/workspace?characterId=${LUNA.id}`,
        cookies,
      })
    ).json();
    expect(
      board.selected.requirements.find((r: { key: string }) => r.key === 'primary_nude').required,
    ).toBe(4);
  });

  it('files an item into a category from review, and refuses an unconfigured one', async () => {
    const cookies = await adminCookies();
    const asset = await seedAsset({ requirementKey: null, status: 'under_review', mediaType: 'video' });

    const filed = await ctx.app.inject({
      method: 'PATCH',
      url: `/admin/content/assets/${asset.id}`,
      payload: { requirementKey: 'selfie' },
      cookies,
    });
    expect(filed.statusCode).toBe(200);
    expect(filed.json().requirementKey).toBe('selfie');
    expect(entryFor(await statusOf(cookies), 'selfie').pending).toBe(1);

    const bogus = await ctx.app.inject({
      method: 'PATCH',
      url: `/admin/content/assets/${asset.id}`,
      payload: { requirementKey: 'invented_category' },
      cookies,
    });
    expect(bogus.statusCode).toBe(400);
    expect(bogus.json().error).toBe('unknown_requirement');

    // ...and it can be un-filed back to triage.
    const cleared = await ctx.app.inject({
      method: 'PATCH',
      url: `/admin/content/assets/${asset.id}`,
      payload: { requirementKey: null },
      cookies,
    });
    expect(cleared.json().requirementKey).toBeNull();
  });

  it('approval is what makes an item count, and it reaches the Library by the same act', async () => {
    const cookies = await adminCookies();
    const asset = await seedAsset({
      requirementKey: 'selfie',
      status: 'under_review',
      mediaType: 'video',
    });
    expect(entryFor(await statusOf(cookies), 'selfie').approved).toBe(0);

    await ctx.app.inject({
      method: 'POST',
      url: `/admin/content/assets/${asset.id}/approve`,
      cookies,
    });

    expect(entryFor(await statusOf(cookies), 'selfie').approved).toBe(1);
    const library = (
      await ctx.app.inject({ method: 'GET', url: '/admin/content/library', cookies })
    ).json();
    expect(library.assets.map((a: { assetId: string }) => a.assetId)).toContain(asset.id);
  });

  it('handles a character with no requirements configured at all', async () => {
    const cookies = await adminCookies();
    await ctx.pool.query('TRUNCATE TABLE content_requirements CASCADE');
    const board = (
      await ctx.app.inject({
        method: 'GET',
        url: `/admin/content/review/workspace?characterId=${LUNA.id}`,
        cookies,
      })
    ).json();
    expect(board.requirements).toEqual([]);
    expect(board.selected.requirements).toEqual([]);
    expect(board.selected.totals.complete).toBe(true);
  });
});


/* ------------------------------------------------------------------ *
 * Guards found by review — each of these silently destroyed something
 * ------------------------------------------------------------------ */

describe('configuration edits cannot destroy configuration', () => {
  it('a PATCH against an unknown id changes NOTHING', async () => {
    // It used to clear the primary-reference claim and commit that, before
    // answering 404 — losing configuration while rejecting the request.
    const cookies = await adminCookies();
    const before = (await settings(cookies)).requirements.filter(
      (r: ContentRequirement) => r.assignPrimaryReference,
    );
    expect(before).toHaveLength(1);

    const res = await ctx.app.inject({
      method: 'PATCH',
      url: '/admin/settings/content-requirements/00000000-0000-4000-8000-000000000999',
      payload: { assignPrimaryReference: true },
      cookies,
    });
    expect(res.statusCode).toBe(404);

    const after = (await settings(cookies)).requirements.filter(
      (r: ContentRequirement) => r.assignPrimaryReference,
    );
    expect(after.map((r: ContentRequirement) => r.key)).toEqual(
      before.map((r: ContentRequirement) => r.key),
    );
  });

  it('refuses to change the media type of a requirement content is filed under', async () => {
    // The media type decides what qualifies, so changing it would orphan every
    // item already filed there — the same failure the immutable key prevents.
    const cookies = await adminCookies();
    await seedAsset({ requirementKey: 'selfie', status: 'approved', mediaType: 'video' });
    const { requirements } = await settings(cookies);
    const selfie = requirements.find((r: ContentRequirement) => r.key === 'selfie');

    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/admin/settings/content-requirements/${selfie.id}`,
      payload: { mediaType: 'image' },
      cookies,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('requirement_in_use');
    expect(entryFor(await statusOf(cookies), 'selfie').approved).toBe(1);

    // A requirement nothing is filed under can still be corrected.
    const spare = (
      await ctx.app.inject({
        method: 'POST',
        url: '/admin/settings/content-requirements',
        payload: { label: 'Wrong medium', mediaType: 'image' },
        cookies,
      })
    ).json();
    const fixed = await ctx.app.inject({
      method: 'PATCH',
      url: `/admin/settings/content-requirements/${spare.id}`,
      payload: { mediaType: 'video' },
      cookies,
    });
    expect(fixed.statusCode).toBe(200);
    expect(fixed.json().mediaType).toBe('video');
  });
});

describe('content cannot be filed where it could never count', () => {
  it('refuses a category of the wrong medium, on every filing path', async () => {
    const cookies = await adminCookies();
    const video = await seedAsset({
      requirementKey: null,
      status: 'under_review',
      mediaType: 'video',
    });

    // Review's category picker.
    const patched = await ctx.app.inject({
      method: 'PATCH',
      url: `/admin/content/assets/${video.id}`,
      payload: { requirementKey: 'primary_nude' }, // an IMAGE requirement
      cookies,
    });
    expect(patched.statusCode).toBe(400);
    expect(patched.json().error).toBe('media_mismatch');
    expect(patched.json().message).toContain('cannot count toward it');

    // ...and the asset is untouched, still awaiting a real category.
    const [row] = await ctx.db
      .select()
      .from(characterVisualAssets)
      .where(eq(characterVisualAssets.id, video.id));
    expect(row!.requirementKey).toBeNull();

    // The matching category is still accepted.
    const ok = await ctx.app.inject({
      method: 'PATCH',
      url: `/admin/content/assets/${video.id}`,
      payload: { requirementKey: 'selfie' },
      cookies,
    });
    expect(ok.statusCode).toBe(200);
  });
});

/* ------------------------------------------------------------------ *
 * Authorization
 * ------------------------------------------------------------------ */

describe('authorization', () => {
  const routes: Array<[string, string]> = [
    ['GET', '/admin/settings/content-requirements'],
    ['GET', '/admin/settings/content-requirements/impact'],
    ['POST', '/admin/settings/content-requirements'],
    ['PATCH', '/admin/settings/content-requirements/00000000-0000-4000-8000-000000000001'],
    ['DELETE', '/admin/settings/content-requirements/00000000-0000-4000-8000-000000000001'],
    ['GET', '/admin/content/review/workspace'],
    ['GET', `/admin/characters/${LUNA.id}/requirements`],
    ['GET', `/admin/characters/${LUNA.id}/requirements/plan`],
  ];

  it('refuses anonymous callers everywhere', async () => {
    for (const [method, url] of routes) {
      const res = await ctx.app.inject({ method: method as 'GET', url });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it('refuses a signed-in non-admin everywhere', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'regular.requirements@example.com', password: 'requirements-test-pass1' },
    });
    const c = extractSessionCookie(res)!;
    const cookies = { [c.name]: c.value };
    for (const [method, url] of routes) {
      const forbidden = await ctx.app.inject({ method: method as 'GET', url, cookies });
      expect(forbidden.statusCode, `${method} ${url}`).toBe(403);
    }
    // The configuration is untouched by the attempt.
    expect(await ctx.db.select().from(contentRequirements)).toHaveLength(5);
  });
});
