import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { generationJobs, users } from '../db/schema.js';
import { SEED_CHARACTERS } from '../db/seed-data.js';
import { seedCharacters, seedVisualIdentities } from '../db/seed.js';
import { createMockProviders } from '../media-pipeline/mock-adapter.js';
import {
  createTestContext,
  destroyTestContext,
  extractSessionCookie,
  migrateTestDb,
  resetContentRequirements,
  testEnv,
  truncateAll,
  type TestContext,
} from './helpers.js';

/**
 * Generation readiness.
 *
 * The requirement travels the EXISTING generation path — configuration → job →
 * effective config → asset — so generated content arrives in Review already
 * filed under its category. No parallel pipeline, and the Generation Studio
 * itself is not built here: this proves the data model is ready for it.
 */

const LUNA = SEED_CHARACTERS.find((c) => c.name === 'luna')!;
const FIXTURES = join(testEnv.media.storageDir, '__requirement__');

let ctx: TestContext;

beforeAll(async () => {
  migrateTestDb();
  mkdirSync(FIXTURES, { recursive: true });
  writeFileSync(join(FIXTURES, 'seed.jpg'), Buffer.from('fake-jpeg-bytes'));
  writeFileSync(join(FIXTURES, 'seed.mp4'), Buffer.from('fake-mp4-bytes'));
  ctx = await createTestContext({
    mediaProviders: createMockProviders({
      imageFixturePath: join(FIXTURES, 'seed.jpg'),
      videoFixturePath: join(FIXTURES, 'seed.mp4'),
    }),
  });
});
afterAll(async () => {
  await destroyTestContext(ctx);
  rmSync(FIXTURES, { recursive: true, force: true });
});
beforeEach(async () => {
  await truncateAll(ctx);
  await resetContentRequirements(ctx);
  await seedCharacters(ctx.db);
  await seedVisualIdentities(ctx.db);
});

async function adminCookie(email = 'ops.generation@example.com'): Promise<string> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email, password: 'generation-test-pass1' },
  });
  const c = extractSessionCookie(res)!;
  await ctx.db.update(users).set({ role: 'admin' }).where(eq(users.email, email));
  return `${c.name}=${c.value}`;
}


/**
 * Submits a job and waits for it to finish.
 *
 * The generation contract is asynchronous by design — POST returns 202 and the
 * work happens in the background — so a test that asserts on the produced asset
 * has to wait for the job the same way the Studio's progress view would.
 */
