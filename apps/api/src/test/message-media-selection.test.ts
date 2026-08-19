import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { characterVisualAssets, messages } from '../db/schema.js';
import { SEED_CHARACTERS } from '../db/seed-data.js';
import { seedCharacters, seedVisualIdentities } from '../db/seed.js';
import { createVisualAsset } from '../services/visual-asset-service.js';
import { getActiveVisualIdentity } from '../services/visual-identity-service.js';
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
 * Character Media Messages, commit 2 — server-side selection and the send flow.
 *
 * Two contexts are built: one with the feature OFF (production's default) and
 * one with it ON. Every eligibility rule is tested by making an asset eligible
 * and then breaking exactly ONE rule, so a passing test cannot be explained by
 * some other filter doing the work.
 */

const LUNA = SEED_CHARACTERS.find((c) => c.name === 'luna')!;
const EMBER = SEED_CHARACTERS.find((c) => c.name === 'ember')!;
const STORAGE_DIR = testEnv.media.storageDir;
const OUTSIDE_DIR = join(tmpdir(), 'over18-test-media-outside-sel');

let on: TestContext; // CHAT_MEDIA_ENABLED = true
let off: TestContext; // CHAT_MEDIA_ENABLED = false (the default)

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

beforeAll(async () => {
  migrateTestDb();
  on = await createTestContext({ chatMediaEnabled: true });
  off = await createTestContext();
});

afterAll(async () => {
  rmSync(OUTSIDE_DIR, { recursive: true, force: true });
  await destroyTestContext(on);
  await destroyTestContext(off);
});

beforeEach(async () => {
  await truncateAll(on);
  await seedCharacters(on.db);
  await seedVisualIdentities(on.db);
});

/**
 * Creates an asset that is eligible by default; each override breaks one rule.
 * Uses the UPLOAD convention (route in storage_key, real path in provenance),
 * because that is what a manually uploaded Library asset actually looks like —
 * and its extensionless `/file` key is exactly what naive extension sniffing
 * gets wrong.
 */
async function makeAsset(options: {
  character?: { id: string };
  mediaType?: 'image' | 'video';
  status?: 'generated' | 'under_review' | 'approved' | 'rejected';
  contentRating?: 'sfw' | 'explicit';
  canonical?: boolean;
  kind?: 'reference' | 'generated';
  writeFile?: boolean;
  dir?: string;
} = {}): Promise<string> {
  const character = options.character ?? LUNA;
  const mediaType = options.mediaType ?? 'image';
  const identity = (await getActiveVisualIdentity(on.db, character.id))!;
  const asset = await createVisualAsset(on.db, {
    characterId: character.id,
    visualIdentityId: identity.id,
    kind: options.kind ?? 'generated',
    status: options.status ?? 'approved',
    contentRating: options.contentRating ?? 'sfw',
  });

  const dir = options.dir ?? join(STORAGE_DIR, character.id, 'uploads');
  mkdirSync(dir, { recursive: true });
  const storagePath = join(dir, `${asset.id}.${mediaType === 'video' ? 'mp4' : 'png'}`);
  if (options.writeFile !== false) {
    writeFileSync(storagePath, mediaType === 'video' ? MP4 : PNG);
  }

  await on.db
    .update(characterVisualAssets)
    .set({
      storageKey: `/admin/content/uploads/${asset.id}/file`,
      isCanonical: options.canonical ?? false,
      provenance: {
        source: 'manual-upload',
        mimeType: mediaType === 'video' ? 'video/mp4' : 'image/png',
        mediaType,
        storagePath,
      },
    })
    .where(eq(characterVisualAssets.id, asset.id));
  return asset.id;
}

async function setupUser(ctx: TestContext, email: string, characterId = LUNA.id) {
  const reg = await ctx.app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email, password: 'media-sel-pass1' },
  });
  const c = extractSessionCookie(reg)!;
  const cookies = { [c.name]: c.value };
  const conv = await ctx.app.inject({
    method: 'POST',
    url: '/api/conversations',
    payload: { characterId },
    cookies,
  });
  return { userId: reg.json().id as string, cookies, conversationId: conv.json().id as string };
}

function send(
  ctx: TestContext,
  cookies: Record<string, string>,
  conversationId: string,
  content: string,
  requestMedia?: 'image' | 'video',
) {
  return ctx.app.inject({
    method: 'POST',
    url: `/api/conversations/${conversationId}/messages`,
    payload: requestMedia ? { content, requestMedia } : { content },
    cookies,
  });
}

const selector = () => createDeterministicMediaSelector(STORAGE_DIR);

/* ------------------------------------------------------------------ *
 * Selection eligibility
 * ------------------------------------------------------------------ */

