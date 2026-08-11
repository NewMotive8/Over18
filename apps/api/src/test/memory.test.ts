import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PublicCharacter } from '@over18/shared';
import { memories, messages } from '../db/schema.js';
import { SEED_CHARACTERS } from '../db/seed-data.js';
import { seedCharacters } from '../db/seed.js';
import type { Env } from '../env.js';
import { LlmError, type LlmClient, type LlmRequest } from '../llm/types.js';
import type { ReplyContext } from '../services/character-reply.js';
import { createLlmReplyProvider, selectReplyProvider } from '../services/llm-reply-provider.js';
import {
  createLlmMemoryExtractor,
  deterministicMemoryExtractor,
  noopMemoryExtractor,
  parseExtractedFacts,
  selectMemoryExtractor,
  type MemoryExtractor,
} from '../services/memory-extractor.js';
import {
  listMemories,
  MEMORY_MAX_CONTENT_LENGTH,
  normalizeFact,
  storeMemories,
} from '../services/memory-service.js';
import {
  buildCharacterSystemPrompt,
  createPromptBuilder,
  selectMemoriesForPrompt,
} from '../services/prompt-builder.js';
import { sendMessage } from '../services/message-service.js';
import { testEnv } from './helpers.js';
import {
  createTestContext,
  destroyTestContext,
  extractSessionCookie,
  migrateTestDb,
  truncateAll,
  type TestContext,
} from './helpers.js';

const LUNA = SEED_CHARACTERS.find((c) => c.name === 'luna')!;
const EMBER = SEED_CHARACTERS.find((c) => c.name === 'ember')!;

function publicCharacter(seed: (typeof SEED_CHARACTERS)[number]): PublicCharacter {
  return {
    id: seed.id,
    name: seed.name,
    displayName: seed.displayName,
    profileImage: seed.profileImage ?? null,
    shortBio: seed.shortBio,
    personality: seed.personality,
    interests: seed.interests as string[],
    conversationStyle: seed.conversationStyle,
  };
}

function contextFor(
  seed: (typeof SEED_CHARACTERS)[number],
  overrides: Partial<ReplyContext> = {},
): ReplyContext {
  return {
    character: publicCharacter(seed),
    systemPrompt: seed.systemPrompt,
    history: [],
    priorMessageCount: 0,
    userMessage: 'Hello there!',
    ...overrides,
  };
}

/** Fake in-memory LlmClient — captures requests, returns or throws on demand. */
function createFakeClient() {
  const captured: LlmRequest[] = [];
  let behavior: { reply: string } | { error: LlmError } = { reply: 'A fake in-character reply.' };
  const client: LlmClient = {
    async generate(request) {
      captured.push(request);
      if ('error' in behavior) throw behavior.error;
      return behavior.reply;
    },
  };
  return {
    client,
    captured,
    setReply: (reply: string) => (behavior = { reply }),
    setError: (error: LlmError) => (behavior = { error }),
  };
}

// ───────────────────────── pure units: bounds, injection, extraction ─────

describe('selectMemoriesForPrompt (memory bounds)', () => {
  it('keeps everything when within budgets, in original order', () => {
    const facts = ['Their name is Maya.', 'They live in Haifa.'];
    expect(selectMemoriesForPrompt(facts, { maxMemories: 10, maxMemoryChars: 2000 })).toEqual(
      facts,
    );
  });

  it('prefers the NEWEST facts under the count budget, output stays chronological', () => {
    const facts = ['oldest', 'middle', 'newest'];
    expect(selectMemoriesForPrompt(facts, { maxMemories: 2, maxMemoryChars: 2000 })).toEqual([
      'middle',
      'newest',
    ]);
  });

  it('respects the character budget with whole facts only', () => {
    const facts = ['a'.repeat(10), 'b'.repeat(10), 'c'.repeat(10)];
    expect(selectMemoriesForPrompt(facts, { maxMemories: 10, maxMemoryChars: 20 })).toEqual([
      'b'.repeat(10),
      'c'.repeat(10),
    ]);
  });

  it('is deterministic: same inputs, same selection', () => {
    const facts = ['one', 'two', 'three', 'four'];
    const a = selectMemoriesForPrompt(facts, { maxMemories: 3, maxMemoryChars: 12 });
    const b = selectMemoriesForPrompt(facts, { maxMemories: 3, maxMemoryChars: 12 });
    expect(a).toEqual(b);
  });
});