async function generate(
  cookie: string,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const submitted = await ctx.app.inject({
    method: 'POST',
    url: '/admin/generation/jobs',
    headers: { cookie },
    payload,
  });
  expect(submitted.statusCode).toBe(202);
  const jobId = submitted.json().jobId;

  for (let attempt = 0; attempt < 50; attempt++) {
    const view = (
      await ctx.app.inject({
        method: 'GET',
        url: `/admin/generation/jobs/${jobId}`,
        headers: { cookie },
      })
    ).json();
    if (['completed', 'partial', 'failed', 'cancelled'].includes(view.status)) return view;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('generation job did not settle');
}

describe('a generation job carries its target requirement', () => {
  it('lands the produced asset in the right slot, with its job provenance', async () => {
    const cookie = await adminCookie();

    const job = await generate(cookie, {
      type: 'image',
      characterId: LUNA.id,
      prompt: 'studio portrait',
      modelId: 'mock:image',
      quantity: 1,
      requirementKey: 'primary_nude',
    });
    expect(job.status).toBe('completed');

    const board = (
      await ctx.app.inject({
        method: 'GET',
        url: `/admin/content/review/workspace?characterId=${LUNA.id}`,
        headers: { cookie },
      })
    ).json();
    const entry = board.selected.requirements.find((r: { key: string }) => r.key === 'primary_nude');

    // It went straight into the category's slot — not into triage.
    expect(entry.assets).toHaveLength(1);
    expect(entry.pending).toBe(1);
    // ...awaiting review, exactly like a manual upload.
    expect(entry.assets[0].status).toBe('under_review');
    expect(entry.assets[0].requirementKey).toBe('primary_nude');
    // ...and it still carries the generation job that produced it.
    expect(entry.assets[0].provenance.jobId).toBeTruthy();
    expect(board.selected.triage).toHaveLength(
      board.selected.triage.filter((t: { assetId: string }) => t.assetId !== entry.assets[0].assetId)
        .length,
    );
  });

  it('persists the requirement on the job, so a retry produces the same category', async () => {
    const cookie = await adminCookie();
    await generate(cookie, {
      type: 'image',
      characterId: LUNA.id,
      prompt: 'studio portrait',
      modelId: 'mock:image',
      requirementKey: 'primary_natural',
    });

    const [row] = await ctx.db
      .select()
      .from(generationJobs)
      .where(eq(generationJobs.characterId, LUNA.id));
    expect((row!.effectiveConfig as { requirementKey?: string }).requirementKey).toBe(
      'primary_natural',
    );
  });

  it('is optional — a job without one produces an uncategorised asset, as before', async () => {
    const cookie = await adminCookie();
    await generate(cookie, {
      type: 'image',
      characterId: LUNA.id,
      prompt: 'studio portrait',
      modelId: 'mock:image',
    });

    const board = (
      await ctx.app.inject({
        method: 'GET',
        url: `/admin/content/review/workspace?characterId=${LUNA.id}`,
        headers: { cookie },
      })
    ).json();
    const generated = board.selected.triage.filter(
      (t: { provenance: { jobId: string | null } }) => t.provenance.jobId,
    );
    expect(generated).toHaveLength(1);
    expect(generated[0].reason).toBe('uncategorised');
    expect(generated[0].requirementKey).toBeNull();
  });


  it('refuses an unconfigured category and a wrong-medium one, before spending anything', async () => {
    // Accepting either would strand the asset: it would carry a key nothing
    // answers to, or sit in a category it can never satisfy — and a paid
    // provider call would already have happened.
    const cookie = await adminCookie();

    const unknown = await ctx.app.inject({
      method: 'POST',
      url: '/admin/generation/jobs',
      headers: { cookie },
      payload: {
        type: 'image',
        characterId: LUNA.id,
        prompt: 'studio portrait',
        modelId: 'mock:image',
        requirementKey: 'totally_made_up',
      },
    });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().error).toBe('unknown_requirement');

    const wrongMedium = await ctx.app.inject({
      method: 'POST',
      url: '/admin/generation/jobs',
      headers: { cookie },
      payload: {
        type: 'image',
        characterId: LUNA.id,
        prompt: 'studio portrait',
        modelId: 'mock:image',
        requirementKey: 'selfie', // a VIDEO requirement
      },
    });
    expect(wrongMedium.statusCode).toBe(400);
    expect(wrongMedium.json().error).toBe('media_mismatch');

    // No job was created, so nothing was queued or spent.
    expect(await ctx.db.select().from(generationJobs)).toHaveLength(0);
  });

  it('the plan and the board agree on what is still missing', async () => {
    const cookie = await adminCookie();
    const missingBefore = (
      await ctx.app.inject({
        method: 'GET',
        url: `/admin/characters/${LUNA.id}/requirements/plan`,
        headers: { cookie },
      })
    ).json().missing;
    const nudeBefore = missingBefore.find(
      (m: { requirementKey: string }) => m.requirementKey === 'primary_nude',
    );
    expect(nudeBefore.quantity).toBe(1);

    // Generate one, approve it, and the shortfall closes — through the ordinary
    // review lifecycle, with no separate accounting.
    await generate(cookie, {
      type: 'image',
      characterId: LUNA.id,
      prompt: 'studio portrait',
      modelId: 'mock:image',
      requirementKey: 'primary_nude',
    });
    const board = (
      await ctx.app.inject({
        method: 'GET',
        url: `/admin/content/review/workspace?characterId=${LUNA.id}`,
        headers: { cookie },
      })
    ).json();
    const assetId = board.selected.requirements.find(
      (r: { key: string }) => r.key === 'primary_nude',
    ).assets[0].assetId;

    // Pending does not close the gap — it might still be rejected.
    const midway = (
      await ctx.app.inject({
        method: 'GET',
        url: `/admin/characters/${LUNA.id}/requirements/plan`,
        headers: { cookie },
      })
    ).json().missing;
    expect(
      midway.find((m: { requirementKey: string }) => m.requirementKey === 'primary_nude').quantity,
    ).toBe(1);

    await ctx.app.inject({
      method: 'POST',
      url: `/admin/content/assets/${assetId}/approve`,
      headers: { cookie },
    });

    const after = (
      await ctx.app.inject({
        method: 'GET',
        url: `/admin/characters/${LUNA.id}/requirements/plan`,
        headers: { cookie },
      })
    ).json().missing;
    expect(
      after.find((m: { requirementKey: string }) => m.requirementKey === 'primary_nude'),
    ).toBeUndefined();
  });
});
