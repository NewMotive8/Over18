import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
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

const LUNA = SEED_CHARACTERS.find((c) => c.name === 'luna')!;
let ctx: TestContext;

async function adminCookie(): Promise<string> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email: 'op@example.com', password: 'correct horse battery staple' },
  });
  const c = extractSessionCookie(res)!;
  await ctx.db.update(users).set({ role: 'admin' }).where(eq(users.email, 'op@example.com'));
  return `${c.name}=${c.value}`;
}

/** A minimal valid PNG (1x1). */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function multipart(characterId: string, filename: string, contentType: string, bytes: Buffer) {
  const boundary = '----smokeboundary1234';
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="characterId"\r\n\r\n${characterId}\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: ${contentType}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    payload: Buffer.concat([head, bytes, tail]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}


/** Minimal real-shaped MP4 (ftyp box). Enough to be a genuine video/mp4 part. */
const MP4 = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x18]),
  Buffer.from('ftypmp42'),
  Buffer.from([0x00, 0x00, 0x00, 0x00]),
  Buffer.from('mp42isom'),
  Buffer.alloc(32, 0x21),
]);

beforeAll(async () => {
  migrateTestDb();
  ctx = await createTestContext();
});
afterAll(async () => destroyTestContext(ctx));
beforeEach(async () => {
  await truncateAll(ctx);
  await seedCharacters(ctx.db);
  await seedVisualIdentities(ctx.db);
});

describe('manual library upload', () => {
  /**
   * LIFECYCLE (changed): an upload no longer arrives approved.
   *
   * It used to be written straight into the Library, which meant manual uploads
   * skipped the review step generated content has to pass. Both origins now
   * land in `under_review` and meet the same queue; the Library still begins at
   * approval, so it simply begins one deliberate decision later.
   */
  it('stores an uploaded image into REVIEW — not the library — and serves the bytes', async () => {
    const cookie = await adminCookie();
    const { payload, headers } = multipart(LUNA.id, 'luna.png', 'image/png', PNG);

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/admin/content/uploads',
      headers: { ...headers, cookie },
      payload,
    });
    expect(res.statusCode).toBe(201);
    const asset = res.json();
    expect(asset.characterId).toBe(LUNA.id);
    expect(asset.status).toBe('under_review');
    // NEVER canonical — the public gallery rule is untouched.
    expect(asset.isPrimary).toBe(false);
    expect(asset.mediaType).toBe('image');

    const inReview = await ctx.app.inject({
      method: 'GET',
      url: '/admin/content/review',
      headers: { cookie },
    });
    expect(inReview.json().assets.map((a: { assetId: string }) => a.assetId)).toContain(
      asset.assetId,
    );

    const beforeApproval = await ctx.app.inject({
      method: 'GET',
      url: '/admin/content/library',
      headers: { cookie },
    });
    expect(
      beforeApproval.json().assets.map((a: { assetId: string }) => a.assetId),
    ).not.toContain(asset.assetId);

    const file = await ctx.app.inject({
      method: 'GET',
      url: `/admin/content/uploads/${asset.assetId}/file`,
      headers: { cookie },
    });
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toBe('image/png');
    expect(file.rawPayload.equals(PNG)).toBe(true);
  });

  it('reaches the library through approval, without being re-uploaded', async () => {
    const cookie = await adminCookie();
    const { payload, headers } = multipart(LUNA.id, 'luna.png', 'image/png', PNG);
    const assetId = (
      await ctx.app.inject({
        method: 'POST',
        url: '/admin/content/uploads',
        headers: { ...headers, cookie },
        payload,
      })
    ).json().assetId;

    const approved = await ctx.app.inject({
      method: 'POST',
      url: `/admin/content/assets/${assetId}/approve`,
      headers: { cookie },
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().status).toBe('approved');

    const library = await ctx.app.inject({
      method: 'GET',
      url: '/admin/content/library',
      headers: { cookie },
    });
    expect(library.json().assets.map((a: { assetId: string }) => a.assetId)).toContain(assetId);
    // ...and it has left the review queue.
    const queue = await ctx.app.inject({
      method: 'GET',
      url: '/admin/content/review',
      headers: { cookie },
    });
    expect(queue.json().assets.map((a: { assetId: string }) => a.assetId)).not.toContain(assetId);
  });

  it('keeps the upload out of the public canonical gallery', async () => {
    const cookie = await adminCookie();
    const { payload, headers } = multipart(LUNA.id, 'luna.png', 'image/png', PNG);
    const uploaded = await ctx.app.inject({
      method: 'POST',
      url: '/admin/content/uploads',
      headers: { ...headers, cookie },
      payload,
    });
    const assetId = uploaded.json().assetId;

    const publicView = await ctx.app.inject({
      method: 'GET',
      url: `/api/characters/${LUNA.id}/visual-identity`,
    });
    const ids = publicView.json().canonicalAssets.map((a: { id: string }) => a.id);
    expect(ids).not.toContain(assetId);
  });

  it('refuses an unsupported file type', async () => {
    const cookie = await adminCookie();
    const { payload, headers } = multipart(LUNA.id, 'notes.txt', 'text/plain', Buffer.from('hi'));
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/admin/content/uploads',
      headers: { ...headers, cookie },
      payload,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('unsupported_type');
  });

  it('requires admin', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/admin/content/uploads',
      ...multipart(LUNA.id, 'luna.png', 'image/png', PNG),
    });
    expect([401, 403]).toContain(res.statusCode);
  });
});

