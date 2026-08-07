import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { messages } from '../db/schema.js';
import { SEED_CHARACTERS } from '../db/seed-data.js';
import { seedCharacters } from '../db/seed.js';
import { sendMessage } from '../services/message-service.js';
import {
  createTestContext,
  destroyTestContext,
  extractSessionCookie,
  migrateTestDb,
  truncateAll,
  type TestContext,
} from './helpers.js';

let ctx: TestContext;
const LUNA_ID = SEED_CHARACTERS.find((c) => c.name === 'luna')!.id;

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

async function setupUserWithConversation(email: string) {
  const reg = await ctx.app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email, password: 'message-test-pass1' },
  });
  const cookie = extractSessionCookie(reg)!;
  const cookies = { [cookie.name]: cookie.value };
  const conv = await ctx.app.inject({
    method: 'POST',
    url: '/api/conversations',
    payload: { characterId: LUNA_ID },
    cookies,
  });
  return { userId: reg.json().id as string, cookies, conversationId: conv.json().id as string };
}

function send(cookies: Record<string, string>, conversationId: string, content: string) {
  return ctx.app.inject({
    method: 'POST',
    url: `/api/conversations/${conversationId}/messages`,
    payload: { content },
    cookies,
  });
}

function list(cookies: Record<string, string>, conversationId: string) {
  return ctx.app.inject({
    method: 'GET',
    url: `/api/conversations/${conversationId}/messages`,
    cookies,
  });
}

describe('POST /api/conversations/:id/messages', () => {
  it('persists the user message and returns a character reply (201)', async () => {
    const { cookies, conversationId } = await setupUserWithConversation('msg.a@example.com');
    const res = await send(cookies, conversationId, 'Hi Luna, how are the stars tonight?');
    expect(res.statusCode).toBe(201);

    const body = res.json();
    expect(body.userMessage.sender).toBe('user');
    expect(body.userMessage.content).toBe('Hi Luna, how are the stars tonight?');
    expect(body.characterMessage.sender).toBe('character');
    expect(body.characterMessage.content.length).toBeGreaterThan(10);
    expect(body.characterMessage.content).toContain('Luna'); // in-character

    const rows = await ctx.db.select().from(messages);
    expect(rows).toHaveLength(2);
  });

  it('replies deterministically from public persona fields (no system_prompt leakage)', async () => {
    const a = await setupUserWithConversation('msg.det1@example.com');
    const b = await setupUserWithConversation('msg.det2@example.com');
    const ra = await send(a.cookies, a.conversationId, 'hello');
    const rb = await send(b.cookies, b.conversationId, 'hello');
    // Same character, same position in conversation → same reply.
    expect(ra.json().characterMessage.content).toBe(rb.json().characterMessage.content);
    // The seed system prompts start with "You are ..." — must never surface.
    expect(ra.json().characterMessage.content).not.toContain('You are Luna');
  });

  it('preserves history ordering across multiple exchanges', async () => {
    const { cookies, conversationId } = await setupUserWithConversation('msg.b@example.com');
    await send(cookies, conversationId, 'first');
    await send(cookies, conversationId, 'second');
    await send(cookies, conversationId, 'third');

    const res = await list(cookies, conversationId);
    const history = res.json();
    expect(history).toHaveLength(6);
    expect(history.map((m: { sender: string }) => m.sender)).toEqual([
      'user', 'character', 'user', 'character', 'user', 'character',
    ]);
    expect(history[0].content).toBe('first');
    expect(history[2].content).toBe('second');
    expect(history[4].content).toBe('third');
  });

  it('is atomic: a failing reply provider rolls back the user message too', async () => {
    const { userId, conversationId } = await setupUserWithConversation('msg.atomic@example.com');
    await expect(
      sendMessage(ctx.db, userId, conversationId, 'this must roll back', () => {
        throw new Error('reply generation exploded');
      }),
    ).rejects.toThrow('reply generation exploded');

    const rows = await ctx.db.select().from(messages);
    expect(rows).toHaveLength(0); // nothing persisted — full rollback
  });

  it('validates content boundaries: empty, whitespace-only, and over-length are 400', async () => {
    const { cookies, conversationId } = await setupUserWithConversation('msg.valid@example.com');
    const empty = await send(cookies, conversationId, '');
    expect(empty.statusCode).toBe(400);
    const whitespace = await send(cookies, conversationId, '   ');
    expect(whitespace.statusCode).toBe(400);
    const overLength = await send(cookies, conversationId, 'x'.repeat(2001));
    expect(overLength.statusCode).toBe(400);
    const maxLength = await send(cookies, conversationId, 'x'.repeat(2000));
    expect(maxLength.statusCode).toBe(201); // exactly at the limit is fine
  });

  it("enforces ownership: another user's conversation is 404, unauth is 401", async () => {
    const owner = await setupUserWithConversation('msg.owner@example.com');
    const intruder = await setupUserWithConversation('msg.intruder@example.com');

    const foreign = await send(intruder.cookies, owner.conversationId, 'let me in');
    expect(foreign.statusCode).toBe(404);

    const unauth = await ctx.app.inject({
      method: 'POST',
      url: `/api/conversations/${owner.conversationId}/messages`,
      payload: { content: 'anonymous' },
    });
    expect(unauth.statusCode).toBe(401);

    // The foreign attempt persisted nothing to the owner's conversation.
    const history = await list(owner.cookies, owner.conversationId);
    expect(history.json()).toHaveLength(0);
  });
});

describe('GET /api/conversations/:id/messages', () => {
  it('returns an empty array for a fresh conversation', async () => {
    const { cookies, conversationId } = await setupUserWithConversation('msg.empty@example.com');
    const res = await list(cookies, conversationId);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it("returns 404 for foreign/unknown/malformed conversation ids", async () => {
    const owner = await setupUserWithConversation('msg.h1@example.com');
    const other = await setupUserWithConversation('msg.h2@example.com');

    const foreign = await list(other.cookies, owner.conversationId);
    expect(foreign.statusCode).toBe(404);

    const unknown = await list(owner.cookies, '00000000-0000-4000-8000-999999999999');
    expect(unknown.statusCode).toBe(404);

    const malformed = await list(owner.cookies, 'not-a-uuid');
    expect(malformed.statusCode).toBe(404);
  });

  it('bumps conversation.updated_at when a message is sent', async () => {
    const { cookies, conversationId } = await setupUserWithConversation('msg.upd@example.com');
    const before = await ctx.pool.query('SELECT updated_at FROM conversations WHERE id = $1', [
      conversationId,
    ]);
    await new Promise((r) => setTimeout(r, 20));
    await send(cookies, conversationId, 'bump it');
    const after = await ctx.pool.query('SELECT updated_at FROM conversations WHERE id = $1', [
      conversationId,
    ]);
    expect(new Date(after.rows[0].updated_at).getTime()).toBeGreaterThan(
      new Date(before.rows[0].updated_at).getTime(),
    );
  });
});
