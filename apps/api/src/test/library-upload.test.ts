import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { users } from '../db/schema.js';
import { SEED_CHARACTERS } from '../db/seed-data.js';
import { seedCharacters, seedVisualIdentities } from '../db/seed.js';
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