describe('library asset delete', () => {
  it('removes the DB row and the stored file', async () => {
    const cookie = await adminCookie();
    const { payload, headers } = multipart(LUNA.id, 'luna.png', 'image/png', PNG);
    const up = await ctx.app.inject({ method: 'POST', url: '/admin/content/uploads', headers: { ...headers, cookie }, payload });
    const assetId = up.json().assetId;

    const [row] = await ctx.db.select().from(characterVisualAssets).where(eq(characterVisualAssets.id, assetId));
    const filePath = (row!.provenance as Record<string, unknown>).storagePath as string;
    expect(existsSync(filePath)).toBe(true);

    const del = await ctx.app.inject({ method: 'DELETE', url: `/admin/content/assets/${assetId}`, headers: { cookie } });
    expect(del.statusCode).toBe(200);
    expect(del.json()).toMatchObject({ assetId, fileRemoved: true, fileWasMissing: false });

    // file gone
    expect(existsSync(filePath)).toBe(false);
    // row gone
    const after = await ctx.db.select().from(characterVisualAssets).where(eq(characterVisualAssets.id, assetId));
    expect(after).toHaveLength(0);
    // and it has left the library listing
    const lib = await ctx.app.inject({ method: 'GET', url: '/admin/content/library', headers: { cookie } });
    expect(lib.json().assets.map((a: { assetId: string }) => a.assetId)).not.toContain(assetId);
  });

  it('still removes the row cleanly when the file is already missing', async () => {
    const cookie = await adminCookie();
    const { payload, headers } = multipart(LUNA.id, 'luna.png', 'image/png', PNG);
    const up = await ctx.app.inject({ method: 'POST', url: '/admin/content/uploads', headers: { ...headers, cookie }, payload });
    const assetId = up.json().assetId;

    const [row] = await ctx.db.select().from(characterVisualAssets).where(eq(characterVisualAssets.id, assetId));
    const filePath = (row!.provenance as Record<string, unknown>).storagePath as string;
    rmSync(filePath); // simulate an ephemeral-disk redeploy having wiped it

    const del = await ctx.app.inject({ method: 'DELETE', url: `/admin/content/assets/${assetId}`, headers: { cookie } });
    expect(del.statusCode).toBe(200);
    expect(del.json()).toMatchObject({ assetId, fileRemoved: false, fileWasMissing: true });
    const after = await ctx.db.select().from(characterVisualAssets).where(eq(characterVisualAssets.id, assetId));
    expect(after).toHaveLength(0);
  });

  it('refuses to delete a canonical (public gallery) asset', async () => {
    const cookie = await adminCookie();
    const identityId = (await getActiveVisualIdentity(ctx.db, LUNA.id))!.id;
    const canonical = await createVisualAsset(ctx.db, {
      characterId: LUNA.id,
      visualIdentityId: identityId,
      kind: 'reference',
      status: 'approved',
      storageKey: 'https://example.invalid/canonical.png',
    });
    await ctx.db.update(characterVisualAssets).set({ isCanonical: true }).where(eq(characterVisualAssets.id, canonical.id));

    const del = await ctx.app.inject({ method: 'DELETE', url: `/admin/content/assets/${canonical.id}`, headers: { cookie } });
    expect(del.statusCode).toBe(409);
    expect(del.json().error).toBe('canonical_refused');
    const after = await ctx.db.select().from(characterVisualAssets).where(eq(characterVisualAssets.id, canonical.id));
    expect(after).toHaveLength(1); // untouched
  });

  it('requires admin', async () => {
    const res = await ctx.app.inject({ method: 'DELETE', url: `/admin/content/assets/${LUNA.id}` });
    expect([401, 403]).toContain(res.statusCode);
  });
});

