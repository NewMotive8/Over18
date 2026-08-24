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

/**
 * PHASE 1 — Character content uploads skip Review.
 *
 * WHAT CHANGED, IN ONE SENTENCE: the upload route learned an OPT-IN
 * `approve=true` field, and the Character page's Regular and Explicit shelves
 * are the only caller that sends it.
 *
 * WHAT DID NOT CHANGE, AND IS PINNED HERE: Review still exists, still queues
 * everything that reaches it by any other path, and still approves. The
 * Content Library's upload omits the field and is byte-for-byte the flow it
 * always was. These tests fail loudly if any of that regresses — that is their
 * main job, more than proving the new path works.
 */

const LUNA = SEED_CHARACTERS.find((c) => c.name === 'luna')!;
let ctx: TestContext;
let identityId: string;

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

/** A minimal valid PNG (1x1) — a real image part, for the rejection tests. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/** Minimal real-shaped MP4 (ftyp box). Enough to be a genuine video/mp4 part. */
const MP4 = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x18]),
  Buffer.from('ftypmp42'),
  Buffer.from([0x00, 0x00, 0x00, 0x00]),
  Buffer.from('mp42isom'),
  Buffer.alloc(32, 0x21),
]);

/**
 * A multipart body with arbitrary text fields.
 *
 * The existing library-upload helper hard-codes `characterId` alone, and the
 * whole point here is which OTHER fields are present — so the fields are
 * passed in rather than assumed.
 */
