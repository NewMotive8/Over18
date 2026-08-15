import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { characterVisualAssets, users } from '../db/schema.js';
import { SEED_CHARACTERS } from '../db/seed-data.js';
import { seedCharacters, seedVisualIdentities } from '../db/seed.js';
import { getActiveVisualIdentity } from '../services/visual-identity-service.js';
import { createVisualAsset } from '../services/visual-asset-service.js';
import {
  createTestContext,
  destroyTestContext,
  extractSessionCookie,
  migrateTestDb,
  truncateAll,
  type TestContext,
} from './helpers.js';

/** US-106 — content review & approval over the existing EPIC 7 lifecycle. */

const LUNA = SEED_CHARACTERS.find((c) => c.name === 'luna')!;
let ctx: TestContext;
let identityId: string;

async function signUp(email: string): Promise<string> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email, password: 'correct horse battery staple' },
  });
  const c = extractSessionCookie(res)!;
  return `${c.name}=${c.value}`;
}

async function adminCookie(): Promise<string> {
  const cookie = await signUp('op@example.com');
  await ctx.db.update(users).set({ role: 'admin' }).where(eq(users.email, 'op@example.com'));
  return cookie;
}

async function seedAsset(ext: 'jpg' | 'mp4') {
  return createVisualAsset(ctx.db, {
    characterId: LUNA.id,
    visualIdentityId: identityId,
    kind: 'generated',
    status: 'under_review',
    contentRating: 'sfw',
    storageKey: `/media/luna/${Math.random().toString(36).slice(2)}.${ext}`,
    provenance: { jobId: 'job-1', provider: 'mock', model: 'mock:image' },
  });
}

beforeAll(async () => {
  migrateTestDb();
  ctx = await createTestContext();
});
afterAll(async () => destroyTestContext(ctx));
beforeEach(async () => {
  await truncateAll(ctx);
  await seedCharacters(ctx.db);
  await seedVisualIdentities(ctx.db);
  identityId = (await getActiveVisualIdentity(ctx.db, LUNA.id))!.id;
});

describe('US-106 authorization', () => {
  it('rejects unauthenticated and non-admin callers', async () => {
    const anon = await ctx.app.inject({ method: 'GET', url: '/admin/content/review' });
    expect(anon.statusCode).toBe(401);

    const cookie = await signUp('normal@example.com');
    const user = await ctx.app.inject({ method: 'GET', url: '/admin/content/review', headers: { cookie } });
    expect(user.statusCode).toBe(403);
  });
});

describe('US-106 review queue', () => {
  it('lists pending generated content with character context and media type', async () => {
    await seedAsset('jpg');
    await seedAsset('mp4');
    const cookie = await adminCookie();

    const res = await ctx.app.inject({ method: 'GET', url: '/admin/content/review', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const { assets } = res.json();
    expect(assets).toHaveLength(2);
    // Never an anonymous media grid — character is always present.
    expect(assets.every((a: { characterName: string }) => a.characterName === 'luna')).toBe(true);
    expect(assets.map((a: { mediaType: string }) => a.mediaType).sort()).toEqual(['image', 'video']);
    // Product terminology, not the DB column name.
    expect(assets[0]).toHaveProperty('isPrimary');
    expect(assets[0]).not.toHaveProperty('isCanonical');
  });

  it('summarises pending work per character', async () => {
    await seedAsset('jpg');
    await seedAsset('jpg');
    const cookie = await adminCookie();
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/admin/content/review/summary',
      headers: { cookie },
    });
    expect(res.json().characters[0]).toMatchObject({ characterName: 'luna', pendingCount: 2 });
  });

  it('filters by media type', async () => {
    await seedAsset('jpg');
    await seedAsset('mp4');
    const cookie = await adminCookie();
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/admin/content/review?mediaType=video',
      headers: { cookie },
    });
    expect(res.json().assets).toHaveLength(1);
    expect(res.json().assets[0].mediaType).toBe('video');
  });
});

