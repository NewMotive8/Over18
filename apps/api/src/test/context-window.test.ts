import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import type { ChatMessage } from '@over18/shared';
import {
  createPromptBuilder,
  DEFAULT_CONTEXT_WINDOW,
  selectContextWindow,
} from '../services/prompt-builder.js';
import { createLlmReplyProvider } from '../services/llm-reply-provider.js';
import type { LlmClient, LlmRequest } from '../llm/types.js';
import { SEED_CHARACTERS } from '../db/seed-data.js';
import { seedCharacters } from '../db/seed.js';
import {
  createTestContext,
  destroyTestContext,
  extractSessionCookie,
  migrateTestDb,
  truncateAll,
  type TestContext,
} from './helpers.js';

const LUNA = SEED_CHARACTERS.find((c) => c.name === 'luna')!;

function makeHistory(count: number, contentFor: (i: number) => string = (i) => `message ${i}`): ChatMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `m${i}`,
    sender: i % 2 === 0 ? ('user' as const) : ('character' as const),
    content: contentFor(i),
    createdAt: `t${i}`,
  }));
}

describe('selectContextWindow (US-10)', () => {
  it('keeps short conversations fully intact', () => {
    const history = makeHistory(6);
    expect(selectContextWindow(history)).toEqual(history);
  });

  it('bounds long conversations by message count, keeping the NEWEST messages', () => {
    const history = makeHistory(100);
    const window = selectContextWindow(history, { maxHistoryMessages: 10, maxHistoryChars: 1e9 });
    expect(window).toHaveLength(10);
    expect(window).toEqual(history.slice(-10)); // newest 10, chronological
  });

  it('bounds long conversations by character budget, dropping whole messages only', () => {
    const history = makeHistory(20, () => 'x'.repeat(100)); // 2000 chars total
    const window = selectContextWindow(history, { maxHistoryMessages: 1000, maxHistoryChars: 450 });
    expect(window).toHaveLength(4); // 4 × 100 ≤ 450 < 5 × 100
    expect(window).toEqual(history.slice(-4));
    // Content is verbatim — never truncated or altered.
    for (const message of window) {
      expect(message.content).toBe('x'.repeat(100));
    }
  });

  it('preserves chronological order and message identity of the survivors', () => {
    const history = makeHistory(50);
    const window = selectContextWindow(history, { maxHistoryMessages: 7, maxHistoryChars: 1e9 });
    expect(window.map((m) => m.id)).toEqual(history.slice(-7).map((m) => m.id));
    expect(window.map((m) => m.sender)).toEqual(history.slice(-7).map((m) => m.sender));
  });

  it('returns an empty window when a single oldest-candidate message exceeds the char budget', () => {
    const history = makeHistory(3, () => 'y'.repeat(500));
    const window = selectContextWindow(history, { maxHistoryMessages: 10, maxHistoryChars: 100 });
    expect(window).toEqual([]); // whole-message policy: nothing partially included
  });

  it('is deterministic — same inputs, same window', () => {
    const history = makeHistory(37);
    const a = selectContextWindow(history, DEFAULT_CONTEXT_WINDOW);
    const b = selectContextWindow(history, DEFAULT_CONTEXT_WINDOW);
    expect(a).toEqual(b);
  });
});

