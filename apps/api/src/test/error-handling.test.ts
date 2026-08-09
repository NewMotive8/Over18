import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { messages } from '../db/schema.js';
import { SEED_CHARACTERS } from '../db/seed-data.js';
import { seedCharacters } from '../db/seed.js';
import { LlmError } from '../llm/types.js';
import type { ReplyContext, ReplyProvider } from '../services/character-reply.js';
import { unconfiguredReplyProvider } from '../services/llm-reply-provider.js';
import {
  createTestContext,
  destroyTestContext,
  extractSessionCookie,
  migrateTestDb,
  truncateAll,
  type TestContext,
} from './helpers.js';

/**
 * US-14 — Conversation Error Handling.
 *
 * Exercises the server side of the story on the real route/service path:
 * timeouts and provider failures produce clean, understandable errors; a
 * failed send persists NOTHING (no orphan/partial messages); and retrying a
 * failed send creates exactly one user message — never a duplicate. Reuses
 * the US-08 error architecture unchanged; only asserts its guarantees.
 */

const LUNA = SEED_CHARACTERS.find((c) => c.name === 'luna')!;

/** Reply provider whose behavior can be flipped between calls (fail ↔ succeed). */
function toggleProvider() {
  let behavior: { reply: string } | { error: LlmError } = { reply: 'A steady reply.' };
  const provider: ReplyProvider = (_context: ReplyContext) => {
    if ('error' in behavior) throw behavior.error;
    return behavior.reply;
  };
  return {
    provider,
    fail: (error: LlmError) => (behavior = { error }),
    succeed: (reply: string) => (behavior = { reply }),
  };
}

describe('US-14 error handling on the message route', () => {
  let ctx: TestContext;
  const toggle = toggleProvider();

  beforeAll(async () => {
    migrateTestDb();
    ctx = await createTestContext({ replyProvider: toggle.provider });
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  beforeEach(async () => {
    await truncateAll(ctx);
    await seedCharacters(ctx.db);
    toggle.succeed('A steady reply.');
  });

  async function setup(email: string) {
    const reg = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email, password: 'err-test-pass1' },
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

  it('a successful message is unchanged: 201 with both persisted messages', async () => {
    const { cookies, conversationId } = await setup('err.ok@example.com');
    toggle.succeed('The stars look wonderful tonight.');
    const res = await send(cookies, conversationId, 'Hi Luna!');
    expect(res.statusCode).toBe(201);
    expect(res.json().userMessage.content).toBe('Hi Luna!');
    expect(res.json().characterMessage.content).toBe('The stars look wonderful tonight.');
    expect(await ctx.db.select().from(messages)).toHaveLength(2);
  });

  it('an LLM timeout returns 502 with its own understandable message', async () => {
    const { cookies, conversationId } = await setup('err.timeout@example.com');
    toggle.fail(new LlmError('timeout', 'Inference request timed out after 30000ms.'));
    const res = await send(cookies, conversationId, 'slow please');
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe('ai_unavailable');
    expect(res.json().message).toBe('The character took too long to respond. Please try again.');
    // Internal timing/detail never leaks to the client.
    expect(res.json().message).not.toContain('30000');
  });

  it('a generic provider failure returns 502 with the standard message', async () => {
    const { cookies, conversationId } = await setup('err.http@example.com');
    toggle.fail(new LlmError('http', 'Inference endpoint returned HTTP 500.', 500));
    const res = await send(cookies, conversationId, 'boom');
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe('ai_unavailable');
    expect(res.json().message).toBe("The character couldn't respond right now. Please try again.");
    expect(res.json().message).not.toContain('500');
  });

  it('a network failure is also a clean 502 (no internal detail leaked)', async () => {
    const { cookies, conversationId } = await setup('err.net@example.com');
    toggle.fail(new LlmError('network', 'ECONNREFUSED 10.0.0.5:8000'));
    const res = await send(cookies, conversationId, 'unreachable');
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe('ai_unavailable');
    expect(res.json().message).not.toContain('ECONNREFUSED');
  });

  it('a failed send leaves NO orphan or partial messages', async () => {
    const { cookies, conversationId } = await setup('err.orphan@example.com');
    toggle.fail(new LlmError('http', 'provider exploded', 500));
    await send(cookies, conversationId, 'this must not persist');
    // Neither the user message nor a partial character message survived.
    expect(await ctx.db.select().from(messages)).toHaveLength(0);
    const history = await ctx.app.inject({
      method: 'GET',
      url: `/api/conversations/${conversationId}/messages`,
      cookies,
    });
    expect(history.json()).toEqual([]);
  });

  it('retry after a failure succeeds and creates exactly ONE user message (no duplicate)', async () => {
    const { cookies, conversationId } = await setup('err.retry@example.com');

    // First attempt fails — nothing persisted.
    toggle.fail(new LlmError('timeout', 'timed out'));
    const failed = await send(cookies, conversationId, 'Remember this exact message');
    expect(failed.statusCode).toBe(502);
    expect(await ctx.db.select().from(messages)).toHaveLength(0);

    // Retry with the SAME content — now the provider recovers.
    toggle.succeed('Of course I remember.');
    const ok = await send(cookies, conversationId, 'Remember this exact message');
    expect(ok.statusCode).toBe(201);

    // Exactly one user message + one character message — the failed attempt
    // did not leave a duplicate behind.
    const rows = await ctx.db.select().from(messages);
    expect(rows).toHaveLength(2);
    const userRows = rows.filter((r) => r.sender === 'user');
    expect(userRows).toHaveLength(1);
    expect(userRows[0]!.content).toBe('Remember this exact message');
  });

  it('multiple consecutive failures still persist nothing (retryable, no accumulation)', async () => {
    const { cookies, conversationId } = await setup('err.multi@example.com');
    toggle.fail(new LlmError('http', 'still down', 503));
    for (let i = 0; i < 3; i++) {
      const res = await send(cookies, conversationId, 'attempt');
      expect(res.statusCode).toBe(502);
    }
    expect(await ctx.db.select().from(messages)).toHaveLength(0);
  });
});

describe('US-14 unconfigured production guard', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    migrateTestDb();
    // Mirrors production-without-LLM: the guard provider throws not_configured.
    ctx = await createTestContext({ replyProvider: unconfiguredReplyProvider });
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  beforeEach(async () => {
    await truncateAll(ctx);
    await seedCharacters(ctx.db);
  });

  it('returns 503 ai_not_configured and persists nothing', async () => {
    const reg = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'err.unconfigured@example.com', password: 'err-test-pass1' },
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
      payload: { content: 'anyone home?' },
      cookies,
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('ai_not_configured');
    expect(await ctx.db.select().from(messages)).toHaveLength(0);
  });
});
