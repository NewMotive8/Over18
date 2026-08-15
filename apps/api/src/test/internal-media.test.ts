import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { buildApp } from '../app.js';
import { characterVisualAssets } from '../db/schema.js';
import { SEED_CHARACTERS } from '../db/seed-data.js';
import { seedCharacters, seedVisualIdentities } from '../db/seed.js';
import { createMockProviders } from '../media-pipeline/mock-adapter.js';
import { getVisualAssetById } from '../services/visual-asset-service.js';
import { getActiveVisualIdentity } from '../services/visual-identity-service.js';
import {
  createTestContext,
  destroyTestContext,
  migrateTestDb,
  testEnv,
  truncateAll,
  type TestContext,
} from './helpers.js';

/**
 * US-36 — internal media generation endpoints, end-to-end against the mock
 * provider (no paid calls, no network). Verifies the acceptance criteria:
 * an image job creates an asset row + file; a video job from a source image
 * asset creates a linked clip; the prompt is passed through; content_rating is
 * stored; a failed provider call is recorded without crashing; and the token
 * gate is enforced.
 */

const LUNA = SEED_CHARACTERS.find((c) => c.name === 'luna')!;
const TOKEN = testEnv.media.internalToken!;
const FIXTURES = join(testEnv.media.storageDir, '__fixtures__');
const IMAGE_FIXTURE = join(FIXTURES, 'seed.jpg');
const VIDEO_FIXTURE = join(FIXTURES, 'seed.mp4');

let ctx: TestContext;

beforeAll(async () => {
  migrateTestDb();
  // Clean scratch storage + write dummy fixtures the mock provider "generates"
  // by copying (bytes only need to be non-empty; QA is an offline concern).
  rmSync(testEnv.media.storageDir, { recursive: true, force: true });
  mkdirSync(FIXTURES, { recursive: true });
  writeFileSync(IMAGE_FIXTURE, Buffer.from('fake-jpeg-bytes'));
  writeFileSync(VIDEO_FIXTURE, Buffer.from('fake-mp4-bytes'));

  ctx = await createTestContext({
    mediaProviders: createMockProviders({ imageFixturePath: IMAGE_FIXTURE, videoFixturePath: VIDEO_FIXTURE }),
  });
});

afterAll(async () => {
  await destroyTestContext(ctx);
});

beforeEach(async () => {
  await truncateAll(ctx);
  await seedCharacters(ctx.db);
  await seedVisualIdentities(ctx.db);
});

function generateImage(body: Record<string, unknown>, token: string | null = TOKEN) {
  return ctx.app.inject({
    method: 'POST',
    url: '/internal/media/generate-image',
    headers: token ? { 'x-internal-token': token } : {},
    payload: body,
  });
}

function generateVideo(body: Record<string, unknown>, token: string | null = TOKEN) {
  return ctx.app.inject({
    method: 'POST',
    url: '/internal/media/generate-video',
    headers: token ? { 'x-internal-token': token } : {},
    payload: body,
  });
}

