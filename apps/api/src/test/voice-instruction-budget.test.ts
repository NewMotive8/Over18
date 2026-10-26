import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { callSessions, characters, conversations, memories } from '../db/schema.js';
import { SEED_CHARACTERS } from '../db/seed-data.js';
import { seedCharacters } from '../db/seed.js';
import {
  buildProviderSessionRequest,
  INSTRUCTION_SAFETY_MARGIN,
} from '../services/call-session-service.js';
import { INSTRUCTIONS_MAX_CHARS } from '../voice/spicyapi.js';
import {
  createTestContext,
  destroyTestContext,
  extractSessionCookie,
  migrateTestDb,
  truncateAll,
  type TestContext,
} from './helpers.js';

/**
 * THE 8,000-CHARACTER CLIFF, AND WHAT FALLS OFF IT.
 *
 * `truncateInstructions` keeps the FIRST 8,000 characters of the compiled
 * persona and discards the tail. The behaviour layer is pushed LAST. Measured
 * on Staging data before this change: one character compiled to 8,042
 * characters with a full memory load and was silently dropping
 * "never break character" on every call she took. Nothing failed, nothing was
 * logged, and the only way to find it was to measure.
 *
 * These pin the fix: the remembered facts are budgeted from whatever the
 * persona leaves over, so the rules always fit -- and when even the bare
 * persona does not fit, the call fails with something an operator can act on
 * instead of quietly shipping a prompt with its frame cut off.
 */

let ctx: TestContext;
const LUNA = SEED_CHARACTERS.find((c) => c.name === 'luna')!;

beforeAll(async () => {
  migrateTestDb();
  ctx = await createTestContext({ voiceCallsEnabled: true });
});

afterAll(async () => {
  await destroyTestContext(ctx);
});

beforeEach(async () => {
  await truncateAll(ctx);
  await seedCharacters(ctx.db);
});

async function register(email: string) {
  const reg = await ctx.app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email, password: 'voice-budget-pass1' },
  });
  const cookie = extractSessionCookie(reg)!;
  const conv = await ctx.app.inject({
    method: 'POST',
    url: '/api/conversations',
    payload: { characterId: LUNA.id },
    cookies: { [cookie.name]: cookie.value },
  });
  return { userId: reg.json().id as string, conversationId: conv.json().id as string };
}

/** A claimed call row, which is all `buildProviderSessionRequest` needs. */
async function callRow(user: { userId: string; conversationId: string }) {
  const [row] = await ctx.db
    .insert(callSessions)
    .values({
      userId: user.userId,
      conversationId: user.conversationId,
      characterId: LUNA.id,
      provider: 'spicyapi',
      voice: 'Serena',
      status: 'active',
      maxSeconds: 120,
    })
    .returning();
  return row!;
}

/** `count` remembered facts of `size` characters each. */
async function remember(userId: string, count: number, size = 180) {
  for (let i = 0; i < count; i++) {
    await ctx.db.insert(memories).values({
      userId,
      characterId: LUNA.id,
      content: `Fact ${i} ${'x'.repeat(Math.max(0, size - 10))}`,
    });
  }
}

/* ------------------------------------------------------------------ *
 * The budget
 * ------------------------------------------------------------------ */

describe('remembered facts are budgeted from what the persona leaves over', () => {
  it('fits inside the provider limit even when the user has a lot remembered', async () => {
    const user = await register('vb.many@example.com');
    await remember(user.userId, 40);
    const request = await buildProviderSessionRequest(ctx.db, await callRow(user));
    expect(request).not.toBeNull();
    expect(request!.instructions.length).toBeLessThanOrEqual(
      INSTRUCTIONS_MAX_CHARS - INSTRUCTION_SAFETY_MARGIN,
    );
  });

  /**
   * THE REGRESSION THIS FILE EXISTS FOR. Both lines live at the BOTTOM of the
   * compiled prompt, so they are the first thing a truncating provider throws
   * away -- which is exactly what was happening in production-shaped data.
   */
  it('keeps the frame rules that used to be truncated away', async () => {
    const user = await register('vb.frame@example.com');
    await remember(user.userId, 40);
    const request = await buildProviderSessionRequest(ctx.db, await callRow(user));
    expect(request!.instructions).toContain('never break character');
    expect(request!.instructions).toContain('She is an adult and so is he');
  });

  /** Nothing is spent that is not needed: a light user keeps the full policy. */
  it('does not trim when there is room', async () => {
    const user = await register('vb.few@example.com');
    await remember(user.userId, 2);
    const request = await buildProviderSessionRequest(ctx.db, await callRow(user));
    expect(request!.instructions).toContain('Fact 0');
    expect(request!.instructions).toContain('Fact 1');
  });

  /**
   * SELECTION PRIORITY IS UNCHANGED (US-12): newest facts win when the budget
   * binds, and whole facts are kept or dropped, never edited.
   */
  it('keeps the newest facts when the budget binds', async () => {
    const user = await register('vb.newest@example.com');
    await remember(user.userId, 40);
    const request = await buildProviderSessionRequest(ctx.db, await callRow(user));
    expect(request!.instructions).toContain('Fact 39');
    expect(request!.instructions).not.toContain('Fact 0 ');
  });

  it('never splits a fact in half', async () => {
    const user = await register('vb.whole@example.com');
    await remember(user.userId, 40);
    const request = await buildProviderSessionRequest(ctx.db, await callRow(user));
    for (const line of request!.instructions.split('\n')) {
      if (!line.includes('Fact ')) continue;
      expect(line).toMatch(/x{170}/);
    }
  });
});

