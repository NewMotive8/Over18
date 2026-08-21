import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { PublicCharacter } from '@over18/shared';
import { characterVisualAssets, messages } from '../db/schema.js';
import { SEED_CHARACTERS } from '../db/seed-data.js';
import { seedCharacters, seedVisualIdentities } from '../db/seed.js';
import { createVisualAsset } from '../services/visual-asset-service.js';
import { getActiveVisualIdentity } from '../services/visual-identity-service.js';
import type { ReplyContext } from '../services/character-reply.js';
import { createLlmReplyProvider } from '../services/llm-reply-provider.js';
import { buildLlmMessages, createPromptBuilder } from '../services/prompt-builder.js';
import type { LlmClient, LlmMessage, LlmRequest } from '../llm/types.js';
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
 * Media / reply consistency.
 *
 * The production defect these tests exist for: the person asked for a video,
 * the server selected and attached one, and the character replied
 * "If you want a video, the answer is still no."
 *
 * The mechanism was NOT a missing instruction. The instruction was present and
 * correct — it just sat at the top of the system message, while the model's own
 * earlier refusal, replayed out of the history window, was the last thing it
 * read before writing. The word "still" is the tell: the model was being
 * consistent with itself.
 *
 * WHAT THE MODEL HERE IS, AND IS NOT. No real LLM is exercised — that would be
 * non-deterministic and would need a live endpoint. Instead the stub below
 * reproduces the DIAGNOSED failure mode specifically: it resolves what to say
 * by scanning the prompt from the END backwards and obeying whichever it meets
 * first — an earlier refusal of its own, or the per-turn media instruction.
 *
 * That makes these real regression tests rather than tautologies. Against the
 * previous prompt layout (instruction inside the system message at index 0) the
 * refusal is always met first and every "does not refuse" assertion below
 * fails. They pass only because the instruction is now emitted after the
 * history. What they prove is the prompt *structure*, not model goodwill.
 */

const LUNA = SEED_CHARACTERS.find((c) => c.name === 'luna')!;
const STORAGE_DIR = testEnv.media.storageDir;

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

/** The exact production symptom, kept verbatim as the thing that must not recur. */
const PRODUCTION_SYMPTOM = 'If you want a video, the answer is still no.';