describe('deterministic media selector', () => {
  it('selects an eligible image', async () => {
    const user = await setupUser(on, 'sel.img@example.com');
    const assetId = await makeAsset({ mediaType: 'image' });

    const chosen = await selector()(on.db, {
      characterId: LUNA.id,
      conversationId: user.conversationId,
      requested: 'image',
    });
    expect(chosen).toEqual({ assetId, mediaType: 'image' });
  });

  it('selects an eligible video', async () => {
    const user = await setupUser(on, 'sel.vid@example.com');
    const assetId = await makeAsset({ mediaType: 'video' });

    const chosen = await selector()(on.db, {
      characterId: LUNA.id,
      conversationId: user.conversationId,
      requested: 'video',
    });
    expect(chosen).toEqual({ assetId, mediaType: 'video' });
  });

  it('resolves media type from provenance, not the extensionless /file key', async () => {
    const user = await setupUser(on, 'sel.prov@example.com');
    await makeAsset({ mediaType: 'video' });

    // Extension sniffing on '/admin/content/uploads/<id>/file' would call this
    // an image; asking for an image must therefore find nothing.
    const asImage = await selector()(on.db, {
      characterId: LUNA.id,
      conversationId: user.conversationId,
      requested: 'image',
    });
    expect(asImage).toBeNull();
  });

  it('refuses an explicit asset', async () => {
    const user = await setupUser(on, 'sel.explicit@example.com');
    await makeAsset({ contentRating: 'explicit' });

    expect(
      await selector()(on.db, {
        characterId: LUNA.id,
        conversationId: user.conversationId,
        requested: 'image',
      }),
    ).toBeNull();
  });

  it('refuses an unapproved asset', async () => {
    const user = await setupUser(on, 'sel.unapproved@example.com');
    await makeAsset({ status: 'generated' });
    await makeAsset({ status: 'under_review' });
    await makeAsset({ status: 'rejected' });

    expect(
      await selector()(on.db, {
        characterId: LUNA.id,
        conversationId: user.conversationId,
        requested: 'image',
      }),
    ).toBeNull();
  });

  it('refuses a canonical (public gallery) asset', async () => {
    const user = await setupUser(on, 'sel.canon@example.com');
    await makeAsset({ canonical: true });

    expect(
      await selector()(on.db, {
        characterId: LUNA.id,
        conversationId: user.conversationId,
        requested: 'image',
      }),
    ).toBeNull();
  });

  it("refuses another character's asset", async () => {
    const user = await setupUser(on, 'sel.foreign@example.com');
    // A perfectly eligible asset — but it belongs to Ember, not Luna.
    const emberAsset = await makeAsset({ character: EMBER });

    const chosen = await selector()(on.db, {
      characterId: LUNA.id,
      conversationId: user.conversationId,
      requested: 'image',
    });
    expect(chosen).toBeNull();

    // Proof the asset itself is fine: Ember's own conversation can select it.
    const emberUser = await setupUser(on, 'sel.foreign.b@example.com', EMBER.id);
    expect(
      await selector()(on.db, {
        characterId: EMBER.id,
        conversationId: emberUser.conversationId,
        requested: 'image',
      }),
    ).toEqual({ assetId: emberAsset, mediaType: 'image' });
  });

  it('refuses an asset already sent in this conversation', async () => {
    const user = await setupUser(on, 'sel.repeat@example.com');
    const assetId = await makeAsset();

    const first = await selector()(on.db, {
      characterId: LUNA.id,
      conversationId: user.conversationId,
      requested: 'image',
    });
    expect(first!.assetId).toBe(assetId);

    // Record it as sent, exactly as sendMessage does.
    await on.db.insert(messages).values({
      conversationId: user.conversationId,
      sender: 'character',
      content: 'here you go',
      mediaAssetId: assetId,
    });

    expect(
      await selector()(on.db, {
        characterId: LUNA.id,
        conversationId: user.conversationId,
        requested: 'image',
      }),
    ).toBeNull();
  });

  it('the already-sent exclusion is per-conversation, not global', async () => {
    const a = await setupUser(on, 'sel.scope.a@example.com');
    const b = await setupUser(on, 'sel.scope.b@example.com');
    const assetId = await makeAsset();

    await on.db.insert(messages).values({
      conversationId: a.conversationId,
      sender: 'character',
      content: 'sent in A',
      mediaAssetId: assetId,
    });

    // Exhausted for A...
    expect(
      await selector()(on.db, {
        characterId: LUNA.id,
        conversationId: a.conversationId,
        requested: 'image',
      }),
    ).toBeNull();
    // ...but still fresh for B.
    expect(
      (await selector()(on.db, {
        characterId: LUNA.id,
        conversationId: b.conversationId,
        requested: 'image',
      }))!.assetId,
    ).toBe(assetId);
  });

  it('skips an asset whose file is missing and picks the next that exists', async () => {
    const user = await setupUser(on, 'sel.missing@example.com');
    const missing = await makeAsset({ writeFile: false });
    const present = await makeAsset();

    const chosen = await selector()(on.db, {
      characterId: LUNA.id,
      conversationId: user.conversationId,
      requested: 'image',
    });
    expect(chosen!.assetId).toBe(present);
    expect(chosen!.assetId).not.toBe(missing);
  });

  it('returns null when the only candidate has no file', async () => {
    const user = await setupUser(on, 'sel.nofile@example.com');
    await makeAsset({ writeFile: false });

    expect(
      await selector()(on.db, {
        characterId: LUNA.id,
        conversationId: user.conversationId,
        requested: 'image',
      }),
    ).toBeNull();
  });

  it('refuses an asset whose file resolves outside MEDIA_STORAGE_DIR', async () => {
    const user = await setupUser(on, 'sel.outside@example.com');
    await makeAsset({ dir: OUTSIDE_DIR });

    expect(
      await selector()(on.db, {
        characterId: LUNA.id,
        conversationId: user.conversationId,
        requested: 'image',
      }),
    ).toBeNull();
  });

  it('returns null when no eligible asset exists at all', async () => {
    const user = await setupUser(on, 'sel.none@example.com');
    expect(
      await selector()(on.db, {
        characterId: LUNA.id,
        conversationId: user.conversationId,
        requested: 'image',
      }),
    ).toBeNull();
  });

  it('is deterministic and advances: two asks give two different assets, oldest first', async () => {
    const user = await setupUser(on, 'sel.order@example.com');
    const first = await makeAsset();
    const second = await makeAsset();

    const a = await selector()(on.db, {
      characterId: LUNA.id,
      conversationId: user.conversationId,
      requested: 'image',
    });
    expect(a!.assetId).toBe(first); // oldest first, not random

    await on.db.insert(messages).values({
      conversationId: user.conversationId,
      sender: 'character',
      content: 'one',
      mediaAssetId: first,
    });

    const b = await selector()(on.db, {
      characterId: LUNA.id,
      conversationId: user.conversationId,
      requested: 'image',
    });
    expect(b!.assetId).toBe(second);
  });
});