/* ------------------------------------------------------------------ *
 * When the persona alone will not fit
 * ------------------------------------------------------------------ */

describe('a persona that cannot fit on its own fails loudly', () => {
  /**
   * There is nothing left to trim here, so the alternative to failing is
   * letting the provider cut the frame off the end -- which is the exact
   * failure this change exists to stop. A refusal names the character and is
   * fixable by editing her; a silent truncation is not fixable, because nobody
   * finds out.
   */
  it('refuses rather than shipping a prompt with its rules cut off', async () => {
    await ctx.db
      .update(characters)
      .set({ personality: 'A'.repeat(INSTRUCTIONS_MAX_CHARS) })
      .where(eq(characters.id, LUNA.id));
    const user = await register('vb.huge@example.com');
    await expect(buildProviderSessionRequest(ctx.db, await callRow(user))).rejects.toThrow(
      /exceeds the 8000-character limit/,
    );
  });

  it('says how long it was and what to do about it', async () => {
    await ctx.db
      .update(characters)
      .set({ personality: 'A'.repeat(INSTRUCTIONS_MAX_CHARS) })
      .where(eq(characters.id, LUNA.id));
    const user = await register('vb.hugemsg@example.com');
    await expect(buildProviderSessionRequest(ctx.db, await callRow(user))).rejects.toThrow(
      /Shorten her persona or system prompt/,
    );
  });

  /** The boundary itself: just inside the margin must still succeed. */
  it('allows a persona that lands just inside the margin', async () => {
    const user = await register('vb.edge@example.com');
    const bare = await buildProviderSessionRequest(ctx.db, await callRow(user));
    const headroom = INSTRUCTIONS_MAX_CHARS - INSTRUCTION_SAFETY_MARGIN - bare!.instructions.length;
    await ctx.db
      .update(characters)
      .set({ personality: `${LUNA.personality}${'A'.repeat(Math.max(0, headroom - 50))}` })
      .where(eq(characters.id, LUNA.id));
    const user2 = await register('vb.edge2@example.com');
    const request = await buildProviderSessionRequest(ctx.db, await callRow(user2));
    expect(request).not.toBeNull();
    expect(request!.instructions).toContain('never break character');
  });
});

/* ------------------------------------------------------------------ *
 * Fresh vs established, and character individuality
 * ------------------------------------------------------------------ */

describe('a call does not depend on how long they have known each other', () => {
  /**
   * The old layer keyed three warmth variants to a count of rows in `messages`,
   * which call turns never enter -- so a voice-only caller stayed a stranger
   * forever. This proves the instructions no longer move at all.
   */
  it('gives a fresh caller and an established one identical instructions', async () => {
    const fresh = await register('vb.fresh@example.com');
    const freshReq = await buildProviderSessionRequest(ctx.db, await callRow(fresh));

    const established = await register('vb.established@example.com');
    for (let i = 0; i < 30; i++) {
      await ctx.app.inject({
        method: 'POST',
        url: `/api/conversations/${established.conversationId}/messages`,
        payload: { content: `message ${i}` },
        cookies: {},
      });
    }
    const establishedReq = await buildProviderSessionRequest(ctx.db, await callRow(established));

    expect(freshReq!.instructions).toBe(establishedReq!.instructions);
  });

  it('carries no stage wording at all', async () => {
    const user = await register('vb.nostage@example.com');
    const request = await buildProviderSessionRequest(ctx.db, await callRow(user));
    expect(request!.instructions).not.toContain('You two are new to each other');
    expect(request!.instructions).not.toContain('You have known each other a while');
    expect(request!.instructions).not.toContain('A call warms up as it runs');
  });
});