/** Anything that reads as a denial of having sent something. */
const REFUSAL =
  /\b(the answer is still no|answer is no|i don'?t send|i do not send|i won'?t send|i can'?t send|not sending|rather not|no\.?$)/i;

const MEDIA_INSTRUCTION_PREFIX = 'For THIS reply only';

/** Every prompt the provider was handed, newest last. */
const captured: LlmRequest[] = [];

const recencyBiasedClient: LlmClient = {
  async generate(request) {
    captured.push(request);
    for (let i = request.messages.length - 1; i >= 0; i--) {
      const message = request.messages[i]!;

      if (message.role === 'system' && message.content.startsWith(MEDIA_INSTRUCTION_PREFIX)) {
        if (message.content.includes('You have just sent them a short video')) {
          return "Fine — here's your video. Don't make me regret it.";
        }
        if (message.content.includes('You have just sent them a photo')) {
          return "Fine — here's your photo. Don't make me regret it.";
        }
        // The "asked, nothing eligible" branch. Deliberately about this moment
        // only, exactly as the instruction asks.
        return 'Not tonight. Ask me again sometime.';
      }

      // An earlier refusal of its own. Under the old layout this always won.
      if (message.role === 'assistant' && REFUSAL.test(message.content)) {
        return PRODUCTION_SYMPTOM;
      }
    }
    return 'Mm. Tell me more.';
  },
};

/** Composed exactly as selectReplyProvider composes production. */
const replyProvider = createLlmReplyProvider(
  recencyBiasedClient,
  { maxTokens: 400, temperature: 0.9 },
  createPromptBuilder(
    { maxHistoryMessages: 40, maxHistoryChars: 16_000 },
    { maxMemories: 10, maxMemoryChars: 2_000 },
  ),
);

let on: TestContext;

beforeAll(async () => {
  migrateTestDb();
  on = await createTestContext({ chatMediaEnabled: true, replyProvider });
});
afterAll(async () => destroyTestContext(on));
beforeEach(async () => {
  captured.length = 0;
  await truncateAll(on);
  await seedCharacters(on.db);
  await seedVisualIdentities(on.db);
});

async function makeAsset(mediaType: 'image' | 'video'): Promise<string> {
  const identity = (await getActiveVisualIdentity(on.db, LUNA.id))!;
  const asset = await createVisualAsset(on.db, {
    characterId: LUNA.id,
    visualIdentityId: identity.id,
    kind: 'generated',
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
    payload: { email, password: 'media-consistency-1' },
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

function send(
  user: { cookies: Record<string, string>; conversationId: string },
  content: string,
  requestMedia?: 'image' | 'video',
) {
  return on.app.inject({
    method: 'POST',
    url: `/api/conversations/${user.conversationId}/messages`,
    payload: requestMedia ? { content, requestMedia } : { content },
    cookies: user.cookies,
  });
}

/**
 * Plants a refusal already in the conversation — which is the real production
 * state: those lines exist in live conversations today and the history window
 * replays them for up to 40 messages.
 */
async function plantPriorRefusal(conversationId: string, text: string): Promise<void> {
  await on.db
    .insert(messages)
    .values({ conversationId, sender: 'user', content: 'send me something' });
  await on.db.insert(messages).values({ conversationId, sender: 'character', content: text });
}

/** The per-turn media instruction from the last prompt, or null. */
function lastMediaInstruction(): { index: number; content: string; total: number } | null {
  const request = captured.at(-1);
  if (!request) return null;
  const index = request.messages.findIndex(
    (m: LlmMessage) => m.role === 'system' && m.content.startsWith(MEDIA_INSTRUCTION_PREFIX),
  );
  if (index === -1) return null;
  return {
    index,
    content: request.messages[index]!.content,
    total: request.messages.length,
  };
}

/* ------------------------------------------------------------------ *
 * 1–2. A first request, with no history at all
 * ------------------------------------------------------------------ */

describe('a first media request', () => {
  it('1. attaches the image and the reply does not refuse or deny it', async () => {
    const user = await setupUser('consistency.first.image@example.com');
    await makeAsset('image');

    const message = (await send(user, 'send me a picture', 'image')).json().characterMessage;

    expect(message.media.type).toBe('image');
    expect(message.content).not.toMatch(REFUSAL);
    expect(message.content).not.toBe(PRODUCTION_SYMPTOM);
    expect(message.content.toLowerCase()).toContain('photo');
  });

  it('2. attaches the video and the reply does not refuse or deny it', async () => {
    const user = await setupUser('consistency.first.video@example.com');
    await makeAsset('video');

    const message = (await send(user, 'send me a video', 'video')).json().characterMessage;

    expect(message.media.type).toBe('video');
    expect(message.content).not.toMatch(REFUSAL);
    expect(message.content).not.toBe(PRODUCTION_SYMPTOM);
    expect(message.content.toLowerCase()).toContain('video');
  });
});

/* ------------------------------------------------------------------ *
 * 3–4. The reported bug: a refusal already sits in the history
 * ------------------------------------------------------------------ */

describe('a media request AFTER the character has already refused once', () => {
  it('3. attaches the image and does not repeat or continue the refusal', async () => {
    const user = await setupUser('consistency.after.image@example.com');
    await makeAsset('image');
    await plantPriorRefusal(user.conversationId, "I don't send pictures to guys I just met.");

    const message = (await send(user, 'go on, send me a picture', 'image')).json()
      .characterMessage;

    expect(message.media.type).toBe('image');
    expect(message.content).not.toMatch(REFUSAL);
    expect(message.content).not.toBe(PRODUCTION_SYMPTOM);

    // The refusal WAS replayed to the model — it just no longer wins.
    const replayed = captured
      .at(-1)!
      .messages.some((m: LlmMessage) => m.content.includes("I don't send pictures"));
    expect(replayed).toBe(true);
  });

  it('4. attaches the video and does not repeat or continue the refusal', async () => {
    const user = await setupUser('consistency.after.video@example.com');
    await makeAsset('video');
    await plantPriorRefusal(user.conversationId, PRODUCTION_SYMPTOM);

    const message = (await send(user, 'please, a video', 'video')).json().characterMessage;

    expect(message.media.type).toBe('video');
    expect(message.content).not.toMatch(REFUSAL);
    expect(message.content).not.toBe(PRODUCTION_SYMPTOM);
    expect(message.content.toLowerCase()).toContain('video');
  });
});

/* ------------------------------------------------------------------ *
 * 5–6. Follow-ups: the text must track the kind that was actually sent
 * ------------------------------------------------------------------ */

describe('follow-ups switch kind without contradicting themselves', () => {
  it('5. image then video: the second reply is consistent with a video', async () => {
    const user = await setupUser('consistency.image.then.video@example.com');
    await makeAsset('image');
    await makeAsset('video');

    const first = (await send(user, 'a picture?', 'image')).json().characterMessage;
    expect(first.media.type).toBe('image');

    const second = (await send(user, 'and a video?', 'video')).json().characterMessage;
    expect(second.media.type).toBe('video');
    expect(second.content).not.toMatch(REFUSAL);
    expect(second.content.toLowerCase()).toContain('video');
    expect(second.content.toLowerCase()).not.toContain('photo');
    expect(lastMediaInstruction()!.content).toContain('a short video');
  });

  it('6. video then image: the second reply is consistent with a photo', async () => {
    const user = await setupUser('consistency.video.then.image@example.com');
    await makeAsset('image');
    await makeAsset('video');

    const first = (await send(user, 'a video?', 'video')).json().characterMessage;
    expect(first.media.type).toBe('video');

    const second = (await send(user, 'now a picture?', 'image')).json().characterMessage;
    expect(second.media.type).toBe('image');
    expect(second.content).not.toMatch(REFUSAL);
    expect(second.content.toLowerCase()).toContain('photo');
    expect(second.content.toLowerCase()).not.toContain('video');
    expect(lastMediaInstruction()!.content).toContain('a photo');
  });
});

/* ------------------------------------------------------------------ *
 * 7. Asked for, but nothing eligible
 * ------------------------------------------------------------------ */

describe('requested media that does not exist', () => {
  it('7. answers in character, claims nothing was sent, and sets no standing rule', async () => {
    const user = await setupUser('consistency.unavailable@example.com');
    // Images exist; a video is asked for. Nothing eligible.
    await makeAsset('image');

    const res = await send(user, 'send me a video', 'video');
    const message = res.json().characterMessage;

    // Nothing attached, and nothing claiming otherwise.
    expect('media' in message).toBe(false);
    expect(message.content.toLowerCase()).not.toMatch(/here'?s (your|a) (video|photo)|just sent/);

    // The model WAS told, explicitly, rather than being left to guess.
    const instruction = lastMediaInstruction();
    expect(instruction).not.toBeNull();
    expect(instruction!.content).toContain('nothing is attached to this reply');
    expect(instruction!.content).toContain('Do not turn it into a rule about yourself');

    // ...and the guidance is about this moment, not a permanent trait, so it
    // cannot poison the next turn. Proof: the next request still succeeds.
    await makeAsset('video');
    const next = (await send(user, 'now?', 'video')).json().characterMessage;
    expect(next.media.type).toBe('video');
    expect(next.content).not.toMatch(REFUSAL);
  });

  it('7b. the deterministic fallback provider behaves the same way', async () => {
    const { deterministicReplyProvider } = await import('../services/character-reply.js');
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
      userMessage: 'send me a video',
    };

    const reply = await deterministicReplyProvider({
      ...base,
      requestedMediaUnavailable: 'video',
    });
    expect(reply.toLowerCase()).not.toContain("here's a");
    expect(reply.toLowerCase()).toContain('not right now');
    // "not right now" — never "I don't send those".
    expect(reply).not.toMatch(/i don'?t send|i never send/i);
  });
});

/* ------------------------------------------------------------------ *
 * 8. Ordinary conversation is untouched
 * ------------------------------------------------------------------ */

describe('an ordinary, non-media turn', () => {
  it('8. produces a prompt with no per-turn media instruction of any kind', async () => {
    const user = await setupUser('consistency.ordinary@example.com');
    await makeAsset('image'); // eligible media exists and is still not offered

    await send(user, 'hey, how was your day?');

    const request = captured.at(-1)!;
    expect(lastMediaInstruction()).toBeNull();
    expect(request.messages.map((m: LlmMessage) => m.role)).toEqual(['system', 'user']);
    expect(request.messages.every((m: LlmMessage) => !m.content.includes('For THIS reply only')))
      .toBe(true);
  });

  it('8b. the assembled array is byte-identical with the fields absent or null', () => {
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
      history: [
        { id: 'm1', sender: 'user', content: 'first', createdAt: 'x' },
        { id: 'm2', sender: 'character', content: 'second', createdAt: 'x' },
      ],
      priorMessageCount: 2,
      userMessage: 'newest',
    };

    const plain = buildLlmMessages(base);
    expect(buildLlmMessages({ ...base, sendingMedia: null })).toEqual(plain);
    expect(buildLlmMessages({ ...base, requestedMediaUnavailable: null })).toEqual(plain);
    expect(plain.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
  });
});

/* ------------------------------------------------------------------ *
 * 9. Position — the fix itself
 * ------------------------------------------------------------------ */

describe('where the per-turn instruction sits in the prompt', () => {
  it('9. comes AFTER the conversation history and immediately before the new message', async () => {
    const user = await setupUser('consistency.position@example.com');
    await makeAsset('video');
    await plantPriorRefusal(user.conversationId, PRODUCTION_SYMPTOM);

    await send(user, 'send me a video', 'video');

    const request = captured.at(-1)!;
    const instruction = lastMediaInstruction()!;

    // Second-to-last: the newest user message is the only thing after it.
    expect(instruction.index).toBe(instruction.total - 2);
    expect(request.messages.at(-1)).toEqual({ role: 'user', content: 'send me a video' });

    // Strictly later than every replayed history message, including the refusal.
    const refusalIndex = request.messages.findIndex(
      (m: LlmMessage) => m.content === PRODUCTION_SYMPTOM,
    );
    expect(refusalIndex).toBeGreaterThan(-1);
    expect(instruction.index).toBeGreaterThan(refusalIndex);

    // And it is not in the character block, where it used to live.
    expect(request.messages[0]!.content).not.toContain('For THIS reply only');
  });

  it('9b. explicitly overrides an earlier refusal for this turn', async () => {
    const user = await setupUser('consistency.override@example.com');
    await makeAsset('image');

    await send(user, 'a picture please', 'image');

    const content = lastMediaInstruction()!.content;
    expect(content).toContain('overrides anything you said earlier in this conversation');
    expect(content).toMatch(/do not refuse, deny, dodge/i);
    // ...while leaving the character's manner entirely their own.
    expect(content).toContain('Shy, teasing, playful, reluctant, smug, quiet');
  });
});
