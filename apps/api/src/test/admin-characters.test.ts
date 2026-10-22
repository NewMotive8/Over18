import { readdir } from 'node:fs/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  characters,
  characterVisualAssets,
  characterVisualIdentities,
  contentRequirements,
  users,
} from '../db/schema.js';
import { seedCharacters } from '../db/seed.js';
import { DEFAULT_LIVE_CALL_VOICE, VOICE_CATALOGUE } from '@over18/shared';
import { resolveVoice } from '../voice/voice-catalogue.js';
import type {
  ProfileAuthor,
  ProfileAuthorInput,
} from '../services/character-profile-service.js';
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
 * US-101 — Character, Visual Identity and Primary Reference management.
 *
 * No migration was needed for this ticket: the schema already modelled
 * versioned identities (with a partial unique index enforcing one active
 * version per character) and identity-scoped assets. These tests therefore
 * prove the RULES hold through the HTTP surface, not that new columns exist.
 */

let ctx: TestContext;

/**
 * Autofill stub. Records what it was asked, and echoes the variation seed back
 * inside the text, so a test can prove that re-rolling really does ask for
 * something different rather than replaying a cached answer.
 */
const authorCalls: ProfileAuthorInput[] = [];
const stubAuthor: ProfileAuthor = async (input) => {
  authorCalls.push(input);
  return {
    displayName: input.displayName,
    shortBio: `bio ${input.variationSeed}`,
    personality: 'wry',
    conversationStyle: 'asks questions back',
    systemPrompt: `You are ${input.displayName}, a fictional adult woman.`,
    interests: ['astronomy', 'jazz'],
  };
};

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const DNA = { apparentAgeBand: 'adult', hair: 'dark, shoulder length', eyes: 'green' };

const VALID_CHARACTER = {
  name: 'nova',
  displayName: 'Nova',
  shortBio: 'Night-shift astronomer with a dry sense of humour.',
  personality: 'Curious, wry, unhurried.',
  conversationStyle: 'Asks questions back. Never lectures.',
  systemPrompt: 'You are Nova, a fictional adult woman.',
  interests: ['astronomy', 'jazz'],
  // Complete means complete: she is created live, and live needs an age.
  age: 29,
};

beforeAll(async () => {
  migrateTestDb();
  ctx = await createTestContext({ profileAuthor: stubAuthor });
});
afterAll(async () => destroyTestContext(ctx));
beforeEach(async () => {
  await truncateAll(ctx);
  await seedCharacters(ctx.db);
  authorCalls.length = 0;
});

async function login(email: string, admin: boolean) {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email, password: 'us101-test-pass1' },
  });
  const c = extractSessionCookie(res)!;
  if (admin) await ctx.db.update(users).set({ role: 'admin' }).where(eq(users.email, email));
  return { cookies: { [c.name]: c.value }, userId: res.json().id as string };
}

const adminCookies = () => login('op.us101@example.com', true).then((r) => r.cookies);