describe('createPromptBuilder with context window (US-10)', () => {
  const context = {
    character: {
      id: LUNA.id,
      name: LUNA.name,
      displayName: LUNA.displayName,
      profileImage: LUNA.profileImage ?? null,
      shortBio: LUNA.shortBio,
      personality: LUNA.personality,
      interests: LUNA.interests as string[],
      conversationStyle: LUNA.conversationStyle,
    },
    systemPrompt: LUNA.systemPrompt,
    history: makeHistory(30),
    priorMessageCount: 30,
    userMessage: 'the newest user message',
  };

  it('never drops the system/persona instructions, even with a zero-history window', () => {
    const builder = createPromptBuilder({ maxHistoryMessages: 0, maxHistoryChars: 0 });
    const messages = builder(context);
    expect(messages).toHaveLength(2); // system + newest user message survive any window
    expect(messages[0]!.role).toBe('system');
    expect(messages[0]!.content).toContain('You are Luna.');
    expect(messages[0]!.content).toContain(LUNA.systemPrompt);
    expect(messages.at(-1)).toEqual({ role: 'user', content: 'the newest user message' });
  });

  it('bounds history while preserving order, roles, and the newest user message', () => {
    const builder = createPromptBuilder({ maxHistoryMessages: 6, maxHistoryChars: 1e9 });
    const messages = builder(context);
    expect(messages).toHaveLength(1 + 6 + 1);
    const historyPart = messages.slice(1, -1);
    expect(historyPart.map((m) => m.content)).toEqual(
      context.history.slice(-6).map((m) => m.content),
    );
    expect(historyPart.map((m) => m.role)).toEqual(
      context.history.slice(-6).map((m) => (m.sender === 'user' ? 'user' : 'assistant')),
    );
    expect(messages.at(-1)!.content).toBe('the newest user message');
  });

  it('default builder applies the default window (unbounded growth prevented)', () => {
    const huge = { ...context, history: makeHistory(500) };
    const builder = createPromptBuilder();
    const messages = builder(huge);
    expect(messages.length).toBe(1 + DEFAULT_CONTEXT_WINDOW.maxHistoryMessages + 1);
  });
});

describe('context window through the API (US-10 integration)', () => {
  let ctx: TestContext;
  const captured: LlmRequest[] = [];
  const client: LlmClient = {
    async generate(request) {
      captured.push(request);
      return 'A bounded-context reply.';
    },
  };

  beforeAll(async () => {
    migrateTestDb();
    ctx = await createTestContext({
      replyProvider: createLlmReplyProvider(
        client,
        { maxTokens: 128, temperature: 0.5 },
        createPromptBuilder({ maxHistoryMessages: 4, maxHistoryChars: 1e9 }),
      ),
    });
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  beforeEach(async () => {
    await truncateAll(ctx);
    await seedCharacters(ctx.db);
    captured.length = 0;
  });

  it('long conversations produce bounded model requests; short ones stay intact', async () => {
    const reg = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'us10.window@example.com', password: 'context-pass-1' },
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

    // 8 sends → history grows 0,2,4,...,14 prior messages.
    for (let i = 1; i <= 8; i++) {
      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/conversations/${conversationId}/messages`,
        payload: { content: `user message ${i}` },
        cookies,
      });
      expect(res.statusCode).toBe(201);
    }

    // Send 1: no history → system + user only (short conversations intact).
    expect(captured[0]!.messages).toHaveLength(2);
    // Send 2: 2 prior messages, under the window → fully intact.
    expect(captured[1]!.messages).toHaveLength(1 + 2 + 1);
    // Sends 4..8: history ≥ 4 → bounded at exactly 4 history messages.
    for (let i = 3; i < 8; i++) {
      expect(captured[i]!.messages).toHaveLength(1 + 4 + 1);
    }
    // The last request: newest user message last, windowed history is the
    // most recent exchanges in order, system prompt present and first.
    const last = captured[7]!;
    expect(last.messages[0]!.role).toBe('system');
    expect(last.messages[0]!.content).toContain('You are Luna.');
    expect(last.messages.at(-1)).toEqual({ role: 'user', content: 'user message 8' });
    // Window = 4 → the four most recent prior messages, chronological:
    // exchange 6 (user + reply) then exchange 7 (user + reply).
    expect(last.messages.slice(1, -1).map((m) => m.content)).toEqual([
      'user message 6',
      'A bounded-context reply.',
      'user message 7',
      'A bounded-context reply.',
    ]);
    expect(last.messages.slice(1, -1).map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
    ]);
  });

  it('everything in the database remains complete — windowing never deletes stored history', async () => {
    const reg = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'us10.storage@example.com', password: 'context-pass-1' },
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
    for (let i = 1; i <= 6; i++) {
      await ctx.app.inject({
        method: 'POST',
        url: `/api/conversations/${conversationId}/messages`,
        payload: { content: `persist ${i}` },
        cookies,
      });
    }
    const history = await ctx.app.inject({
      method: 'GET',
      url: `/api/conversations/${conversationId}/messages`,
      cookies,
    });
    // API/history (refresh path) still returns ALL 12 messages — the window
    // applies only to what is sent to the model.
    expect(history.json()).toHaveLength(12);
    expect(history.json()[0].content).toBe('persist 1');
  });
});
