import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { CharacterPersona } from '@over18/shared';
import { characterPersonas, characterVisualAssets, characters, users } from '../db/schema.js';
import { SEED_CHARACTERS } from '../db/seed-data.js';
import { seedCharacters } from '../db/seed.js';
import { createCharacterDraft } from '../services/character-service.js';
import { activateVisualIdentityVersion, createVisualIdentityVersion } from '../services/visual-identity-service.js';
import type { PersonaGenerator } from '../services/character-persona-generator.js';
import { PersonaGeneratorError } from '../services/character-persona-generator.js';
import {
  CharacterPersonaRegenerationError,
  CharacterPersonaValidationError,
  getCharacterPersona,
  regenerateCharacterPersona,
  saveCharacterPersona,
  validateCharacterPersona,
} from '../services/character-persona-service.js';
import {
  createTestContext,
  destroyTestContext,
  extractSessionCookie,
  migrateTestDb,
  truncateAll,
  type TestContext,
} from './helpers.js';

/**
 * NOTE ON THIS FILE'S EXECUTION STATE: written against the real test-DB
 * harness (createTestContext/migrateTestDb/truncateAll, same pattern as
 * visual-identity.test.ts and library-upload.test.ts) but NOT executed in
 * this sandbox — no Postgres is reachable here (embedded-postgres's native
 * initdb hits an EACCES at the process-spawn layer even with sandboxing
 * disabled). Run with `npx vitest run src/test/character-persona-service.test.ts`
 * against a real *_test database before merging.
 */

const LUNA = SEED_CHARACTERS.find((c) => c.name === 'luna')!;

/** A minimal valid PNG (1x1), same fixture library-upload.test.ts uses. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function pngMultipart() {
  const boundary = '----personaboundary1234';
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="avatar.png"\r\n` +
      `Content-Type: image/png\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    payload: Buffer.concat([head, PNG, tail]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

let ctx: TestContext;

beforeAll(async () => {
  migrateTestDb();
  ctx = await createTestContext({ personaGenerator: capturingGenerator });
});

afterAll(async () => {
  await destroyTestContext(ctx);
});

beforeEach(async () => {
  lastGeneratorInput = null;
  await truncateAll(ctx);
  await seedCharacters(ctx.db);
});

/**
 * The operator's session. Callable more than once per test: this used to
 * register unconditionally, so the second call in a test collided on the fixed
 * email and returned an undefined cookie -- and since characterWithAvatar()
 * calls it too, "more than once" is the normal case, not the exception.
 */
async function adminCookie(): Promise<string> {
  const credentials = { email: 'op@example.com', password: 'correct horse battery staple' };
  let res = await ctx.app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: credentials,
  });
  if (res.statusCode >= 400) {
    res = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: credentials });
  }
  const c = extractSessionCookie(res)!;
  await ctx.db.update(users).set({ role: 'admin' }).where(eq(users.email, credentials.email));
  return `${c.name}=${c.value}`;
}

