import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { characters, characterPersonas } from '../db/schema.js';
import { seedCharacters } from '../db/seed.js';
import { SEED_CHARACTERS } from '../db/seed-data.js';
import {
  confirmedCharacterAge,
  suggestedCharacterAge,
  usableAge,
} from '../services/character-age.js';
import { compilePersonaWhoSheIs } from '../services/character-persona-compiler.js';
import { toPersonaGeneratorDraft } from '../services/character-persona-generator.js';
import { saveCharacterPersona } from '../services/character-persona-service.js';
import { users } from '../db/schema.js';
import {
  createTestContext,
  destroyTestContext,
  extractSessionCookie,
  migrateTestDb,
  truncateAll,
  type TestContext,
} from './helpers.js';

/**
 * THE AGE RULES, AS RULES RATHER THAN AS CURRENT BEHAVIOUR.
 *
 * Three numbers can describe a character and only one is a fact. These pin the
 * standing in both directions: a confirmed age is the only one anybody public
 * ever sees or hears, a suggestion reaches Admin and stops there, and nothing
 * about regenerating a persona can disturb what an operator decided.
 */

let ctx: TestContext;
let adminCookies: Record<string, string>;

const ADMIN_EMAIL = 'age.admin@over18.test';

beforeAll(async () => {
  migrateTestDb();
  ctx = await createTestContext({});
}, 180_000);

afterAll(async () => {
  await destroyTestContext(ctx);
});

beforeEach(async () => {
  await truncateAll(ctx);
  await seedCharacters(ctx.db);
  const registered = await ctx.app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email: ADMIN_EMAIL, password: 'age-test-pass1' },
  });
  const cookie = extractSessionCookie(registered)!;
  // The role is not settable over the wire, so it is set directly -- the same
  // approach the existing admin suite uses.
  await ctx.db.update(users).set({ role: 'admin' }).where(eq(users.email, ADMIN_EMAIL));
  adminCookies = { [cookie.name]: cookie.value };
});

const firstCharacter = async () => {
  const [row] = await ctx.db
    .select()
    .from(characters)
    .where(eq(characters.name, SEED_CHARACTERS[0]!.name))
    .limit(1);
  return row!;
};

/* ------------------------------------------------------------------ *
 * Precedence
 * ------------------------------------------------------------------ */