function multipart(
  fields: Record<string, string>,
  file: { filename: string; contentType: string; bytes: Buffer },
) {
  const boundary = '----charactercontent1234';
  let head = '';
  for (const [name, value] of Object.entries(fields)) {
    head += `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
  }
  head +=
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.filename}"\r\n` +
    `Content-Type: ${file.contentType}\r\n\r\n`;
  return {
    payload: Buffer.concat([Buffer.from(head), file.bytes, Buffer.from(`\r\n--${boundary}--\r\n`)]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

/** Exactly what the Character page's Regular / Explicit shelves send. */
async function uploadFromShelf(
  cookie: string,
  section: 'regular' | 'explicit',
  file: { filename: string; contentType: string; bytes: Buffer } = {
    filename: 'clip.mp4',
    contentType: 'video/mp4',
    bytes: MP4,
  },
) {
  const { payload, headers } = multipart(
    {
      characterId: LUNA.id,
      contentRating: section === 'explicit' ? 'explicit' : 'sfw',
      approve: 'true',
    },
    file,
  );
  return ctx.app.inject({
    method: 'POST',
    url: '/admin/content/uploads',
    headers: { ...headers, cookie },
    payload,
  });
}

/** Exactly what the Content Library sends: no `approve` field at all. */
async function uploadFromLibrary(
  cookie: string,
  file: { filename: string; contentType: string; bytes: Buffer } = {
    filename: 'shot.png',
    contentType: 'image/png',
    bytes: PNG,
  },
) {
  const { payload, headers } = multipart({ characterId: LUNA.id }, file);
  return ctx.app.inject({
    method: 'POST',
    url: '/admin/content/uploads',
    headers: { ...headers, cookie },
    payload,
  });
}

async function reviewQueue(cookie: string): Promise<string[]> {
  const res = await ctx.app.inject({
    method: 'GET',
    url: '/admin/content/review',
    headers: { cookie },
  });
  expect(res.statusCode).toBe(200);
  return res.json().assets.map((a: { assetId: string }) => a.assetId);
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

describe('a video uploaded from a character shelf is usable immediately', () => {
  it('lands APPROVED, with an approval timestamp, and never enters Review', async () => {
    const cookie = await adminCookie();
    const res = await uploadFromShelf(cookie, 'regular');

    expect(res.statusCode).toBe(201);
    const asset = res.json();
    expect(asset.status).toBe('approved');
    expect(asset.mediaType).toBe('video');

    // The stored row, not just the response projection.
    const [row] = await ctx.db
      .select()
      .from(characterVisualAssets)
      .where(eq(characterVisualAssets.id, asset.assetId));
    expect(row!.status).toBe('approved');
    expect(row!.approvedAt).not.toBeNull();

    // The queue an operator actually looks at is untouched by this upload.
    expect(await reviewQueue(cookie)).not.toContain(asset.assetId);
  });

  it('is in the Library straight away, without a second decision', async () => {
    const cookie = await adminCookie();
    const asset = (await uploadFromShelf(cookie, 'regular')).json();
    const library = await ctx.app.inject({
      method: 'GET',
      url: '/admin/content/library',
      headers: { cookie },
    });
    expect(library.json().assets.map((a: { assetId: string }) => a.assetId)).toContain(
      asset.assetId,
    );
  });

  it('is NEVER promoted to a primary reference by being approved', async () => {
    // Approval and identity are separate decisions; auto-approval must not
    // quietly make an uploaded clip the character's canonical portrait.
    const cookie = await adminCookie();
    const asset = (await uploadFromShelf(cookie, 'regular')).json();
    expect(asset.isPrimary).toBe(false);
    const [row] = await ctx.db
      .select()
      .from(characterVisualAssets)
      .where(eq(characterVisualAssets.id, asset.assetId));
    expect(row!.isCanonical).toBe(false);
    expect(row!.kind).not.toBe('reference');
  });
});

describe('Regular and Explicit cannot be crossed', () => {
  it('stores a Regular upload as sfw', async () => {
    const cookie = await adminCookie();
    const asset = (await uploadFromShelf(cookie, 'regular')).json();
    const [row] = await ctx.db
      .select()
      .from(characterVisualAssets)
      .where(eq(characterVisualAssets.id, asset.assetId));
    expect(row!.contentRating).toBe('sfw');
  });

  it('stores an Explicit upload as explicit', async () => {
    const cookie = await adminCookie();
    const asset = (await uploadFromShelf(cookie, 'explicit')).json();
    const [row] = await ctx.db
      .select()
      .from(characterVisualAssets)
      .where(eq(characterVisualAssets.id, asset.assetId));
    expect(row!.contentRating).toBe('explicit');
  });

  it('keeps two uploads from the two shelves apart', async () => {
    const cookie = await adminCookie();
    const regular = (await uploadFromShelf(cookie, 'regular')).json();
    const explicit = (await uploadFromShelf(cookie, 'explicit')).json();
    const rows = await ctx.db
      .select()
      .from(characterVisualAssets)
      .where(eq(characterVisualAssets.characterId, LUNA.id));
    const byId = new Map(rows.map((r) => [r.id, r.contentRating]));
    expect(byId.get(regular.assetId)).toBe('sfw');
    expect(byId.get(explicit.assetId)).toBe('explicit');
  });

  it('refuses a rating that is neither, rather than guessing one', async () => {
    const cookie = await adminCookie();
    const { payload, headers } = multipart(
      { characterId: LUNA.id, contentRating: 'spicy', approve: 'true' },
      { filename: 'clip.mp4', contentType: 'video/mp4', bytes: MP4 },
    );
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/admin/content/uploads',
      headers: { ...headers, cookie },
      payload,
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('the character shelves are video-only', () => {
  it('refuses an image and writes NOTHING', async () => {
    const cookie = await adminCookie();
    const before = await ctx.db.select().from(characterVisualAssets);

    const res = await uploadFromShelf(cookie, 'regular', {
      filename: 'photo.png',
      contentType: 'image/png',
      bytes: PNG,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('unsupported_type');

    // A refusal that had already written an approved image would be worse than
    // no check at all.
    const after = await ctx.db.select().from(characterVisualAssets);
    expect(after).toHaveLength(before.length);
  });

  it('refuses an image on the Explicit shelf too', async () => {
    const cookie = await adminCookie();
    const res = await uploadFromShelf(cookie, 'explicit', {
      filename: 'photo.png',
      contentType: 'image/png',
      bytes: PNG,
    });
    expect(res.statusCode).toBe(400);
  });

  it('still accepts an image through the Content Library, which is unaffected', async () => {
    const cookie = await adminCookie();
    const res = await uploadFromLibrary(cookie);
    expect(res.statusCode).toBe(201);
    expect(res.json().mediaType).toBe('image');
  });
});

/* ------------------------------------------------------------------ *
 * REVIEW REGRESSION.
 *
 * The requirement was explicit: do not remove, disable, bypass or change
 * Review. These tests are the proof, and they are deliberately written from
 * the outside — through the same HTTP routes the Review screen calls — rather
 * than by asserting that a function still exists.
 * ------------------------------------------------------------------ */

describe('Review is untouched', () => {
  /** An asset that reached review the ordinary way, before any of this. */
  async function seedUnderReview() {
    return createVisualAsset(ctx.db, {
      characterId: LUNA.id,
      visualIdentityId: identityId,
      kind: 'generated',
      status: 'under_review',
      contentRating: 'sfw',
      storageKey: `/media/luna/${Math.random().toString(36).slice(2)}.jpg`,
      provenance: { jobId: 'job-1', provider: 'mock', model: 'mock:image' },
    });
  }

  it('still lists an existing under-review asset in the queue', async () => {
    const cookie = await adminCookie();
    const pending = await seedUnderReview();
    expect(await reviewQueue(cookie)).toContain(pending.id);
  });

  it('still approves it, and it moves to approved', async () => {
    const cookie = await adminCookie();
    const pending = await seedUnderReview();

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/admin/content/assets/${pending.id}/approve`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);

    const [row] = await ctx.db
      .select()
      .from(characterVisualAssets)
      .where(eq(characterVisualAssets.id, pending.id));
    expect(row!.status).toBe('approved');
    expect(row!.approvedAt).not.toBeNull();
    expect(await reviewQueue(cookie)).not.toContain(pending.id);
  });

  it('still rejects it', async () => {
    const cookie = await adminCookie();
    const pending = await seedUnderReview();
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/admin/content/assets/${pending.id}/reject`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const [row] = await ctx.db
      .select()
      .from(characterVisualAssets)
      .where(eq(characterVisualAssets.id, pending.id));
    expect(row!.status).toBe('rejected');
  });

  it('still queues a Content Library upload — the DEFAULT is unchanged', async () => {
    const cookie = await adminCookie();
    const asset = (await uploadFromLibrary(cookie)).json();
    expect(asset.status).toBe('under_review');
    expect(await reviewQueue(cookie)).toContain(asset.assetId);
  });

  it('still queues a Library VIDEO upload — it is the flag, not the media type', async () => {
    // Guards against the video-only rule leaking out of the auto-approve
    // branch and quietly approving every video anyone uploads.
    const cookie = await adminCookie();
    const asset = (
      await uploadFromLibrary(cookie, {
        filename: 'clip.mp4',
        contentType: 'video/mp4',
        bytes: MP4,
      })
    ).json();
    expect(asset.status).toBe('under_review');
    expect(await reviewQueue(cookie)).toContain(asset.assetId);
  });

  it('does not treat any value other than the exact opt-in as approval', async () => {
    const cookie = await adminCookie();
    for (const value of ['false', '1', 'yes', 'TRUE', '']) {
      const { payload, headers } = multipart(
        { characterId: LUNA.id, approve: value },
        { filename: 'clip.mp4', contentType: 'video/mp4', bytes: MP4 },
      );
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/admin/content/uploads',
        headers: { ...headers, cookie },
        payload,
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().status).toBe('under_review');
    }
  });

  it('still refuses an anonymous caller at the upload route', async () => {
    const { payload, headers } = multipart(
      { characterId: LUNA.id, contentRating: 'sfw', approve: 'true' },
      { filename: 'clip.mp4', contentType: 'video/mp4', bytes: MP4 },
    );
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/admin/content/uploads',
      headers,
      payload,
    });
    expect(res.statusCode).toBe(401);
  });
});

/* ------------------------------------------------------------------ *
 * MERCHANDISE.
 * ------------------------------------------------------------------ */

describe('the merchandising picker offers content, not identity', () => {
  async function candidates(cookie: string): Promise<Array<{ assetId: string; kind?: string }>> {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/admin/app-categories/candidates?characterId=${LUNA.id}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    return res.json().assets;
  }

  it('does NOT offer an approved identity reference', async () => {
    const cookie = await adminCookie();
    const reference = await createVisualAsset(ctx.db, {
      characterId: LUNA.id,
      visualIdentityId: identityId,
      kind: 'reference',
      status: 'approved',
      contentRating: 'sfw',
      storageKey: '/media/luna/portrait.jpg',
      provenance: { jobId: 'job-r', provider: 'mock', model: 'mock:image' },
    });
    expect((await candidates(cookie)).map((a) => a.assetId)).not.toContain(reference.id);
  });

  it('DOES offer Regular and Explicit videos uploaded from the character page', async () => {
    const cookie = await adminCookie();
    const regular = (await uploadFromShelf(cookie, 'regular')).json();
    const explicit = (await uploadFromShelf(cookie, 'explicit')).json();
    const ids = (await candidates(cookie)).map((a) => a.assetId);
    expect(ids).toContain(regular.assetId);
    expect(ids).toContain(explicit.assetId);
  });

  it('does NOT offer an approved IMAGE, however it got approved', async () => {
    // The leak this closes: an App Category is a public surface, and every
    // public surface is clip-only. An approved image offered here was the one
    // remaining route onto one.
    const cookie = await adminCookie();
    const image = (await uploadFromLibrary(cookie)).json();
    const approve = await ctx.app.inject({
      method: 'POST',
      url: `/admin/content/assets/${image.assetId}/approve`,
      headers: { cookie },
    });
    expect(approve.statusCode).toBe(200);
    expect(image.mediaType).toBe('image');

    // Approved, not a reference — it satisfies every OTHER condition, which is
    // exactly why this assertion is the one that matters.
    expect((await candidates(cookie)).map((a) => a.assetId)).not.toContain(image.assetId);
  });

  it('offers ONLY videos, with no filter applied at all', async () => {
    const cookie = await adminCookie();
    const image = (await uploadFromLibrary(cookie)).json();
    await ctx.app.inject({
      method: 'POST',
      url: `/admin/content/assets/${image.assetId}/approve`,
      headers: { cookie },
    });
    await uploadFromShelf(cookie, 'regular');

    const offered = await candidates(cookie);
    expect(offered.length).toBeGreaterThan(0);
    expect(offered.every((a) => (a as { mediaType?: string }).mediaType === 'video')).toBe(true);
  });

  it('cannot be talked into images by the media-type filter', async () => {
    // Video-only is enforced, not defaulted: asking for images returns an
    // empty list rather than re-opening the door.
    const cookie = await adminCookie();
    const image = (await uploadFromLibrary(cookie)).json();
    await ctx.app.inject({
      method: 'POST',
      url: `/admin/content/assets/${image.assetId}/approve`,
      headers: { cookie },
    });

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/admin/app-categories/candidates?characterId=${LUNA.id}&mediaType=image`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().assets).toEqual([]);
  });

  it('still excludes anything that is not approved', async () => {
    const cookie = await adminCookie();
    const pending = await createVisualAsset(ctx.db, {
      characterId: LUNA.id,
      visualIdentityId: identityId,
      kind: 'generated',
      status: 'under_review',
      contentRating: 'sfw',
      storageKey: '/media/luna/pending.mp4',
      provenance: { jobId: 'job-p', provider: 'mock', model: 'mock:video' },
    });
    expect((await candidates(cookie)).map((a) => a.assetId)).not.toContain(pending.id);
  });
});

/* ------------------------------------------------------------------ *
 * KEYWORDS — the one per-clip control the shelves kept.
 * ------------------------------------------------------------------ */

describe('keywords still work on a shelf upload', () => {
  it('saves and reads back a keyword set for an auto-approved clip', async () => {
    const cookie = await adminCookie();
    const asset = (await uploadFromShelf(cookie, 'regular')).json();

    const put = await ctx.app.inject({
      method: 'PUT',
      url: `/admin/discovery/content/${asset.assetId}/keywords`,
      headers: { cookie },
      payload: { keywords: ['beach', 'bikini'] },
    });
    expect(put.statusCode).toBe(200);

    const get = await ctx.app.inject({
      method: 'GET',
      url: `/admin/discovery/content/${asset.assetId}/keywords`,
      headers: { cookie },
    });
    expect(get.json().keywords.map((k: { key: string }) => k.key).sort()).toEqual([
      'beach',
      'bikini',
    ]);
  });

  it('leaves the asset itself alone — tagging is metadata, not a decision', async () => {
    const cookie = await adminCookie();
    const asset = (await uploadFromShelf(cookie, 'explicit')).json();
    await ctx.app.inject({
      method: 'PUT',
      url: `/admin/discovery/content/${asset.assetId}/keywords`,
      headers: { cookie },
      payload: { keywords: ['pool'] },
    });
    const [row] = await ctx.db
      .select()
      .from(characterVisualAssets)
      .where(eq(characterVisualAssets.id, asset.assetId));
    expect(row!.status).toBe('approved');
    expect(row!.contentRating).toBe('explicit');
  });
});
