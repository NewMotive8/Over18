import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { users, sessions } from '../db/schema.js';
import {
  createTestContext,
  destroyTestContext,
  extractSessionCookie,
  migrateTestDb,
  truncateAll,
  type TestContext,
} from './helpers.js';

const EMAIL = 'Test.User@Example.com'; // deliberately mixed-case for normalization checks
const NORMALIZED = 'test.user@example.com';
const PASSWORD = 'correct-horse-battery';

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
});

async function register(email = EMAIL, password = PASSWORD) {
  return ctx.app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email, password },
  });
}

describe('POST /api/auth/register', () => {
  it('registers successfully, sets an HttpOnly session cookie, returns safe user', async () => {
    const res = await register();
    expect(res.statusCode).toBe(201);

    const body = res.json();
    expect(body.email).toBe(NORMALIZED); // email was normalized
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/); // UUID
    expect(body).not.toHaveProperty('passwordHash');
    expect(body).not.toHaveProperty('password_hash');

    const cookie = extractSessionCookie(res)!;
    expect(cookie).toBeDefined();
    expect(res.headers['set-cookie']).toMatch(/HttpOnly/i);
    expect(res.headers['set-cookie']).toMatch(/Path=\//i);
    expect(res.headers['set-cookie']).toMatch(/SameSite=Lax/i);
    expect(res.headers['set-cookie']).toMatch(/Max-Age=/i);
  });

  it('rejects duplicate registration (case-insensitively)', async () => {
    await register();
    const res = await register('test.user@EXAMPLE.com');
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('email_taken');
  });

  it('stores the password hashed, never in plaintext', async () => {
    await register();
    const row = await ctx.db.query.users.findFirst({ where: eq(users.email, NORMALIZED) });
    expect(row).toBeDefined();
    expect(row!.passwordHash).not.toContain(PASSWORD);
    expect(row!.passwordHash).toMatch(/^\$2[aby]\$12\$/); // bcrypt, cost 12
  });

  it('rejects invalid input (bad email, short password)', async () => {
    const badEmail = await register('not-an-email');
    expect(badEmail.statusCode).toBe(400);
    const shortPw = await register(EMAIL, 'short');
    expect(shortPw.statusCode).toBe(400);
  });
});

describe('POST /api/auth/login', () => {
  it('succeeds with valid credentials (normalized email) and sets a cookie', async () => {
    await register();
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: '  TEST.user@example.COM  ', password: PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().email).toBe(NORMALIZED);
    expect(extractSessionCookie(res)).toBeDefined();
  });

  it('fails with a generic error for wrong password AND unknown email', async () => {
    await register();
    const wrongPassword = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: EMAIL, password: 'wrong-password-123' },
    });
    const unknownEmail = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'nobody@example.com', password: PASSWORD },
    });
    expect(wrongPassword.statusCode).toBe(401);
    expect(unknownEmail.statusCode).toBe(401);
    // Identical response bodies: no signal about whether the email exists.
    expect(wrongPassword.json()).toEqual(unknownEmail.json());
    expect(extractSessionCookie(wrongPassword)).toBeUndefined();
  });
});

describe('GET /api/auth/me', () => {
  it('returns the safe profile for an authenticated session', async () => {
    const reg = await register();
    const cookie = extractSessionCookie(reg)!;
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/auth/me',
      cookies: { [cookie.name]: cookie.value },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: reg.json().id, email: NORMALIZED });
  });

  it('returns 401 without authentication', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/auth/me' });
    expect(res.statusCode).toBe(401);
  });

  it('returns 401 for an expired session', async () => {
    const reg = await register();
    const cookie = extractSessionCookie(reg)!;
    await ctx.db
      .update(sessions)
      .set({ expiresAt: new Date(Date.now() - 1000) });
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/auth/me',
      cookies: { [cookie.name]: cookie.value },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('POST /api/auth/logout', () => {
  it('invalidates the session server-side and clears the cookie', async () => {
    const reg = await register();
    const cookie = extractSessionCookie(reg)!;

    const logout = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      cookies: { [cookie.name]: cookie.value },
    });
    expect(logout.statusCode).toBe(200);
    expect(logout.headers['set-cookie']).toMatch(/over18_session=;/);

    // Old token no longer works even if the client kept it.
    const me = await ctx.app.inject({
      method: 'GET',
      url: '/api/auth/me',
      cookies: { [cookie.name]: cookie.value },
    });
    expect(me.statusCode).toBe(401);

    // Session row is gone from the database.
    const rows = await ctx.db.select().from(sessions);
    expect(rows).toHaveLength(0);
  });
});

describe('protected conversation routes (chat area)', () => {
  it('rejects unauthenticated requests with 401', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/conversations/00000000-0000-4000-8000-000000000000',
    });
    expect(res.statusCode).toBe(401);
  });

  it('lets authenticated requests through the auth gate (404 for unknown id, not 401)', async () => {
    const reg = await register();
    const cookie = extractSessionCookie(reg)!;
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/conversations/00000000-0000-4000-8000-000000000000',
      cookies: { [cookie.name]: cookie.value },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('session token storage', () => {
  it('stores only a hash of the token, never the raw token', async () => {
    const reg = await register();
    const cookie = extractSessionCookie(reg)!;
    const rows = await ctx.db.select().from(sessions);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokenHash).not.toBe(cookie.value);
    expect(rows[0]!.tokenHash).toMatch(/^[0-9a-f]{64}$/); // sha-256 hex
  });
});