function multipart(bytes: Buffer, filename = 'ref.png', contentType = 'image/png') {
  const boundary = '----us101boundary';
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: ${contentType}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    payload: Buffer.concat([head, bytes, tail]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

/** Multipart with text fields BEFORE the file — and one test sends them after. */
function multipartWith(
  fields: Record<string, string>,
  bytes: Buffer,
  { filename = 'her.png', contentType = 'image/png', fieldsLast = false } = {},
) {
  const boundary = '----us101quick';
  const fieldParts = Object.entries(fields)
    .map(([k, v]) => `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`)
    .join('');
  const filePart =
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
    `Content-Type: ${contentType}\r\n\r\n`;
  const payload = fieldsLast
    ? Buffer.concat([
        Buffer.from(filePart),
        bytes,
        Buffer.from(`\r\n${fieldParts}--${boundary}--\r\n`),
      ])
    : Buffer.concat([
        Buffer.from(fieldParts + filePart),
        bytes,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
  return {
    payload,
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

const quickCreate = (
  cookies: Record<string, string>,
  fields: Record<string, string> = { name: 'nova', displayName: 'Nova' },
  bytes: Buffer = PNG,
  options?: Parameters<typeof multipartWith>[2],
) => {
  const { payload, headers } = multipartWith(fields, bytes, options);
  return ctx.app.inject({ method: 'POST', url: '/admin/characters/quick', headers, payload, cookies });
};

/** Every file currently under the test media root — used to prove nothing is orphaned. */
async function storedFileCount(): Promise<number> {
  const entries = await readdir(testEnv.media.storageDir, {
    recursive: true,
    withFileTypes: true,
  }).catch(() => []);
  return entries.filter((e) => e.isFile()).length;
}

const createCharacter = (cookies: Record<string, string>, overrides = {}) =>
  ctx.app.inject({
    method: 'POST',
    url: '/admin/characters',
    payload: { ...VALID_CHARACTER, ...overrides },
    cookies,
  });

const createIdentity = (
  cookies: Record<string, string>,
  characterId: string,
  body: Record<string, unknown> = { visualDna: DNA },
) =>
  ctx.app.inject({
    method: 'POST',
    url: `/admin/characters/${characterId}/identities`,
    payload: body,
    cookies,
  });

const activate = (cookies: Record<string, string>, identityId: string) =>
  ctx.app.inject({ method: 'POST', url: `/admin/identities/${identityId}/activate`, cookies });

/* ------------------------------------------------------------------ *
 * Characters
 * ------------------------------------------------------------------ */

describe('character creation and editing', () => {
  it('creates a character with only the fields the schema already has', async () => {
    const cookies = await adminCookies();
    const res = await createCharacter(cookies);
    expect(res.statusCode).toBe(201);

    const body = res.json();
    expect(body.name).toBe('nova');
    expect(body.displayName).toBe('Nova');
    expect(body.interests).toEqual(['astronomy', 'jazz']);
    expect(body.status).toBe('active');
    // Admin sees system_prompt — it is required to make a usable character.
    expect(body.systemPrompt).toBe(VALID_CHARACTER.systemPrompt);
  });

  it('the new character appears in the admin list with identity readiness', async () => {
    const cookies = await adminCookies();
    await createCharacter(cookies);

    const list = (await ctx.app.inject({ method: 'GET', url: '/admin/characters', cookies })).json();
    const nova = list.find((c: { name: string }) => c.name === 'nova');
    expect(nova).toBeDefined();
    expect(nova.activeIdentityVersion).toBeNull();
    expect(nova.identityVersionCount).toBe(0);
    expect(nova.primaryReferenceCount).toBe(0);
  });

  it('edits a character', async () => {
    const cookies = await adminCookies();
    const id = (await createCharacter(cookies)).json().id;

    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/admin/characters/${id}`,
      payload: { displayName: 'Nova Reyes', interests: ['astronomy'] },
      cookies,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().displayName).toBe('Nova Reyes');
    expect(res.json().interests).toEqual(['astronomy']);
    // Untouched fields survive a partial update.
    expect(res.json().systemPrompt).toBe(VALID_CHARACTER.systemPrompt);
  });

  it('rejects an invalid slug and a missing required field', async () => {
    const cookies = await adminCookies();
    expect((await createCharacter(cookies, { name: 'Not A Slug' })).statusCode).toBe(400);
    expect((await createCharacter(cookies, { shortBio: '   ' })).statusCode).toBe(400);
    expect((await createCharacter(cookies, { systemPrompt: '' })).statusCode).toBe(400);
  });

  it('refuses a duplicate name with 409, not a 500', async () => {
    const cookies = await adminCookies();
    expect((await createCharacter(cookies)).statusCode).toBe(201);
    const second = await createCharacter(cookies, { displayName: 'Another' });
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toBe('name_taken');
  });

  it('a created character is immediately visible on the PUBLIC api', async () => {
    // Proves this writes real characters, not an admin-only shadow record.
    const cookies = await adminCookies();
    const id = (await createCharacter(cookies)).json().id;
    const publicList = (await ctx.app.inject({ method: 'GET', url: '/api/characters' })).json();
    expect(publicList.some((c: { id: string }) => c.id === id)).toBe(true);
    // ...but system_prompt still never leaves the admin surface.
    expect(JSON.stringify(publicList)).not.toContain('You are Nova');
  });
});

/* ------------------------------------------------------------------ *
 * Visual identity versioning
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * Her live-call voice
 * ------------------------------------------------------------------ */

describe('assigning a live-call voice', () => {
  /**
   * THE COLUMN HAD NO WRITER UNTIL NOW, which is why every character sounded
   * the same: `live_call_voice` was read by the call path and set by nothing,
   * so all 40 took `resolveVoice`'s default. These cover the way in.
   */
  it('accepts every voice in the published catalogue', async () => {
    const cookies = await adminCookies();
    const id = (await createCharacter(cookies)).json().id;

    for (const voice of VOICE_CATALOGUE) {
      const res = await ctx.app.inject({
        method: 'PATCH',
        url: `/admin/characters/${id}`,
        payload: { liveCallVoice: voice },
        cookies,
      });
      expect(res.statusCode, voice).toBe(200);
      expect(res.json().liveCallVoice, voice).toBe(voice);
    }
  });

  it('rejects a voice the catalogue does not have', async () => {
    const cookies = await adminCookies();
    const id = (await createCharacter(cookies)).json().id;

    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/admin/characters/${id}`,
      payload: { liveCallVoice: 'Bob' },
      cookies,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_character');
    expect(res.json().field).toBe('liveCallVoice');
  });

  /** Provider identifiers, so a near miss is a miss. */
  it.each(['serena', 'SERENA', 'hana'])('rejects the wrong case: %s', async (voice) => {
    const cookies = await adminCookies();
    const id = (await createCharacter(cookies)).json().id;

    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/admin/characters/${id}`,
      payload: { liveCallVoice: voice },
      cookies,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().field).toBe('liveCallVoice');
  });

  it.each([
    ['null', null],
    ['an empty string', ''],
    ['whitespace', '   '],
  ])('clears the assignment with %s', async (_label, value) => {
    const cookies = await adminCookies();
    const id = (await createCharacter(cookies)).json().id;

    await ctx.app.inject({
      method: 'PATCH',
      url: `/admin/characters/${id}`,
      payload: { liveCallVoice: 'Hana' },
      cookies,
    });
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/admin/characters/${id}`,
      payload: { liveCallVoice: value },
      cookies,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().liveCallVoice).toBeNull();
  });

  /** A partial update must not wipe a field it says nothing about. */
  it('leaves the assignment alone when the key is absent', async () => {
    const cookies = await adminCookies();
    const id = (await createCharacter(cookies)).json().id;

    await ctx.app.inject({
      method: 'PATCH',
      url: `/admin/characters/${id}`,
      payload: { liveCallVoice: 'Kiki' },
      cookies,
    });
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/admin/characters/${id}`,
      payload: { displayName: 'Nova Reyes' },
      cookies,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().displayName).toBe('Nova Reyes');
    expect(res.json().liveCallVoice).toBe('Kiki');
  });

  it('reports null for a character with no assignment', async () => {
    const cookies = await adminCookies();
    const id = (await createCharacter(cookies)).json().id;

    const res = await ctx.app.inject({ method: 'GET', url: `/admin/characters/${id}`, cookies });
    expect(res.statusCode).toBe(200);
    expect(res.json().character.liveCallVoice).toBeNull();
  });

  /**
   * THE REGRESSION THIS FEATURE EXISTS TO PREVENT. Storing a voice is only
   * worth anything if it reaches the provider request, and an unassigned
   * character must still fall back rather than fail.
   */
  it('resolves an assigned voice, and still defaults without one', async () => {
    const cookies = await adminCookies();
    const id = (await createCharacter(cookies)).json().id;

    const unassigned = await ctx.db.select().from(characters).where(eq(characters.id, id));
    expect(unassigned[0]!.liveCallVoice).toBeNull();
    expect(resolveVoice(unassigned[0]!.liveCallVoice)).toBe(DEFAULT_LIVE_CALL_VOICE);

    await ctx.app.inject({
      method: 'PATCH',
      url: `/admin/characters/${id}`,
      payload: { liveCallVoice: 'Katerina' },
      cookies,
    });

    const assigned = await ctx.db.select().from(characters).where(eq(characters.id, id));
    expect(assigned[0]!.liveCallVoice).toBe('Katerina');
    expect(resolveVoice(assigned[0]!.liveCallVoice)).toBe('Katerina');
  });
});

describe('visual identity versions', () => {
  it('creates v1 as a draft, then v2 without touching v1', async () => {
    const cookies = await adminCookies();
    const characterId = (await createCharacter(cookies)).json().id;

    const v1 = await createIdentity(cookies, characterId);
    expect(v1.statusCode).toBe(201);
    expect(v1.json().version).toBe(1);
    expect(v1.json().status).toBe('draft');

    const v2 = await createIdentity(cookies, characterId, { visualDna: DNA, label: 'softer look' });
    expect(v2.json().version).toBe(2);
    expect(v2.json().label).toBe('softer look');

    const versions = (
      await ctx.app.inject({
        method: 'GET',
        url: `/admin/characters/${characterId}/identities`,
        cookies,
      })
    ).json();
    expect(versions.map((v: { version: number }) => v.version)).toEqual([2, 1]);
  });

  it('duplicates an existing version as the next version, leaving the source intact', async () => {
    const cookies = await adminCookies();
    const characterId = (await createCharacter(cookies)).json().id;
    const v1 = (await createIdentity(cookies, characterId)).json();

    const v2 = await createIdentity(cookies, characterId, {
      fromIdentityId: v1.id,
      label: 'from v1',
    });
    expect(v2.statusCode).toBe(201);
    expect(v2.json().version).toBe(2);
    expect(v2.json().visualDna).toEqual(v1.visualDna);
    expect(v2.json().id).not.toBe(v1.id);
  });

  it('rejects Visual DNA that does not denote an adult', async () => {
    const cookies = await adminCookies();
    const characterId = (await createCharacter(cookies)).json().id;
    const res = await createIdentity(cookies, characterId, {
      visualDna: { apparentAgeBand: 'teen' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_visual_dna');
  });

  it("cannot seed from another character's version", async () => {
    const cookies = await adminCookies();
    const a = (await createCharacter(cookies)).json().id;
    const b = (await createCharacter(cookies, { name: 'orion', displayName: 'Orion' })).json().id;
    const aV1 = (await createIdentity(cookies, a)).json();

    expect((await createIdentity(cookies, b, { fromIdentityId: aV1.id })).statusCode).toBe(404);
  });
});

describe('exactly one active version', () => {
  it('activating v2 retires v1 and leaves exactly one active', async () => {
    const cookies = await adminCookies();
    const characterId = (await createCharacter(cookies)).json().id;
    const v1 = (await createIdentity(cookies, characterId)).json();
    const v2 = (await createIdentity(cookies, characterId)).json();

    expect((await activate(cookies, v1.id)).json().status).toBe('active');
    expect((await activate(cookies, v2.id)).json().status).toBe('active');

    const rows = await ctx.db
      .select()
      .from(characterVisualIdentities)
      .where(eq(characterVisualIdentities.characterId, characterId));
    expect(rows.filter((r) => r.status === 'active')).toHaveLength(1);
    expect(rows.find((r) => r.id === v2.id)!.status).toBe('active');
    expect(rows.find((r) => r.id === v1.id)!.status).toBe('retired');
  });

  it('history survives activation — the old version is retired, never deleted', async () => {
    const cookies = await adminCookies();
    const characterId = (await createCharacter(cookies)).json().id;
    const v1 = (await createIdentity(cookies, characterId, {
      visualDna: { ...DNA, hair: 'original' },
      label: 'launch',
    })).json();
    const v2 = (await createIdentity(cookies, characterId)).json();

    await activate(cookies, v1.id);
    await activate(cookies, v2.id);

    const versions = (
      await ctx.app.inject({
        method: 'GET',
        url: `/admin/characters/${characterId}/identities`,
        cookies,
      })
    ).json();
    expect(versions).toHaveLength(2);
    const retired = versions.find((v: { id: string }) => v.id === v1.id);
    expect(retired.status).toBe('retired');
    expect(retired.label).toBe('launch');
    // The old DNA is intact, not overwritten by the newer version.
    expect(retired.visualDna.hair).toBe('original');
  });

  it('rolling back to a retired version re-activates it and retires the newer one', async () => {
    const cookies = await adminCookies();
    const characterId = (await createCharacter(cookies)).json().id;
    const v1 = (await createIdentity(cookies, characterId)).json();
    const v2 = (await createIdentity(cookies, characterId)).json();

    await activate(cookies, v1.id);
    await activate(cookies, v2.id);
    expect((await activate(cookies, v1.id)).json().status).toBe('active');

    const detail = (
      await ctx.app.inject({ method: 'GET', url: `/admin/characters/${characterId}`, cookies })
    ).json();
    expect(detail.activeIdentity.id).toBe(v1.id);
    expect(detail.identities).toHaveLength(2);
  });

  it('active identity retrieval reports the active version and nothing else', async () => {
    const cookies = await adminCookies();
    const characterId = (await createCharacter(cookies)).json().id;
    const v1 = (await createIdentity(cookies, characterId)).json();

    const before = (
      await ctx.app.inject({ method: 'GET', url: `/admin/characters/${characterId}`, cookies })
    ).json();
    expect(before.activeIdentity).toBeNull(); // draft-only

    await activate(cookies, v1.id);
    const after = (
      await ctx.app.inject({ method: 'GET', url: `/admin/characters/${characterId}`, cookies })
    ).json();
    expect(after.activeIdentity.id).toBe(v1.id);
    expect(after.activeIdentity.isActive).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * Her confirmed age
 * ------------------------------------------------------------------ */

describe('the confirmed age', () => {
  const patch = (cookies: Record<string, string>, id: string, body: unknown) =>
    ctx.app.inject({ method: 'PATCH', url: `/admin/characters/${id}`, cookies, payload: body as never });

  it('starts unset, and unset is a real answer rather than a default', async () => {
    const cookies = await adminCookies();
    // A DRAFT: created from a name alone, with no age and not live.
    const id = (await createCharacter(cookies, { age: null, status: 'inactive' })).json().id;
    const got = await ctx.app.inject({ method: 'GET', url: `/admin/characters/${id}`, cookies });
    // Never 26, never a band-derived number: Admin reports what is KNOWN.
    expect(got.json().character.age).toBeNull();
  });

  it('stores an adult age and reads it back', async () => {
    const cookies = await adminCookies();
    const id = (await createCharacter(cookies)).json().id;
    expect((await patch(cookies, id, { age: 32 })).statusCode).toBe(200);
    const got = await ctx.app.inject({ method: 'GET', url: `/admin/characters/${id}`, cookies });
    expect(got.json().character.age).toBe(32);
  });

  it('clears it again on a draft — a wrong age must be removable', async () => {
    const cookies = await adminCookies();
    const id = (await createCharacter(cookies, { age: null, status: 'inactive' })).json().id;
    await patch(cookies, id, { age: 32 });
    expect((await patch(cookies, id, { age: null })).statusCode).toBe(200);
    const got = await ctx.app.inject({ method: 'GET', url: `/admin/characters/${id}`, cookies });
    expect(got.json().character.age).toBeNull();
  });

  /**
   * BOTH DIRECTIONS OF THE SAME RULE. Going live without an age is refused,
   * and so is taking the age away from someone already live -- otherwise the
   * gate would be a formality anyone could step around in a second request.
   */
  it('refuses to leave a LIVE character without an age', async () => {
    const cookies = await adminCookies();
    const id = (await createCharacter(cookies)).json().id; // created live, age 29
    const cleared = await patch(cookies, id, { age: null });
    expect(cleared.statusCode).toBe(400);
    expect(cleared.json().field).toBe('age');

    // Taking her offline first makes it an ordinary edit again.
    expect((await patch(cookies, id, { status: 'inactive' })).statusCode).toBe(200);
    expect((await patch(cookies, id, { age: null })).statusCode).toBe(200);
  });

  it('refuses to publish a character who has no confirmed age', async () => {
    const cookies = await adminCookies();
    const id = (await createCharacter(cookies, { age: null, status: 'inactive' })).json().id;
    const res = await patch(cookies, id, { status: 'active' });
    expect(res.statusCode).toBe(400);
    expect(res.json().field).toBe('age');

    // Age and status together, which is what the Publish button sends.
    expect((await patch(cookies, id, { status: 'active', age: 24 })).statusCode).toBe(200);
  });

  it('leaves it alone when the patch does not mention it', async () => {
    const cookies = await adminCookies();
    const id = (await createCharacter(cookies)).json().id;
    await patch(cookies, id, { age: 29 });
    await patch(cookies, id, { personality: 'Changed something else.' });
    const got = await ctx.app.inject({ method: 'GET', url: `/admin/characters/${id}`, cookies });
    expect(got.json().character.age).toBe(29);
  });

  /**
   * REFUSED, NEVER COERCED. Rounding 17.5 or reading "twenty" as 20 would put
   * a number nobody typed onto a public card, and on an adult product this is
   * the one number that must never be wrong.
   */
  it('refuses a minor, a fraction and anything that is not a number', async () => {
    const cookies = await adminCookies();
    const id = (await createCharacter(cookies, { age: null, status: 'inactive' })).json().id;
    for (const bad of [17, 0, -1, 25.5, '32', 'twenty', true, {}, []]) {
      const res = await patch(cookies, id, { age: bad });
      expect(res.statusCode, JSON.stringify(bad)).toBe(400);
      expect(res.json().field, JSON.stringify(bad)).toBe('age');
    }
    const got = await ctx.app.inject({ method: 'GET', url: `/admin/characters/${id}`, cookies });
    expect(got.json().character.age).toBeNull();
  });

  it('accepts exactly 18', async () => {
    const cookies = await adminCookies();
    const id = (await createCharacter(cookies)).json().id;
    expect((await patch(cookies, id, { age: 18 })).statusCode).toBe(200);
  });

  /**
   * THE DATABASE IS THE LAST WORD. The API check above is the friendly half;
   * this proves the guarantee survives a writer that bypasses it.
   */
  it('is refused by the database itself, not only by the API', async () => {
    const cookies = await adminCookies();
    const id = (await createCharacter(cookies)).json().id;
    await expect(
      ctx.pool.query('UPDATE characters SET age = $1 WHERE id = $2', [16, id]),
    ).rejects.toThrow(/characters_age_adult|check constraint/i);
  });
});

/* ------------------------------------------------------------------ *
 * Primary references
 * ------------------------------------------------------------------ */

describe('primary references', () => {
  async function characterWithActiveIdentity(cookies: Record<string, string>) {
    const characterId = (await createCharacter(cookies)).json().id;
    const identity = (await createIdentity(cookies, characterId)).json();
    await activate(cookies, identity.id);
    return { characterId, identityId: identity.id as string };
  }

  /**
   * THE DEAD END. A character saved WITHOUT a photo gets no identity version
   * on purpose, and the only reference route was scoped to an identity id --
   * so there was nothing to post to, and her main image could never be
   * supplied at all. The admin page could only tell the operator to activate
   * a version that did not exist.
   *
   * These pin the way out: the upload is addressed to the CHARACTER, and the
   * version she lacks is provisioned by the upload itself.
   */
  describe('a character who has no visual identity version yet', () => {
    it('accepts her main image and provisions her first version with it', async () => {
      const cookies = await adminCookies();
      const characterId = (await createCharacter(cookies)).json().id;

      // She genuinely has none -- that is the whole premise.
      const before = (
        await ctx.app.inject({ method: 'GET', url: `/admin/characters/${characterId}`, cookies })
      ).json();
      expect(before.identities).toHaveLength(0);
      expect(before.activeIdentity).toBeNull();

      const { payload, headers } = multipart(PNG);
      const res = await ctx.app.inject({
        method: 'POST',
        url: `/admin/characters/${characterId}/references`,
        headers,
        payload,
        cookies,
      });

      expect(res.statusCode).toBe(201);
      const ref = res.json();
      expect(ref.kind).toBe('reference');
      expect(ref.isPrimary).toBe(true);
      expect(ref.status).toBe('approved');
      expect(ref.characterId).toBe(characterId);
      expect(ref.visualIdentityId).toBeTruthy();

      // v1 now exists, is ACTIVE, and owns the image.
      const after = (
        await ctx.app.inject({ method: 'GET', url: `/admin/characters/${characterId}`, cookies })
      ).json();
      expect(after.identities).toHaveLength(1);
      expect(after.activeIdentity).not.toBeNull();
      expect(after.activeIdentity.version).toBe(1);
      expect(after.activeIdentity.id).toBe(ref.visualIdentityId);
      expect(after.primaryReferences).toHaveLength(1);
      expect(after.primaryReferences[0].assetId).toBe(ref.assetId);

      // Still no storage internals on the way out.
      expect(res.payload).not.toContain('storagePath');
      expect(res.payload).not.toContain('provenance');
    });

    /**
     * ONE version, not one per upload: the second image must join the version
     * the first one created rather than quietly starting a v2 and orphaning
     * the portrait that was already there.
     */
    it('puts a second image on the same version rather than making another', async () => {
      const cookies = await adminCookies();
      const characterId = (await createCharacter(cookies)).json().id;

      const upload = async () => {
        const { payload, headers } = multipart(PNG);
        return ctx.app.inject({
          method: 'POST',
          url: `/admin/characters/${characterId}/references`,
          headers,
          payload,
          cookies,
        });
      };
      const first = (await upload()).json();
      const second = (await upload()).json();

      expect(second.visualIdentityId).toBe(first.visualIdentityId);
      const detail = (
        await ctx.app.inject({ method: 'GET', url: `/admin/characters/${characterId}`, cookies })
      ).json();
      expect(detail.identities).toHaveLength(1);
      expect(detail.primaryReferences).toHaveLength(2);
    });

    /** With a version already active, it is used -- never a fresh one. */
    it('uses her ACTIVE version when she already has one', async () => {
      const cookies = await adminCookies();
      const { characterId, identityId } = await characterWithActiveIdentity(cookies);
      const { payload, headers } = multipart(PNG);

      const ref = (
        await ctx.app.inject({
          method: 'POST',
          url: `/admin/characters/${characterId}/references`,
          headers,
          payload,
          cookies,
        })
      ).json();

      expect(ref.visualIdentityId).toBe(identityId);
      const detail = (
        await ctx.app.inject({ method: 'GET', url: `/admin/characters/${characterId}`, cookies })
      ).json();
      expect(detail.identities).toHaveLength(1);
    });

    it('404s for a character that does not exist, and rejects a non-multipart body', async () => {
      const cookies = await adminCookies();
      const missing = await ctx.app.inject({
        method: 'POST',
        url: '/admin/characters/00000000-0000-4000-8000-000000000001/references',
        headers: (() => multipart(PNG).headers)(),
        payload: multipart(PNG).payload,
        cookies,
      });
      expect(missing.statusCode).toBe(404);

      const characterId = (await createCharacter(cookies)).json().id;
      const notMultipart = await ctx.app.inject({
        method: 'POST',
        url: `/admin/characters/${characterId}/references`,
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ file: 'nope' }),
        cookies,
      });
      expect(notMultipart.statusCode).toBe(400);
    });
  });

  it('uploads a reference and links it to the identity version as primary', async () => {
    const cookies = await adminCookies();
    const { characterId, identityId } = await characterWithActiveIdentity(cookies);
    const { payload, headers } = multipart(PNG);

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/admin/identities/${identityId}/references`,
      headers,
      payload,
      cookies,
    });
    expect(res.statusCode).toBe(201);
    const ref = res.json();
    expect(ref.kind).toBe('reference');
    expect(ref.isPrimary).toBe(true);
    expect(ref.status).toBe('approved');
    // The relationship is explicit — bound to the VERSION, not just the character.
    expect(ref.visualIdentityId).toBe(identityId);
    expect(ref.characterId).toBe(characterId);
    expect(ref.mediaType).toBe('image');

    // Never leaks storage internals.
    expect(res.payload).not.toContain('storagePath');
    expect(res.payload).not.toContain('provenance');
  });

  it('the primary set shows on character detail and is fetchable', async () => {
    const cookies = await adminCookies();
    const { characterId, identityId } = await characterWithActiveIdentity(cookies);
    const { payload, headers } = multipart(PNG);
    const ref = (
      await ctx.app.inject({
        method: 'POST',
        url: `/admin/identities/${identityId}/references`,
        headers,
        payload,
        cookies,
      })
    ).json();

    const detail = (
      await ctx.app.inject({ method: 'GET', url: `/admin/characters/${characterId}`, cookies })
    ).json();
    expect(detail.primaryReferences).toHaveLength(1);
    expect(detail.primaryReferences[0].assetId).toBe(ref.assetId);

    const file = await ctx.app.inject({ method: 'GET', url: ref.fileUrl, cookies });
    expect(file.statusCode).toBe(200);
    expect(file.rawPayload.equals(PNG)).toBe(true);
  });

  it('removing an asset from the primary set keeps the row and the file', async () => {
    const cookies = await adminCookies();
    const { characterId, identityId } = await characterWithActiveIdentity(cookies);
    const { payload, headers } = multipart(PNG);
    const ref = (
      await ctx.app.inject({
        method: 'POST',
        url: `/admin/identities/${identityId}/references`,
        headers,
        payload,
        cookies,
      })
    ).json();

    const removed = await ctx.app.inject({
      method: 'DELETE',
      url: `/admin/references/${ref.assetId}/primary`,
      cookies,
    });
    expect(removed.statusCode).toBe(200);
    expect(removed.json().isPrimary).toBe(false);

    const detail = (
      await ctx.app.inject({ method: 'GET', url: `/admin/characters/${characterId}`, cookies })
    ).json();
    expect(detail.primaryReferences).toHaveLength(0);

    // The asset still exists — un-linking is not deletion.
    const listed = (
      await ctx.app.inject({
        method: 'GET',
        url: `/admin/identities/${identityId}/references`,
        cookies,
      })
    ).json();
    expect(listed).toHaveLength(1);
  });

  it('references follow their version: activating another version changes the primary set', async () => {
    const cookies = await adminCookies();
    const { characterId, identityId } = await characterWithActiveIdentity(cookies);
    const { payload, headers } = multipart(PNG);
    await ctx.app.inject({
      method: 'POST',
      url: `/admin/identities/${identityId}/references`,
      headers,
      payload,
      cookies,
    });

    const v2 = (await createIdentity(cookies, characterId)).json();
    await activate(cookies, v2.id);

    const detail = (
      await ctx.app.inject({ method: 'GET', url: `/admin/characters/${characterId}`, cookies })
    ).json();
    // v2 has no references of its own yet — v1's are not silently inherited.
    expect(detail.activeIdentity.id).toBe(v2.id);
    expect(detail.primaryReferences).toHaveLength(0);

    // ...and v1 still owns its own, so rolling back restores the set.
    const v1Refs = (
      await ctx.app.inject({
        method: 'GET',
        url: `/admin/identities/${identityId}/references`,
        cookies,
      })
    ).json();
    expect(v1Refs).toHaveLength(1);
  });

  it('refuses to make GENERATED content primary — that belongs to review', async () => {
    const cookies = await adminCookies();
    const { characterId, identityId } = await characterWithActiveIdentity(cookies);

    // An ordinary Library upload is kind='generated'.
    const boundary = '----libboundary';
    const head = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="characterId"\r\n\r\n${characterId}\r\n` +
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="g.png"\r\n` +
        `Content-Type: image/png\r\n\r\n`,
    );
    const generated = (
      await ctx.app.inject({
        method: 'POST',
        url: '/admin/content/uploads',
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        payload: Buffer.concat([head, PNG, Buffer.from(`\r\n--${boundary}--\r\n`)]),
        cookies,
      })
    ).json();

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/admin/references/${generated.assetId}/primary`,
      cookies,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('not_a_reference');
    expect(identityId).toBeTruthy();
  });
});

/* ------------------------------------------------------------------ *
 * Phase 1 — quick create (name + image)
 * ------------------------------------------------------------------ */

describe('quick create', () => {
  it('a name and one image produce a character, an active v1, and a primary reference', async () => {
    const cookies = await adminCookies();
    const res = await quickCreate(cookies);
    expect(res.statusCode).toBe(201);

    const { character, identity, primaryReference } = res.json();
    expect(character.name).toBe('nova');
    expect(character.displayName).toBe('Nova');
    expect(identity.version).toBe(1);
    expect(identity.isActive).toBe(true);
    expect(primaryReference.isPrimary).toBe(true);
    expect(primaryReference.kind).toBe('reference');
    expect(primaryReference.visualIdentityId).toBe(identity.id);
    expect(primaryReference.mediaType).toBe('image');

    // The detail endpoint agrees — this is real state, not a synthesised reply.
    const detail = (
      await ctx.app.inject({ method: 'GET', url: `/admin/characters/${character.id}`, cookies })
    ).json();
    expect(detail.activeIdentity.id).toBe(identity.id);
    expect(detail.primaryReferences).toHaveLength(1);

    // ...and the bytes are actually served back.
    const file = await ctx.app.inject({ method: 'GET', url: primaryReference.fileUrl, cookies });
    expect(file.rawPayload.equals(PNG)).toBe(true);
  });

  it('reports the profile as incomplete, naming the fields still empty', async () => {
    const cookies = await adminCookies();
    const { character } = (await quickCreate(cookies)).json();
    expect(character.profileComplete).toBe(false);
    expect(character.missingProfileFields.sort()).toEqual([
      'age',
      'conversationStyle',
      'personality',
      'shortBio',
      'systemPrompt',
    ]);
  });

  it('does NOT duplicate the image into profile_image — one file, one asset row', async () => {
    const cookies = await adminCookies();
    const { character } = (await quickCreate(cookies)).json();

    // THE COLUMN, not the payload field. P0.2 made `profileImage` on the wire
    // the RESOLVED portrait, so asserting the payload would now assert the
    // opposite of what this test is about: the uploaded image is represented
    // once, as a canonical reference, and the legacy column is never written.
    const [row] = await ctx.db
      .select({ profileImage: characters.profileImage })
      .from(characters)
      .where(eq(characters.id, character.id));
    expect(row!.profileImage).toBeNull();

    const assets = await ctx.db
      .select()
      .from(characterVisualAssets)
      .where(eq(characterVisualAssets.characterId, character.id));
    expect(assets).toHaveLength(1);

    // ...and the portrait the payload carries IS that one asset, served by the
    // opaque media route rather than copied into a second column.
    expect(character.profileImage).toBe(`/api/media/assets/${assets[0]!.id}/file`);
  });

  it('stays OFF the public API until she is explicitly published', async () => {
    // An empty persona must never reach real users just because a file was
    // uploaded. Publishing is a separate, deliberate act.
    const cookies = await adminCookies();
    const { character } = (await quickCreate(cookies)).json();
    expect(character.status).toBe('inactive');

    const before = (await ctx.app.inject({ method: 'GET', url: '/api/characters' })).json();
    expect(before.some((c: { id: string }) => c.id === character.id)).toBe(false);

    // Going live needs a confirmed age; set it in the same patch, which is
    // exactly what the Publish button does.
    const published = await ctx.app.inject({
      method: 'PATCH',
      url: `/admin/characters/${character.id}`,
      payload: { status: 'active', age: 29 },
      cookies,
    });
    expect(published.statusCode).toBe(200);
    const after = (await ctx.app.inject({ method: 'GET', url: '/api/characters' })).json();
    expect(after.some((c: { id: string }) => c.id === character.id)).toBe(true);
  });

  it('rejects a non-image BEFORE creating anything', async () => {
    const cookies = await adminCookies();
    const res = await quickCreate(cookies, { name: 'nova' }, PNG, { contentType: 'video/mp4' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('unsupported_type');

    const list = (await ctx.app.inject({ method: 'GET', url: '/admin/characters', cookies })).json();
    expect(list.some((c: { name: string }) => c.name === 'nova')).toBe(false);
  });

  it('rejects a missing file and a bad name, and refuses a duplicate with 409', async () => {
    const cookies = await adminCookies();
    expect((await quickCreate(cookies, { name: 'Not A Slug' })).statusCode).toBe(400);
    expect((await quickCreate(cookies, { name: '' })).statusCode).toBe(400);
    expect((await quickCreate(cookies)).statusCode).toBe(201);
    expect((await quickCreate(cookies)).statusCode).toBe(409);
  });

  it('cannot orphan the uploaded image when creation fails', async () => {
    // The bytes are written only AFTER the character, identity and asset row
    // exist, so a rejected create leaves nothing behind on disk.
    const cookies = await adminCookies();
    expect((await quickCreate(cookies)).statusCode).toBe(201);
    const before = await storedFileCount();

    expect((await quickCreate(cookies)).statusCode).toBe(409); // duplicate name
    expect((await quickCreate(cookies, { name: 'Not A Slug' })).statusCode).toBe(400);
    expect(
      (await quickCreate(cookies, { name: 'orion' }, PNG, { contentType: 'video/mp4' })).statusCode,
    ).toBe(400);

    expect(await storedFileCount()).toBe(before);
  });

  it('reads fields sent AFTER the file — part order is the client\'s choice', async () => {
    const cookies = await adminCookies();
    const res = await quickCreate(cookies, { name: 'orion', displayName: 'Orion' }, PNG, {
      fieldsLast: true,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().character.displayName).toBe('Orion');
  });

  it('files the primary image under whichever requirement CLAIMS it in Settings', async () => {
    // Configuration decides, not code: the creation path asks which requirement
    // has assign_primary_reference set. Nothing here names a category, and the
    // expected key is read from the configuration rather than written down.
    const cookies = await adminCookies();
    const [claimant] = await ctx.db
      .select()
      .from(contentRequirements)
      .where(eq(contentRequirements.assignPrimaryReference, true));
    expect(claimant, 'a seeded requirement should claim the primary reference').toBeDefined();

    const plain = (await quickCreate(cookies)).json();
    const [plainRow] = await ctx.db
      .select()
      .from(characterVisualAssets)
      .where(eq(characterVisualAssets.id, plain.primaryReference.assetId));
    expect(plainRow!.requirementKey).toBe(claimant!.key);

    // ...and it therefore counts toward that requirement immediately.
    const status = (
      await ctx.app.inject({
        method: 'GET',
        url: `/admin/characters/${plain.character.id}/requirements`,
        cookies,
      })
    ).json();
    const entry = status.requirements.find((r: { key: string }) => r.key === claimant!.key);
    expect(entry.approved).toBe(1);
    expect(entry.satisfied).toBe(true);

    // An explicit key overrides the claim — and an unconfigured one is simply
    // not written, rather than becoming a dangling label on the asset.
    const [other] = await ctx.db
      .select()
      .from(contentRequirements)
      .where(eq(contentRequirements.assignPrimaryReference, false));
    const labelled = (
      await quickCreate(cookies, {
        name: 'orion',
        displayName: 'Orion',
        requirementKey: other!.key,
      })
    ).json();
    const [labelledRow] = await ctx.db
      .select()
      .from(characterVisualAssets)
      .where(eq(characterVisualAssets.id, labelled.primaryReference.assetId));
    expect(labelledRow!.requirementKey).toBe(other!.key);

    const bogus = (
      await quickCreate(cookies, {
        name: 'vega',
        displayName: 'Vega',
        requirementKey: 'not_a_configured_category',
      })
    ).json();
    const [bogusRow] = await ctx.db
      .select()
      .from(characterVisualAssets)
      .where(eq(characterVisualAssets.id, bogus.primaryReference.assetId));
    expect(bogusRow!.requirementKey).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * Phase 1 — Autofill
 * ------------------------------------------------------------------ */

describe('profile autofill', () => {
  it('returns a DRAFT and persists nothing', async () => {
    const cookies = await adminCookies();
    const { character } = (await quickCreate(cookies)).json();

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/admin/characters/${character.id}/autofill`,
      cookies,
    });
    expect(res.statusCode).toBe(200);
    const draft = res.json().draft;
    expect(draft.shortBio.length).toBeGreaterThan(0);
    expect(draft.interests).toEqual(['astronomy', 'jazz']);

    // The character on disk is untouched: still empty, still incomplete.
    const after = (
      await ctx.app.inject({ method: 'GET', url: `/admin/characters/${character.id}`, cookies })
    ).json();
    expect(after.character.shortBio).toBe('');
    expect(after.character.profileComplete).toBe(false);
  });

  it('re-rolling asks for something different each time', async () => {
    const cookies = await adminCookies();
    const { character } = (await quickCreate(cookies)).json();
    const url = `/admin/characters/${character.id}/autofill`;
    const first = (await ctx.app.inject({ method: 'POST', url, cookies })).json().draft;
    const second = (await ctx.app.inject({ method: 'POST', url, cookies })).json().draft;

    expect(authorCalls).toHaveLength(2);
    expect(authorCalls[0]!.variationSeed).not.toBe(authorCalls[1]!.variationSeed);
    expect(first.shortBio).not.toBe(second.shortBio);
    // It is told who she is, so the persona matches the name already chosen.
    expect(authorCalls[0]!.displayName).toBe('Nova');
  });

  /**
   * AUTOFILL CANNOT FINISH HER ANY MORE, AND THAT IS THE POINT. It writes
   * every text field, and the one field it cannot supply is her age -- which
   * has to be a person's decision, not a model's. So the profile is one step
   * from complete, and that step is a human confirming a number.
   */
  it('saving the draft fills every text field, leaving only the age to confirm', async () => {
    const cookies = await adminCookies();
    const { character } = (await quickCreate(cookies)).json();
    const url = `/admin/characters/${character.id}/autofill`;
    const draft = (await ctx.app.inject({ method: 'POST', url, cookies })).json().draft;

    const saved = await ctx.app.inject({
      method: 'PATCH',
      url: `/admin/characters/${character.id}`,
      payload: draft,
      cookies,
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().shortBio).toBe(draft.shortBio);
    expect(saved.json().missingProfileFields).toEqual(['age']);
    expect(saved.json().profileComplete).toBe(false);

    // And one confirmed age finishes her.
    const withAge = await ctx.app.inject({
      method: 'PATCH',
      url: `/admin/characters/${character.id}`,
      payload: { age: 29 },
      cookies,
    });
    expect(withAge.json().missingProfileFields).toEqual([]);
    expect(withAge.json().profileComplete).toBe(true);
  });

  it('404s for an unknown character rather than calling the model', async () => {
    const cookies = await adminCookies();
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/admin/characters/00000000-0000-4000-8000-000000000009/autofill',
      cookies,
    });
    expect(res.statusCode).toBe(404);
    expect(authorCalls).toHaveLength(0);
  });
});