describe('prompt injection of memories (US-12)', () => {
  it('renders remembered facts inside the system prompt', () => {
    const prompt = buildCharacterSystemPrompt(
      contextFor(LUNA, { memories: ['Their name is Maya.', 'They live in Haifa.'] }),
    );
    expect(prompt).toContain('Things you remember about this person');
    expect(prompt).toContain('- Their name is Maya.');
    expect(prompt).toContain('- They live in Haifa.');
    expect(prompt).toContain('Never recite this list');
  });

  it('omits the memory section entirely when there are no memories', () => {
    for (const context of [contextFor(LUNA), contextFor(LUNA, { memories: [] })]) {
      expect(buildCharacterSystemPrompt(context)).not.toContain(
        'Things you remember about this person',
      );
    }
  });

  it('keeps US-09 persona and conduct rules intact alongside memories', () => {
    const prompt = buildCharacterSystemPrompt(contextFor(LUNA, { memories: ['A fact.'] }));
    expect(prompt).toContain('You are Luna.');
    expect(prompt).toContain(LUNA.systemPrompt);
    expect(prompt).toContain('Always stay in character as Luna.');
  });

  it('createPromptBuilder bounds injected memories and leaves history/user message alone', () => {
    const build = createPromptBuilder(
      { maxHistoryMessages: 40, maxHistoryChars: 16_000 },
      { maxMemories: 2, maxMemoryChars: 2000 },
    );
    const llmMessages = build(
      contextFor(LUNA, {
        memories: ['oldest fact', 'middle fact', 'newest fact'],
        history: [
          { id: '1', sender: 'user', content: 'hi', createdAt: '2026-01-01T00:00:00Z' },
          { id: '2', sender: 'character', content: 'hey', createdAt: '2026-01-01T00:00:01Z' },
        ],
        userMessage: 'What do you remember?',
      }),
    );
    const system = llmMessages[0]!;
    expect(system.role).toBe('system');
    expect(system.content).not.toContain('oldest fact'); // over the count budget
    expect(system.content).toContain('middle fact');
    expect(system.content).toContain('newest fact');
    // US-10 window and message layout untouched by memory injection.
    expect(llmMessages.slice(1).map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(llmMessages.at(-1)!.content).toBe('What do you remember?');
  });
});

describe('deterministic development extractor', () => {
  const extract = (userMessage: string) =>
    deterministicMemoryExtractor({ character: publicCharacter(LUNA), userMessage }) as string[];

  it('extracts multiple durable facts from one message', () => {
    const facts = extract('Hi! My name is Maya and I live in Haifa. I have a dog named Rex.');
    expect(facts).toContain('Their name is Maya.');
    expect(facts).toContain('They live in Haifa.');
    expect(facts).toContain('They have a dog named Rex.');
  });

  it('extracts job, age, favorite, and family facts', () => {
    expect(extract('I work as a nurse these days')).toContain('They work as a nurse.');
    expect(extract("I'm 29 years old, by the way")).toContain('They are 29 years old.');
    expect(extract('my favorite color is turquoise!')).toContain(
      'Their favorite color is turquoise.',
    );
    expect(extract("My sister's name is Dana")).toContain('Their sister is named Dana.');
  });

  it('extracts nothing from small talk (favors precision over recall)', () => {
    expect(extract('lol ok, how are the stars tonight?')).toEqual([]);
    expect(extract('tell me something interesting')).toEqual([]);
  });

  it('rejects name-like captures that are not proper names', () => {
    // "annoying" is not a capitalized proper name — no fact invented.
    expect(extract('my sister is annoying')).toEqual([]);
  });

  it('is deterministic: same message, same facts', () => {
    const message = 'My name is Maya and I live in Haifa.';
    expect(extract(message)).toEqual(extract(message));
  });
});

describe('LLM-backed extractor (fake/injected client)', () => {
  it('sends extraction instructions + the user message, at temperature 0', async () => {
    const fake = createFakeClient();
    fake.setReply('- Their name is Maya.\n- They live in Haifa.');
    const extractor = createLlmMemoryExtractor(fake.client);
    const facts = await extractor({
      character: publicCharacter(LUNA),
      userMessage: 'My name is Maya and I live in Haifa.',
    });
    expect(facts).toEqual(['Their name is Maya.', 'They live in Haifa.']);
    expect(fake.captured).toHaveLength(1);
    const request = fake.captured[0]!;
    expect(request.temperature).toBe(0);
    expect(request.messages.map((m) => m.role)).toEqual(['system', 'user']);
    expect(request.messages[0]!.content).toContain('durable personal facts');
    expect(request.messages[1]!.content).toBe('My name is Maya and I live in Haifa.');
  });

  it('returns no facts for a NONE response', async () => {
    const fake = createFakeClient();
    fake.setReply('NONE');
    const extractor = createLlmMemoryExtractor(fake.client);
    await expect(
      extractor({ character: publicCharacter(LUNA), userMessage: 'hi there' }),
    ).resolves.toEqual([]);
  });

  it('parses messy model output defensively (bullets, dupes, blanks, overlong, cap)', () => {
    const messy = [
      '- Their name is Maya.',
      '',
      '* Their name is Maya.', // duplicate, different bullet
      '• They live in Haifa.',
      `- ${'x'.repeat(MEMORY_MAX_CONTENT_LENGTH + 1)}`, // overlong — dropped
      '- Fact three.',
      '- Fact four.',
      '- Fact five.',
      '- Fact six — beyond the per-exchange cap.',
    ].join('\n');
    const facts = parseExtractedFacts(messy);
    expect(facts).toEqual([
      'Their name is Maya.',
      'They live in Haifa.',
      'Fact three.',
      'Fact four.',
      'Fact five.',
    ]);
  });

  it('propagates client failures as LlmError (isolation happens in the caller)', async () => {
    const fake = createFakeClient();
    fake.setError(new LlmError('timeout', 'extraction timed out'));
    const extractor = createLlmMemoryExtractor(fake.client);
    await expect(
      extractor({ character: publicCharacter(LUNA), userMessage: 'My name is Maya.' }),
    ).rejects.toBeInstanceOf(LlmError);
  });

  it('selectMemoryExtractor mirrors reply-provider selection', () => {
    expect(selectMemoryExtractor(testEnv)).toBe(deterministicMemoryExtractor); // dev, no LLM
    expect(selectMemoryExtractor({ ...testEnv, isProduction: true })).toBe(noopMemoryExtractor);
    const withLlm = selectMemoryExtractor({
      ...testEnv,
      llm: {
        provider: 'openai-compatible',
        baseUrl: 'http://127.0.0.1:9',
        model: 'test-model',
        timeoutMs: 1000,
        maxTokens: 64,
        temperature: 0,
        contextMaxMessages: 40,
        contextMaxChars: 16_000,
      },
    });
    expect(withLlm).not.toBe(deterministicMemoryExtractor);
    expect(withLlm).not.toBe(noopMemoryExtractor);
  });
});

// ───────────────────────── storage service against the database ─────────

describe('memory storage service (schema, persistence, dedup, isolation)', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    migrateTestDb();
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  beforeEach(async () => {
    await truncateAll(ctx);
    await seedCharacters(ctx.db);
  });

  async function registerUser(email: string): Promise<string> {
    const reg = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email, password: 'memory-test-pass1' },
    });
    return reg.json().id as string;
  }

  it('persists facts in the memories table, separate from raw messages', async () => {
    const userId = await registerUser('mem.store@example.com');
    const inserted = await storeMemories(ctx.db, userId, LUNA.id, ['Their name is Maya.']);
    expect(inserted).toBe(1);

    const rows = await ctx.db.select().from(memories);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.content).toBe('Their name is Maya.');
    expect(rows[0]!.userId).toBe(userId);
    expect(rows[0]!.characterId).toBe(LUNA.id);
    // Stored separately: no message rows were created by storing memories.
    expect(await ctx.db.select().from(messages)).toHaveLength(0);
  });

  it('normalizes facts and rejects empty/overlong content', async () => {
    expect(normalizeFact('  Their   name is\n Maya.  ')).toBe('Their name is Maya.');
    expect(normalizeFact('   ')).toBeNull();
    expect(normalizeFact('x'.repeat(MEMORY_MAX_CONTENT_LENGTH + 1))).toBeNull();

    const userId = await registerUser('mem.norm@example.com');
    const inserted = await storeMemories(ctx.db, userId, LUNA.id, [
      '  Their   name is Maya. ',
      '',
      'y'.repeat(MEMORY_MAX_CONTENT_LENGTH + 1),
    ]);
    expect(inserted).toBe(1);
    expect(await listMemories(ctx.db, userId, LUNA.id)).toEqual(['Their name is Maya.']);
  });

  it('deduplicates: an identical fact is stored once, across batches and calls', async () => {
    const userId = await registerUser('mem.dedup@example.com');
    const first = await storeMemories(ctx.db, userId, LUNA.id, [
      'They live in Haifa.',
      'They live   in Haifa.', // same fact after normalization
    ]);
    expect(first).toBe(1);
    const second = await storeMemories(ctx.db, userId, LUNA.id, ['They live in Haifa.']);
    expect(second).toBe(0); // ON CONFLICT DO NOTHING — silent no-op
    expect(await listMemories(ctx.db, userId, LUNA.id)).toEqual(['They live in Haifa.']);
  });

  it('isolates memories per user AND per character', async () => {
    const alice = await registerUser('mem.alice@example.com');
    const bob = await registerUser('mem.bob@example.com');
    await storeMemories(ctx.db, alice, LUNA.id, ['Alice told Luna this.']);
    await storeMemories(ctx.db, alice, EMBER.id, ['Alice told Ember this.']);
    await storeMemories(ctx.db, bob, LUNA.id, ['Bob told Luna this.']);

    expect(await listMemories(ctx.db, alice, LUNA.id)).toEqual(['Alice told Luna this.']);
    expect(await listMemories(ctx.db, alice, EMBER.id)).toEqual(['Alice told Ember this.']);
    expect(await listMemories(ctx.db, bob, LUNA.id)).toEqual(['Bob told Luna this.']);
    expect(await listMemories(ctx.db, bob, EMBER.id)).toEqual([]);
  });

  it('retrieves facts oldest-first', async () => {
    const userId = await registerUser('mem.order@example.com');
    await storeMemories(ctx.db, userId, LUNA.id, ['first fact']);
    await storeMemories(ctx.db, userId, LUNA.id, ['second fact']);
    await storeMemories(ctx.db, userId, LUNA.id, ['third fact']);
    expect(await listMemories(ctx.db, userId, LUNA.id)).toEqual([
      'first fact',
      'second fact',
      'third fact',
    ]);
  });

  it('enforces the storage cap by evicting the oldest facts', async () => {
    const userId = await registerUser('mem.cap@example.com');
    for (const fact of ['one', 'two', 'three', 'four', 'five']) {
      await storeMemories(ctx.db, userId, LUNA.id, [fact], 3);
    }
    expect(await listMemories(ctx.db, userId, LUNA.id)).toEqual(['three', 'four', 'five']);
  });
});

