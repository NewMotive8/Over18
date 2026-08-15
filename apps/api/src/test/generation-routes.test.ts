import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { users } from '../db/schema.js';
import { SEED_CHARACTERS } from '../db/seed-data.js';
import { seedCharacters, seedVisualIdentities } from '../db/seed.js';
import { createMockProviders } from '../media-pipeline/mock-adapter.js';
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
 * US-103 — admin generation API.
 *
 * The point of these tests is the money boundary: an ordinary authenticated app
 * user must not be able to invoke generation, because generation spends real
 * provider credit.
 */

const LUNA = SEED_CHARACTERS.find((c) => c.name === 'luna')!;
const FIXTURES = join(testEnv.media.storageDir, '__routes__');

let ctx: TestContext;

async function signUp(email: string): Promise<string> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email, password: 'correct horse battery staple' },
  });
  const c = extractSessionCookie(res)!;
  return `${c.name}=${c.value}`;
}

async function makeAdmin(email: string): Promise<void> {
  await ctx.db.update(users).set({ role: 'admin' }).where(eq(users.email, email));
}

const imageJobBody = {
  type: 'image',
  characterId: '',
  prompt: 'studio portrait',
  modelId: 'mock:image',
  quantity: 2,
};

beforeAll(async () => {
  migrateTestDb();
  rmSync(testEnv.media.storageDir, { recursive: true, force: true });
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
  rmSync(testEnv.media.storageDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await truncateAll(ctx);
  await seedCharacters(ctx.db);
  await seedVisualIdentities(ctx.db);
});

describe('US-103 admin generation routes — authorization', () => {
  it('rejects an unauthenticated caller with 401', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/admin/generation/jobs',
      payload: { ...imageJobBody, characterId: LUNA.id },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects an ordinary authenticated user with 403 — generation spends money', async () => {
    const cookie = await signUp('normal@example.com');
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/admin/generation/jobs',
      headers: { cookie },
      payload: { ...imageJobBody, characterId: LUNA.id },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('forbidden');
  });

  it('rejects a non-admin on every admin generation route', async () => {
    const cookie = await signUp('nosy@example.com');
    const routes: [string, string][] = [
      ['GET', '/admin/generation/jobs/00000000-0000-4000-8000-000000000000'],
      ['POST', '/admin/generation/results/00000000-0000-4000-8000-000000000000/retry'],
      ['POST', '/admin/generation/sequences/00000000-0000-4000-8000-000000000000/run'],
      ['GET', '/admin/generation/sequence-runs/00000000-0000-4000-8000-000000000000'],
    ];
    for (const [method, url] of routes) {
      const res = await ctx.app.inject({ method: method as 'GET', url, headers: { cookie }, payload: {} });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
  });

  it('allows an admin', async () => {
    const cookie = await signUp('boss@example.com');
    await makeAdmin('boss@example.com');
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/admin/generation/jobs',
      headers: { cookie },
      payload: { ...imageJobBody, characterId: LUNA.id },
    });
    expect(res.statusCode).toBe(202);
  });
});

describe('US-103 admin generation routes — async contract', () => {
  async function adminCookie(): Promise<string> {
    const cookie = await signUp('admin@example.com');
    await makeAdmin('admin@example.com');
    return cookie;
  }

  it('returns a jobId immediately and reports progress on GET', async () => {
    const cookie = await adminCookie();
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/admin/generation/jobs',
      headers: { cookie },
      payload: { ...imageJobBody, characterId: LUNA.id },
    });
    expect(created.statusCode).toBe(202);
    const body = created.json();
    expect(body.jobId).toBeTruthy();
    expect(body.progress.requested).toBe(2);
    // Result rows exist before anything has run.
    expect(body.results).toHaveLength(2);
    expect(body.results.every((r: { resultId: string }) => Boolean(r.resultId))).toBe(true);

    const deadline = Date.now() + 15_000;
    let view = body;
    while (Date.now() < deadline && !['completed', 'partial', 'failed'].includes(view.status)) {
      await new Promise((r) => setTimeout(r, 100));
      const polled = await ctx.app.inject({
        method: 'GET',
        url: `/admin/generation/jobs/${body.jobId}`,
        headers: { cookie },
      });
      view = polled.json();
    }

    expect(view.status).toBe('completed');
    expect(view.progress.succeeded).toBe(2);
    expect(view.results.filter((r: { status: string }) => r.status === 'succeeded')).toHaveLength(2);
    // Every result carries its own asset — independently reviewable.
    const assetIds = view.results.map((r: { assetId: string }) => r.assetId);
    expect(new Set(assetIds).size).toBe(2);
  });

  it('returns structured validation errors for an unsupported parameter', async () => {
    const cookie = await adminCookie();
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/admin/generation/jobs',
      headers: { cookie },
      payload: {
        ...imageJobBody,
        characterId: LUNA.id,
        parameters: { motionStrength: 1 },
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().details[0].code).toBe('unsupported_parameter');
  });

  it('404s an unknown job', async () => {
    const cookie = await adminCookie();
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/admin/generation/jobs/00000000-0000-4000-8000-000000000000',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(404);
  });
});