describe('autofill when no AI is configured', () => {
  let bare: TestContext;
  beforeAll(async () => {
    bare = await createTestContext(); // no profileAuthor injected
  });
  afterAll(async () => destroyTestContext(bare));

  it('says so plainly instead of inventing a profile', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'noai.us101@example.com', password: 'us101-test-pass1' },
    });
    const c = extractSessionCookie(res)!;
    await ctx.db.update(users).set({ role: 'admin' }).where(eq(users.email, 'noai.us101@example.com'));
    const cookies = { [c.name]: c.value };

    const { character } = (await quickCreate(cookies)).json();
    // Same database, different app instance — one without an author wired in.
    const autofill = await bare.app.inject({
      method: 'POST',
      url: `/admin/characters/${character.id}/autofill`,
      cookies,
    });
    expect(autofill.statusCode).toBe(503);
    expect(autofill.json().error).toBe('ai_not_configured');
    expect(autofill.json().message).toContain('by hand');
  });
});

/* ------------------------------------------------------------------ *
 * Authorization
 * ------------------------------------------------------------------ */

describe('authorization boundaries', () => {
  it('every route requires authentication', async () => {
    const routes: Array<[string, string]> = [
      ['GET', '/admin/characters'],
      ['POST', '/admin/characters'],
      ['POST', '/admin/characters/quick'],
      ['POST', '/admin/characters/00000000-0000-4000-8000-000000000001/autofill'],
      ['GET', '/admin/characters/00000000-0000-4000-8000-000000000001'],
      ['PATCH', '/admin/characters/00000000-0000-4000-8000-000000000001'],
      ['GET', '/admin/characters/00000000-0000-4000-8000-000000000001/identities'],
      ['POST', '/admin/characters/00000000-0000-4000-8000-000000000001/identities'],
      ['POST', '/admin/identities/00000000-0000-4000-8000-000000000001/activate'],
      ['POST', '/admin/characters/00000000-0000-4000-8000-000000000001/references'],
      ['GET', '/admin/identities/00000000-0000-4000-8000-000000000001/references'],
      ['POST', '/admin/references/00000000-0000-4000-8000-000000000001/primary'],
      ['DELETE', '/admin/references/00000000-0000-4000-8000-000000000001/primary'],
    ];
    for (const [method, url] of routes) {
      const res = await ctx.app.inject({ method: method as 'GET', url });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it('a signed-in NON-admin is refused everywhere', async () => {
    const { cookies } = await login('regular.us101@example.com', false);
    expect((await ctx.app.inject({ method: 'GET', url: '/admin/characters', cookies })).statusCode).toBe(403);
    expect((await createCharacter(cookies)).statusCode).toBe(403);
    expect(
      (
        await ctx.app.inject({
          method: 'POST',
          url: '/admin/identities/00000000-0000-4000-8000-000000000001/activate',
          cookies,
        })
      ).statusCode,
    ).toBe(403);
  });

  it('a non-admin cannot quick-create or run Autofill', async () => {
    const { cookies } = await login('regular3.us101@example.com', false);
    expect((await quickCreate(cookies)).statusCode).toBe(403);
    expect(
      (
        await ctx.app.inject({
          method: 'POST',
          url: '/admin/characters/00000000-0000-4000-8000-000000000001/autofill',
          cookies,
        })
      ).statusCode,
    ).toBe(403);
    // Refused before anything ran — no character, and the model was never asked.
    expect(authorCalls).toHaveLength(0);
    const admin = await adminCookies();
    const list = (await ctx.app.inject({ method: 'GET', url: '/admin/characters', cookies: admin })).json();
    expect(list.some((c: { name: string }) => c.name === 'nova')).toBe(false);
  });

  it('a non-admin cannot create a character even with a valid body', async () => {
    const { cookies } = await login('regular2.us101@example.com', false);
    expect((await createCharacter(cookies)).statusCode).toBe(403);
    const admin = await adminCookies();
    const list = (await ctx.app.inject({ method: 'GET', url: '/admin/characters', cookies: admin })).json();
    expect(list.some((c: { name: string }) => c.name === 'nova')).toBe(false);
  });

  it('unknown and malformed ids read as 404, not 500', async () => {
    const cookies = await adminCookies();
    for (const url of [
      '/admin/characters/not-a-uuid',
      '/admin/characters/00000000-0000-4000-8000-000000000009',
      '/admin/characters/00000000-0000-4000-8000-000000000009/identities',
    ]) {
      expect((await ctx.app.inject({ method: 'GET', url, cookies })).statusCode).toBe(404);
    }
    expect(
      (
        await ctx.app.inject({
          method: 'POST',
          url: '/admin/identities/00000000-0000-4000-8000-000000000009/activate',
          cookies,
        })
      ).statusCode,
    ).toBe(404);
  });
});

/* ------------------------------------------------------------------ *
 * Where she lives
 * ------------------------------------------------------------------ */

describe('a character can be given a location', () => {
  const patch = (cookies: Record<string, string>, id: string, body: Record<string, unknown>) =>
    ctx.app.inject({ method: 'PATCH', url: `/admin/characters/${id}`, payload: body, cookies });

  const WARSAW = { countryCode: 'PL', region: 'Masovian', city: 'Warsaw', timezone: 'Europe/Warsaw' };

  it('is created with no location, and that is a valid character', async () => {
    const cookies = await adminCookies();
    const created = (await createCharacter(cookies)).json();

    expect(created).toMatchObject({ countryCode: null, region: null, city: null, timezone: null });
  });

  it('stores and returns every part', async () => {
    const cookies = await adminCookies();
    const id = (await createCharacter(cookies)).json().id as string;

    const res = await patch(cookies, id, WARSAW);

    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject(WARSAW);
  });

  /** "pl" and "PL" are the same country; the column holds one of them. */
  it('normalises a country code to upper case', async () => {
    const cookies = await adminCookies();
    const id = (await createCharacter(cookies)).json().id as string;

    expect((await patch(cookies, id, { countryCode: 'pl' })).json()).toMatchObject({ countryCode: 'PL' });
  });

  /** A country NAME in a code column would be stored and never work. */
  it('refuses a country name where a code belongs', async () => {
    const cookies = await adminCookies();
    const id = (await createCharacter(cookies)).json().id as string;

    const res = await patch(cookies, id, { countryCode: 'Poland' });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'invalid_character', field: 'countryCode' });
  });

  /**
   * A misspelt zone must be refused HERE. Accepted, it would silently produce
   * no time at prompt-build and nobody would know why.
   */
  it('refuses a time zone the platform does not know', async () => {
    const cookies = await adminCookies();
    const id = (await createCharacter(cookies)).json().id as string;

    const res = await patch(cookies, id, { timezone: 'Mars/Olympus' });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'invalid_character', field: 'timezone' });
  });

  it('accepts a real IANA zone', async () => {
    const cookies = await adminCookies();
    const id = (await createCharacter(cookies)).json().id as string;

    expect((await patch(cookies, id, { timezone: 'Asia/Tokyo' })).json()).toMatchObject({ timezone: 'Asia/Tokyo' });
  });

  /** Clearing a box means she has no stated city, not that it is "". */
  it('turns a blank box back into no value', async () => {
    const cookies = await adminCookies();
    const id = (await createCharacter(cookies)).json().id as string;
    await patch(cookies, id, WARSAW);

    const cleared = await patch(cookies, id, { city: '   ', timezone: '' });

    expect(cleared.json()).toMatchObject({ city: null, timezone: null, countryCode: 'PL' });
  });

  /** Absent from a patch means "leave it alone" -- the liveCallVoice contract. */
  it('leaves a part alone when the patch does not mention it', async () => {
    const cookies = await adminCookies();
    const id = (await createCharacter(cookies)).json().id as string;
    await patch(cookies, id, WARSAW);

    expect((await patch(cookies, id, { city: 'Kraków' })).json()).toMatchObject({
      city: 'Kraków',
      region: 'Masovian',
      countryCode: 'PL',
      timezone: 'Europe/Warsaw',
    });
  });

  /** Admin-facing only: a customer is told who she is, not her record. */
  it('never reaches the public character payload', async () => {
    const cookies = await adminCookies();
    const id = (await createCharacter(cookies)).json().id as string;
    await patch(cookies, id, WARSAW);

    const publicRes = await ctx.app.inject({ method: 'GET', url: `/api/characters/${id}` });
    const body = publicRes.body;
    expect(body).not.toContain('Masovian');
    expect(body).not.toContain('Europe/Warsaw');
    expect(body).not.toContain('countryCode');
  });
});