describe('POST /internal/media/generate-image', () => {
  it('generates an image, stores the file, and creates a non-canonical generated asset', async () => {
    const res = await generateImage({ characterId: LUNA.id, prompt: 'a calm studio portrait, neutral lighting', contentRating: 'sfw' });
    expect(res.statusCode).toBe(201);
    const { jobId, asset, cost } = res.json();
    expect(jobId).toMatch(/[0-9a-f-]{36}/);
    expect(asset.kind).toBe('generated');
    expect(asset.status).toBe('generated');
    expect(asset.isCanonical).toBe(false); // never auto-canonical
    expect(asset.contentRating).toBe('sfw');
    expect(asset.mediaType).toBe('image');
    expect(asset.storageKey.length).toBeGreaterThan(0);
    expect(cost.estimatedCostUsd).toBeGreaterThan(0);
    // File really landed on disk (storage_key is the path when no public base).
    expect(existsSync(asset.storageKey)).toBe(true);

    // The row is persisted and links to Luna's active identity version.
    const active = await getActiveVisualIdentity(ctx.db, LUNA.id);
    const row = await getVisualAssetById(ctx.db, asset.id);
    expect(row).not.toBeNull();
    expect(row!.visualIdentityId).toBe(active!.id);
    // Prompt is passed through from the request into provenance (not baked in).
    expect((row!.provenance as Record<string, unknown>).prompt).toBe('a calm studio portrait, neutral lighting');
  });

  it('stores content_rating exactly as supplied (explicit is just data)', async () => {
    const res = await generateImage({ characterId: LUNA.id, prompt: 'a portrait', contentRating: 'explicit' });
    expect(res.statusCode).toBe(201);
    expect(res.json().asset.contentRating).toBe('explicit');
  });

  it('rejects a request without the internal token (401)', async () => {
    const res = await generateImage({ characterId: LUNA.id, prompt: 'a portrait' }, null);
    expect(res.statusCode).toBe(401);
  });

  it('rejects a wrong internal token (401)', async () => {
    const res = await generateImage({ characterId: LUNA.id, prompt: 'a portrait' }, 'not-the-token');
    expect(res.statusCode).toBe(401);
  });
});

describe('POST /internal/media/generate-video', () => {
  it('generates a short clip from a source image asset, linked to the same character', async () => {
    const imgRes = await generateImage({ characterId: LUNA.id, prompt: 'a portrait', contentRating: 'explicit' });
    const sourceImageAssetId = imgRes.json().asset.id as string;

    const res = await generateVideo({
      characterId: LUNA.id,
      sourceImageAssetId,
      motionPrompt: 'slow gentle head turn',
      durationSeconds: 5,
    });
    expect(res.statusCode).toBe(201);
    const { asset } = res.json();
    expect(asset.kind).toBe('generated');
    expect(asset.mediaType).toBe('video');
    expect(asset.isCanonical).toBe(false);
    // Rating inherited from the source asset when not overridden.
    expect(asset.contentRating).toBe('explicit');
    expect(existsSync(asset.storageKey)).toBe(true);

    const row = await getVisualAssetById(ctx.db, asset.id);
    expect((row!.provenance as Record<string, unknown>).sourceImageAssetId).toBe(sourceImageAssetId);
    expect((row!.provenance as Record<string, unknown>).motionPrompt).toBe('slow gentle head turn');
  });

  it('fails cleanly (400) when the source image asset does not exist', async () => {
    const res = await generateVideo({
      characterId: LUNA.id,
      sourceImageAssetId: '00000000-0000-4000-8000-000000000000',
      motionPrompt: 'slow gentle head turn',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.kind).toBe('source_not_found');
  });
});

describe('provider failure handling', () => {
  it('records the failure and returns 502 without crashing or creating an asset', async () => {
    const failingApp = await buildApp(testEnv, ctx.db, {
      mediaProviders: createMockProviders({ imageFixturePath: IMAGE_FIXTURE, videoFixturePath: VIDEO_FIXTURE, failureMode: 'provider_error' }),
    });

    const before = await ctx.db.select().from(characterVisualAssets).where(eq(characterVisualAssets.characterId, LUNA.id));
    const res = await failingApp.inject({
      method: 'POST',
      url: '/internal/media/generate-image',
      headers: { 'x-internal-token': TOKEN },
      payload: { characterId: LUNA.id, prompt: 'a portrait' },
    });
    expect(res.statusCode).toBe(502);
    const body = res.json();
    expect(body.jobId).toMatch(/[0-9a-f-]{36}/);
    expect(body.error.kind).toBe('http'); // mock provider_error → ProviderError('http')
    expect(typeof body.error.message).toBe('string');

    // No asset row was created for the failed attempt.
    const after = await ctx.db.select().from(characterVisualAssets).where(eq(characterVisualAssets.characterId, LUNA.id));
    expect(after.length).toBe(before.length);

    await failingApp.close();
  });
});