/** Fresh character with a real, uploaded, canonical reference image on disk. */
async function characterWithAvatar(): Promise<string> {
  const character = await createCharacterDraft(ctx.db, { name: `nova-${Date.now()}` });
  const identity = await createVisualIdentityVersion(
    ctx.db,
    character.id,
    { apparentAgeBand: 'adult' },
    { label: 'Test identity' },
  );
  const active = await activateVisualIdentityVersion(ctx.db, identity.id);

  const cookie = await adminCookie();
  const { payload, headers } = pngMultipart();
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/admin/identities/${active.id}/references`,
    payload,
    headers: { ...headers, cookie },
  });
  expect(res.statusCode).toBe(201);
  return character.id;
}

const stubGenerator = (persona: CharacterPersona): PersonaGenerator => async () => ({ persona });

/**
 * THE INSTRUMENT FOR THE SENTINEL TESTS BELOW.
 *
 * Every other stub here ignores its input, which is exactly why none of them
 * could ever have caught her profile being handed to the model. This one keeps
 * it, so a test can assert on the REQUEST rather than on the result \u2014 the only
 * place the guarantee actually lives.
 *
 * It is wired into the app in beforeAll, so the HTTP test below observes what
 * the real route passed, not what a test re-assembled.
 */
let lastGeneratorInput: Record<string, unknown> | null = null;
const capturingGenerator: PersonaGenerator = async (input) => {
  lastGeneratorInput = input as unknown as Record<string, unknown>;
  return {
    persona: { occupation: 'from the photo' },
    profile: {
      shortBio: 'A bio the photo implies.',
      personality: 'A personality the photo implies.',
      interests: ['something visible'],
    },
  };
};

/** Placed where her profile used to enter the generation request. */
const SENTINEL = {
  shortBio: 'ZZZ-SENTINEL-BIO-NOT-FROM-ANY-PHOTO',
  personality: 'ZZZ-SENTINEL-PERSONALITY-NOT-FROM-ANY-PHOTO',
  interests: ['ZZZ-SENTINEL-INTEREST-NOT-FROM-ANY-PHOTO'],
  conversationStyle: 'ZZZ-SENTINEL-STYLE-NOT-FROM-ANY-PHOTO',
  systemPrompt: 'ZZZ-SENTINEL-SYSTEM-PROMPT-NOT-FROM-ANY-PHOTO',
  persona: { occupation: 'ZZZ-SENTINEL-PERSONA-NOT-FROM-ANY-PHOTO' },
};

const ALL_SENTINEL_TEXT = [
  SENTINEL.shortBio,
  SENTINEL.personality,
  SENTINEL.interests[0]!,
  SENTINEL.conversationStyle,
  SENTINEL.systemPrompt,
  SENTINEL.persona.occupation,
];
const throwingGenerator = (error: PersonaGeneratorError): PersonaGenerator => async () => {
  throw error;
};

describe('validateCharacterPersona', () => {
  it('accepts a full persona and cleans it', () => {
    const persona = validateCharacterPersona({
      age: 27,
      occupation: '  second-year ER nurse  ',
      hobbies: ['night runs', 'trashy reality TV'],
    });
    expect(persona.age).toBe(27);
    expect(persona.occupation).toBe('second-year ER nurse');
    expect(persona.hobbies).toEqual(['night runs', 'trashy reality TV']);
  });

  it('drops unknown keys rather than surfacing them', () => {
    const persona = validateCharacterPersona({ occupation: 'nurse', race: 'x', religion: 'y' });
    expect(persona).not.toHaveProperty('race');
    expect(persona).not.toHaveProperty('religion');
  });

  it('rejects a non-object payload', () => {
    expect(() => validateCharacterPersona('nope')).toThrow(CharacterPersonaValidationError);
    expect(() => validateCharacterPersona(null)).toThrow(CharacterPersonaValidationError);
  });

  it('rejects an age under 18', () => {
    expect(() => validateCharacterPersona({ age: 17 })).toThrow(CharacterPersonaValidationError);
    expect(() => validateCharacterPersona({ age: 3.5 })).toThrow(CharacterPersonaValidationError);
  });

  it('rejects an ageRange or lifeStage denoting a minor', () => {
    expect(() => validateCharacterPersona({ ageRange: 'teenager' })).toThrow(
      CharacterPersonaValidationError,
    );
    expect(() => validateCharacterPersona({ lifeStage: 'high school student' })).toThrow(
      CharacterPersonaValidationError,
    );
  });

  it('accepts an empty object — every field is optional', () => {
    expect(validateCharacterPersona({})).toEqual({});
  });
});

describe('getCharacterPersona / saveCharacterPersona', () => {
  it('returns null when no persona row exists yet', async () => {
    expect(await getCharacterPersona(ctx.db, LUNA.id)).toBeNull();
  });

  it('upserts on first save and records editedFields', async () => {
    const row = await saveCharacterPersona(ctx.db, LUNA.id, { occupation: 'bartender' });
    expect(row.persona.occupation).toBe('bartender');
    expect(row.editedFields).toEqual(['occupation']);
  });

  it('merges a second partial edit and dedupes editedFields', async () => {
    await saveCharacterPersona(ctx.db, LUNA.id, { occupation: 'bartender' });
    const row = await saveCharacterPersona(ctx.db, LUNA.id, {
      occupation: 'bartender', // re-saved — must not duplicate in editedFields
      hobbies: ['mixology'],
    });
    expect(row.persona.occupation).toBe('bartender');
    expect(row.persona.hobbies).toEqual(['mixology']);
    expect(row.editedFields.sort()).toEqual(['hobbies', 'occupation']);
  });

  it('rejects an invalid partial edit without touching the existing persona', async () => {
    await saveCharacterPersona(ctx.db, LUNA.id, { occupation: 'bartender' });
    await expect(saveCharacterPersona(ctx.db, LUNA.id, { age: 15 })).rejects.toThrow(
      CharacterPersonaValidationError,
    );
    const row = await getCharacterPersona(ctx.db, LUNA.id);
    expect(row!.persona.occupation).toBe('bartender');
  });
});

describe('regenerateCharacterPersona', () => {
  it('fails with no_source_image before calling the generator at all', async () => {
    const character = await createCharacterDraft(ctx.db, { name: `no-avatar-${Date.now()}` });
    let called = false;
    const generator: PersonaGenerator = async () => {
      called = true;
      return { persona: {} };
    };
    await expect(
      regenerateCharacterPersona(
        ctx.db,
        { displayName: character.displayName },
        character.id,
        generator,
      ),
    ).rejects.toThrow(CharacterPersonaRegenerationError);
    expect(called).toBe(false);
  });

  it('on success, stores the persona, sourceAssetId and generatedAt', async () => {
    const characterId = await characterWithAvatar();
    const { row } = await regenerateCharacterPersona(
      ctx.db,
      { displayName: 'Nova' },
      characterId,
      stubGenerator({ occupation: 'barista', age: 24 }),
    );
    expect(row.persona.occupation).toBe('barista');
    expect(row.persona.age).toBe(24);
    expect(row.sourceAssetId).not.toBeNull();
    expect(row.generatedAt).not.toBeNull();
    expect(row.editedFields).toEqual([]); // regeneration never adds to editedFields
  });

  it('THE CORE PROPERTY: an explicitly edited field survives regeneration', async () => {
    const characterId = await characterWithAvatar();
    await saveCharacterPersona(ctx.db, characterId, { occupation: 'hand-edited occupation' });

    const { row } = await regenerateCharacterPersona(
      ctx.db,
      { displayName: 'Nova' },
      characterId,
      stubGenerator({ occupation: 'generated occupation', age: 30 }),
    );
    expect(row.persona.occupation).toBe('hand-edited occupation'); // untouched
    expect(row.persona.age).toBe(30); // fresh field DOES update
    expect(row.editedFields).toEqual(['occupation']);
  });

  /**
   * GENERATING REPLACES HER PERSONA; IT DOES NOT MERGE INTO IT.
   *
   * Regeneration used to start from the existing persona and overlay whatever
   * the model returned, so a field the model DID NOT mention kept its old
   * text for ever. Regenerating against a NEW reference photo therefore left
   * fragments of the previous one behind, with nothing on screen to say which
   * line came from which image and no way to remove them.
   */
  it('REPLACES: a field the new generation omits does not survive it', async () => {
    const characterId = await characterWithAvatar();
    await regenerateCharacterPersona(
      ctx.db,
      { displayName: 'Nova' },
      characterId,
      stubGenerator({ occupation: 'from the first photo', humorStyle: 'dry' }),
    );

    // The second generation says nothing about humorStyle.
    const { row } = await regenerateCharacterPersona(
      ctx.db,
      { displayName: 'Nova' },
      characterId,
      stubGenerator({ occupation: 'from the second photo' }),
    );
    expect(row.persona.occupation).toBe('from the second photo');
    expect(row.persona.humorStyle, 'the first photo must leave nothing behind').toBeUndefined();
  });

  it('REPLACES, but never the operator: a pinned field still survives', async () => {
    const characterId = await characterWithAvatar();
    await regenerateCharacterPersona(
      ctx.db,
      { displayName: 'Nova' },
      characterId,
      stubGenerator({ occupation: 'generated', humorStyle: 'dry' }),
    );
    await saveCharacterPersona(ctx.db, characterId, { humorStyle: 'hand-written' });

    const { row } = await regenerateCharacterPersona(
      ctx.db,
      { displayName: 'Nova' },
      characterId,
      // Mentions neither field the operator cares about.
      stubGenerator({ occupation: 'regenerated' }),
    );
    expect(row.persona.humorStyle, "the operator's own edit is kept").toBe('hand-written');
    expect(row.persona.occupation, 'everything else is the new generation').toBe('regenerated');
    expect(row.editedFields).toEqual(['humorStyle']);
  });

  /* \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
   * WHAT THE GENERATOR IS ALLOWED TO SEE
   *
   * "From her photo" has to mean from her photo. Her stored profile used to be
   * part of the request, and while the prompt told the model the photo was
   * authoritative, the text still anchored the result: a regeneration against
   * a genuinely different reference came back wearing the previous life.
   *
   * These tests assert on the REQUEST, not the output, because the output
   * cannot distinguish "invented from the image" from "echoed from the bio".
   * The sentinels are strings no image could produce, so any appearance in the
   * request is proof of a leak and nothing else.
   * \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */

  it('receives ONLY displayName, imageBytes and imageMimeType', async () => {
    const characterId = await characterWithAvatar();
    await regenerateCharacterPersona(
      ctx.db,
      { displayName: 'Nova' },
      characterId,
      capturingGenerator,
    );
    expect(Object.keys(lastGeneratorInput!).sort()).toEqual([
      'displayName',
      'imageBytes',
      'imageMimeType',
    ]);
    expect(lastGeneratorInput!.displayName).toBe('Nova');
    expect(Buffer.isBuffer(lastGeneratorInput!.imageBytes)).toBe(true);
    expect(lastGeneratorInput!.imageMimeType).toBe('image/png');
  });

  it('passes no profile field even when a caller forces one in', async () => {
    const characterId = await characterWithAvatar();
    await regenerateCharacterPersona(
      ctx.db,
      // The narrowed parameter is the safeguard; this is the runtime proof
      // that the service, not just the compiler, is the barrier.
      { displayName: 'Nova', ...SENTINEL } as unknown as { displayName: string },
      characterId,
      capturingGenerator,
    );
    const serialised = JSON.stringify(lastGeneratorInput);
    for (const sentinel of ALL_SENTINEL_TEXT) {
      expect(serialised, `${sentinel} reached the generator`).not.toContain(sentinel);
    }
  });

  it('does not read her stored persona into the request either', async () => {
    const characterId = await characterWithAvatar();
    await saveCharacterPersona(ctx.db, characterId, SENTINEL.persona);

    await regenerateCharacterPersona(
      ctx.db,
      { displayName: 'Nova' },
      characterId,
      capturingGenerator,
    );
    expect(JSON.stringify(lastGeneratorInput)).not.toContain(SENTINEL.persona.occupation);
  });

  it('skips references with no readable file and uses the first one that has bytes', async () => {
    // The real-world shape this was found in: a seeded placeholder reference
    // (external locator, no file on disk, explicit position so it sorts
    // FIRST) alongside a genuinely uploaded one (position null, sorts last).
    // Taking references[0] blindly made such a character un-regenerable.
    const character = await createCharacterDraft(ctx.db, { name: `mixed-${Date.now()}` });
    const identity = await createVisualIdentityVersion(
      ctx.db,
      character.id,
      { apparentAgeBand: 'adult' },
      { label: 'Test identity' },
    );
    const active = await activateVisualIdentityVersion(ctx.db, identity.id);

    // A placeholder canonical reference with no real file, positioned first.
    await ctx.db.insert(characterVisualAssets).values({
      characterId: character.id,
      visualIdentityId: active.id,
      kind: 'reference',
      status: 'approved',
      isCanonical: true,
      position: 1,
      storageKey: 'https://example.invalid/placeholder.png',
      provenance: { source: 'seed-placeholder' },
    });

    // A real upload lands after it, with position null.
    const cookie = await adminCookie();
    const { payload, headers } = pngMultipart();
    const uploaded = await ctx.app.inject({
      method: 'POST',
      url: `/admin/identities/${active.id}/references`,
      payload,
      headers: { ...headers, cookie },
    });
    expect(uploaded.statusCode).toBe(201);

    const { row } = await regenerateCharacterPersona(
      ctx.db,
      { displayName: character.displayName },
      character.id,
      stubGenerator({ occupation: 'barista' }),
    );
    expect(row.persona.occupation).toBe('barista');
    // Provenance points at the asset that actually supplied the bytes.
    expect(row.sourceAssetId).toBe(uploaded.json().assetId);
  });

  it('a generator failure leaves the persona row completely untouched', async () => {
    const characterId = await characterWithAvatar();
    await saveCharacterPersona(ctx.db, characterId, { occupation: 'bartender' });
    const before = await getCharacterPersona(ctx.db, characterId);

    await expect(
      regenerateCharacterPersona(
        ctx.db,
        { displayName: 'Nova' },
        characterId,
        throwingGenerator(new PersonaGeneratorError('unavailable', 'boom')),
      ),
    ).rejects.toThrow(PersonaGeneratorError);

    const after = await getCharacterPersona(ctx.db, characterId);
    expect(after).toEqual(before);
  });

  it('a generator failure on a character with NO existing persona creates no row', async () => {
    const characterId = await characterWithAvatar();
    await expect(
      regenerateCharacterPersona(
        ctx.db,
        { displayName: 'Nova' },
        characterId,
        throwingGenerator(new PersonaGeneratorError('invalid_output', 'boom')),
      ),
    ).rejects.toThrow(PersonaGeneratorError);
    expect(await getCharacterPersona(ctx.db, characterId)).toBeNull();
  });
});

describe('character_personas cleanup', () => {
  it('is removed when its character is deleted (cascade)', async () => {
    const characterId = await characterWithAvatar();
    await saveCharacterPersona(ctx.db, characterId, { occupation: 'temp' });
    await ctx.db.delete(characters).where(eq(characters.id, characterId));
    const [row] = await ctx.db
      .select()
      .from(characterPersonas)
      .where(eq(characterPersonas.characterId, characterId));
    expect(row).toBeUndefined();
  });
});


/* \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
 * OVER HTTP, THROUGH THE ROUTE THE ADMIN BUTTON ACTUALLY CALLS
 *
 * The service tests above prove the service passes nothing extra. This proves
 * the route does not either -- it is the route that loads the full character
 * (it needs it for the 404 and for the comparison), so it is the route that
 * has the profile in hand at the moment it calls the generator. That is the
 * one place a leak would be easiest to reintroduce and hardest to notice.
 * \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */

describe('POST /admin/characters/:id/persona/regenerate sends only the photo', () => {
  /** A character with a readable avatar AND a fully written-out profile. */
  async function characterWithAvatarAndProfile(): Promise<string> {
    const characterId = await characterWithAvatar();
    await ctx.db
      .update(characters)
      .set({
        shortBio: SENTINEL.shortBio,
        personality: SENTINEL.personality,
        interests: SENTINEL.interests,
        conversationStyle: SENTINEL.conversationStyle,
        systemPrompt: SENTINEL.systemPrompt,
      })
      .where(eq(characters.id, characterId));
    await saveCharacterPersona(ctx.db, characterId, SENTINEL.persona);
    return characterId;
  }

  it('hands the generator her name and image only, with a full profile on file', async () => {
    const characterId = await characterWithAvatarAndProfile();
    const cookie = await adminCookie();
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/admin/characters/${characterId}/persona/regenerate`,
      headers: { cookie },
      payload: {},
    });
    expect(res.statusCode).toBe(200);

    expect(lastGeneratorInput, 'the route must have called the generator').not.toBeNull();
    expect(Object.keys(lastGeneratorInput!).sort()).toEqual([
      'displayName',
      'imageBytes',
      'imageMimeType',
    ]);
    const serialised = JSON.stringify(lastGeneratorInput);
    for (const sentinel of ALL_SENTINEL_TEXT) {
      expect(serialised, `${sentinel} reached the generator`).not.toContain(sentinel);
    }
  });

  /**
   * The comparison is the reason her profile is loaded at all, so removing it
   * from the REQUEST must not remove it from the RESPONSE. It now compares two
   * independently written descriptions, which is the only way the phrase "her
   * photo suggests a different profile" is true of anything.
   */
  it('still offers the photo-vs-profile comparison, computed after generation', async () => {
    const characterId = await characterWithAvatarAndProfile();
    const cookie = await adminCookie();
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/admin/characters/${characterId}/persona/regenerate`,
      headers: { cookie },
      payload: {},
    });
    const body = res.json() as {
      proposedProfile: Record<string, unknown> | null;
      appliedProfileFields: string[];
      persona: Record<string, unknown>;
    };

    // Her fields all had text, so all three wait for a human.
    expect(body.proposedProfile).toMatchObject({
      shortBio: 'A bio the photo implies.',
      personality: 'A personality the photo implies.',
      interests: ['something visible'],
    });
    expect(body.appliedProfileFields).toEqual([]);

    // And nothing was written over her profile behind the operator's back.
    const [row] = await ctx.db.select().from(characters).where(eq(characters.id, characterId));
    expect(row!.shortBio).toBe(SENTINEL.shortBio);
    expect(row!.personality).toBe(SENTINEL.personality);

    // The sentinel persona was written through saveCharacterPersona, which
    // PINS the field -- so it correctly outlives the regeneration (the Task 5
    // promise: "anything you type in here is yours"). What matters here is
    // that surviving in the row is not the same as being fed back in: the
    // test above proves it never reached the generator.
    expect(body.persona.occupation).toBe(SENTINEL.persona.occupation);
  });

  /** Blank fields still fill themselves in; that behaviour is unchanged. */
  it('still auto-applies into fields that were empty', async () => {
    const characterId = await characterWithAvatar();
    await ctx.db
      .update(characters)
      .set({ shortBio: '', personality: '', interests: [] })
      .where(eq(characters.id, characterId));
    const cookie = await adminCookie();
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/admin/characters/${characterId}/persona/regenerate`,
      headers: { cookie },
      payload: {},
    });
    const body = res.json() as {
      proposedProfile: unknown;
      appliedProfileFields: string[];
    };
    expect(body.appliedProfileFields.sort()).toEqual(['interests', 'personality', 'shortBio']);
    expect(body.proposedProfile).toBeNull();
  });
});