/* ------------------------------------------------------------------ *
 * The send flow
 * ------------------------------------------------------------------ */

describe('send flow with media', () => {
  it('attaches an image when explicitly requested, as ONE character message', async () => {
    const user = await setupUser(on, 'flow.img@example.com');
    await makeAsset({ mediaType: 'image' });

    const res = await send(on, user.cookies, user.conversationId, 'send me a picture', 'image');
    expect(res.statusCode).toBe(201);
    const body = res.json();

    // Text is unaffected — the reply provider is still a plain string provider.
    expect(body.characterMessage.content.length).toBeGreaterThan(10);
    expect(body.characterMessage.media).toEqual({
      type: 'image',
      url: `/api/conversations/${user.conversationId}/messages/${body.characterMessage.id}/media`,
    });
    // The user's own message never carries media.
    expect('media' in body.userMessage).toBe(false);

    // Exactly two rows: text and media are the SAME message, not two.
    const rows = await on.db.select().from(messages);
    expect(rows).toHaveLength(2);
  });

  it('attaches a video when explicitly requested', async () => {
    const user = await setupUser(on, 'flow.vid@example.com');
    await makeAsset({ mediaType: 'video' });

    const res = await send(on, user.cookies, user.conversationId, 'send me a video', 'video');
    expect(res.json().characterMessage.media.type).toBe('video');
  });

  it('sends TEXT ONLY when requestMedia is omitted, even with eligible media present', async () => {
    const user = await setupUser(on, 'flow.none@example.com');
    await makeAsset({ mediaType: 'image' });

    const res = await send(on, user.cookies, user.conversationId, 'just chatting');
    const body = res.json();
    expect('media' in body.characterMessage).toBe(false);
    expect(Object.keys(body.characterMessage).sort()).toEqual([
      'content',
      'createdAt',
      'id',
      'sender',
    ]);
  });

  it('sends text only when the request asks for media that does not exist', async () => {
    const user = await setupUser(on, 'flow.mismatch@example.com');
    await makeAsset({ mediaType: 'image' }); // only an image exists

    const res = await send(on, user.cookies, user.conversationId, 'a video please', 'video');
    expect(res.statusCode).toBe(201);
    expect('media' in res.json().characterMessage).toBe(false);
  });

  it('never repeats an asset across turns in the same conversation', async () => {
    const user = await setupUser(on, 'flow.repeat@example.com');
    await makeAsset();

    const first = await send(on, user.cookies, user.conversationId, 'pic', 'image');
    expect(first.json().characterMessage.media).toBeDefined();

    const second = await send(on, user.cookies, user.conversationId, 'another', 'image');
    expect('media' in second.json().characterMessage).toBe(false);
  });

  it('the response never leaks storage keys, paths, provenance or asset ids', async () => {
    const user = await setupUser(on, 'flow.leak@example.com');
    const assetId = await makeAsset();

    const raw = (await send(on, user.cookies, user.conversationId, 'pic', 'image')).payload;
    expect(raw).not.toContain(assetId);
    expect(raw).not.toContain(STORAGE_DIR);
    expect(raw).not.toContain('storagePath');
    expect(raw).not.toContain('storageKey');
    expect(raw).not.toContain('provenance');
    expect(raw).not.toContain('/admin/');
  });

  it('rejects an invalid requestMedia value before any handler runs', async () => {
    const user = await setupUser(on, 'flow.bad@example.com');
    const res = await on.app.inject({
      method: 'POST',
      url: `/api/conversations/${user.conversationId}/messages`,
      payload: { content: 'hi', requestMedia: 'audio' },
      cookies: user.cookies,
    });
    expect(res.statusCode).toBe(400);
  });

  it('media is fetchable through the message-scoped route from commit 1', async () => {
    const user = await setupUser(on, 'flow.fetch@example.com');
    await makeAsset({ mediaType: 'image' });

    const body = (await send(on, user.cookies, user.conversationId, 'pic', 'image')).json();
    const res = await on.app.inject({
      method: 'GET',
      url: body.characterMessage.media.url,
      cookies: user.cookies,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.rawPayload.equals(PNG)).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * Feature flag
 * ------------------------------------------------------------------ */

describe('CHAT_MEDIA_ENABLED = false (production default)', () => {
  it('attaches NOTHING even when media is explicitly requested and eligible', async () => {
    const user = await setupUser(off, 'flag.off@example.com');
    await makeAsset({ mediaType: 'image' });

    const res = await send(off, user.cookies, user.conversationId, 'pic', 'image');
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect('media' in body.characterMessage).toBe(false);
    expect(Object.keys(body.characterMessage).sort()).toEqual([
      'content',
      'createdAt',
      'id',
      'sender',
    ]);
  });

  it('writes no media_asset_id at all', async () => {
    const user = await setupUser(off, 'flag.off2@example.com');
    await makeAsset({ mediaType: 'video' });
    await send(off, user.cookies, user.conversationId, 'vid', 'video');

    const rows = await off.db.select().from(messages);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.mediaAssetId === null)).toBe(true);
  });

  it('leaves ordinary chat byte-for-byte unchanged', async () => {
    const user = await setupUser(off, 'flag.off3@example.com');
    const res = await send(off, user.cookies, user.conversationId, 'hello');
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.userMessage.content).toBe('hello');
    expect(body.characterMessage.sender).toBe('character');
    expect('media' in body.characterMessage).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * Security
 * ------------------------------------------------------------------ */

describe('security', () => {
  it("another user cannot fetch media from someone else's conversation", async () => {
    const owner = await setupUser(on, 'sec.owner@example.com');
    const intruder = await setupUser(on, 'sec.intruder@example.com');
    await makeAsset();

    const body = (await send(on, owner.cookies, owner.conversationId, 'pic', 'image')).json();
    const url = body.characterMessage.media.url;

    expect((await on.app.inject({ method: 'GET', url, cookies: owner.cookies })).statusCode).toBe(200);
    expect(
      (await on.app.inject({ method: 'GET', url, cookies: intruder.cookies })).statusCode,
    ).toBe(404);
    expect((await on.app.inject({ method: 'GET', url })).statusCode).toBe(401);
  });

  it("a conversation can never attach another character's asset", async () => {
    // Luna's conversation, with ONLY an Ember asset available.
    const user = await setupUser(on, 'sec.cross@example.com');
    await makeAsset({ character: EMBER });

    const res = await send(on, user.cookies, user.conversationId, 'pic', 'image');
    expect('media' in res.json().characterMessage).toBe(false);

    const rows = await on.db.select().from(messages);
    expect(rows.every((r) => r.mediaAssetId === null)).toBe(true);
  });

  it('an explicit asset is never attached, even when it is the only candidate', async () => {
    const user = await setupUser(on, 'sec.explicit@example.com');
    await makeAsset({ contentRating: 'explicit' });

    const res = await send(on, user.cookies, user.conversationId, 'pic', 'image');
    expect('media' in res.json().characterMessage).toBe(false);
  });

  it('there is no asset-id-addressed route for chat media', async () => {
    const user = await setupUser(on, 'sec.route@example.com');
    const assetId = await makeAsset();
    await send(on, user.cookies, user.conversationId, 'pic', 'image');

    // The only admin path that serves this asset must still require admin.
    const byAssetId = await on.app.inject({
      method: 'GET',
      url: `/admin/content/uploads/${assetId}/file`,
      cookies: user.cookies,
    });
    expect(byAssetId.statusCode).toBe(403);
  });
});