describe('uploaded video media type (regression: /file storage keys have no extension)', () => {
  it('reports mediaType "video", appears under the video filter, and not under image', async () => {
    const cookie = await adminCookie();
    const { payload, headers } = multipart(LUNA.id, 'clip.mp4', 'video/mp4', MP4);

    const up = await ctx.app.inject({ method: 'POST', url: '/admin/content/uploads', headers: { ...headers, cookie }, payload });
    expect(up.statusCode).toBe(201);
    const asset = up.json();

    // The storage key is a route path with NO extension — the exact shape that
    // used to defeat extension sniffing and misclassify every upload as image.
    expect(asset.storageKey).toMatch(/\/file$/);
    expect(asset.storageKey).not.toMatch(/\.(mp4|webm|mov|m4v)$/i);

    expect(asset.mediaType).toBe('video');

    // Filtered through the REVIEW queue: an upload now waits for a decision
    // there, so that is where its classification has to be right.
    const video = await ctx.app.inject({ method: 'GET', url: '/admin/content/review?mediaType=video', headers: { cookie } });
    expect(video.json().assets.map((a: { assetId: string }) => a.assetId)).toContain(asset.assetId);

    const image = await ctx.app.inject({ method: 'GET', url: '/admin/content/review?mediaType=image', headers: { cookie } });
    expect(image.json().assets.map((a: { assetId: string }) => a.assetId)).not.toContain(asset.assetId);
  });

  it('classifies an uploaded image as image (the fallback path is not broken)', async () => {
    const cookie = await adminCookie();
    const { payload, headers } = multipart(LUNA.id, 'luna.png', 'image/png', PNG);
    const up = await ctx.app.inject({ method: 'POST', url: '/admin/content/uploads', headers: { ...headers, cookie }, payload });
    expect(up.json().mediaType).toBe('image');

    const image = await ctx.app.inject({ method: 'GET', url: '/admin/content/review?mediaType=image', headers: { cookie } });
    expect(image.json().assets.map((a: { assetId: string }) => a.assetId)).toContain(up.json().assetId);
  });

  it('classifies an ALREADY-STORED video row from provenance alone — no migration or backfill', async () => {
    const cookie = await adminCookie();
    const identityId = (await getActiveVisualIdentity(ctx.db, LUNA.id))!.id;
    // Simulates a row uploaded BEFORE this fix: extensionless key, but the
    // provenance the upload service has always written is already present.
    const existing = await createVisualAsset(ctx.db, {
      characterId: LUNA.id,
      visualIdentityId: identityId,
      kind: 'generated',
      status: 'approved',
      storageKey: '/admin/content/uploads/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/file',
      provenance: { source: 'manual-upload', mediaType: 'video', mimeType: 'video/mp4' },
    });

    const asset = await ctx.app.inject({ method: 'GET', url: `/admin/content/assets/${existing.id}`, headers: { cookie } });
    expect(asset.json().mediaType).toBe('video');
  });

  it('still falls back to the storage-key extension when provenance says nothing', async () => {
    const cookie = await adminCookie();
    const identityId = (await getActiveVisualIdentity(ctx.db, LUNA.id))!.id;
    // A generated (non-upload) asset: no provenance.mediaType, key ends .mp4.
    const generated = await createVisualAsset(ctx.db, {
      characterId: LUNA.id,
      visualIdentityId: identityId,
      kind: 'generated',
      status: 'approved',
      storageKey: 'https://example.invalid/clip.mp4',
      provenance: { jobId: 'job-1', provider: 'mock', model: 'mock:video' },
    });

    const asset = await ctx.app.inject({ method: 'GET', url: `/admin/content/assets/${generated.id}`, headers: { cookie } });
    expect(asset.json().mediaType).toBe('video');
  });
});
