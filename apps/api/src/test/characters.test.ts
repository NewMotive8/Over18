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
  it('creates exactly the 4 deterministic seed characters with fixed UUIDs', async () => {
    const count = await seedCharacters(ctx.db);
    expect(count).toBe(4);
    const rows = await ctx.db.select().from(characters);
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r.id).sort()).toEqual(SEED_CHARACTERS.map((s) => s.id).sort());
    // Every seeded character is identifiable and has a display image.
    for (const row of rows) {
      expect(row.displayName.length).toBeGreaterThan(0);
      expect(row.profileImage).toBeTruthy();
    }
    // US-88: the AUTHORED characters still carry complete realistic copy.
    // Maria is excluded here on purpose — the PO approved neutral placeholders
    // for her text rather than an invented biography (asserted separately
    // below), so holding her to the authored-copy bar would be wrong.
    for (const row of rows.filter((r) => r.name !== 'maria')) {
      expect(row.shortBio.length).toBeGreaterThan(10);
      expect(row.personality.length).toBeGreaterThan(10);
      expect(row.conversationStyle.length).toBeGreaterThan(10);
      expect(row.systemPrompt.length).toBeGreaterThan(10);
      expect(row.interests.length).toBeGreaterThanOrEqual(3);
    }
  });

  it('is idempotent — running twice never duplicates rows', async () => {
    await seedCharacters(ctx.db);
    await seedCharacters(ctx.db);
    const rows = await ctx.db.select().from(characters);
    expect(rows).toHaveLength(4);
  });
});

/**
 * ── US-88 — Retire Sage, add Maria ──────────────────────────────────────
 *
 * The active product roster is Luna, Ember and Maria. Sage is retired at the
 * product level ONLY: her row, her identity, her assets and her provenance all
 * survive, and her UUID is never reused.
 */
describe('US-88 roster: Maria active, Sage retired but preserved', () => {
  const SAGE_SEED = SEED_CHARACTERS.find((c) => c.name === 'sage')!;
  const MARIA_SEED = SEED_CHARACTERS.find((c) => c.name === 'maria')!;

  it('AC1 — Maria exists and is active', async () => {
    await seedCharacters(ctx.db);
    const rows = await ctx.db.select().from(characters);
    const maria = rows.find((r) => r.name === 'maria');
    expect(maria).toBeDefined();
    expect(maria!.displayName).toBe('Maria');
    expect(maria!.status).toBe('active');
  });

  it('AC5 — Sage is inactive', async () => {
    await seedCharacters(ctx.db);
    const rows = await ctx.db.select().from(characters);
    const sage = rows.find((r) => r.name === 'sage');
    expect(sage).toBeDefined();
    expect(sage!.status).toBe('inactive');
  });

  it('AC6 — Sage\'s row survives retirement with her content and UUID intact', async () => {
    await seedCharacters(ctx.db);
    // Re-seeding must never delete or blank a retired character.
    await seedCharacters(ctx.db);
    const rows = await ctx.db.select().from(characters);
    const sage = rows.find((r) => r.name === 'sage')!;
    expect(sage.id).toBe(SAGE_SEED.id);
    expect(sage.displayName).toBe('Sage');
    expect(sage.shortBio.length).toBeGreaterThan(10);
    expect(sage.personality.length).toBeGreaterThan(10);
    expect(sage.systemPrompt.length).toBeGreaterThan(10);
    expect(sage.interests.length).toBeGreaterThanOrEqual(3);
    expect(sage.profileImage).toBeTruthy();
  });

  it('Maria never reuses Sage\'s UUID', () => {
    expect(MARIA_SEED.id).not.toBe(SAGE_SEED.id);
    const ids = SEED_CHARACTERS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('Maria carries the approved neutral placeholders — no invented biography', () => {
    expect(MARIA_SEED.shortBio).toBe('');
    expect(MARIA_SEED.personality).toBe('Not specified.');
    expect(MARIA_SEED.conversationStyle).toBe('Default.');
    expect(MARIA_SEED.systemPrompt).toBe('');
    expect(MARIA_SEED.interests).toEqual([]);
  });

  it('AC3 — Maria\'s profile image is the approved supplied portrait', () => {
    expect(MARIA_SEED.profileImage).toBe('/media/maria/portrait.png');
  });

  it('AC7 — Luna and Ember are untouched by US-88', async () => {
    await seedCharacters(ctx.db);
    const rows = await ctx.db.select().from(characters);
    for (const name of ['luna', 'ember']) {
      const seed = SEED_CHARACTERS.find((c) => c.name === name)!;
      const row = rows.find((r) => r.name === name)!;
      expect(row.id).toBe(seed.id);
      expect(row.status).toBe('active');
      expect(row.displayName).toBe(seed.displayName);
      expect(row.shortBio).toBe(seed.shortBio);
      expect(row.personality).toBe(seed.personality);
      expect(row.conversationStyle).toBe(seed.conversationStyle);
      expect(row.systemPrompt).toBe(seed.systemPrompt);
      expect(row.interests).toEqual(seed.interests);
      expect(row.profileImage).toBe(seed.profileImage);
    }
  });

  it('AC5/AC12 — the public active-character API returns Maria and not Sage', async () => {
    await seedCharacters(ctx.db);
    const res = await ctx.app.inject({ method: 'GET', url: '/api/characters' });
    expect(res.statusCode).toBe(200);
    const names = res.json().map((c: { name: string }) => c.name);
    expect(names).toContain('maria');
    expect(names).not.toContain('sage');
    expect(names.sort()).toEqual(['ember', 'luna', 'maria']);
  });

  it('a retired character reads as not-found through the public detail route', async () => {
    await seedCharacters(ctx.db);
    const res = await ctx.app.inject({ method: 'GET', url: `/api/characters/${SAGE_SEED.id}` });
    expect(res.statusCode).toBe(404);
  });
});

describe('GET /api/characters', () => {
  it('returns the active seed characters in deterministic order', async () => {
    await seedCharacters(ctx.db);
    const res = await ctx.app.inject({ method: 'GET', url: '/api/characters' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // US-88: the active roster is Ember, Luna, Maria — Sage is retired.
    expect(body).toHaveLength(3);
    // Ordered by display name: Ember, Luna, Maria.
    expect(body.map((c: { displayName: string }) => c.displayName)).toEqual(['Ember', 'Luna', 'Maria']);
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
    // Sage is already inactive from US-88, so deactivating Ember leaves Luna
    // and Maria — the mechanism is the same soft-hide in both cases.
    expect(names).toEqual(['luna', 'maria']);
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