describe('characters still sound like themselves', () => {
  /**
   * The per-character sound line is the ONLY line in the layer that differs
   * between characters, which is what stops every voice sounding alike. It is
   * now inside the protected head, so a long persona can no longer cost a
   * character her own voice.
   */
  it('gives two characters different instructions', async () => {
    const ember = SEED_CHARACTERS.find((c) => c.name === 'ember')!;
    const user = await register('vb.diff@example.com');
    const lunaReq = await buildProviderSessionRequest(ctx.db, await callRow(user));

    /**
     * A SECOND CALLER, not a second call by the same one.
     * `call_sessions_user_live_idx` permits one live call per USER — the
     * constraint that stops anybody holding two open at once — so comparing two
     * characters means two people.
     */
    const other = await register('vb.diff2@example.com');
    const [conv] = await ctx.db
      .insert(conversations)
      .values({ userId: other.userId, characterId: ember.id })
      .returning();
    const [row] = await ctx.db
      .insert(callSessions)
      .values({
        userId: other.userId,
        conversationId: conv!.id,
        characterId: ember.id,
        provider: 'spicyapi',
        voice: 'Serena',
        status: 'active',
        maxSeconds: 120,
      })
      .returning();
    const emberReq = await buildProviderSessionRequest(ctx.db, row!);

    expect(lunaReq!.instructions).not.toBe(emberReq!.instructions);
    expect(lunaReq!.instructions).toContain(LUNA.displayName);
    expect(emberReq!.instructions).toContain(ember.displayName);
  });

  it('keeps her own sound line where truncation cannot reach it', async () => {
    const user = await register('vb.sound@example.com');
    await remember(user.userId, 40);
    const request = await buildProviderSessionRequest(ctx.db, await callRow(user));
    expect(request!.instructions).toContain('This is how she sounds, so sound like it');
  });
});

/* ------------------------------------------------------------------ *
 * Ordinary conversation versus a scene
 * ------------------------------------------------------------------ */

describe('ordinary talk and an acted scene are both provided for', () => {
  /**
   * ONE DEFAULT WITH A CONDITIONAL. Both lines are present on every call --
   * nothing branches, because the model can see what he is actually doing and
   * a server deciding it from one message was the old mistake.
   */
  it('states the ordinary default and the scene exception together', async () => {
    const user = await register('vb.modes@example.com');
    const request = await buildProviderSessionRequest(ctx.db, await callRow(user));
    expect(request!.instructions).toContain('follow what he came for');
    expect(request!.instructions).toContain('If he starts acting something out');
    expect(request!.instructions).toContain('step out with him');
  });

  it('does not force flirting or small talk on a caller who did not ask', async () => {
    const user = await register('vb.noforce@example.com');
    const request = await buildProviderSessionRequest(ctx.db, await callRow(user));
    expect(request!.instructions).not.toContain('Flirt, and let it build');
    expect(request!.instructions).not.toContain('Carry the conversation');
    expect(request!.instructions).not.toContain('Volunteer things');
    expect(request!.instructions).not.toContain('Lead sometimes');
  });

  /** Consent reads in both directions, and the upward half is the new part. */
  it('follows him up as well as down, without a one-way ceiling', async () => {
    const user = await register('vb.consent@example.com');
    const request = await buildProviderSessionRequest(ctx.db, await callRow(user));
    expect(request!.instructions).toContain('Go where he goes, both ways');
    expect(request!.instructions).toContain('Follow his conversational lead');
    expect(request!.instructions).toContain('If he changes direction, change with him');
    expect(request!.instructions).toContain('rather than taking it there yourself');
    expect(request!.instructions).not.toContain('never push past where he is');
  });

  it('speaks the physical line aloud rather than in typed conventions', async () => {
    const user = await register('vb.spoken@example.com');
    const request = await buildProviderSessionRequest(ctx.db, await callRow(user));
    expect(request!.instructions).toContain('answer it out loud');
    expect(request!.instructions).not.toContain('If he is writing a scene');
    expect(request!.instructions).not.toContain('No room, no staging, no asterisks');
  });
});