// ───────────────────────── full flow through the API ─────────────────────

describe('memory through the API (extraction → storage → injection)', () => {
  let ctx: TestContext;
  const fakeReply = createFakeClient();

  beforeAll(async () => {
    migrateTestDb();
    // Real reply pipeline shape: LLM reply provider (fake client, captures the
    // exact prompts sent to the "model") + deterministic extractor.
    ctx = await createTestContext({
      replyProvider: createLlmReplyProvider(fakeReply.client, { maxTokens: 256, temperature: 0.7 }),
      memoryExtractor: deterministicMemoryExtractor,
    });
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  beforeEach(async () => {
    await truncateAll(ctx);
    await seedCharacters(ctx.db);
    fakeReply.captured.length = 0;
    fakeReply.setReply('A fake in-character reply.');
  });

  async function setup(email: string, characterId: string = LUNA.id) {
    const reg = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email, password: 'memory-flow-pass1' },
    });
    const cookie = extractSessionCookie(reg)!;
    const cookies = { [cookie.name]: cookie.value };
    const conv = await ctx.app.inject({
      method: 'POST',
      url: '/api/conversations',
      payload: { characterId },
      cookies,
    });
    return {
      userId: reg.json().id as string,
      cookies,
      conversationId: conv.json().id as string,
    };
  }

  function send(cookies: Record<string, string>, conversationId: string, content: string) {
    return ctx.app.inject({
      method: 'POST',
      url: `/api/conversations/${conversationId}/messages`,
      payload: { content },
      cookies,
    });
  }

  function lastSystemPrompt(): string {
    const request = fakeReply.captured.at(-1)!;
    return request.messages.find((m) => m.role === 'system')!.content;
  }

  it('a send triggers extraction and stores scoped facts (after the exchange)', async () => {
    const { userId, cookies, conversationId } = await setup('flow.extract@example.com');
    const res = await send(cookies, conversationId, 'Hi Luna! My name is Maya and I live in Haifa.');
    expect(res.statusCode).toBe(201);

    const stored = await listMemories(ctx.db, userId, LUNA.id);
    expect(stored).toContain('Their name is Maya.');
    expect(stored).toContain('They live in Haifa.');
    // Extraction ran AFTER the reply was generated: the send that introduced
    // the fact did not have it injected into its own prompt.
    expect(fakeReply.captured).toHaveLength(1);
    expect(lastSystemPrompt()).not.toContain('Their name is Maya.');
  });

  it('the NEXT message receives stored memories in the model context', async () => {
    const { cookies, conversationId } = await setup('flow.inject@example.com');
    await send(cookies, conversationId, 'My name is Maya and I have a cat named Miso.');
    await send(cookies, conversationId, 'What do you remember about me?');

    expect(fakeReply.captured).toHaveLength(2);
    const system = lastSystemPrompt();
    expect(system).toContain('Things you remember about this person');
    expect(system).toContain('Their name is Maya.');
    expect(system).toContain('They have a cat named Miso.');
  });

  it('memories survive leaving and returning (fresh login, same facts injected)', async () => {
    const first = await setup('flow.return@example.com');
    await send(first.cookies, first.conversationId, 'My name is Maya.');

    // Logout, log back in — a brand-new session, like closing the browser.
    await ctx.app.inject({ method: 'POST', url: '/api/auth/logout', cookies: first.cookies });
    const login = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'flow.return@example.com', password: 'memory-flow-pass1' },
    });
    const cookie = extractSessionCookie(login)!;
    const cookies = { [cookie.name]: cookie.value };

    // Reopen the same conversation (US-06 get-or-create) and continue.
    const conv = await ctx.app.inject({
      method: 'POST',
      url: '/api/conversations',
      payload: { characterId: LUNA.id },
      cookies,
    });
    expect(conv.json().id).toBe(first.conversationId);
    await send(cookies, first.conversationId, 'Do you remember my name?');
    expect(lastSystemPrompt()).toContain('Their name is Maya.');
  });

  it("NEVER injects Luna's memories into Ember (character isolation end-to-end)", async () => {
    const luna = await setup('flow.isolation@example.com', LUNA.id);
    await send(luna.cookies, luna.conversationId, 'My name is Maya and my sister is called Dana.');

    // Same user opens Ember: none of Luna's facts may appear.
    const conv = await ctx.app.inject({
      method: 'POST',
      url: '/api/conversations',
      payload: { characterId: EMBER.id },
      cookies: luna.cookies,
    });
    const emberConversation = conv.json().id as string;
    await send(luna.cookies, emberConversation, 'Hi Ember, nice to meet you!');

    const emberSystem = lastSystemPrompt();
    expect(emberSystem).toContain('You are Ember.');
    expect(emberSystem).not.toContain('Maya');
    expect(emberSystem).not.toContain('Dana');
    expect(emberSystem).not.toContain('Things you remember about this person');

    // And back in Luna's conversation the facts are still injected.
    await send(luna.cookies, luna.conversationId, 'What was my name again?');
    expect(lastSystemPrompt()).toContain('Their name is Maya.');
  });

  it('memory rows never appear in any API response (server-side only)', async () => {
    const { cookies, conversationId } = await setup('flow.wire@example.com');
    await send(cookies, conversationId, 'My name is Maya.');
    const res = await send(cookies, conversationId, 'hello again');
    const history = await ctx.app.inject({
      method: 'GET',
      url: `/api/conversations/${conversationId}/messages`,
      cookies,
    });
    for (const body of [res.body, history.body]) {
      expect(body).not.toContain('Their name is Maya.');
      expect(body).not.toContain('memories');
    }
  });

  it('sendMessage without a memory hook stores nothing (safe default)', async () => {
    const { userId, conversationId } = await setup('flow.default@example.com');
    await sendMessage(ctx.db, userId, conversationId, 'My name is Maya.', () => 'a reply');
    expect(await listMemories(ctx.db, userId, LUNA.id)).toEqual([]);
  });
});

