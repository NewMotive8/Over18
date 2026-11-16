import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MyAiDraft } from '@over18/shared';
import { userCompanionPhotos, userCompanions } from '../db/schema.js';
import {
  companionAsCharacter,
  companionReplyContext,
} from '../services/my-ai/my-ai-chat.js';
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

  it('never hands over the provider’s ids', async () => {
    // Her guid and her numeric id are ours: they address her at OhAPI, and a
    // client that knows them is a client that can ask OhAPI about her.
    const hers = await giveCompanion(aliceId);
    await on.pool.query(
      "UPDATE user_companions SET provider_character_guid = 'guid-abc', provider_character_id = 27956 WHERE id = $1",
      [hers.id],
    );
    const res = await on.app.inject({ method: 'GET', url: '/api/my-ai', cookies: alice });
    expect(res.body).not.toContain('guid-abc');
    expect(res.body).not.toContain('27956');
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

describe('deleting one', () => {
  /*
   * A companion nobody else can see is not something to keep a copy of, so
   * this is a real delete: the row AND the file. A "deleted" companion whose
   * picture is still on the volume is a picture the user believes is gone.
   */
  it('removes her row and her picture together', async () => {
    const hers = await giveCompanion(aliceId);
    const path = join(testEnv.media.storageDir, 'my-ai', `${hers.id}.jpg`);
    expect(existsSync(path)).toBe(true);

    const res = await on.app.inject({
      method: 'DELETE',
      url: `/api/my-ai/${hers.id}`,
      cookies: alice,
    });

    expect(res.statusCode).toBe(204);
    const { rows } = await on.pool.query('SELECT count(*)::int AS n FROM user_companions');
    expect(rows[0].n).toBe(0);
    expect(existsSync(path)).toBe(false);
  });

  it('refuses somebody else’s, and does not touch her', async () => {
    const hers = await giveCompanion(aliceId);
    const path = join(testEnv.media.storageDir, 'my-ai', `${hers.id}.jpg`);

    const res = await on.app.inject({
      method: 'DELETE',
      url: `/api/my-ai/${hers.id}`,
      cookies: bob,
    });

    expect(res.statusCode).toBe(404);
    const { rows } = await on.pool.query('SELECT count(*)::int AS n FROM user_companions');
    expect(rows[0].n).toBe(1);
    expect(existsSync(path)).toBe(true);
  });

  it('answers the same 404 for one that never existed', async () => {
    const res = await on.app.inject({
      method: 'DELETE',
      url: '/api/my-ai/11111111-1111-4111-8111-111111111111',
      cookies: alice,
    });
    expect(res.statusCode).toBe(404);
  });

  it('needs a session', async () => {
    const hers = await giveCompanion(aliceId);
    const res = await on.app.inject({ method: 'DELETE', url: `/api/my-ai/${hers.id}` });
    expect(res.statusCode).toBe(401);
  });

  it('deletes one who has no picture yet', async () => {
    // Still being drawn, or failed before her portrait arrived.
    const hers = await giveCompanion(aliceId, { status: 'generating', withImage: false });
    const res = await on.app.inject({
      method: 'DELETE',
      url: `/api/my-ai/${hers.id}`,
      cookies: alice,
    });
    expect(res.statusCode).toBe(204);
  });

  it('leaves the other account’s companions alone', async () => {
    const hers = await giveCompanion(aliceId);
    await giveCompanion(bobId, { name: 'Bobs' });

    await on.app.inject({ method: 'DELETE', url: `/api/my-ai/${hers.id}`, cookies: alice });

    const res = await on.app.inject({ method: 'GET', url: '/api/my-ai', cookies: bob });
    const { companions } = res.json<{ companions: { name: string }[] }>();
    expect(companions.map((c) => c.name)).toEqual(['Bobs']);
  });
});

/**
 * Further photographs of a companion she already has.
 *
 * THE RULE IS THE SAME ONE AS EVERYWHERE ELSE HERE: a photograph has no
 * owner of its own. It belongs to a companion, and the companion belongs to
 * an account — so every route joins back to that account, and a photo id on
 * its own proves nothing about who may see it.
 */
async function givePhoto(
  companionId: string,
  opts: { prompt?: string; withImage?: boolean; status?: 'generating' | 'ready' | 'failed' } = {},
) {
  const [row] = await on.db
    .insert(userCompanionPhotos)
    .values({
      companionId,
      prompt: opts.prompt ?? 'In a red bikini by the pool',
      style: 'glam',
      status: opts.status ?? 'ready',
    })
    .returning();

  if (opts.withImage !== false) {
    const dir = join(testEnv.media.storageDir, 'my-ai', 'photos');
    const path = join(dir, `${row.id}.jpg`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, JPEG);
    await on.pool.query('UPDATE user_companion_photos SET image_path = $1 WHERE id = $2', [
      path,
      row.id,
    ]);
  }
  return row;
}

describe('her gallery', () => {
  it('puts her original portrait first, then everything since', async () => {
    const hers = await giveCompanion(aliceId);
    await givePhoto(hers.id, { prompt: 'Nude, on white sheets' });

    const res = await on.app.inject({
      method: 'GET',
      url: `/api/my-ai/${hers.id}/photos`,
      cookies: alice,
    });

    expect(res.statusCode).toBe(200);
    const { photos } = res.json<{ photos: { isReference: boolean; prompt: string }[] }>();
    expect(photos).toHaveLength(2);
    expect(photos[0].isReference).toBe(true);
    expect(photos[1].prompt).toBe('Nude, on white sheets');
  });

  it('shows nobody else’s gallery', async () => {
    const hers = await giveCompanion(aliceId);
    const stranger = await on.app.inject({
      method: 'GET',
      url: `/api/my-ai/${hers.id}/photos`,
      cookies: bob,
    });
    expect(stranger.statusCode).toBe(404);
  });

  it('serves a photo to her owner and to nobody else', async () => {
    const hers = await giveCompanion(aliceId);
    const photo = await givePhoto(hers.id);

    const owner = await on.app.inject({
      method: 'GET',
      url: `/api/my-ai/${hers.id}/photos/${photo.id}/image`,
      cookies: alice,
    });
    expect(owner.statusCode).toBe(200);
    expect(owner.headers['content-type']).toContain('image/jpeg');
    expect(owner.headers['cache-control']).toContain('private');

    const stranger = await on.app.inject({
      method: 'GET',
      url: `/api/my-ai/${hers.id}/photos/${photo.id}/image`,
      cookies: bob,
    });
    expect(stranger.statusCode).toBe(404);
  });

  /*
   * THE ONE MOST WORTH WRITING DOWN. A photo id is a uuid in a URL. If the
   * route looked it up without joining back to the account, anybody holding
   * one could read it — and the companion id in the path would be decoration.
   */
  it('refuses a photo asked for under somebody else’s companion id', async () => {
    const hers = await giveCompanion(aliceId);
    const photo = await givePhoto(hers.id);
    const his = await giveCompanion(bobId, { name: 'His' });

    const res = await on.app.inject({
      method: 'GET',
      url: `/api/my-ai/${his.id}/photos/${photo.id}/image`,
      cookies: bob,
    });
    expect(res.statusCode).toBe(404);
  });

  it('needs a session for every one of them', async () => {
    const hers = await giveCompanion(aliceId);
    const photo = await givePhoto(hers.id);
    for (const url of [
      `/api/my-ai/${hers.id}/photos`,
      `/api/my-ai/${hers.id}/photos/${photo.id}/image`,
    ]) {
      expect((await on.app.inject({ method: 'GET', url })).statusCode, url).toBe(401);
    }
    expect(
      (await on.app.inject({ method: 'POST', url: `/api/my-ai/${hers.id}/photos`, payload: {} }))
        .statusCode,
    ).toBe(401);
    expect(
      (
        await on.app.inject({
          method: 'DELETE',
          url: `/api/my-ai/${hers.id}/photos/${photo.id}`,
        })
      ).statusCode,
    ).toBe(401);
  });
});

describe('asking for another photo', () => {
  it('refuses a description the composer could not have produced', async () => {
    const hers = await giveCompanion(aliceId);
    const res = await on.app.inject({
      method: 'POST',
      url: `/api/my-ai/${hers.id}/photos`,
      cookies: alice,
      payload: { prompt: '', style: 'cinematic' },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json<{ error: string; fields: string[] }>();
    expect(body.error).toBe('invalid_photo_request');
    expect(body.fields).toEqual(expect.arrayContaining(['prompt', 'style']));
  });

  it('says plainly when the environment has no provider configured', async () => {
    const hers = await giveCompanion(aliceId);
    const res = await on.app.inject({
      method: 'POST',
      url: `/api/my-ai/${hers.id}/photos`,
      cookies: alice,
      payload: { prompt: 'In a red bikini by the pool', style: 'glam' },
    });
    expect(res.statusCode).toBe(503);
  });

  it('writes nothing when it refuses', async () => {
    const hers = await giveCompanion(aliceId);
    await on.app.inject({
      method: 'POST',
      url: `/api/my-ai/${hers.id}/photos`,
      cookies: alice,
      payload: { prompt: 'In a red bikini by the pool', style: 'glam' },
    });
    const { rows } = await on.pool.query('SELECT count(*)::int AS n FROM user_companion_photos');
    expect(rows[0].n).toBe(0);
  });
});

describe('deleting photographs', () => {
  it('removes one photo and its file, leaving her and the rest', async () => {
    const hers = await giveCompanion(aliceId);
    const one = await givePhoto(hers.id, { prompt: 'One' });
    await givePhoto(hers.id, { prompt: 'Two' });
    const path = join(testEnv.media.storageDir, 'my-ai', 'photos', `${one.id}.jpg`);

    const res = await on.app.inject({
      method: 'DELETE',
      url: `/api/my-ai/${hers.id}/photos/${one.id}`,
      cookies: alice,
    });

    expect(res.statusCode).toBe(204);
    expect(existsSync(path)).toBe(false);
    const { rows } = await on.pool.query('SELECT count(*)::int AS n FROM user_companion_photos');
    expect(rows[0].n).toBe(1);
    const still = await on.app.inject({ method: 'GET', url: '/api/my-ai', cookies: alice });
    expect(still.json<{ companions: unknown[] }>().companions).toHaveLength(1);
  });

  it('refuses somebody else’s photo and leaves it alone', async () => {
    const hers = await giveCompanion(aliceId);
    const photo = await givePhoto(hers.id);

    const res = await on.app.inject({
      method: 'DELETE',
      url: `/api/my-ai/${hers.id}/photos/${photo.id}`,
      cookies: bob,
    });

    expect(res.statusCode).toBe(404);
    const { rows } = await on.pool.query('SELECT count(*)::int AS n FROM user_companion_photos');
    expect(rows[0].n).toBe(1);
  });

  /*
   * `reference` is a reserved id, not a row: her original portrait lives on
   * the companion. Deleting it must clear that and nothing else — SHE stays,
   * because the provider keeps its own copy and further photos still work.
   */
  it('deletes her original portrait without deleting her', async () => {
    const hers = await giveCompanion(aliceId);
    const path = join(testEnv.media.storageDir, 'my-ai', `${hers.id}.jpg`);

    const res = await on.app.inject({
      method: 'DELETE',
      url: `/api/my-ai/${hers.id}/photos/reference`,
      cookies: alice,
    });

    expect(res.statusCode).toBe(204);
    expect(existsSync(path)).toBe(false);
    const { rows } = await on.pool.query('SELECT image_path FROM user_companions WHERE id = $1', [
      hers.id,
    ]);
    expect(rows).toHaveLength(1); // she is still here
    expect(rows[0].image_path).toBeNull();
  });

  it('404s her portrait when she has none', async () => {
    const hers = await giveCompanion(aliceId, { withImage: false });
    const res = await on.app.inject({
      method: 'DELETE',
      url: `/api/my-ai/${hers.id}/photos/reference`,
      cookies: alice,
    });
    expect(res.statusCode).toBe(404);
  });

  /*
   * THE ONE THAT LEAVES RUBBISH BEHIND IF IT IS WRONG. The foreign key
   * cascades, so her photo ROWS go on their own — taking with them any
   * record of where their files are. The paths have to be read first.
   */
  it('takes every photo file with her when she is deleted', async () => {
    const hers = await giveCompanion(aliceId);
    const one = await givePhoto(hers.id, { prompt: 'One' });
    const two = await givePhoto(hers.id, { prompt: 'Two' });
    const paths = [one, two].map((p) =>
      join(testEnv.media.storageDir, 'my-ai', 'photos', `${p.id}.jpg`),
    );
    expect(paths.every((p) => existsSync(p))).toBe(true);

    const res = await on.app.inject({
      method: 'DELETE',
      url: `/api/my-ai/${hers.id}`,
      cookies: alice,
    });

    expect(res.statusCode).toBe(204);
    expect(paths.some((p) => existsSync(p))).toBe(false);
    const { rows } = await on.pool.query('SELECT count(*)::int AS n FROM user_companion_photos');
    expect(rows[0].n).toBe(0);
  });
});

/**
 * Talking to a companion you made.
 *
 * SHE IS THE THREAD — there is no conversation row and no conversation id in
 * any of these routes, because a companion belongs to exactly one account.
 * These tests hold that the ownership check is the only gate and that it is
 * on every path.
 */
describe('her conversation', () => {
  it('starts empty and keeps what is said, in order', async () => {
    const hers = await giveCompanion(aliceId);

    const empty = await on.app.inject({
      method: 'GET',
      url: `/api/my-ai/${hers.id}/messages`,
      cookies: alice,
    });
    expect(empty.statusCode).toBe(200);
    expect(empty.json<{ messages: unknown[] }>().messages).toEqual([]);

    const sent = await on.app.inject({
      method: 'POST',
      url: `/api/my-ai/${hers.id}/messages`,
      cookies: alice,
      payload: { body: 'Hello you' },
    });
    expect(sent.statusCode).toBe(200);
    const pair = sent.json<{ messages: { sender: string; body: string }[] }>().messages;
    expect(pair).toHaveLength(2);
    expect(pair[0].sender).toBe('user');
    expect(pair[0].body).toBe('Hello you');
    expect(pair[1].sender).toBe('character');
    expect(pair[1].body.length).toBeGreaterThan(0);

    const thread = await on.app.inject({
      method: 'GET',
      url: `/api/my-ai/${hers.id}/messages`,
      cookies: alice,
    });
    const all = thread.json<{ messages: { sender: string }[] }>().messages;
    expect(all.map((m) => m.sender)).toEqual(['user', 'character']);
  });

  it('is nobody else’s to read or to write to', async () => {
    const hers = await giveCompanion(aliceId);
    await on.app.inject({
      method: 'POST',
      url: `/api/my-ai/${hers.id}/messages`,
      cookies: alice,
      payload: { body: 'Something private' },
    });

    const read = await on.app.inject({
      method: 'GET',
      url: `/api/my-ai/${hers.id}/messages`,
      cookies: bob,
    });
    const write = await on.app.inject({
      method: 'POST',
      url: `/api/my-ai/${hers.id}/messages`,
      cookies: bob,
      payload: { body: 'Hello stranger' },
    });

    expect(read.statusCode).toBe(404);
    expect(write.statusCode).toBe(404);
    // And nothing of his was written against her.
    const { rows } = await on.pool.query('SELECT count(*)::int AS n FROM user_companion_messages');
    expect(rows[0].n).toBe(2);
  });

  it('needs a session', async () => {
    const hers = await giveCompanion(aliceId);
    expect(
      (await on.app.inject({ method: 'GET', url: `/api/my-ai/${hers.id}/messages` })).statusCode,
    ).toBe(401);
    expect(
      (
        await on.app.inject({
          method: 'POST',
          url: `/api/my-ai/${hers.id}/messages`,
          payload: { body: 'hi' },
        })
      ).statusCode,
    ).toBe(401);
  });

  it('refuses an empty message rather than asking her to answer nothing', async () => {
    const hers = await giveCompanion(aliceId);
    for (const body of ['', '   ', 'x'.repeat(3000), 42, null]) {
      const res = await on.app.inject({
        method: 'POST',
        url: `/api/my-ai/${hers.id}/messages`,
        cookies: alice,
        payload: { body },
      });
      expect(res.statusCode, JSON.stringify(body).slice(0, 20)).toBe(400);
    }
    const { rows } = await on.pool.query('SELECT count(*)::int AS n FROM user_companion_messages');
    expect(rows[0].n).toBe(0);
  });

  it('will not talk to one who is still being made', async () => {
    const half = await giveCompanion(aliceId, { status: 'generating', withImage: false });
    const res = await on.app.inject({
      method: 'POST',
      url: `/api/my-ai/${half.id}/messages`,
      cookies: alice,
      payload: { body: 'Hello?' },
    });
    expect(res.statusCode).toBe(409);
  });

  /*
   * A FAILED companion still talks. Her attributes are all there — only her
   * picture is missing — and refusing would strand the user with nothing at
   * all for a companion they already paid to create.
   */
  it('talks to one whose picture failed', async () => {
    const hers = await giveCompanion(aliceId, { status: 'failed', withImage: false });
    const res = await on.app.inject({
      method: 'POST',
      url: `/api/my-ai/${hers.id}/messages`,
      cookies: alice,
      payload: { body: 'Are you there?' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('goes when she goes', async () => {
    const hers = await giveCompanion(aliceId);
    await on.app.inject({
      method: 'POST',
      url: `/api/my-ai/${hers.id}/messages`,
      cookies: alice,
      payload: { body: 'Hello you' },
    });

    await on.app.inject({ method: 'DELETE', url: `/api/my-ai/${hers.id}`, cookies: alice });

    const { rows } = await on.pool.query('SELECT count(*)::int AS n FROM user_companion_messages');
    expect(rows[0].n).toBe(0);
  });
});

describe('what the model is told about her', () => {
  /*
   * Only five fields reach the prompt: name, bio, personality, interests and
   * age. Everything about a companion has to travel in those, because
   * `prompt-builder` deliberately renders neither a stored system prompt nor
   * a conversation style — both are behavioural, and character data issuing
   * behavioural orders is the bug that made production write scenes instead
   * of having conversations.
   */
  it('describes her as facts, never as instructions', () => {
    const companion = {
      id: 'c1',
      name: 'Maya',
      age: 24,
      attributes: {
        ethnicity: 'latina', hairColour: 'blonde', hairStyle: 'wavy', eyeColour: 'green',
        figure: 'curvy', breasts: 'large', butt: 'medium', personality: 'flirty',
        relationship: 'girlfriend', job: 'nurse', interests: ['yoga', 'travel'],
      },
    } as never;

    const character = companionAsCharacter(companion);
    expect(character.displayName).toBe('Maya');
    expect(character.age).toBe(24);
    expect(character.shortBio).toContain('blonde wavy hair');
    expect(character.shortBio).toContain('green eyes');
    expect(character.shortBio).toContain('nurse');
    expect(character.personality).toBe("She's flirty.");
    expect(character.interests.length).toBe(2);

    // Behavioural slots left empty on purpose: the builder ignores them, and
    // writing into an ignored slot is how a prompt quietly stops matching.
    expect(character.conversationStyle).toBe('');
  });

  it('states her age as verified, which for a companion it is', () => {
    // Four independent gates stop one existing under 21: the wizard, the
    // shared validator, a database CHECK and the provider itself.
    const context = companionReplyContext(
      { id: 'c1', name: 'Maya', age: 24, attributes: { ethnicity: 'latina', hairColour: 'blonde', hairStyle: 'wavy', eyeColour: 'green', figure: 'curvy', breasts: 'large', butt: 'medium', personality: 'flirty', relationship: 'girlfriend', job: 'nurse', interests: [] } } as never,
      [],
      'hello',
    );
    expect(context.verifiedAdultAgeBand).toBe('24');
    expect(context.systemPrompt).toBe('');
    expect(context.channel).toBe('text');
    expect(context.priorMessageCount).toBe(0);
  });
});
