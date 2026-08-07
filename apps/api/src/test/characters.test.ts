import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { characters } from '../db/schema.js';
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

describe('characters schema / migration', () => {
  it('created the characters table with the expected columns', async () => {
    const res = await ctx.pool.query(
      `SELECT column_name, data_type, is_nullable FROM information_schema.columns
       WHERE table_name = 'characters' ORDER BY column_name`,
    );
    const columns = Object.fromEntries(res.rows.map((r) => [r.column_name, r]));
    expect(Object.keys(columns).sort()).toEqual([
      'conversation_style',
      'created_at',
      'display_name',
      'id',
      'interests',
      'name',
      'personality',
      'profile_image',
      'short_bio',
      'status',
      'system_prompt',
      'updated_at',
    ]);
    expect(columns.id.data_type).toBe('uuid');
    expect(columns.interests.data_type).toBe('ARRAY');
    expect(columns.status.data_type).toBe('USER-DEFINED'); // character_status enum
    expect(columns.profile_image.is_nullable).toBe('YES');
    expect(columns.system_prompt.is_nullable).toBe('NO');
  });

  it('enforces the unique constraint on name', async () => {
    await seedCharacters(ctx.db);
    await expect(
      ctx.db.insert(characters).values({
        name: 'luna', // duplicate
        displayName: 'Luna Clone',
        shortBio: 'x',
        personality: 'x',
        interests: [],
        conversationStyle: 'x',
        systemPrompt: 'x',
      }),
    ).rejects.toThrow();
  });
});

describe('seed data', () => {
  it('creates exactly the 3 deterministic seed characters with fixed UUIDs', async () => {
    const count = await seedCharacters(ctx.db);
    expect(count).toBe(3);
    const rows = await ctx.db.select().from(characters);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.id).sort()).toEqual(SEED_CHARACTERS.map((s) => s.id).sort());
    // Complete realistic data: every seeded field is non-empty.
    for (const row of rows) {
      expect(row.displayName.length).toBeGreaterThan(0);
      expect(row.shortBio.length).toBeGreaterThan(10);
      expect(row.personality.length).toBeGreaterThan(10);
      expect(row.conversationStyle.length).toBeGreaterThan(10);
      expect(row.systemPrompt.length).toBeGreaterThan(10);
      expect(row.interests.length).toBeGreaterThanOrEqual(3);
      expect(row.profileImage).toBeTruthy();
      expect(row.status).toBe('active');
    }
  });

  it('is idempotent — running twice never duplicates rows', async () => {
    await seedCharacters(ctx.db);
    await seedCharacters(ctx.db);
    const rows = await ctx.db.select().from(characters);
    expect(rows).toHaveLength(3);
  });
});

describe('GET /api/characters', () => {
  it('returns the active seed characters in deterministic order', async () => {
    await seedCharacters(ctx.db);
    const res = await ctx.app.inject({ method: 'GET', url: '/api/characters' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveLength(3);
    // Ordered by display name: Ember, Luna, Sage.
    expect(body.map((c: { displayName: string }) => c.displayName)).toEqual(['Ember', 'Luna', 'Sage']);
  });

  it('never exposes system_prompt or status', async () => {
    await seedCharacters(ctx.db);
    const res = await ctx.app.inject({ method: 'GET', url: '/api/characters' });
    for (const character of res.json()) {
      expect(character).not.toHaveProperty('systemPrompt');
      expect(character).not.toHaveProperty('system_prompt');
      expect(character).not.toHaveProperty('status');
      expect(Object.keys(character).sort()).toEqual([
        'conversationStyle',
        'displayName',
        'id',
        'interests',
        'name',
        'personality',
        'profileImage',
        'shortBio',
      ]);
    }
  });

  it('excludes inactive characters', async () => {
    await seedCharacters(ctx.db);
    await ctx.pool.query(`UPDATE characters SET status = 'inactive' WHERE name = 'ember'`);
    const res = await ctx.app.inject({ method: 'GET', url: '/api/characters' });
    const names = res.json().map((c: { name: string }) => c.name);
    expect(names).toEqual(['luna', 'sage']);
  });

  it('returns an empty array when no characters exist (empty state)', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/characters' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it('is public: works without authentication, and identically with it', async () => {
    await seedCharacters(ctx.db);
    const anonymous = await ctx.app.inject({ method: 'GET', url: '/api/characters' });
    expect(anonymous.statusCode).toBe(200);

    const reg = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'char.viewer@example.com', password: 'char-viewer-pass' },
    });
    const cookie = extractSessionCookie(reg)!;
    const authed = await ctx.app.inject({
      method: 'GET',
      url: '/api/characters',
      cookies: { [cookie.name]: cookie.value },
    });
    expect(authed.statusCode).toBe(200);
    expect(authed.json()).toEqual(anonymous.json());
  });

  it('rejects unsupported methods on the collection', async () => {
    const res = await ctx.app.inject({ method: 'POST', url: '/api/characters', payload: {} });
    expect(res.statusCode).toBe(404); // no character creation endpoint in US-03
  });
});

describe('GET /api/characters/:characterId (US-05)', () => {
  it('returns a single active character by id, public shape only', async () => {
    await seedCharacters(ctx.db);
    const luna = SEED_CHARACTERS.find((c) => c.name === 'luna')!;
    const res = await ctx.app.inject({ method: 'GET', url: `/api/characters/${luna.id}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.id).toBe(luna.id);
    expect(body.displayName).toBe('Luna');
    expect(body.interests).toEqual(luna.interests);
    expect(body).not.toHaveProperty('systemPrompt');
    expect(body).not.toHaveProperty('system_prompt');
    expect(body).not.toHaveProperty('status');
  });

  it('is public: no authentication required', async () => {
    await seedCharacters(ctx.db);
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/characters/${SEED_CHARACTERS[0]!.id}`,
    });
    expect(res.statusCode).toBe(200);
  });

  it('returns 404 for an unknown id', async () => {
    await seedCharacters(ctx.db);
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/characters/00000000-0000-4000-8000-999999999999',
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('not_found');
  });

  it('returns 404 for an inactive character (no existence leak)', async () => {
    await seedCharacters(ctx.db);
    const ember = SEED_CHARACTERS.find((c) => c.name === 'ember')!;
    await ctx.pool.query(`UPDATE characters SET status = 'inactive' WHERE id = $1`, [ember.id]);
    const res = await ctx.app.inject({ method: 'GET', url: `/api/characters/${ember.id}` });
    expect(res.statusCode).toBe(404);
  });

  it('returns 404 (not 500) for a malformed id', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/characters/not-a-uuid' });
    expect(res.statusCode).toBe(404);
  });
});