describe('which age counts', () => {
  it('treats only an operator age as confirmed', () => {
    expect(confirmedCharacterAge(32)).toBe(32);
    expect(confirmedCharacterAge(null)).toBeNull();
    expect(confirmedCharacterAge(undefined)).toBeNull();
  });

  it('never lets a confirmed age be a non-adult or a non-integer', () => {
    for (const bad of [17, 0, -1, 17.9, 29.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(confirmedCharacterAge(bad as never), `${String(bad)} must not confirm`).toBeNull();
    }
    expect(usableAge(18)).toBe(18);
    expect(usableAge(120)).toBe(120);
    expect(usableAge(121)).toBeNull();
  });

  it('coerces a numeric string, because an age arrives from a form', () => {
    // Deliberate in `usableAge`, and worth pinning: an admin form sends "30",
    // and refusing it would make the field unusable for the one person allowed
    // to set it. A non-numeric string is still refused.
    expect(confirmedCharacterAge('30' as never)).toBe(30);
    expect(confirmedCharacterAge('17' as never)).toBeNull();
    expect(confirmedCharacterAge('thirty' as never)).toBeNull();
    expect(confirmedCharacterAge('' as never)).toBeNull();
  });

  it('reads a suggestion from the persona and validates it the same way', () => {
    expect(suggestedCharacterAge({ age: 27 })).toBe(27);
    expect(suggestedCharacterAge({ age: 16 })).toBeNull();
    expect(suggestedCharacterAge({ ageRange: 'late 20s' })).toBeNull();
    expect(suggestedCharacterAge(null)).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * What she says
 * ------------------------------------------------------------------ */

describe('the age she states in chat and voice', () => {
  it('states the confirmed age when there is one', () => {
    const facts = compilePersonaWhoSheIs({ age: 27, occupation: 'florist' }, 32);
    expect(facts.join(' ')).toContain("She's 32.");
    expect(facts.join(' ')).not.toContain('27');
  });

  it('a confirmed age OUTRANKS a conflicting persona age', () => {
    // The defect this exists for: her card said 26 while she told a caller 32.
    const facts = compilePersonaWhoSheIs({ age: 26 }, 32);
    expect(facts.join(' ')).toContain("She's 32.");
  });

  it('says NOTHING about her age when none is confirmed, even with a suggestion', () => {
    /**
     * The same defect pointing the other way. The prompt used to fall back to
     * the persona's number, so an unconfirmed character told a caller she was
     * 32 while her card showed nothing at all. A suggestion is for an operator,
     * not for her mouth.
     */
    const facts = compilePersonaWhoSheIs({ age: 32, occupation: 'florist' }, null);
    const text = facts.join(' ');
    expect(text).not.toContain('32');
    expect(text).not.toMatch(/She's \d/);
    // She is still described -- only the age is withheld.
    expect(text).toContain('florist');
  });

  it('does not fall back to the age range either, which is the same guess in prose', () => {
    const facts = compilePersonaWhoSheIs({ ageRange: 'mid-to-late 20s' }, null);
    expect(facts.join(' ')).not.toContain('20s');
  });

  it('states a confirmed age even for a character with no persona at all', () => {
    expect(compilePersonaWhoSheIs(null, 29).join(' ')).toContain("She's 29.");
    expect(compilePersonaWhoSheIs(null, null)).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * Generation
 * ------------------------------------------------------------------ */

describe('a generated persona', () => {
  const draft = (over: Record<string, unknown>) =>
    toPersonaGeneratorDraft({ occupation: 'florist', ...over });

  it('keeps an adult age', () => {
    expect(draft({ age: 28 }).age).toBe(28);
    expect(draft({ age: 18 }).age).toBe(18);
  });

  it('REFUSES a non-adult age outright, rather than storing or dropping it', () => {
    /**
     * Stricter than merely omitting the field, and correct: a persona that
     * describes a minor must not exist in the record at all. The whole
     * generation is rejected, which costs a vision call and is the right price.
     */
    for (const age of [17, 0, -3]) {
      expect(() => draft({ age }), `age ${age} must be refused`).toThrow(/adult \(18 or older\)/i);
    }
  });

  it('refuses a non-integer age', () => {
    expect(() => draft({ age: 28.5 })).toThrow(/integer/i);
  });

  it('ASKS the model for a single whole adult number', () => {
    /**
     * The parser can only drop a bad age; it cannot make the model produce a
     * good one. The prompt is the only place that stops this gap recurring on
     * every new character -- a schema that merely ALLOWED `age` yielded a range
     * and no number for two of thirty-nine personas. So the instruction itself
     * is pinned, read from the source rather than trusted.
     */
    const source = readFileSync(
      new URL('../services/character-persona-generator.ts', import.meta.url),
      'utf8',
    );
    const instruction = source.split(/\r?\n/).find((line) => line.includes('HER AGE:'));
    expect(instruction, 'the age instruction is missing from the prompt').toBeDefined();
    expect(instruction).toMatch(/single whole number/i);
    expect(instruction).toMatch(/never below 18/i);
    // And that the range is explicitly NOT a substitute.
    expect(instruction).toMatch(/never as a substitute/i);
  });
});

/* ------------------------------------------------------------------ *
 * Regeneration must not disturb a decision
 * ------------------------------------------------------------------ */

describe('persona changes and the confirmed age', () => {
  it('saving a new persona never changes characters.age', async () => {
    const character = await firstCharacter();
    await ctx.db.update(characters).set({ age: 31 }).where(eq(characters.id, character.id));

    await saveCharacterPersona(ctx.db, character.id, { age: 22, occupation: 'barista' });

    const [after] = await ctx.db
      .select()
      .from(characters)
      .where(eq(characters.id, character.id))
      .limit(1);
    expect(after!.age).toBe(31);

    const [persona] = await ctx.db
      .select()
      .from(characterPersonas)
      .where(eq(characterPersonas.characterId, character.id))
      .limit(1);
    // The suggestion moved; the decision did not.
    expect(suggestedCharacterAge(persona!.persona as never)).toBe(22);
    expect(confirmedCharacterAge(after!.age)).toBe(31);
  });

  it('and she still says the confirmed age afterwards, not the new suggestion', async () => {
    const character = await firstCharacter();
    await ctx.db.update(characters).set({ age: 31 }).where(eq(characters.id, character.id));
    await saveCharacterPersona(ctx.db, character.id, { age: 22 });
    const [after] = await ctx.db
      .select()
      .from(characters)
      .where(eq(characters.id, character.id))
      .limit(1);
    const facts = compilePersonaWhoSheIs({ age: 22 }, after!.age);
    expect(facts.join(' ')).toContain("She's 31.");
    expect(facts.join(' ')).not.toContain('22');
  });
});

/* ------------------------------------------------------------------ *
 * The bulk endpoint
 * ------------------------------------------------------------------ */

describe('POST /admin/characters/age-confirmations', () => {
  const post = (payload: unknown) =>
    ctx.app.inject({
      method: 'POST',
      url: '/admin/characters/age-confirmations',
      cookies: adminCookies,
      payload: payload as never,
    });

  it('confirms several ages at once and writes them', async () => {
    const [a, b] = await ctx.db.select().from(characters).limit(2);
    const response = await post({
      confirmations: [
        { characterId: a!.id, age: 29 },
        { characterId: b!.id, age: 34 },
      ],
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { confirmed: unknown[]; rejected: unknown[] };
    expect(body.confirmed).toHaveLength(2);
    expect(body.rejected).toHaveLength(0);

    const [after] = await ctx.db.select().from(characters).where(eq(characters.id, a!.id)).limit(1);
    expect(after!.age).toBe(29);
  });

  it('rejects a non-adult age and leaves the stored age untouched', async () => {
    const [a] = await ctx.db.select().from(characters).limit(1);
    // Asserted as UNCHANGED rather than null: seeded characters may already
    // carry a confirmed age, and "it did not write" is the actual claim.
    const before = a!.age;

    const response = await post({ confirmations: [{ characterId: a!.id, age: 17 }] });
    const body = response.json() as { confirmed: unknown[]; rejected: { reason: string }[] };
    expect(body.confirmed).toHaveLength(0);
    expect(body.rejected[0]!.reason).toMatch(/18 or over/i);

    const [after] = await ctx.db.select().from(characters).where(eq(characters.id, a!.id)).limit(1);
    expect(after!.age).toBe(before);
  });

  it('reports a bad row without dropping the good ones', async () => {
    const [a, b] = await ctx.db.select().from(characters).limit(2);
    const body = (
      await post({
        confirmations: [
          { characterId: a!.id, age: 30 },
          { characterId: b!.id, age: 12 },
        ],
      })
    ).json() as { confirmed: { characterId: string }[]; rejected: { characterId: string }[] };

    expect(body.confirmed.map((c) => c.characterId)).toEqual([a!.id]);
    expect(body.rejected.map((r) => r.characterId)).toEqual([b!.id]);
  });

  it('refuses a non-integer age', async () => {
    const [a] = await ctx.db.select().from(characters).limit(1);
    const body = (await post({ confirmations: [{ characterId: a!.id, age: 29.5 }] })).json() as {
      rejected: { reason: string }[];
    };
    expect(body.rejected[0]!.reason).toBe('age_must_be_a_whole_number');
  });

  it('reports an unknown character rather than failing the batch', async () => {
    const body = (
      await post({
        confirmations: [{ characterId: '11111111-2222-3333-4444-555555555555', age: 30 }],
      })
    ).json() as { rejected: { reason: string }[] };
    expect(body.rejected[0]!.reason).toBe('not_found');
  });

  it('refuses an empty or malformed body', async () => {
    expect((await post({})).statusCode).toBe(400);
    expect((await post({ confirmations: [] })).statusCode).toBe(400);
    expect((await post({ confirmations: 'all of them' })).statusCode).toBe(400);
  });

  it('cannot be reached without an admin session', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/admin/characters/age-confirmations',
      payload: { confirmations: [{ characterId: '11111111-2222-3333-4444-555555555555', age: 30 }] },
    });
    expect([401, 403]).toContain(response.statusCode);
  });
});

/* ------------------------------------------------------------------ *
 * A suggestion must not escape to a customer
 * ------------------------------------------------------------------ */

describe('a suggestion is Admin-only', () => {
  it('the public character payload carries no suggestion, confirmed or not', async () => {
    const character = await firstCharacter();
    await saveCharacterPersona(ctx.db, character.id, { age: 27 });

    const response = await ctx.app.inject({ method: 'GET', url: '/api/characters' });
    const body = response.json() as Record<string, unknown>[];
    for (const item of body) {
      expect(item).not.toHaveProperty('suggestedAge');
      expect(item).not.toHaveProperty('persona');
      // `age` is present and null until somebody confirms one.
      expect(item).toHaveProperty('age');
    }
  });

  it('the public payload shows the confirmed age once it is set', async () => {
    const character = await firstCharacter();
    await ctx.db.update(characters).set({ age: 33 }).where(eq(characters.id, character.id));
    const body = (await ctx.app.inject({ method: 'GET', url: '/api/characters' })).json() as {
      id: string;
      age: number | null;
    }[];
    expect(body.find((c) => c.id === character.id)?.age).toBe(33);
  });
});
