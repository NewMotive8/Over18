import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MyAiDraft } from '@over18/shared';
import { userCompanions } from '../db/schema.js';
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
 * My AI — the companions a user builds for themselves.
 *
 * THE RULE THIS SUITE EXISTS TO HOLD: a companion belongs to exactly one
 * account. Not "is usually shown to", not "is hard to guess the id of" —
 * every route refuses to serve one to anybody else, including her PICTURE,
 * which is the part most likely to be left on a public route by accident
 * because the app already has one.
 *
 * Nothing here contacts the provider. `testEnv.myAi` is null, so the create
 * route answers 503, and every read path is exercised against rows inserted
 * directly — which is also how the ownership checks get tested without
 * spending money at OhAPI to produce a fixture.
 */

const VALID_DRAFT: MyAiDraft = {
  ethnicity: 'latina',
  hairColour: 'blonde',
  hairStyle: 'wavy',
  eyeColour: 'green',
  figure: 'curvy',
  breasts: 'large',
  butt: 'medium',
  personality: 'flirty',
  relationship: 'girlfriend',
  age: 24,
  name: 'Lisa',
  voice: 'Serena',
  job: 'nurse',
  interests: ['yoga', 'travel'],
};

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 0x7a)]);

let on: TestContext;
let alice: Record<string, string>;
let bob: Record<string, string>;
let aliceId: string;
let bobId: string;

beforeAll(async () => {
  migrateTestDb();
  on = await createTestContext();
});
afterAll(async () => destroyTestContext(on));

beforeEach(async () => {
  await truncateAll(on);
  [alice, aliceId] = await register('alice.myai@example.com');
  [bob, bobId] = await register('bob.myai@example.com');
});

async function register(email: string): Promise<[Record<string, string>, string]> {
  const res = await on.app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email, password: 'my-ai-test-1' },
  });
  const cookie = extractSessionCookie(res)!;
  const { rows } = await on.pool.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [
    email,
  ]);
  return [{ [cookie.name]: cookie.value }, rows[0].id];
}

/** A finished companion, inserted straight in — no provider involved. */
async function giveCompanion(
  userId: string,
  opts: { name?: string; withImage?: boolean; status?: 'generating' | 'ready' | 'failed' } = {},
) {
  const [row] = await on.db
    .insert(userCompanions)
    .values({
      userId,
      name: opts.name ?? 'Lisa',
      age: 24,
      voice: 'Serena',
      attributes: {
        ethnicity: 'latina', hairColour: 'blonde', hairStyle: 'wavy', eyeColour: 'green',
        figure: 'curvy', breasts: 'large', butt: 'medium', personality: 'flirty',
        relationship: 'girlfriend', job: 'nurse', interests: ['yoga'],
      },
      status: opts.status ?? 'ready',
    })
    .returning();

  if (opts.withImage !== false) {
    const path = join(testEnv.media.storageDir, 'my-ai', `${row.id}.jpg`);
    mkdirSync(join(testEnv.media.storageDir, 'my-ai'), { recursive: true });
    writeFileSync(path, JPEG);
    await on.pool.query('UPDATE user_companions SET image_path = $1 WHERE id = $2', [path, row.id]);
  }
  return row;
}

