import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import {
  deriveMediaContext,
  detectMediaRequest,
  type ChatMessage,
  type PublicCharacter,
} from '@over18/shared';
import { characterVisualAssets, messages } from '../db/schema.js';
import { SEED_CHARACTERS } from '../db/seed-data.js';
import { seedCharacters, seedVisualIdentities } from '../db/seed.js';
import { createVisualAsset } from '../services/visual-asset-service.js';
import { getActiveVisualIdentity } from '../services/visual-identity-service.js';
import { deterministicReplyProvider, type ReplyContext } from '../services/character-reply.js';
import { buildCharacterSystemPrompt, buildLlmMessages } from '../services/prompt-builder.js';
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
 * Character Media Messages — end-to-end POC.
 *
 * Covers the loop the first production test failed at: the person asks in
 * plain words, the client turns that into an explicit flag, the server picks
 * an eligible asset, and the reply TEXT agrees with the attachment instead of
 * refusing it.
 */

const LUNA = SEED_CHARACTERS.find((c) => c.name === 'luna')!;
const STORAGE_DIR = testEnv.media.storageDir;

let on: TestContext;

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
});
afterAll(async () => destroyTestContext(on));
beforeEach(async () => {
  await truncateAll(on);
  await seedCharacters(on.db);
  await seedVisualIdentities(on.db);
});

async function makeAsset(mediaType: 'image' | 'video'): Promise<string> {
  const identity = (await getActiveVisualIdentity(on.db, LUNA.id))!;
  const asset = await createVisualAsset(on.db, {
    characterId: LUNA.id,
    visualIdentityId: identity.id,
    /**
     * CHAT CONTENT.
     *
     * These fixtures exist to be SENT IN A CONVERSATION, which since Phase 2
     * means `kind: 'chat'` — the selector's pool. They were `'generated'` while
     * chat media and Regular content were the same rows; the assertions below
     * are unchanged, only the shelf the fixture belongs to is now stated.
     */
    kind: 'chat',
    status: 'approved',
    contentRating: 'sfw',
  });
  const dir = join(STORAGE_DIR, LUNA.id, 'uploads');
  mkdirSync(dir, { recursive: true });
  const storagePath = join(dir, `${asset.id}.${mediaType === 'video' ? 'mp4' : 'png'}`);
  writeFileSync(storagePath, mediaType === 'video' ? MP4 : PNG);
  await on.db
    .update(characterVisualAssets)
    .set({
      storageKey: `/admin/content/uploads/${asset.id}/file`,
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

async function setupUser(email: string) {
  const reg = await on.app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email, password: 'media-poc-pass1' },
  });
  const c = extractSessionCookie(reg)!;
  const cookies = { [c.name]: c.value };
  const conv = await on.app.inject({
    method: 'POST',
    url: '/api/conversations',
    payload: { characterId: LUNA.id },
    cookies,
  });
  return { cookies, conversationId: conv.json().id as string };
}

async function history(
  cookies: Record<string, string>,
  conversationId: string,
): Promise<ChatMessage[]> {
  const res = await on.app.inject({
    method: 'GET',
    url: `/api/conversations/${conversationId}/messages`,
    cookies,
  });
  return res.json() as ChatMessage[];
}

/**
 * Sends exactly the way the real client does: read the conversation, derive
 * media context from it, detect against the typed text, and put whatever comes
 * out on the wire. No hand-set flag — so these exercise detection, context
 * derivation and the send flow together, including follow-ups.
 */
async function sendAsClient(
  cookies: Record<string, string>,
  conversationId: string,
  content: string,
) {
  const context = deriveMediaContext(await history(cookies, conversationId));
  const requestMedia = detectMediaRequest(content, context);
  return on.app.inject({
    method: 'POST',
    url: `/api/conversations/${conversationId}/messages`,
    payload: requestMedia ? { content, requestMedia } : { content },
    cookies,
  });
}

/* ------------------------------------------------------------------ *
 * End-to-end, driven by the user's own words
 * ------------------------------------------------------------------ */