// ───────────────────────── US-33: env-configured real provider path ──────
//
// The eval/smoke runs prove the provider side; these tests prove OUR side of
// the seam with the SAME selection logic production uses: an Env with llm
// configured → selectReplyProvider → OpenAI-compatible adapter → real HTTP —
// against a local mock endpoint (the sandbox cannot reach openrouter.ai; the
// documented smoke test in scripts/llm-smoke.mjs covers the live provider).

describe('US-33: env-selected real provider through the API (local endpoint)', () => {
  let ctx: TestContext;
  let server: Server;
  let mode: 'ok' | 'http500' = 'ok';
  const MOCK_REPLY = 'Under a real sky tonight — I kept your place by the window.';
  const API_KEY = 'test-provider-key-not-a-real-secret';
  /** Everything the provider endpoint received, request by request. */
  const wire: Array<{ authorization: string | undefined; body: any }> = [];

  beforeAll(async () => {
    migrateTestDb();

    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => (raw += chunk));
      req.on('end', () => {
        wire.push({ authorization: req.headers.authorization, body: JSON.parse(raw) });
        if (mode === 'http500') {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'provider exploded' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: MOCK_REPLY } }] }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };

    // Exactly what production does: an Env with llm configured, passed through
    // selectReplyProvider. Model/timeout/token settings are environment-driven.
    const llmEnv: Env = {
      ...testEnv,
      llm: {
        provider: 'openai-compatible',
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        model: 'nousresearch/hermes-3-llama-3.1-70b',
        apiKey: API_KEY,
        timeoutMs: 2_000,
        maxTokens: 512,
        temperature: 0.8,
        contextMaxMessages: 40,
        contextMaxChars: 16_000,
      },
    };
    ctx = await createTestContext({
      replyProvider: selectReplyProvider(llmEnv),
      memoryExtractor: deterministicMemoryExtractor,
    });
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  beforeEach(async () => {
    await truncateAll(ctx);
    await seedCharacters(ctx.db);
    wire.length = 0;
    mode = 'ok';
  });

  async function setup(email: string) {
    const reg = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email, password: 'us33-real-llm-pass1' },
    });
    const cookie = extractSessionCookie(reg)!;
    const cookies = { [cookie.name]: cookie.value };
    const conv = await ctx.app.inject({
      method: 'POST',
      url: '/api/conversations',
      payload: { characterId: LUNA.id },
      cookies,
    });
    return { cookies, conversationId: conv.json().id as string };
  }

  function send(cookies: Record<string, string>, conversationId: string, content: string) {
    return ctx.app.inject({
      method: 'POST',
      url: `/api/conversations/${conversationId}/messages`,
      payload: { content },
      cookies,
    });
  }

  it('completes a request through the existing backend path with env-driven settings', async () => {
    const { cookies, conversationId } = await setup('us33.path@example.com');
    const res = await send(cookies, conversationId, 'Hi Luna, are you real now?');

    expect(res.statusCode).toBe(201);
    expect(res.json().characterMessage.content).toBe(MOCK_REPLY);

    // The provider received exactly the env-configured model/sampling settings
    // over the OpenAI-compatible wire shape — nothing hardcoded in the path.
    expect(wire).toHaveLength(1);
    expect(wire[0]!.body.model).toBe('nousresearch/hermes-3-llama-3.1-70b');
    expect(wire[0]!.body.max_tokens).toBe(512);
    expect(wire[0]!.body.temperature).toBe(0.8);
    expect(wire[0]!.body.messages[0]!.role).toBe('system');
  });

  it('sends credentials to the provider only — the browser never sees key or prompts', async () => {
    const { cookies, conversationId } = await setup('us33.secrets@example.com');
    const res = await send(cookies, conversationId, 'My name is Maya, by the way.');
    const history = await ctx.app.inject({
      method: 'GET',
      url: `/api/conversations/${conversationId}/messages`,
      cookies,
    });

    // Server→provider: bearer auth actually applied.
    expect(wire[0]!.authorization).toBe(`Bearer ${API_KEY}`);
    // Server→browser: no credential, no composed prompt, no persona internals.
    for (const body of [res.body, history.body]) {
      expect(body).not.toContain(API_KEY);
      expect(body).not.toContain('Bearer');
      expect(body).not.toContain(LUNA.systemPrompt);
      expect(body).not.toContain('Things you remember about this person');
    }
  });

  it('injects stored memories into the real provider call on the next send', async () => {
    const { cookies, conversationId } = await setup('us33.memory@example.com');
    await send(cookies, conversationId, 'My name is Maya and I have a cat named Miso.');
    const res = await send(cookies, conversationId, 'What do you remember about me?');

    expect(res.statusCode).toBe(201);
    expect(wire).toHaveLength(2);
    const system = wire[1]!.body.messages.find((m: any) => m.role === 'system')!.content as string;
    expect(system).toContain('Things you remember about this person');
    expect(system).toContain('Their name is Maya.');
    // Same guarantee as US-12, now on the real path: memories reach the model,
    // never the browser.
    expect(res.body).not.toContain('Their name is Maya.');
  });

  it('keeps the safe error path: provider failure → clean 502, nothing persisted, nothing leaked', async () => {
    const { cookies, conversationId } = await setup('us33.failure@example.com');
    mode = 'http500';
    const res = await send(cookies, conversationId, 'Hello?');

    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe('ai_unavailable');
    expect(res.body).not.toContain(API_KEY);
    expect(res.body).not.toContain(LUNA.systemPrompt);
    // Full exchange rollback — the failed send left no message rows behind.
    expect(await ctx.db.select().from(messages)).toHaveLength(0);
  });
});