describe('a companion belongs to exactly one account', () => {
  it('lists only your own', async () => {
    await giveCompanion(aliceId, { name: 'Alices' });
    await giveCompanion(bobId, { name: 'Bobs' });

    const res = await on.app.inject({ method: 'GET', url: '/api/my-ai', cookies: alice });
    expect(res.statusCode).toBe(200);
    const { companions } = res.json<{ companions: { name: string }[] }>();
    expect(companions.map((c) => c.name)).toEqual(['Alices']);
  });

  it('refuses to fetch someone else’s, with the same 404 as one that does not exist', async () => {
    const hers = await giveCompanion(aliceId);

    const stranger = await on.app.inject({
      method: 'GET',
      url: `/api/my-ai/${hers.id}`,
      cookies: bob,
    });
    const missing = await on.app.inject({
      method: 'GET',
      url: '/api/my-ai/11111111-1111-4111-8111-111111111111',
      cookies: bob,
    });

    // Identical answers: distinguishing them would confirm hers exists.
    expect(stranger.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
    expect(stranger.json()).toEqual(missing.json());
  });

  /*
   * THE ONE MOST LIKELY TO GO WRONG. The app already has a media route,
   * `/api/media/assets/:id/file`, and it is public by design. Serving a
   * user-made companion through anything with that property would make her
   * picture readable by anyone holding the link.
   */
  it('serves her picture to her owner and to nobody else', async () => {
    const hers = await giveCompanion(aliceId);

    const owner = await on.app.inject({
      method: 'GET',
      url: `/api/my-ai/${hers.id}/image`,
      cookies: alice,
    });
    expect(owner.statusCode).toBe(200);
    expect(owner.headers['content-type']).toContain('image/jpeg');
    expect(owner.rawPayload.length).toBe(JPEG.length);

    const stranger = await on.app.inject({
      method: 'GET',
      url: `/api/my-ai/${hers.id}/image`,
      cookies: bob,
    });
    expect(stranger.statusCode).toBe(404);
  });

  it('never serves her picture without a session', async () => {
    const hers = await giveCompanion(aliceId);
    for (const url of ['/api/my-ai', `/api/my-ai/${hers.id}`, `/api/my-ai/${hers.id}/image`]) {
      const res = await on.app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(401);
    }
  });

  it('marks her picture private so no shared cache can hold it', async () => {
    const hers = await giveCompanion(aliceId);
    const res = await on.app.inject({
      method: 'GET',
      url: `/api/my-ai/${hers.id}/image`,
      cookies: alice,
    });
    expect(res.headers['cache-control']).toContain('private');
  });
});

describe('what the client is told about her', () => {
  it('hands back an owner-scoped route, never a path or a provider URL', async () => {
    const hers = await giveCompanion(aliceId);
    const res = await on.app.inject({ method: 'GET', url: '/api/my-ai', cookies: alice });
    const { companions } = res.json<{ companions: { imageUrl: string }[] }>();

    expect(companions[0].imageUrl).toBe(`/api/my-ai/${hers.id}/image`);
    // No filesystem path, no storage key, no oh.xyz link anywhere in the body.
    expect(res.body).not.toContain('my-ai\\');
    expect(res.body).not.toContain(testEnv.media.storageDir);
    expect(res.body).not.toContain('oh.xyz');
  });

  it('reports no image while she is still being made', async () => {
    await giveCompanion(aliceId, { status: 'generating', withImage: false });
    const res = await on.app.inject({ method: 'GET', url: '/api/my-ai', cookies: alice });
    const { companions } = res.json<{ companions: { status: string; imageUrl: null }[] }>();
    expect(companions[0].status).toBe('generating');
    expect(companions[0].imageUrl).toBeNull();
  });

  it('404s the picture of a companion who has none yet', async () => {
    const hers = await giveCompanion(aliceId, { status: 'generating', withImage: false });
    const res = await on.app.inject({
      method: 'GET',
      url: `/api/my-ai/${hers.id}/image`,
      cookies: alice,
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('creating one', () => {
  it('requires a session', async () => {
    const res = await on.app.inject({ method: 'POST', url: '/api/my-ai', payload: VALID_DRAFT });
    expect(res.statusCode).toBe(401);
  });

  /*
   * Validation runs BEFORE the provider check, so a malformed request is
   * rejected the same way whether or not this environment can render anyone.
   */
  it('refuses a draft the wizard could not have produced, naming the fields', async () => {
    const res = await on.app.inject({
      method: 'POST',
      url: '/api/my-ai',
      cookies: alice,
      payload: { ...VALID_DRAFT, breasts: 'enormous', age: 19 },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json<{ error: string; fields: string[] }>();
    expect(body.error).toBe('invalid_draft');
    expect(body.fields).toContain('breasts');
    expect(body.fields).toContain('age'); // 19 is under the provider's floor of 21
  });

  it('refuses an empty body rather than inventing defaults', async () => {
    const res = await on.app.inject({
      method: 'POST',
      url: '/api/my-ai',
      cookies: alice,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('says plainly when the environment has no provider configured', async () => {
    // testEnv.myAi is null — production does not have the key yet either, and
    // this is the answer it should give rather than a 500.
    const res = await on.app.inject({
      method: 'POST',
      url: '/api/my-ai',
      cookies: alice,
      payload: VALID_DRAFT,
    });
    expect(res.statusCode).toBe(503);
    expect(res.json<{ error: string }>().error).toBe('my_ai_unavailable');
  });

  it('writes nothing when it refuses', async () => {
    await on.app.inject({ method: 'POST', url: '/api/my-ai', cookies: alice, payload: VALID_DRAFT });
    const { rows } = await on.pool.query('SELECT count(*)::int AS n FROM user_companions');
    expect(rows[0].n).toBe(0);
  });
});

describe('the database refuses what the routes refuse', () => {
  /*
   * Belt and braces on the age floor. The wizard stops at 21 and the shared
   * validator stops at 21; this proves a bug that got past both still cannot
   * persist a companion the provider could never have drawn.
   */
  it('will not store a companion under 21', async () => {
    await expect(
      on.pool.query(
        `INSERT INTO user_companions (user_id, name, age, voice, attributes)
         VALUES ($1, 'Too young', 20, 'Serena', '{}'::jsonb)`,
        [aliceId],
      ),
    ).rejects.toThrow(/user_companions_age_21_plus/);
  });

  it('removes a user’s companions when the account goes', async () => {
    await giveCompanion(aliceId);
    await on.pool.query('DELETE FROM users WHERE id = $1', [aliceId]);
    const { rows } = await on.pool.query('SELECT count(*)::int AS n FROM user_companions');
    expect(rows[0].n).toBe(0);
  });
});