describe('POC: plain-language request attaches media', () => {
  it('"Can you send me a picture of you?" attaches an image', async () => {
    const user = await setupUser('poc.img@example.com');
    const assetId = await makeAsset('image');

    const res = await sendAsClient(user.cookies, user.conversationId, 'Can you send me a picture of you?');
    expect(res.statusCode).toBe(201);
    const message = res.json().characterMessage;

    expect(message.media).toEqual({
      type: 'image',
      url: `/api/conversations/${user.conversationId}/messages/${message.id}/media`,
    });

    // The asset really is the one attached, and it is fetchable.
    const [row] = await on.db.select().from(messages).where(eq(messages.id, message.id));
    expect(row!.mediaAssetId).toBe(assetId);
    const file = await on.app.inject({
      method: 'GET',
      url: message.media.url,
      cookies: user.cookies,
    });
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toBe('image/png');
  });

  it('"can you send me a video?" attaches a video', async () => {
    const user = await setupUser('poc.vid@example.com');
    await makeAsset('video');

    const res = await sendAsClient(user.cookies, user.conversationId, 'can you send me a video?');
    expect(res.json().characterMessage.media.type).toBe('video');
  });

  it('an image request never picks a video, and vice versa', async () => {
    const user = await setupUser('poc.kind@example.com');
    await makeAsset('image');
    await makeAsset('video');

    const img = await sendAsClient(user.cookies, user.conversationId, 'send me a picture');
    expect(img.json().characterMessage.media.type).toBe('image');

    const vid = await sendAsClient(user.cookies, user.conversationId, 'send me a video');
    expect(vid.json().characterMessage.media.type).toBe('video');
  });

  it('an ordinary message attaches nothing, even with eligible assets present', async () => {
    const user = await setupUser('poc.plain@example.com');
    await makeAsset('image');
    await makeAsset('video');

    const res = await sendAsClient(user.cookies, user.conversationId, 'how are you tonight?');
    expect(res.statusCode).toBe(201);
    expect('media' in res.json().characterMessage).toBe(false);
  });

  it('handles "asked but nothing eligible" as an ordinary text turn', async () => {
    const user = await setupUser('poc.none@example.com');
    // No assets at all.
    const res = await sendAsClient(user.cookies, user.conversationId, 'send me a picture');

    expect(res.statusCode).toBe(201);
    const message = res.json().characterMessage;
    expect('media' in message).toBe(false);
    expect(message.content.length).toBeGreaterThan(0); // a real reply, not empty
    const [row] = await on.db.select().from(messages).where(eq(messages.id, message.id));
    expect(row!.mediaAssetId).toBeNull(); // no dangling reference
  });

  it('does not repeat an asset, and degrades to text when exhausted', async () => {
    const user = await setupUser('poc.repeat@example.com');
    await makeAsset('image');

    const first = await sendAsClient(user.cookies, user.conversationId, 'send me a picture');
    expect(first.json().characterMessage.media).toBeDefined();

    const second = await sendAsClient(user.cookies, user.conversationId, 'send me another picture');
    expect('media' in second.json().characterMessage).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * Conversational follow-ups, driven by real conversation history
 * ------------------------------------------------------------------ */

describe('POC: follow-up requests', () => {
  it('"what about a video?" after a picture sends a video', async () => {
    const user = await setupUser('poc.follow.switch@example.com');
    await makeAsset('image');
    await makeAsset('video');

    const first = await sendAsClient(user.cookies, user.conversationId, 'send me a picture');
    expect(first.json().characterMessage.media.type).toBe('image');

    const second = await sendAsClient(user.cookies, user.conversationId, 'what about a video?');
    expect(second.json().characterMessage.media.type).toBe('video');
  });

  it('"send me another one" after a picture sends another picture', async () => {
    const user = await setupUser('poc.follow.another@example.com');
    await makeAsset('image');
    await makeAsset('image');

    const first = await sendAsClient(user.cookies, user.conversationId, 'send me a picture');
    const second = await sendAsClient(user.cookies, user.conversationId, 'send me another one');

    expect(second.json().characterMessage.media.type).toBe('image');
    // A different asset — the no-repeat rule still holds across the follow-up.
    const rows = await on.db.select().from(messages);
    const attached = rows.map((r) => r.mediaAssetId).filter(Boolean);
    expect(attached).toHaveLength(2);
    expect(new Set(attached).size).toBe(2);
    expect(first.json().characterMessage.media.url).not.toBe(
      second.json().characterMessage.media.url,
    );
  });

  it('"another picture?" works as a follow-up', async () => {
    const user = await setupUser('poc.follow.noun@example.com');
    await makeAsset('image');
    await makeAsset('image');

    await sendAsClient(user.cookies, user.conversationId, 'send me a picture');
    const second = await sendAsClient(user.cookies, user.conversationId, 'another picture?');
    expect(second.json().characterMessage.media.type).toBe('image');
  });

  it('"show me a different photo" works as a direct request', async () => {
    const user = await setupUser('poc.follow.different@example.com');
    await makeAsset('image');
    await makeAsset('image');

    await sendAsClient(user.cookies, user.conversationId, 'send me a picture');
    const second = await sendAsClient(
      user.cookies,
      user.conversationId,
      'show me a different photo',
    );
    expect(second.json().characterMessage.media.type).toBe('image');
  });

  it('a follow-up after ordinary chat in between still resolves', async () => {
    const user = await setupUser('poc.follow.gap@example.com');
    await makeAsset('image');
    await makeAsset('image');

    await sendAsClient(user.cookies, user.conversationId, 'send me a picture');
    await sendAsClient(user.cookies, user.conversationId, 'nice, thank you');
    const third = await sendAsClient(user.cookies, user.conversationId, 'another one?');
    expect(third.json().characterMessage.media.type).toBe('image');
  });

  it('a follow-up with NO prior media attaches nothing', async () => {
    const user = await setupUser('poc.follow.cold@example.com');
    await makeAsset('image');

    // Cold open — "another one?" refers to nothing.
    const res = await sendAsClient(user.cookies, user.conversationId, 'another one?');
    expect(res.statusCode).toBe(201);
    expect('media' in res.json().characterMessage).toBe(false);
  });

  it('ordinary conversation after media attaches nothing', async () => {
    const user = await setupUser('poc.follow.plain@example.com');
    await makeAsset('image');
    await makeAsset('image');

    await sendAsClient(user.cookies, user.conversationId, 'send me a picture');
    for (const text of ['tell me more', 'what about you?', 'how was your day?']) {
      const res = await sendAsClient(user.cookies, user.conversationId, text);
      expect('media' in res.json().characterMessage).toBe(false);
    }
  });

  it('a negated follow-up attaches nothing', async () => {
    const user = await setupUser('poc.follow.negated@example.com');
    await makeAsset('image');
    await makeAsset('image');

    await sendAsClient(user.cookies, user.conversationId, 'send me a picture');
    const res = await sendAsClient(user.cookies, user.conversationId, "don't send another one");
    expect('media' in res.json().characterMessage).toBe(false);
  });

  it('switches back and forth between image and video', async () => {
    const user = await setupUser('poc.follow.pingpong@example.com');
    await makeAsset('image');
    await makeAsset('video');

    const a = await sendAsClient(user.cookies, user.conversationId, 'send me a picture');
    expect(a.json().characterMessage.media.type).toBe('image');

    const b = await sendAsClient(user.cookies, user.conversationId, 'what about a video?');
    expect(b.json().characterMessage.media.type).toBe('video');

    // Back to image — but both assets are now used, so it degrades to text
    // rather than repeating one. The no-repeat rule outranks the follow-up.
    const c = await sendAsClient(user.cookies, user.conversationId, 'how about a picture?');
    expect('media' in c.json().characterMessage).toBe(false);
  });

  it('a follow-up whose kind has no eligible asset degrades to text', async () => {
    const user = await setupUser('poc.follow.nokind@example.com');
    await makeAsset('image'); // images only

    await sendAsClient(user.cookies, user.conversationId, 'send me a picture');
    const res = await sendAsClient(user.cookies, user.conversationId, 'what about a video?');
    expect(res.statusCode).toBe(201);
    expect('media' in res.json().characterMessage).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * The reply must not contradict the attachment
 * ------------------------------------------------------------------ */

describe('POC: the text agrees with the action', () => {
  const character: PublicCharacter = {
    id: LUNA.id,
    name: LUNA.name,
    displayName: LUNA.displayName,
    profileImage: null,
    shortBio: LUNA.shortBio,
    personality: LUNA.personality,
    interests: LUNA.interests as string[],
    conversationStyle: LUNA.conversationStyle,
  };
  const base: ReplyContext = {
    character,
    systemPrompt: LUNA.systemPrompt,
    history: [],
    priorMessageCount: 0,
    userMessage: 'send me a picture',
  };

  // The per-turn instruction moved OUT of the system message and is now
  // emitted after the history (see media-reply-consistency.test.ts), so these
  // assert on the assembled prompt rather than on the character block.
  const assembled = (overrides: Partial<ReplyContext>) =>
    buildLlmMessages({ ...base, ...overrides })
      .map((m) => m.content)
      .join('\n\n');

  it('the prompt tells the model an attachment is already committed', () => {
    const prompt = assembled({ sendingMedia: 'image' });
    expect(prompt).toContain('You have just sent them a photo of yourself');
    expect(prompt).toContain('already see it');
    // The instruction that fixes the observed refusal.
    expect(prompt).toMatch(/do not refuse/i);
  });

  it('says video when a video is being sent', () => {
    expect(assembled({ sendingMedia: 'video' })).toContain('a short video');
  });

  it('adds NOTHING to the prompt on an ordinary turn', () => {
    const plain = assembled({});
    expect(plain).not.toContain('You have just sent them');
    expect(plain).not.toContain('For THIS reply only');
    // Byte-identical whether the field is absent or explicitly null.
    expect(assembled({ sendingMedia: null })).toBe(plain);
    // ...and the character block itself never carries per-turn media text.
    expect(buildCharacterSystemPrompt({ ...base, sendingMedia: 'image' })).toBe(
      buildCharacterSystemPrompt(base),
    );
  });

  it('never leaks an asset id, path or url into the prompt', () => {
    const prompt = assembled({ sendingMedia: 'image' });
    expect(prompt).not.toContain('/api/');
    expect(prompt).not.toContain('/admin/');
    expect(prompt).not.toContain(STORAGE_DIR);
    expect(prompt.toLowerCase()).not.toContain('asset');
    expect(prompt.toLowerCase()).not.toContain('storage');
  });

  it('the deterministic provider agrees with the attachment instead of refusing', async () => {
    const image = await deterministicReplyProvider({ ...base, sendingMedia: 'image' });
    expect(image.toLowerCase()).toContain('picture');
    expect(image.toLowerCase()).not.toMatch(/don'?t send|can'?t send|won'?t send|rather not/);

    const video = await deterministicReplyProvider({ ...base, sendingMedia: 'video' });
    expect(video.toLowerCase()).toContain('video');
  });

  it('the deterministic provider is unchanged on an ordinary turn', async () => {
    const before = await deterministicReplyProvider(base);
    const withNull = await deterministicReplyProvider({ ...base, sendingMedia: null });
    expect(withNull).toBe(before);
    expect(before.toLowerCase()).not.toContain("here's a picture");
  });

  it('selection happens BEFORE the reply, so the provider is told what is attached', async () => {
    const user = await setupUser('poc.order@example.com');
    await makeAsset('image');

    // A provider that records what it was told, and would refuse if told nothing.
    const seen: Array<'image' | 'video' | null | undefined> = [];
    const ctx = await createTestContext({
      chatMediaEnabled: true,
      replyProvider: (context) => {
        seen.push(context.sendingMedia);
        return context.sendingMedia
          ? 'Here you go.'
          : "I don't send pics to guys I haven't met yet.";
      },
    });
    try {
      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/conversations/${user.conversationId}/messages`,
        payload: { content: 'send me a picture', requestMedia: 'image' },
        cookies: user.cookies,
      });
      expect(res.statusCode).toBe(201);
      expect(seen).toEqual(['image']); // told BEFORE it wrote
      const message = res.json().characterMessage;
      expect(message.content).toBe('Here you go.');
      expect(message.media.type).toBe('image');
    } finally {
      await destroyTestContext(ctx);
    }
  });
});
