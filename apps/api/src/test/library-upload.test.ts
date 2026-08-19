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
  it('stores an uploaded image, lists it in the library, and serves the bytes', async () => {
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
    expect(asset.status).toBe('approved');
    // NEVER canonical — the public gallery rule is untouched.
    expect(asset.isPrimary).toBe(false);
    expect(asset.mediaType).toBe('image');

    const library = await ctx.app.inject({
      method: 'GET',
      url: '/admin/content/library',
      headers: { cookie },
    });
    expect(library.json().assets.map((a: { assetId: string }) => a.assetId)).toContain(asset.assetId);

    const file = await ctx.app.inject({
      method: 'GET',
      url: `/admin/content/uploads/${asset.assetId}/file`,
      headers: { cookie },
    });
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toBe('image/png');
    expect(file.rawPayload.equals(PNG)).toBe(true);
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
