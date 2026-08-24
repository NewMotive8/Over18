import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  appCategories,
  appCategoryAssets,
  characterVisualAssets,
  conversations,
  discoveryCategories,
  discoveryCategoryKeywords,
  messages,
  users,
} from '../db/schema.js';
import { SEED_CHARACTERS } from '../db/seed-data.js';
import { seedCharacters, seedVisualIdentities } from '../db/seed.js';
import { getActiveVisualIdentity } from '../services/visual-identity-service.js';
import { createVisualAsset } from '../services/visual-asset-service.js';
import { createDeterministicMediaSelector } from '../services/message-media-service.js';
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
 * PHASE 2 — THE CHAT CONTENT BOUNDARY.
 *
 * ── THE PROBLEM THIS EXISTS TO PREVENT ───────────────────────────────────────
 *
 * Before `kind = 'chat'`, a Regular video and a chat asset were byte-identical
 * on every column the database had: same kind, same status, same is_canonical,
 * same content_rating. "May this be sent privately in a conversation?" and "may
 * this be merchandised onto the front page?" therefore had the SAME answer for
 * the SAME row. Nobody chose that; it is what "no distinction exists" looks
 * like at runtime.
 *
 * The failure mode to guard against is subtler than a missing feature: an Admin
 * UI that says "Chat Content" while the runtime still reads the generic pool.
 * A label proves nothing. So every test here goes through the real HTTP routes
 * or the real selector, and asserts on stored rows — never on a helper's
 * opinion of what a shelf is called.
 *
 * ── WHY THE EXCLUSIONS ARE ALLOW-LISTS ───────────────────────────────────────
 *
 * Every public surface used to say `kind != 'reference'`. A negative test
 * written against a two-value enum silently admits every value added after it.
 * The day `chat` existed, six surfaces would have started serving private media
 * without one line of them changing. The tests below pin the allow-list
 * behaviour, so re-introducing a negative test fails here rather than in
 * production.
 */

const LUNA = SEED_CHARACTERS.find((c) => c.name === 'luna')!;
const EMBER = SEED_CHARACTERS.find((c) => c.name === 'ember')!;
let ctx: TestContext;
let identityId: string;

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const MP4 = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x18]),
  Buffer.from('ftypmp42'),
  Buffer.from([0x00, 0x00, 0x00, 0x00]),
  Buffer.from('mp42isom'),
  Buffer.alloc(32, 0x21),
]);

function multipart(
  fields: Record<string, string>,
  file: { filename: string; contentType: string; bytes: Buffer },
) {
  const boundary = '----chatboundary9876';
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

async function adminCookie(email = 'op@example.com'): Promise<string> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email, password: 'correct horse battery staple' },
  });
  const c = extractSessionCookie(res)!;
  await ctx.db.update(users).set({ role: 'admin' }).where(eq(users.email, email));
  return `${c.name}=${c.value}`;
}

/** Uploads through the REAL route, exactly as the Character page does. */
async function uploadToShelf(
  cookie: string,
  section: 'regular' | 'explicit' | 'chat',
  media: 'video' | 'image' = 'video',
  characterId: string = LUNA.id,
) {
  const file =
    media === 'video'
      ? { filename: 'clip.mp4', contentType: 'video/mp4', bytes: MP4 }
      : { filename: 'shot.png', contentType: 'image/png', bytes: PNG };
  const { payload, headers } = multipart(
    {
      characterId,
      contentRating: section === 'explicit' ? 'explicit' : 'sfw',
      section,
    },
    file,
  );
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/admin/content/uploads',
    headers: { ...headers, cookie },
    payload,
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { assetId: string; status: string; mediaType: string };
}

async function rowFor(assetId: string) {
  const [row] = await ctx.db
    .select()
    .from(characterVisualAssets)
    .where(eq(characterVisualAssets.id, assetId));
  return row!;
}

/**
 * Makes an asset carry a keyword that an ENABLED discovery category queries —
 * arm 4 of `publiclyReachableCondition`, and the one an operator can trigger
 * without doing anything that looks like publishing.
 */
