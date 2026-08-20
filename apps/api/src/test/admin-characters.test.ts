import { readdir } from 'node:fs/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  characterVisualAssets,
  characterVisualIdentities,
  contentRequirements,
  users,
} from '../db/schema.js';
import { seedCharacters } from '../db/seed.js';
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
 * Primary references
 * ------------------------------------------------------------------ */

describe('primary references', () => {
  async function characterWithActiveIdentity(cookies: Record<string, string>) {
    const characterId = (await createCharacter(cookies)).json().id;
    const identity = (await createIdentity(cookies, characterId)).json();
    await activate(cookies, identity.id);
    return { characterId, identityId: identity.id as string };
  }

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
      'conversationStyle',
      'personality',
      'shortBio',
      'systemPrompt',
    ]);
  });

  it('does NOT duplicate the image into profile_image — one file, one asset row', async () => {
    const cookies = await adminCookies();
    const { character } = (await quickCreate(cookies)).json();
    expect(character.profileImage).toBeNull();

    const assets = await ctx.db
      .select()
      .from(characterVisualAssets)
      .where(eq(characterVisualAssets.characterId, character.id));
    expect(assets).toHaveLength(1);
  });

  it('stays OFF the public API until she is explicitly published', async () => {
    // An empty persona must never reach real users just because a file was
    // uploaded. Publishing is a separate, deliberate act.
    const cookies = await adminCookies();
    const { character } = (await quickCreate(cookies)).json();
    expect(character.status).toBe('inactive');

    const before = (await ctx.app.inject({ method: 'GET', url: '/api/characters' })).json();
    expect(before.some((c: { id: string }) => c.id === character.id)).toBe(false);

    await ctx.app.inject({
      method: 'PATCH',
      url: `/admin/characters/${character.id}`,
      payload: { status: 'active' },
      cookies,
    });
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

  it('saving the draft is an ordinary edit, and completes the profile', async () => {
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
    expect(saved.json().profileComplete).toBe(true);
    expect(saved.json().missingProfileFields).toEqual([]);
    expect(saved.json().shortBio).toBe(draft.shortBio);
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
