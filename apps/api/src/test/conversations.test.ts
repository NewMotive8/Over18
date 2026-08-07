import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { conversations } from '../db/schema.js';
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

let ctx: TestContext;
const LUNA_ID = SEED_CHARACTERS.find((c) => c.name === 'luna')!.id;
const EMBER_ID = SEED_CHARACTERS.find((c) => c.name === 'ember')!.id;

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

async function registerUser(email: string) {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email, password: 'conversation-pass-1' },
  });
  const cookie = extractSessionCookie(res)!;
  return { userId: res.json().id as string, cookies: { [cookie.name]: cookie.value } };
}

function start(cookies: Record<string, string> | undefined, characterId: string) {
  return ctx.app.inject({
    method: 'POST',
    url: '/api/conversations',
    payload: { characterId },
    ...(cookies ? { cookies } : {}),
  });
}

describe('POST /api/conversations', () => {
  it('creates a conversation associated with the authenticated user and character', async () => {
    const { userId, cookies } = await registerUser('conv.a@example.com');
    const res = await start(cookies, LUNA_ID);
    expect(res.statusCode).toBe(201);

    const body = res.json();
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.character.id).toBe(LUNA_ID);
    expect(body.character).not.toHaveProperty('systemPrompt');
    expect(body.createdAt).toBeTruthy();
    expect(body).not.toHaveProperty('userId'); // wire shape stays scoped

    // Persisted with the right associations.
    const rows = await ctx.db.select().from(conversations);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.userId).toBe(userId);
    expect(rows[0]!.characterId).toBe(LUNA_ID);
  });

  it('reopens the existing conversation instead of duplicating (200, same id)', async () => {
    const { cookies } = await registerUser('conv.b@example.com');
    const first = await start(cookies, LUNA_ID);
    const second = await start(cookies, LUNA_ID);
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(second.json().id).toBe(first.json().id);
    expect(await ctx.db.select().from(conversations)).toHaveLength(1);
  });

  it('keeps conversations separate per character and per user', async () => {
    const a = await registerUser('conv.c@example.com');
    const b = await registerUser('conv.d@example.com');
    const aLuna = await start(a.cookies, LUNA_ID);
    const aEmber = await start(a.cookies, EMBER_ID);
    const bLuna = await start(b.cookies, LUNA_ID);
    const ids = [aLuna.json().id, aEmber.json().id, bLuna.json().id];
    expect(new Set(ids).size).toBe(3);
    expect(await ctx.db.select().from(conversations)).toHaveLength(3);
  });

  it('requires authentication', async () => {
    const res = await start(undefined, LUNA_ID);
    expect(res.statusCode).toBe(401);
  });

  it('returns 404 for unknown, inactive, and malformed character ids', async () => {
    const { cookies } = await registerUser('conv.e@example.com');
    const unknown = await start(cookies, '00000000-0000-4000-8000-999999999999');
    expect(unknown.statusCode).toBe(404);

    await ctx.pool.query(`UPDATE characters SET status = 'inactive' WHERE id = $1`, [EMBER_ID]);
    const inactive = await start(cookies, EMBER_ID);
    expect(inactive.statusCode).toBe(404);

    const malformed = await ctx.app.inject({
      method: 'POST',
      url: '/api/conversations',
      payload: { characterId: 'not-a-uuid-but-36-characters-long!!!' },
      cookies,
    });
    expect(malformed.statusCode).toBe(404);
  });
});

describe('GET /api/conversations/:conversationId', () => {
  it('returns the conversation with its character to the owner', async () => {
    const { cookies } = await registerUser('conv.f@example.com');
    const created = await start(cookies, LUNA_ID);
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/conversations/${created.json().id}`,
      cookies,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(created.json().id);
    expect(res.json().character.displayName).toBe('Luna');
  });

  it("returns 404 for another user's conversation (no existence leak)", async () => {
    const owner = await registerUser('conv.g@example.com');
    const intruder = await registerUser('conv.h@example.com');
    const created = await start(owner.cookies, LUNA_ID);
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/conversations/${created.json().id}`,
      cookies: intruder.cookies,
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 404 for malformed ids and 401 without authentication', async () => {
    const { cookies } = await registerUser('conv.i@example.com');
    const malformed = await ctx.app.inject({
      method: 'GET',
      url: '/api/conversations/not-a-uuid',
      cookies,
    });
    expect(malformed.statusCode).toBe(404);

    const unauth = await ctx.app.inject({
      method: 'GET',
      url: '/api/conversations/00000000-0000-4000-8000-000000000000',
    });
    expect(unauth.statusCode).toBe(401);
  });
});