describe('US-106 individual decisions', () => {
  it('approves one asset while another stays pending', async () => {
    const a = await seedAsset('jpg');
    const b = await seedAsset('jpg');
    const cookie = await adminCookie();

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/admin/content/assets/${a.id}/approve`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('approved');

    const [other] = await ctx.db
      .select()
      .from(characterVisualAssets)
      .where(eq(characterVisualAssets.id, b.id));
    expect(other.status).toBe('under_review');

    // Approving generated content must never make it Primary.
    expect(res.json().isPrimary).toBe(false);
  });

  it('rejects without destroying the row, its media or its provenance', async () => {
    const a = await seedAsset('jpg');
    const cookie = await adminCookie();
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/admin/content/assets/${a.id}/reject`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('rejected');

    const [row] = await ctx.db
      .select()
      .from(characterVisualAssets)
      .where(eq(characterVisualAssets.id, a.id));
    expect(row).toBeDefined(); // retirement, never a hard delete
    expect(row.storageKey).toBe(a.storageKey);
    expect((row.provenance as Record<string, unknown>).jobId).toBe('job-1');
  });

  it('refuses to approve a rejected asset', async () => {
    const a = await seedAsset('jpg');
    const cookie = await adminCookie();
    await ctx.app.inject({ method: 'POST', url: `/admin/content/assets/${a.id}/reject`, headers: { cookie } });
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/admin/content/assets/${a.id}/approve`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(409);
  });

  it('removes decided content from the pending queue', async () => {
    const a = await seedAsset('jpg');
    await seedAsset('jpg');
    const cookie = await adminCookie();
    await ctx.app.inject({ method: 'POST', url: `/admin/content/assets/${a.id}/approve`, headers: { cookie } });
    const res = await ctx.app.inject({ method: 'GET', url: '/admin/content/review', headers: { cookie } });
    expect(res.json().assets).toHaveLength(1);
  });
});

describe('US-106 asset detail and metadata', () => {
  it('returns detail with the provenance the model actually stores', async () => {
    const a = await seedAsset('jpg');
    const cookie = await adminCookie();
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/admin/content/assets/${a.id}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().provenance).toMatchObject({ jobId: 'job-1', provider: 'mock', model: 'mock:image' });
  });

  it('edits only supported metadata and refuses anything else', async () => {
    const a = await seedAsset('jpg');
    const cookie = await adminCookie();

    const ok = await ctx.app.inject({
      method: 'PATCH',
      url: `/admin/content/assets/${a.id}`,
      headers: { cookie },
      payload: { contentRating: 'explicit' },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().contentRating).toBe('explicit');

    // Review must not be able to rewrite lifecycle or provenance.
    for (const payload of [{ status: 'approved' }, { provenance: {} }, { isCanonical: true }]) {
      const bad = await ctx.app.inject({
        method: 'PATCH',
        url: `/admin/content/assets/${a.id}`,
        headers: { cookie },
        payload,
      });
      expect(bad.statusCode).toBe(400);
      expect(bad.json().error).toBe('unsupported_field');
    }
  });

  it('404s an unknown asset', async () => {
    const cookie = await adminCookie();
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/admin/content/assets/00000000-0000-4000-8000-000000000000',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('US-106 revision — reject removes content from the active workflow', () => {
  it('a rejected asset leaves the queue while other pending assets stay pending', async () => {
    const a = await seedAsset('jpg');
    const b = await seedAsset('jpg');
    const cookie = await adminCookie();

    // Both are visible while awaiting review.
    const before = await ctx.app.inject({ method: 'GET', url: '/admin/content/review', headers: { cookie } });
    expect(before.json().assets).toHaveLength(2);

    await ctx.app.inject({ method: 'POST', url: `/admin/content/assets/${a.id}/reject`, headers: { cookie } });

    const after = await ctx.app.inject({ method: 'GET', url: '/admin/content/review', headers: { cookie } });
    const ids = after.json().assets.map((x: { assetId: string }) => x.assetId);
    expect(ids).toEqual([b.id]);

    // ...and the per-character count drops with it.
    const summary = await ctx.app.inject({
      method: 'GET',
      url: '/admin/content/review/summary',
      headers: { cookie },
    });
    expect(summary.json().characters[0].pendingCount).toBe(1);
  });

  it('a rejected asset can never proceed through approval', async () => {
    const a = await seedAsset('jpg');
    const cookie = await adminCookie();
    await ctx.app.inject({ method: 'POST', url: `/admin/content/assets/${a.id}/reject`, headers: { cookie } });

    const retried = await ctx.app.inject({
      method: 'POST',
      url: `/admin/content/assets/${a.id}/approve`,
      headers: { cookie },
    });
    expect(retried.statusCode).toBe(409);

    const [row] = await ctx.db
      .select()
      .from(characterVisualAssets)
      .where(eq(characterVisualAssets.id, a.id));
    expect(row.status).toBe('rejected');
    expect(row.isCanonical).toBe(false); // never publishable, never Primary
  });

  it('rejection uses the EXISTING lifecycle — no new status is introduced', async () => {
    const a = await seedAsset('jpg');
    const cookie = await adminCookie();
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/admin/content/assets/${a.id}/reject`,
      headers: { cookie },
    });
    // EPIC 7's enum only. Nothing like 'deleted' or 'removed' may appear.
    expect(['generated', 'under_review', 'approved', 'rejected']).toContain(res.json().status);
    expect(res.json().status).toBe('rejected');
  });

  it('leaves already-approved content untouched', async () => {
    const approved = await seedAsset('jpg');
    const doomed = await seedAsset('jpg');
    const cookie = await adminCookie();

    await ctx.app.inject({ method: 'POST', url: `/admin/content/assets/${approved.id}/approve`, headers: { cookie } });
    await ctx.app.inject({ method: 'POST', url: `/admin/content/assets/${doomed.id}/reject`, headers: { cookie } });

    const [row] = await ctx.db
      .select()
      .from(characterVisualAssets)
      .where(eq(characterVisualAssets.id, approved.id));
    expect(row.status).toBe('approved');
  });
});