describe('extractor failure isolation (US-12 hard requirement)', () => {
  let ctx: TestContext;
  const throwingExtractor: MemoryExtractor = () => {
    throw new LlmError('timeout', 'extraction blew up');
  };

  beforeAll(async () => {
    migrateTestDb();
    ctx = await createTestContext({ memoryExtractor: throwingExtractor });
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  beforeEach(async () => {
    await truncateAll(ctx);
    await seedCharacters(ctx.db);
  });

  it('a throwing extractor NEVER breaks or rolls back the chat exchange', async () => {
    const reg = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'fail.isolated@example.com', password: 'memory-fail-pass1' },
    });
    const cookie = extractSessionCookie(reg)!;
    const cookies = { [cookie.name]: cookie.value };
    const conv = await ctx.app.inject({
      method: 'POST',
      url: '/api/conversations',
      payload: { characterId: LUNA.id },
      cookies,
    });
    const conversationId = conv.json().id as string;

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/conversations/${conversationId}/messages`,
      payload: { content: 'My name is Maya — remember it if you can!' },
      cookies,
    });
    // The chat exchange succeeded and persisted despite the extractor failing.
    expect(res.statusCode).toBe(201);
    expect(res.json().characterMessage.content.length).toBeGreaterThan(0);
    expect(await ctx.db.select().from(messages)).toHaveLength(2);
    // Only the memories were lost.
    expect(await ctx.db.select().from(memories)).toHaveLength(0);
  });
});