async function keywordInEnabledDiscovery(cookie: string, assetId: string, key = 'beach') {
  const put = await ctx.app.inject({
    method: 'PUT',
    url: `/admin/discovery/content/${assetId}/keywords`,
    headers: { cookie },
    payload: { keywords: [key] },
  });
  expect(put.statusCode).toBe(200);

  const created = await ctx.app.inject({
    method: 'POST',
    url: '/admin/discovery/categories',
    headers: { cookie },
    payload: { name: 'Beach', keywords: [key], enabled: true },
  });
  expect([200, 201]).toContain(created.statusCode);

  // Prove the wiring actually exists, so a green result below cannot be a
  // false pass caused by the keyword never having been linked at all.
  const links = await ctx.db
    .select()
    .from(discoveryCategoryKeywords)
    .innerJoin(
      discoveryCategories,
      eq(discoveryCategories.id, discoveryCategoryKeywords.discoveryCategoryId),
    )
    .where(eq(discoveryCategories.enabled, true));
  expect(links.length).toBeGreaterThan(0);
}

/** Merchandises an asset into a category that is enabled AND published. */
async function publishInCategory(cookie: string) {
  const created = await ctx.app.inject({
    method: 'POST',
    url: '/admin/app-categories',
    headers: { cookie },
    payload: { name: 'Featured' },
  });
  expect(created.statusCode).toBe(201);
  const categoryId = created.json().id as string;
  await ctx.db
    .update(appCategories)
    .set({ enabled: true, homePublished: true })
    .where(eq(appCategories.id, categoryId));
  return { categoryId };
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

/* ================================================================== *
 * 1. THE UPLOAD PATH — the shelf decides the kind, and only the server
 * ================================================================== */

describe('the shelf an operator uploads through is recorded on the asset', () => {
  it('stores a Chat upload as kind=chat, approved, and not canonical', async () => {
    const cookie = await adminCookie();
    const asset = await uploadToShelf(cookie, 'chat', 'video');
    const row = await rowFor(asset.assetId);
    expect(row.kind).toBe('chat');
    expect(row.status).toBe('approved');
    expect(row.approvedAt).not.toBeNull();
    expect(row.isCanonical).toBe(false);
  });

  it('accepts an IMAGE on Chat Content', async () => {
    const cookie = await adminCookie();
    const asset = await uploadToShelf(cookie, 'chat', 'image');
    expect(asset.mediaType).toBe('image');
    expect((await rowFor(asset.assetId)).kind).toBe('chat');
  });

  it('keeps Regular and Explicit on kind=generated — nothing is reclassified', async () => {
    const cookie = await adminCookie();
    const regular = await uploadToShelf(cookie, 'regular');
    const explicit = await uploadToShelf(cookie, 'explicit');
    expect((await rowFor(regular.assetId)).kind).toBe('generated');
    expect((await rowFor(explicit.assetId)).kind).toBe('generated');
  });

  it('still refuses an image on Regular and Explicit', async () => {
    const cookie = await adminCookie();
    for (const section of ['regular', 'explicit'] as const) {
      const { payload, headers } = multipart(
        { characterId: LUNA.id, section },
        { filename: 'shot.png', contentType: 'image/png', bytes: PNG },
      );
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/admin/content/uploads',
        headers: { ...headers, cookie },
        payload,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('unsupported_type');
    }
  });
});

/* ================================================================== *
 * 2. THE CHAT SELECTOR — requirements 1-4
 * ================================================================== */

describe('Chat can only send Chat Content', () => {
  const select = (characterId: string, requested: 'image' | 'video', conversationId: string) =>
    createDeterministicMediaSelector(testEnv.media.storageDir)(ctx.db, {
      characterId,
      conversationId,
      requested,
    });

  /** A conversation row, so the "already sent" exclusion has somewhere to look. */
  async function conversation(): Promise<string> {
    const [user] = await ctx.db
      .insert(users)
      .values({ email: `viewer-${Math.random().toString(36).slice(2)}@example.com`, passwordHash: 'x' })
      .returning();
    const [row] = await ctx.db
      .insert(conversations)
      .values({ userId: user!.id, characterId: LUNA.id })
      .returning();
    return row!.id;
  }

  it('1. does NOT select a Regular video', async () => {
    const cookie = await adminCookie();
    await uploadToShelf(cookie, 'regular');
    expect(await select(LUNA.id, 'video', await conversation())).toBeNull();
  });

  it('2. does NOT select an Explicit video', async () => {
    const cookie = await adminCookie();
    await uploadToShelf(cookie, 'explicit');
    expect(await select(LUNA.id, 'video', await conversation())).toBeNull();
  });

  it('3. DOES select a Chat video', async () => {
    const cookie = await adminCookie();
    const chat = await uploadToShelf(cookie, 'chat', 'video');
    const picked = await select(LUNA.id, 'video', await conversation());
    expect(picked?.assetId).toBe(chat.assetId);
    expect(picked?.mediaType).toBe('video');
  });

  it('4. DOES select a Chat image when an image is requested', async () => {
    const cookie = await adminCookie();
    const chat = await uploadToShelf(cookie, 'chat', 'image');
    const picked = await select(LUNA.id, 'image', await conversation());
    expect(picked?.assetId).toBe(chat.assetId);
    expect(picked?.mediaType).toBe('image');
  });

  it('picks the right TYPE when the shelf holds both', async () => {
    const cookie = await adminCookie();
    const video = await uploadToShelf(cookie, 'chat', 'video');
    const image = await uploadToShelf(cookie, 'chat', 'image');
    const cid = await conversation();
    expect((await select(LUNA.id, 'video', cid))?.assetId).toBe(video.assetId);
    expect((await select(LUNA.id, 'image', cid))?.assetId).toBe(image.assetId);
  });

  it('never reaches ANOTHER character’s chat content', async () => {
    const cookie = await adminCookie();
    await uploadToShelf(cookie, 'chat', 'video', EMBER.id);
    expect(await select(LUNA.id, 'video', await conversation())).toBeNull();
  });

  it('still refuses an EXPLICIT-rated chat asset', async () => {
    // The rating gate is independent of the kind gate and must survive it.
    const cookie = await adminCookie();
    const chat = await uploadToShelf(cookie, 'chat', 'video');
    await ctx.db
      .update(characterVisualAssets)
      .set({ contentRating: 'explicit' })
      .where(eq(characterVisualAssets.id, chat.assetId));
    expect(await select(LUNA.id, 'video', await conversation())).toBeNull();
  });

  it('still refuses a chat asset that is not approved', async () => {
    const cookie = await adminCookie();
    const chat = await uploadToShelf(cookie, 'chat', 'video');
    await ctx.db
      .update(characterVisualAssets)
      .set({ status: 'under_review' })
      .where(eq(characterVisualAssets.id, chat.assetId));
    expect(await select(LUNA.id, 'video', await conversation())).toBeNull();
  });
});

/* ================================================================== *
 * 3. PUBLIC SURFACES — requirements 5-11
 * ================================================================== */

describe('Chat Content never reaches a public surface', () => {
  /**
   * The hardest case, and the reason requirement 5 exists: a chat asset that
   * has been given every reachability arm an operator can reach. If the kind
   * gate is missing, THIS is the asset that leaks.
   */
  async function maximallyPublishedChatAsset(cookie: string, media: 'image' | 'video' = 'video') {
    const chat = await uploadToShelf(cookie, 'chat', media);
    await keywordInEnabledDiscovery(cookie, chat.assetId);
    const { categoryId } = await publishInCategory(cookie);
    // Force the category link directly: the merchandising WRITE path now
    // refuses chat, which is itself asserted below. Writing the row by hand
    // proves the READ side holds even against data the write side would never
    // have produced.
    await ctx.db.insert(appCategoryAssets).values({ categoryId, assetId: chat.assetId, position: 0 });
    return chat;
  }

  it('5. keywords in an enabled discovery category do NOT publish it', async () => {
    const cookie = await adminCookie();
    const chat = await maximallyPublishedChatAsset(cookie);

    // The public byte route is the single chokepoint for publicly-reachable
    // media, so a 404 here is the strongest available statement.
    const bytes = await ctx.app.inject({
      method: 'GET',
      url: `/api/media/assets/${chat.assetId}/file`,
    });
    expect(bytes.statusCode).toBe(404);
  });

  it('6. never appears in Search', async () => {
    const cookie = await adminCookie();
    const chat = await maximallyPublishedChatAsset(cookie);
    const res = await ctx.app.inject({ method: 'GET', url: '/api/browse/clips' });
    expect(res.statusCode).toBe(200);
    expect(res.json().clips.map((c: { id: string }) => c.id)).not.toContain(chat.assetId);
  });

  it('7. never appears in Posts', async () => {
    // Posts has no media-type filter, so a chat IMAGE is the dangerous case
    // here — the video-only surfaces would have hidden it by accident.
    const cookie = await adminCookie();
    const chat = await maximallyPublishedChatAsset(cookie, 'image');
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/characters/${LUNA.id}/clips`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().clips.map((c: { id: string }) => c.id)).not.toContain(chat.assetId);
  });

  it('8. never appears in Play with me', async () => {
    const cookie = await adminCookie();
    const chat = await maximallyPublishedChatAsset(cookie);
    const res = await ctx.app.inject({ method: 'GET', url: '/api/home' });
    expect(res.statusCode).toBe(200);
    const body = JSON.stringify(res.json());
    expect(body).not.toContain(chat.assetId);
  });

  it('9. never appears as a Merchandise candidate', async () => {
    const cookie = await adminCookie();
    const chat = await uploadToShelf(cookie, 'chat', 'video');
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/admin/app-categories/candidates?characterId=${LUNA.id}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().assets.map((a: { assetId: string }) => a.assetId)).not.toContain(
      chat.assetId,
    );
  });

  it('9b. cannot be merchandised even by posting its id directly', async () => {
    const cookie = await adminCookie();
    const chat = await uploadToShelf(cookie, 'chat', 'video');
    const { categoryId } = await publishInCategory(cookie);
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/admin/app-categories/${categoryId}/assets`,
      headers: { cookie },
      payload: { assetIds: [chat.assetId] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().added).toBe(0);
    expect(res.json().outcomes[0].reason).toBe('not_content');
  });

  it('10. never appears among Home Hero candidates', async () => {
    const cookie = await adminCookie();
    const chat = await uploadToShelf(cookie, 'chat', 'video');
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/admin/home/hero/candidates',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.stringify(res.json())).not.toContain(chat.assetId);
  });

  it('10b. cannot be added to the Hero even by posting its id directly', async () => {
    const cookie = await adminCookie();
    const chat = await uploadToShelf(cookie, 'chat', 'video');
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/admin/home/hero',
      headers: { cookie },
      payload: { assetIds: [chat.assetId] },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.stringify(res.json())).toContain('not_content');
  });

  it('11. a chat IMAGE is not a Merchandise candidate either', async () => {
    const cookie = await adminCookie();
    const chat = await uploadToShelf(cookie, 'chat', 'image');
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/admin/app-categories/candidates?characterId=${LUNA.id}`,
      headers: { cookie },
    });
    expect(res.json().assets.map((a: { assetId: string }) => a.assetId)).not.toContain(
      chat.assetId,
    );
  });

  it('the identity reference exclusion is unchanged', async () => {
    // The allow-list replaced `kind != 'reference'`; this proves the behaviour
    // it replaced still holds rather than having been swapped for chat-only.
    const cookie = await adminCookie();
    const reference = await createVisualAsset(ctx.db, {
      characterId: LUNA.id,
      visualIdentityId: identityId,
      kind: 'reference',
      status: 'approved',
      contentRating: 'sfw',
      storageKey: '/media/luna/portrait.jpg',
      provenance: { jobId: 'j', provider: 'mock', model: 'mock:image' },
    });
    const candidates = await ctx.app.inject({
      method: 'GET',
      url: `/admin/app-categories/candidates?characterId=${LUNA.id}`,
      headers: { cookie },
    });
    expect(
      candidates.json().assets.map((a: { assetId: string }) => a.assetId),
    ).not.toContain(reference.id);

    const hero = await ctx.app.inject({
      method: 'GET',
      url: '/admin/home/hero/candidates',
      headers: { cookie },
    });
    expect(JSON.stringify(hero.json())).not.toContain(reference.id);
  });

  it('a REGULAR video is still fully publishable — the gate is chat-specific', async () => {
    // The counterweight to every assertion above: if the exclusions were too
    // broad they would silently break the product, and every test here would
    // still pass.
    const cookie = await adminCookie();
    const regular = await uploadToShelf(cookie, 'regular');
    const candidates = await ctx.app.inject({
      method: 'GET',
      url: `/admin/app-categories/candidates?characterId=${LUNA.id}`,
      headers: { cookie },
    });
    expect(candidates.json().assets.map((a: { assetId: string }) => a.assetId)).toContain(
      regular.assetId,
    );

    await keywordInEnabledDiscovery(cookie, regular.assetId);
    const bytes = await ctx.app.inject({
      method: 'GET',
      url: `/api/media/assets/${regular.assetId}/file`,
    });
    // 200 or 404-for-missing-bytes are both fine; what matters is that it is
    // not refused as UNREACHABLE. The search listing is the real assertion.
    const search = await ctx.app.inject({ method: 'GET', url: '/api/browse/clips' });
    expect(search.json().clips.map((c: { id: string }) => c.id)).toContain(regular.assetId);
    expect([200, 404]).toContain(bytes.statusCode);
  });
});

/* ================================================================== *
 * 4. THE MIGRATION — requirement 12
 * ================================================================== */

describe('the migration changed no existing row', () => {
  it('12. seeded assets keep their original kind after the enum was widened', async () => {
    // The seed set is the closest thing to "assets that existed before the
    // migration". Adding an enum value must not reclassify anything.
    const rows = await ctx.db.select().from(characterVisualAssets);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.kind === 'reference' || r.kind === 'generated')).toBe(true);
    expect(rows.some((r) => r.kind === 'chat')).toBe(false);
  });

  it('12b. an upload made without a section is still kind=generated', async () => {
    const cookie = await adminCookie();
    const { payload, headers } = multipart(
      { characterId: LUNA.id },
      { filename: 'clip.mp4', contentType: 'video/mp4', bytes: MP4 },
    );
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/admin/content/uploads',
      headers: { ...headers, cookie },
      payload,
    });
    expect(res.statusCode).toBe(201);
    const row = await rowFor(res.json().assetId);
    expect(row.kind).toBe('generated');
    expect(row.status).toBe('under_review');
  });
});

/* ================================================================== *
 * 5. REVIEW — requirement 13
 * ================================================================== */

describe('13. Review still works exactly as before', () => {
  async function pending() {
    return createVisualAsset(ctx.db, {
      characterId: LUNA.id,
      visualIdentityId: identityId,
      kind: 'generated',
      status: 'under_review',
      contentRating: 'sfw',
      storageKey: `/media/luna/${Math.random().toString(36).slice(2)}.jpg`,
      provenance: { jobId: 'j', provider: 'mock', model: 'mock:image' },
    });
  }

  it('lists an under-review asset in the queue', async () => {
    const cookie = await adminCookie();
    const asset = await pending();
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/admin/content/review',
      headers: { cookie },
    });
    expect(res.json().assets.map((a: { assetId: string }) => a.assetId)).toContain(asset.id);
  });

  it('approves it, and it becomes approved', async () => {
    const cookie = await adminCookie();
    const asset = await pending();
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/admin/content/assets/${asset.id}/approve`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const row = await rowFor(asset.id);
    expect(row.status).toBe('approved');
    expect(row.kind).toBe('generated');
  });

  it('rejects it', async () => {
    const cookie = await adminCookie();
    const asset = await pending();
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/admin/content/assets/${asset.id}/reject`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect((await rowFor(asset.id)).status).toBe('rejected');
  });

  it('never puts a Chat upload into the queue', async () => {
    const cookie = await adminCookie();
    const chat = await uploadToShelf(cookie, 'chat', 'image');
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/admin/content/review',
      headers: { cookie },
    });
    expect(res.json().assets.map((a: { assetId: string }) => a.assetId)).not.toContain(
      chat.assetId,
    );
  });
});

/* ================================================================== *
 * 6. CHAT MEDIA AUTHORIZATION AND THE FEATURE FLAG — requirements 14-15
 * ================================================================== */

describe('14. chat media stays behind the conversation authorization', () => {
  async function conversationWithMedia(assetId: string) {
    const [owner] = await ctx.db
      .insert(users)
      .values({ email: `owner-${Math.random().toString(36).slice(2)}@example.com`, passwordHash: 'x' })
      .returning();
    const [convo] = await ctx.db
      .insert(conversations)
      .values({ userId: owner!.id, characterId: LUNA.id })
      .returning();
    const [message] = await ctx.db
      .insert(messages)
      .values({
        conversationId: convo!.id,
        sender: 'character',
        content: 'here you go',
        mediaAssetId: assetId,
      })
      .returning();
    return { conversationId: convo!.id, messageId: message!.id };
  }

  it('refuses an anonymous caller', async () => {
    const cookie = await adminCookie();
    const chat = await uploadToShelf(cookie, 'chat', 'image');
    const { conversationId, messageId } = await conversationWithMedia(chat.assetId);
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/conversations/${conversationId}/messages/${messageId}/media`,
    });
    expect(res.statusCode).toBe(401);
  });

  it("refuses ANOTHER user's conversation with an opaque 404", async () => {
    const cookie = await adminCookie();
    const chat = await uploadToShelf(cookie, 'chat', 'image');
    const { conversationId, messageId } = await conversationWithMedia(chat.assetId);

    const intruder = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'intruder@example.com', password: 'correct horse battery staple' },
    });
    const c = extractSessionCookie(intruder)!;
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/conversations/${conversationId}/messages/${messageId}/media`,
      headers: { cookie: `${c.name}=${c.value}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('never serves chat media through the PUBLIC media route', async () => {
    const cookie = await adminCookie();
    const chat = await uploadToShelf(cookie, 'chat', 'image');
    await conversationWithMedia(chat.assetId);
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/media/assets/${chat.assetId}/file`,
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('15. CHAT_MEDIA_ENABLED=false still prevents selection', () => {
  it('writes no media_asset_id when the flag is off', async () => {
    // The default test context mirrors production: chatMedia.enabled = false,
    // so `app.ts` never constructs a selector at all.
    const cookie = await adminCookie();
    await uploadToShelf(cookie, 'chat', 'image');

    const viewer = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'viewer@example.com', password: 'correct horse battery staple' },
    });
    const c = extractSessionCookie(viewer)!;
    const cookieHeader = `${c.name}=${c.value}`;

    const convo = await ctx.app.inject({
      method: 'POST',
      url: '/api/conversations',
      headers: { cookie: cookieHeader },
      payload: { characterId: LUNA.id },
    });
    expect(convo.statusCode).toBe(201);
    const conversationId = convo.json().id as string;

    const sent = await ctx.app.inject({
      method: 'POST',
      url: `/api/conversations/${conversationId}/messages`,
      headers: { cookie: cookieHeader },
      payload: { content: 'send me a picture', requestMedia: 'image' },
    });
    expect(sent.statusCode).toBe(201);

    const rows = await ctx.db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversationId));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.mediaAssetId === null)).toBe(true);
  });
});
