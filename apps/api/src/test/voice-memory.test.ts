import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  callSessions,
  callTranscriptTurns,
  characterVisualIdentities,
  memories,
} from '../db/schema.js';
import { SEED_CHARACTERS } from '../db/seed-data.js';
import { seedCharacters } from '../db/seed.js';
import type { LlmClient, LlmRequest } from '../llm/types.js';
import { createLlmReplyProvider } from '../services/llm-reply-provider.js';
import {
  createLlmMemoryExtractor,
  deterministicMemoryExtractor,
  renderTranscriptForExtraction,
  type MemoryExtractionContext,
  type MemoryExtractor,
} from '../services/memory-extractor.js';
import { listMemories } from '../services/memory-service.js';
import {
  extractCallMemories,
  findCallsAwaitingExtraction,
  recoverCallMemories,
  RECOVERY_BATCH_LIMIT,
} from '../services/call-memory-service.js';
import { buildProviderSessionRequest } from '../services/call-session-service.js';
import { buildCharacterSystemPrompt } from '../services/prompt-builder.js';
import {
  createTestContext,
  destroyTestContext,
  extractSessionCookie,
  migrateTestDb,
  truncateAll,
  type TestContext,
} from './helpers.js';

/**
 * Shared memory, filled from a voice call (Step 4).
 *
 * THE PRODUCT CLAIM UNDER TEST is that a call can be discussed afterwards: what
 * someone said on the phone on Monday has to be available to the same character
 * in a text chat on Thursday, and on the next call. There is one memory for both
 * channels, so these tests follow a fact from a transcript into the `memories`
 * table and out again through BOTH prompt paths.
 *
 * The relay is not involved here. The end-to-end trigger -- call, hang up,
 * memories appear -- is covered in voice-relay.test.ts, which owns the socket
 * harness. This suite drives `extractCallMemories` directly, because the states
 * that matter most (expired, already extracted, a failing extractor) are awkward
 * or impossible to reach through a live socket.
 */

/**
 * A seam for making the memory WRITE fail.
 *
 * Mocked rather than provoked: every way of breaking the insert from outside is
 * blocked by a foreign key (`call_sessions.character_id` is ON DELETE restrict,
 * so the character cannot be removed underneath it), and `storeMemories` is
 * deliberately unguarded -- so the only honest way to exercise its failure path
 * is to make it throw.
 */
const storeHooks = vi.hoisted(() => ({ throws: null as null | Error }));

vi.mock('../services/memory-service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/memory-service.js')>();
  return {
    ...actual,
    storeMemories: async (...args: Parameters<typeof actual.storeMemories>) => {
      if (storeHooks.throws) throw storeHooks.throws;
      return actual.storeMemories(...args);
    },
  };
});

const LUNA = SEED_CHARACTERS.find((c) => c.name === 'luna')!;
const EMBER = SEED_CHARACTERS.find((c) => c.name === 'ember')!;

let ctx: TestContext;
const fakeReply = createFakeClient();

/** Counts calls, so "no model was asked" can be asserted and not assumed. */
function countingExtractor(facts: string[] = []): MemoryExtractor & { calls: MemoryExtractionContext[] } {
  const calls: MemoryExtractionContext[] = [];
  const extractor = ((context: MemoryExtractionContext) => {
    calls.push(context);
    return facts;
  }) as MemoryExtractor & { calls: MemoryExtractionContext[] };
  extractor.calls = calls;
  return extractor;
}

function createFakeClient() {
  const captured: LlmRequest[] = [];
  let reply = 'A fake in-character reply.';
  const client: LlmClient = {
    async generate(request) {
      captured.push(request);
      return reply;
    },
  };
  return { client, captured, setReply: (r: string) => (reply = r) };
}

beforeAll(async () => {
  migrateTestDb();
  ctx = await createTestContext({
    // A real reply pipeline, so a later TEXT message's prompt can be inspected.
    replyProvider: createLlmReplyProvider(fakeReply.client, { maxTokens: 256, temperature: 0.7 }),
    memoryExtractor: deterministicMemoryExtractor,
    voiceCallsEnabled: true,
  });
});

afterAll(async () => {
  await destroyTestContext(ctx);
});

beforeEach(async () => {
  await truncateAll(ctx);
  await seedCharacters(ctx.db);
  fakeReply.captured.length = 0;
  fakeReply.setReply('A fake in-character reply.');
  storeHooks.throws = null;
});

/* ------------------------------------------------------------------ *
 * Helpers: a user, a conversation, a finished call with a transcript
 * ------------------------------------------------------------------ */

async function register(email: string, characterId: string = LUNA.id) {
  const reg = await ctx.app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email, password: 'voice-memory-pass1' },
  });
  const cookie = extractSessionCookie(reg)!;
  const cookies = { [cookie.name]: cookie.value };
  const conv = await ctx.app.inject({
    method: 'POST',
    url: '/api/conversations',
    payload: { characterId },
    cookies,
  });
  return {
    userId: reg.json().id as string,
    cookies,
    conversationId: conv.json().id as string,
    characterId,
  };
}

/** A call row in a chosen terminal state, written directly. */
async function finishedCall(
  user: { userId: string; conversationId: string; characterId: string },
  status: 'ended' | 'expired' | 'failed' | 'active' = 'ended',
  terminationReason: string | null = null,
) {
  const [row] = await ctx.db
    .insert(callSessions)
    .values({
      userId: user.userId,
      conversationId: user.conversationId,
      characterId: user.characterId,
      provider: 'spicyapi',
      voice: 'Serena',
      status,
      maxSeconds: 780,
      startedAt: new Date(),
      endedAt: status === 'active' ? null : new Date(),
      terminationReason,
    })
    .returning();
  return row!;
}

/** Appends turns in the given order; `seq` is assigned by the database. */
async function transcript(callSessionId: string, turns: ['user' | 'character', string][]) {
  for (const [speaker, content] of turns) {
    await ctx.db.insert(callTranscriptTurns).values({ callSessionId, speaker, content });
  }
}

const factsFor = (userId: string, characterId: string) =>
  listMemories(ctx.db, userId, characterId);

const rowFor = async (id: string) => {
  const [row] = await ctx.db.select().from(callSessions).where(eq(callSessions.id, id));
  return row!;
};

/* ------------------------------------------------------------------ *
 * A call becomes memory
 * ------------------------------------------------------------------ */

describe('a finished call becomes shared memory', () => {
  it('extracts what the person said and records the call as processed', async () => {
    const user = await register('vm.basic@example.com');
    const call = await finishedCall(user);
    await transcript(call.id, [
      ['character', 'Hey. What should I call you?'],
      ['user', 'My name is Maya.'],
      ['character', 'Where are you calling from?'],
      ['user', 'I live in Haifa.'],
    ]);

    const outcome = await extractCallMemories(ctx.db, call.id, {
      extractor: deterministicMemoryExtractor,
      maxStored: 100,
    });

    expect(outcome).toEqual({ status: 'extracted', facts: 2, firstToComplete: true });
    /**
     * Sorted, because the ORDER of facts written in one batch is not defined:
     * `storeMemories` inserts them in a single statement so they share a
     * `created_at`, and `listMemories` breaks that tie on a random uuid. What is
     * guaranteed -- and all the prompt needs -- is the set.
     */
    expect((await factsFor(user.userId, LUNA.id)).sort()).toEqual(
      ['Their name is Maya.', 'They live in Haifa.'].sort(),
    );
    // Only now is the call marked done.
    expect((await rowFor(call.id)).memoriesExtractedAt).not.toBeNull();
  });

  /**
   * THE MISATTRIBUTION TEST, and the reason the transcript is filtered rather
   * than concatenated. Everything suggestive here is HERS: a question, a guess,
   * and a statement about herself. The person confirms none of it.
   */
  it("never turns the character's own words into facts about the person", async () => {
    const user = await register('vm.attribution@example.com');
    const call = await finishedCall(user);
    await transcript(call.id, [
      ['character', 'My name is Luna.'],
      ['character', 'I live in Lisbon. Do you live in Lisbon too?'],
      ['character', 'You must be exhausted. I bet your name is Daniel.'],
      ['character', 'I have a dog named Pepper.'],
      ['user', 'Mm. Maybe.'],
    ]);

    const outcome = await extractCallMemories(ctx.db, call.id, {
      extractor: deterministicMemoryExtractor,
      maxStored: 100,
    });

    expect(outcome).toEqual({ status: 'extracted', facts: 0, firstToComplete: true });
    const stored = await factsFor(user.userId, LUNA.id);
    expect(stored).toEqual([]);
    // Named explicitly: none of her words became his.
    const asText = stored.join(' ');
    expect(asText).not.toContain('Luna');
    expect(asText).not.toContain('Lisbon');
    expect(asText).not.toContain('Daniel');
    expect(asText).not.toContain('Pepper');
  });

  it('reads the transcript in spoken order and keeps the speaker labels', async () => {
    const user = await register('vm.order@example.com');
    const call = await finishedCall(user);
    await transcript(call.id, [
      ['user', 'First thing I said.'],
      ['character', 'Her reply.'],
      ['user', 'Second thing I said.'],
    ]);

    const extractor = countingExtractor();
    await extractCallMemories(ctx.db, call.id, { extractor, maxStored: 100 });

    expect(extractor.calls).toHaveLength(1);
    expect(extractor.calls[0]!.transcript).toEqual([
      { speaker: 'user', content: 'First thing I said.' },
      { speaker: 'character', content: 'Her reply.' },
      { speaker: 'user', content: 'Second thing I said.' },
    ]);
    // The single-message field is empty by contract when a transcript is present.
    expect(extractor.calls[0]!.userMessage).toBe('');
  });

  it('isolates memories per user and per character', async () => {
    const mine = await register('vm.iso.mine@example.com', LUNA.id);
    const stranger = await register('vm.iso.stranger@example.com', LUNA.id);
    const other = await register('vm.iso.other@example.com', EMBER.id);

    for (const [user, name] of [
      [mine, 'Maya'],
      [stranger, 'Boris'],
      [other, 'Nadia'],
    ] as const) {
      const call = await finishedCall(user);
      await transcript(call.id, [['user', `My name is ${name}.`]]);
      await extractCallMemories(ctx.db, call.id, {
        extractor: deterministicMemoryExtractor,
        maxStored: 100,
      });
    }

    expect(await factsFor(mine.userId, LUNA.id)).toEqual(['Their name is Maya.']);
    expect(await factsFor(stranger.userId, LUNA.id)).toEqual(['Their name is Boris.']);
    expect(await factsFor(other.userId, EMBER.id)).toEqual(['Their name is Nadia.']);
    // Neither the other person's nor the other character's.
    expect(await factsFor(mine.userId, EMBER.id)).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * Eligibility, idempotency and failure
 * ------------------------------------------------------------------ */

describe('which calls are extracted, and how often', () => {
  it('asks no model and stores nothing for a call where only she spoke', async () => {
    const user = await register('vm.empty@example.com');
    const call = await finishedCall(user);
    await transcript(call.id, [['character', 'Hello? Are you there?']]);

    const extractor = countingExtractor(['Their name is Invented.']);
    const outcome = await extractCallMemories(ctx.db, call.id, { extractor, maxStored: 100 });

    expect(outcome).toEqual({ status: 'skipped', reason: 'empty_transcript' });
    expect(extractor.calls).toHaveLength(0); // no inference was bought
    expect(await factsFor(user.userId, LUNA.id)).toEqual([]);
    // Marked done: there is no work owed, so it must not stay eligible for ever.
    expect((await rowFor(call.id)).memoriesExtractedAt).not.toBeNull();
  });

  it('asks no model for a call with no transcript at all', async () => {
    const user = await register('vm.notranscript@example.com');
    const call = await finishedCall(user);

    const extractor = countingExtractor(['Their name is Invented.']);
    const outcome = await extractCallMemories(ctx.db, call.id, { extractor, maxStored: 100 });

    expect(outcome).toEqual({ status: 'skipped', reason: 'empty_transcript' });
    expect(extractor.calls).toHaveLength(0);
    expect(await factsFor(user.userId, LUNA.id)).toEqual([]);
  });

  /**
   * A call that ran to the provider's ceiling is a real conversation and IS
   * extracted. The policy's other half -- that a row the overdue sweep marked
   * `expired` long after the relay was gone is never picked up by anything --
   * is a documented limitation, not a behaviour that can be asserted here.
   */
  it('extracts an expired call, which is a conversation that ran its course', async () => {
    const user = await register('vm.expired@example.com');
    const call = await finishedCall(user, 'expired', 'max_duration');
    await transcript(call.id, [['user', 'My name is Maya.']]);

    const outcome = await extractCallMemories(ctx.db, call.id, {
      extractor: deterministicMemoryExtractor,
      maxStored: 100,
    });

    expect(outcome).toEqual({ status: 'extracted', facts: 1, firstToComplete: true });
    expect(await factsFor(user.userId, LUNA.id)).toEqual(['Their name is Maya.']);
  });

  it.each([
    ['failed', 'failed'],
    ['active', 'active'],
  ] as const)('does not extract a %s call, and asks no model', async (_label, status) => {
    const user = await register(`vm.ineligible.${status}@example.com`);
    const call = await finishedCall(user, status);
    await transcript(call.id, [['user', 'My name is Maya.']]);

    const extractor = countingExtractor(['Their name is Maya.']);
    const outcome = await extractCallMemories(ctx.db, call.id, { extractor, maxStored: 100 });

    expect(outcome).toEqual({ status: 'skipped', reason: 'not_eligible' });
    expect(extractor.calls).toHaveLength(0);
    expect(await factsFor(user.userId, LUNA.id)).toEqual([]);
    // Left unmarked: an ineligible call is not a processed one.
    expect((await rowFor(call.id)).memoriesExtractedAt).toBeNull();
  });

  /**
   * THE UNIQUE INDEX IS NOT ENOUGH ON ITS OWN. It stops a duplicate memory ROW,
   * but a second extraction would still buy a second inference. The marker is
   * what prevents that, so this asserts the model was not asked again.
   */
  it('extracts once, however many times it is asked', async () => {
    const user = await register('vm.once@example.com');
    const call = await finishedCall(user);
    await transcript(call.id, [['user', 'My name is Maya.']]);

    const extractor = countingExtractor(['Their name is Maya.']);
    const first = await extractCallMemories(ctx.db, call.id, { extractor, maxStored: 100 });
    const second = await extractCallMemories(ctx.db, call.id, { extractor, maxStored: 100 });
    const third = await extractCallMemories(ctx.db, call.id, { extractor, maxStored: 100 });

    expect(first).toEqual({ status: 'extracted', facts: 1, firstToComplete: true });
    expect(second).toEqual({ status: 'skipped', reason: 'already_extracted' });
    expect(third).toEqual({ status: 'skipped', reason: 'already_extracted' });
    expect(extractor.calls).toHaveLength(1); // one inference, not three
    expect(await factsFor(user.userId, LUNA.id)).toEqual(['Their name is Maya.']);
  });

  it('leaves the call eligible when extraction fails, and succeeds on a retry', async () => {
    const user = await register('vm.retry@example.com');
    const call = await finishedCall(user);
    await transcript(call.id, [['user', 'My name is Maya.']]);

    const failures: unknown[] = [];
    const outcome = await extractCallMemories(ctx.db, call.id, {
      extractor: () => {
        throw new Error('the model was unreachable');
      },
      maxStored: 100,
      onError: (error) => failures.push(error),
    });

    expect(outcome).toEqual({ status: 'failed' });
    expect(failures).toHaveLength(1);
    expect(await factsFor(user.userId, LUNA.id)).toEqual([]);
    // STILL OWED. This is the whole purpose of the column.
    expect((await rowFor(call.id)).memoriesExtractedAt).toBeNull();

    // A later attempt is free to succeed.
    const retry = await extractCallMemories(ctx.db, call.id, {
      extractor: deterministicMemoryExtractor,
      maxStored: 100,
    });
    expect(retry).toEqual({ status: 'extracted', facts: 1, firstToComplete: true });
    expect(await factsFor(user.userId, LUNA.id)).toEqual(['Their name is Maya.']);
    expect((await rowFor(call.id)).memoriesExtractedAt).not.toBeNull();
  });

  it('marks the call processed when a fact is dropped by normalisation', async () => {
    const user = await register('vm.storefail@example.com');
    const call = await finishedCall(user);
    await transcript(call.id, [['user', 'My name is Maya.']]);

    /**
     * A fact past the 300-character normalisation cap is dropped by
     * `storeMemories`, so nothing is stored -- and the call is STILL marked
     * processed, because the extraction itself succeeded. Retrying would only buy
     * the same inference and discard the same fact, so nothing is owed here.
     */
    const outcome = await extractCallMemories(ctx.db, call.id, {
      extractor: () => ['They '.repeat(200) + 'ramble.'],
      maxStored: 100,
    });
    expect(outcome).toEqual({ status: 'extracted', facts: 1, firstToComplete: true });
    expect(await factsFor(user.userId, LUNA.id)).toEqual([]);
    expect((await rowFor(call.id)).memoriesExtractedAt).not.toBeNull();
  });

  it('survives a call session that has been deleted underneath it', async () => {
    const user = await register('vm.gone@example.com');
    const call = await finishedCall(user);
    await ctx.db.delete(callSessions).where(eq(callSessions.id, call.id));

    const extractor = countingExtractor();
    const outcome = await extractCallMemories(ctx.db, call.id, { extractor, maxStored: 100 });
    expect(outcome).toEqual({ status: 'skipped', reason: 'not_eligible' });
    expect(extractor.calls).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ *
 * The point of all this: both channels read it back
 * ------------------------------------------------------------------ */

describe('what was said on the call reaches both channels afterwards', () => {
  /** A text chat days later. The fact came from a CALL, not from any message. */
  it('a later text message carries the call-derived memories into the prompt', async () => {
    const user = await register('vm.totext@example.com');
    const call = await finishedCall(user);
    await transcript(call.id, [
      ['user', 'My name is Maya and I live in Haifa.'],
      ['character', 'Haifa. I have never been.'],
    ]);
    await extractCallMemories(ctx.db, call.id, {
      extractor: deterministicMemoryExtractor,
      maxStored: 100,
    });

    // No message has ever been sent in this conversation before now.
    const sent = await ctx.app.inject({
      method: 'POST',
      url: `/api/conversations/${user.conversationId}/messages`,
      payload: { content: 'Hey, remember me?' },
      cookies: user.cookies,
    });
    expect(sent.statusCode).toBe(201);

    const system = fakeReply.captured.at(-1)!.messages.find((m) => m.role === 'system')!.content;
    expect(system).toContain('Their name is Maya.');
    expect(system).toContain('They live in Haifa.');
    expect(system).toContain('Things you remember about this person');
  });

  /** And the next call. Same table, same scope, the Step 1 read path. */
  it('a later voice call carries the same memories into the provider prompt', async () => {
    const user = await register('vm.tovoice@example.com');
    const call = await finishedCall(user);
    await transcript(call.id, [['user', 'My name is Maya.']]);
    await extractCallMemories(ctx.db, call.id, {
      extractor: deterministicMemoryExtractor,
      maxStored: 100,
    });

    const next = await finishedCall(user, 'active');
    const request = await buildProviderSessionRequest(ctx.db, next);
    expect(request).not.toBeNull();
    expect(request!.instructions).toContain('Their name is Maya.');
    expect(request!.instructions).toContain('Things you remember about this person');
  });

  /** Nothing remembered must read as nothing, never as a vague recollection. */
  it('says nothing about memory when the call produced none', async () => {
    const user = await register('vm.nofacts@example.com');
    const call = await finishedCall(user);
    await transcript(call.id, [['user', 'Mm. Nice weather.']]);
    await extractCallMemories(ctx.db, call.id, {
      extractor: deterministicMemoryExtractor,
      maxStored: 100,
    });

    const next = await finishedCall(user, 'active');
    const request = await buildProviderSessionRequest(ctx.db, next);
    expect(request!.instructions).not.toContain('Things you remember about this person');
  });

  /** The transcript itself must never be injected -- only the facts drawn from it. */
  it('never puts the transcript into a prompt', async () => {
    const user = await register('vm.notranscriptinprompt@example.com');
    const call = await finishedCall(user);
    await transcript(call.id, [
      ['user', 'My name is Maya. I also said something private about my marriage.'],
      ['character', 'That sounds difficult.'],
    ]);
    await extractCallMemories(ctx.db, call.id, {
      extractor: deterministicMemoryExtractor,
      maxStored: 100,
    });

    const next = await finishedCall(user, 'active');
    const request = await buildProviderSessionRequest(ctx.db, next);
    expect(request!.instructions).toContain('Their name is Maya.');
    expect(request!.instructions).not.toContain('marriage');
    expect(request!.instructions).not.toContain('That sounds difficult.');
  });
});

/* ------------------------------------------------------------------ *
 * The transcript instructions, as the model receives them
 * ------------------------------------------------------------------ */

describe('the transcript extraction prompt', () => {
  it('labels both speakers in spoken order', () => {
    expect(
      renderTranscriptForExtraction([
        { speaker: 'character', content: 'What should I call you?' },
        { speaker: 'user', content: 'Maya.' },
      ]),
    ).toBe('CHARACTER: What should I call you?\nUSER: Maya.');
  });

  it('tells the model to use only what the user said, and sends the labelled turns', async () => {
    const fake = createFakeClient();
    fake.setReply('- Their name is Maya.');
    const extractor = createLlmMemoryExtractor(fake.client);

    const facts = await extractor({
      character: { id: LUNA.id, displayName: 'Luna' } as never,
      userMessage: '',
      transcript: [
        { speaker: 'character', content: 'I bet your name is Daniel.' },
        { speaker: 'user', content: 'My name is Maya.' },
      ],
    });

    expect(facts).toEqual(['Their name is Maya.']);
    const request = fake.captured[0]!;
    const system = request.messages.find((m) => m.role === 'system')!.content;
    expect(system).toContain('Extract durable facts about THE PERSON LABELLED "USER"');
    expect(system).toContain('A question the CHARACTER asked is not an answer');
    expect(system).toContain('A guess, suggestion or sympathy from the CHARACTER is not a fact');
    // The turns go in labelled, as the user-role message.
    const sent = request.messages.find((m) => m.role === 'user')!.content;
    expect(sent).toBe('CHARACTER: I bet your name is Daniel.\nUSER: My name is Maya.');
  });

  /** The pollution guard is NOT relaxed for transcripts. */
  it('still refuses model output that is not a third-person bulleted fact', async () => {
    const fake = createFakeClient();
    fake.setReply(
      [
        'Here is what I found:',
        '- She lives in Lisbon.',
        '- Do they have a brother?',
        '- Their name is Maya.',
        'They live in Haifa.',
      ].join('\n'),
    );
    const extractor = createLlmMemoryExtractor(fake.client);

    const facts = await extractor({
      character: { id: LUNA.id, displayName: 'Luna' } as never,
      userMessage: '',
      transcript: [{ speaker: 'user', content: 'anything' }],
    });

    // Only the bulleted, third-person, finished sentence survives.
    expect(facts).toEqual(['Their name is Maya.']);
  });

  /** A single message still uses the single-message instructions. */
  it('does not use the transcript instructions for an ordinary message', async () => {
    const fake = createFakeClient();
    fake.setReply('NONE');
    const extractor = createLlmMemoryExtractor(fake.client);

    await extractor({
      character: { id: LUNA.id, displayName: 'Luna' } as never,
      userMessage: 'Hello there.',
    });

    const system = fake.captured[0]!.messages.find((m) => m.role === 'system')!.content;
    expect(system).toContain('from one chat message they wrote');
    expect(system).not.toContain('transcript of a phone call');
  });
});

/* ------------------------------------------------------------------ *
 * Memories outlive the transcript they came from
 * ------------------------------------------------------------------ */

describe('extracted memories are independent of transcript retention', () => {
  it('survives deleting the transcript turns', async () => {
    const user = await register('vm.outlive@example.com');
    const call = await finishedCall(user);
    await transcript(call.id, [['user', 'My name is Maya.']]);
    await extractCallMemories(ctx.db, call.id, {
      extractor: deterministicMemoryExtractor,
      maxStored: 100,
    });

    await ctx.db.delete(callTranscriptTurns).where(eq(callTranscriptTurns.callSessionId, call.id));

    expect(await factsFor(user.userId, LUNA.id)).toEqual(['Their name is Maya.']);
  });

  it('survives deleting the call session itself', async () => {
    const user = await register('vm.outlivecall@example.com');
    const call = await finishedCall(user);
    await transcript(call.id, [['user', 'My name is Maya.']]);
    await extractCallMemories(ctx.db, call.id, {
      extractor: deterministicMemoryExtractor,
      maxStored: 100,
    });

    await ctx.db.delete(callSessions).where(eq(callSessions.id, call.id));

    // The transcript cascaded away; the memory did not.
    const [{ count }] = await ctx.db.select({ count: memories.id }).from(memories);
    expect(count).toBeTruthy();
    expect(await factsFor(user.userId, LUNA.id)).toEqual(['Their name is Maya.']);
  });
});

/* ------------------------------------------------------------------ *
 * Concurrency: one inference, whoever asks
 * ------------------------------------------------------------------ */

describe('two callers racing for the same call', () => {
  /**
   * THE RACE THE LEASE EXISTS FOR, and the one the earlier sequential test could
   * not see. Both attempts start before either finishes, so both would pass a
   * read-then-decide guard and both would pay for an inference.
   *
   * The extractor blocks until released, which is what guarantees the overlap is
   * real rather than hoped for: the second attempt cannot possibly have waited
   * for the first.
   */
  it('runs the model once when two extractions start together', async () => {
    const user = await register('vm.race@example.com');
    const call = await finishedCall(user);
    await transcript(call.id, [['user', 'My name is Maya.']]);

    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls: number[] = [];
    const blocking: MemoryExtractor = async () => {
      calls.push(Date.now());
      await held;
      return ['Their name is Maya.'];
    };

    const first = extractCallMemories(ctx.db, call.id, { extractor: blocking, maxStored: 100 });
    const second = extractCallMemories(ctx.db, call.id, { extractor: blocking, maxStored: 100 });

    // Let the loser reach its verdict, then let the winner finish.
    const secondOutcome = await second;
    release();
    const firstOutcome = await first;

    const outcomes = [firstOutcome, secondOutcome];
    expect(outcomes.filter((o) => o.status === 'extracted')).toHaveLength(1);
    expect(outcomes.filter((o) => o.status === 'skipped')).toHaveLength(1);
    expect(outcomes.find((o) => o.status === 'skipped')).toEqual({
      status: 'skipped',
      reason: 'already_claimed',
    });

    // THE ASSERTION THAT MATTERS: one inference was bought, not two.
    expect(calls).toHaveLength(1);
    expect(await factsFor(user.userId, LUNA.id)).toEqual(['Their name is Maya.']);
    expect((await rowFor(call.id)).memoriesExtractedAt).not.toBeNull();
  });

  it('releases the claim when extraction fails, so a retry need not wait', async () => {
    const user = await register('vm.release@example.com');
    const call = await finishedCall(user);
    await transcript(call.id, [['user', 'My name is Maya.']]);

    await extractCallMemories(ctx.db, call.id, {
      extractor: () => {
        throw new Error('model unreachable');
      },
      maxStored: 100,
    });

    // Handed back, not held for the lease duration.
    const row = await rowFor(call.id);
    expect(row.memoriesExtractionClaimedAt).toBeNull();
    expect(row.memoriesExtractedAt).toBeNull();

    // So an immediate retry can claim it.
    const retry = await extractCallMemories(ctx.db, call.id, {
      extractor: deterministicMemoryExtractor,
      maxStored: 100,
    });
    expect(retry).toEqual({ status: 'extracted', facts: 1, firstToComplete: true });
  });

  /** A crash leaves a claim behind. It must not make the call unworkable for ever. */
  it('treats an abandoned claim as free once it is stale', async () => {
    const user = await register('vm.stale@example.com');
    const call = await finishedCall(user);
    await transcript(call.id, [['user', 'My name is Maya.']]);

    // A claim from an hour ago: the process that took it is long gone.
    await ctx.db
      .update(callSessions)
      .set({ memoriesExtractionClaimedAt: new Date(Date.now() - 3_600_000) })
      .where(eq(callSessions.id, call.id));

    const outcome = await extractCallMemories(ctx.db, call.id, {
      extractor: deterministicMemoryExtractor,
      maxStored: 100,
    });
    expect(outcome).toEqual({ status: 'extracted', facts: 1, firstToComplete: true });
  });

  it('leaves a freshly claimed call to whoever holds it', async () => {
    const user = await register('vm.heldclaim@example.com');
    const call = await finishedCall(user);
    await transcript(call.id, [['user', 'My name is Maya.']]);

    await ctx.db
      .update(callSessions)
      .set({ memoriesExtractionClaimedAt: new Date() })
      .where(eq(callSessions.id, call.id));

    const extractor = countingExtractor(['Their name is Maya.']);
    const outcome = await extractCallMemories(ctx.db, call.id, { extractor, maxStored: 100 });
    expect(outcome).toEqual({ status: 'skipped', reason: 'already_claimed' });
    expect(extractor.calls).toHaveLength(0);
  });

  /* ---------------- a release may only undo its own claim ---------------- */

  /**
   * THE DEFECT THIS PINS. The `try` opens before the first read and before the
   * claim, so the catch block is reachable by a worker that holds no claim at
   * all -- an ordinary database blip on the initial select is enough. While
   * release matched on the session id alone, that worker cleared whoever's claim
   * was live, and a third caller could then claim and buy the same inference
   * again.
   *
   * The failing database here breaks only `select`, so `update` still reaches the
   * real database: without the fix, the release genuinely lands.
   */
  it('a worker that never claimed does not release the holder\'s claim', async () => {
    const user = await register('vm.norelease@example.com');
    const call = await finishedCall(user);
    await transcript(call.id, [['user', 'My name is Maya.']]);

    // Somebody else is holding a fresh claim.
    const holder = new Date();
    await ctx.db
      .update(callSessions)
      .set({ memoriesExtractionClaimedAt: holder })
      .where(eq(callSessions.id, call.id));

    // A second worker whose very first read fails. Writes still work.
    const readsFail = new Proxy(ctx.db, {
      get(target, prop, receiver) {
        if (prop === 'select') {
          return () => {
            throw Object.assign(new Error('Failed query: select from "call_sessions" ...'), {
              name: 'DrizzleQueryError',
            });
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as typeof ctx.db;

    const failures: unknown[] = [];
    const outcome = await extractCallMemories(
      readsFail,
      call.id,
      {
        extractor: deterministicMemoryExtractor,
        maxStored: 100,
        onError: (error) => failures.push(error),
      },
    );

    expect(outcome).toEqual({ status: 'failed' });
    expect(failures).toHaveLength(1);

    // THE ASSERTION: the holder's claim is untouched, so nobody else can claim.
    const row = await rowFor(call.id);
    expect(row.memoriesExtractionClaimedAt).not.toBeNull();
    expect(row.memoriesExtractionClaimedAt?.getTime()).toBe(holder.getTime());

    const extractor = countingExtractor(['Their name is Maya.']);
    expect(await extractCallMemories(ctx.db, call.id, { extractor, maxStored: 100 })).toEqual({
      status: 'skipped',
      reason: 'already_claimed',
    });
    expect(extractor.calls).toHaveLength(0);
  });

  /**
   * The stale variant. A worker that overran the lease and was replaced must not
   * hand its successor's claim away when it finally fails.
   */
  it('a worker whose claim was reclaimed cannot release the new one', async () => {
    const user = await register('vm.stalerelease@example.com');
    const call = await finishedCall(user);
    await transcript(call.id, [['user', 'My name is Maya.']]);

    // This worker claims, then is replaced mid-extraction, then fails.
    const successor = new Date(Date.now() + 1_000);
    const outcome = await extractCallMemories(ctx.db, call.id, {
      extractor: async () => {
        await ctx.db
          .update(callSessions)
          .set({ memoriesExtractionClaimedAt: successor })
          .where(eq(callSessions.id, call.id));
        throw new Error('overran the lease and then failed');
      },
      maxStored: 100,
    });

    expect(outcome).toEqual({ status: 'failed' });
    // The successor still holds the row.
    const row = await rowFor(call.id);
    expect(row.memoriesExtractionClaimedAt?.getTime()).toBe(successor.getTime());
    expect(row.memoriesExtractedAt).toBeNull();
  });

  /** The holder's own release still works, which is the point of keeping it. */
  it("releases the holder's own claim so a retry need not wait", async () => {
    const user = await register('vm.ownrelease@example.com');
    const call = await finishedCall(user);
    await transcript(call.id, [['user', 'My name is Maya.']]);

    await extractCallMemories(ctx.db, call.id, {
      extractor: () => {
        throw new Error('model unreachable');
      },
      maxStored: 100,
    });

    expect((await rowFor(call.id)).memoriesExtractionClaimedAt).toBeNull();
  });

  /** A failing WRITE, not a failing model: also eligible, also no marker. */
  it('leaves the call eligible when storing the facts throws', async () => {
    const user = await register('vm.storethrows@example.com');
    const call = await finishedCall(user);
    await transcript(call.id, [['user', 'My name is Maya.']]);

    const failures: unknown[] = [];
    storeHooks.throws = Object.assign(new Error('Failed query: insert into "memories" ...'), {
      name: 'DrizzleQueryError',
    });

    const outcome = await extractCallMemories(
      ctx.db,
      call.id,
      {
        extractor: () => ['Their name is Maya.'],
        maxStored: 100,
        onError: (error) => failures.push(error),
      },
    );

    expect(outcome).toEqual({ status: 'failed' });
    expect(failures).toHaveLength(1);
    const row = await rowFor(call.id);
    expect(row.memoriesExtractedAt).toBeNull();
    expect(row.memoriesExtractionClaimedAt).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * Recovery: the calls still owed an extraction
 * ------------------------------------------------------------------ */

describe('recovering calls that were never extracted', () => {
  it('finds an ended call that has no memories yet', async () => {
    const user = await register('vm.rec.ended@example.com');
    const call = await finishedCall(user, 'ended');
    await transcript(call.id, [['user', 'My name is Maya.']]);

    expect(await findCallsAwaitingExtraction(ctx.db, user.userId, LUNA.id)).toEqual([call.id]);
  });

  it('finds a call that ran to the provider ceiling', async () => {
    const user = await register('vm.rec.maxduration@example.com');
    const call = await finishedCall(user, 'expired', 'max_duration');
    await transcript(call.id, [['user', 'My name is Maya.']]);

    expect(await findCallsAwaitingExtraction(ctx.db, user.userId, LUNA.id)).toEqual([call.id]);
  });

  /**
   * THE TWO `expired` CALLS ARE NOT THE SAME THING, and `termination_reason` is
   * what tells them apart: the relay writes `max_duration` when a call reaches
   * the ceiling, the overdue sweep writes `expired` when it settles a row the
   * relay never did. A swept row may hold a transcript whose end was never
   * flushed, so recovery does not touch it.
   */
  it('ignores a session the overdue sweep expired', async () => {
    const user = await register('vm.rec.swept@example.com');
    const swept = await finishedCall(user, 'expired', 'expired');
    await transcript(swept.id, [['user', 'My name is Maya.']]);

    expect(await findCallsAwaitingExtraction(ctx.db, user.userId, LUNA.id)).toEqual([]);

    const extractor = countingExtractor(['Their name is Maya.']);
    const result = await recoverCallMemories(ctx.db, user.userId, LUNA.id, {
      extractor,
      maxStored: 100,
    });
    expect(result).toEqual({ attempted: 0, extracted: 0 });
    expect(extractor.calls).toHaveLength(0);
    expect(await factsFor(user.userId, LUNA.id)).toEqual([]);
  });

  it.each([
    ['failed', 'failed', 'provider_unauthorized'],
    ['pending', 'active', null],
  ] as const)('ignores a %s session', async (_label, status, reason) => {
    const user = await register(`vm.rec.skip.${status}@example.com`);
    const call = await finishedCall(user, status, reason);
    await transcript(call.id, [['user', 'My name is Maya.']]);

    expect(await findCallsAwaitingExtraction(ctx.db, user.userId, LUNA.id)).toEqual([]);
  });

  it('ignores a call that has already been extracted', async () => {
    const user = await register('vm.rec.done@example.com');
    const call = await finishedCall(user);
    await transcript(call.id, [['user', 'My name is Maya.']]);
    await extractCallMemories(ctx.db, call.id, {
      extractor: deterministicMemoryExtractor,
      maxStored: 100,
    });

    expect(await findCallsAwaitingExtraction(ctx.db, user.userId, LUNA.id)).toEqual([]);
  });

  it('ignores another user and another character', async () => {
    const mine = await register('vm.rec.mine@example.com', LUNA.id);
    const stranger = await register('vm.rec.stranger@example.com', LUNA.id);
    const other = await register('vm.rec.other@example.com', EMBER.id);
    for (const user of [mine, stranger, other]) {
      const call = await finishedCall(user);
      await transcript(call.id, [['user', 'My name is Maya.']]);
    }

    const found = await findCallsAwaitingExtraction(ctx.db, mine.userId, LUNA.id);
    expect(found).toHaveLength(1);
    // And recovery only fills the scope it was asked about.
    await recoverCallMemories(ctx.db, mine.userId, LUNA.id, {
      extractor: deterministicMemoryExtractor,
      maxStored: 100,
    });
    expect(await factsFor(mine.userId, LUNA.id)).toEqual(['Their name is Maya.']);
    expect(await factsFor(stranger.userId, LUNA.id)).toEqual([]);
    expect(await factsFor(other.userId, EMBER.id)).toEqual([]);
  });

  /** One request must never become a batch job. */
  it('considers no more than the batch limit, newest first', async () => {
    const user = await register('vm.rec.limit@example.com');
    const made: string[] = [];
    for (let i = 0; i < RECOVERY_BATCH_LIMIT + 3; i += 1) {
      const call = await finishedCall(user);
      // Distinct end times, so "newest first" is a real ordering and not a tie.
      await ctx.db
        .update(callSessions)
        .set({ endedAt: new Date(Date.now() - (RECOVERY_BATCH_LIMIT + 3 - i) * 60_000) })
        .where(eq(callSessions.id, call.id));
      await transcript(call.id, [['user', `My name is Name${i}.`]]);
      made.push(call.id);
    }

    const found = await findCallsAwaitingExtraction(ctx.db, user.userId, LUNA.id);
    expect(found).toHaveLength(RECOVERY_BATCH_LIMIT);
    // The newest ones, which are the last created.
    expect(found).toEqual(made.slice(-RECOVERY_BATCH_LIMIT).reverse());

    const result = await recoverCallMemories(ctx.db, user.userId, LUNA.id, {
      extractor: deterministicMemoryExtractor,
      maxStored: 100,
    });
    expect(result).toEqual({ attempted: RECOVERY_BATCH_LIMIT, extracted: RECOVERY_BATCH_LIMIT });
  });

  it('extracts a backlog across successive triggers', async () => {
    const user = await register('vm.rec.backlog@example.com');
    for (let i = 0; i < 5; i += 1) {
      const call = await finishedCall(user);
      await ctx.db
        .update(callSessions)
        .set({ endedAt: new Date(Date.now() - (5 - i) * 60_000) })
        .where(eq(callSessions.id, call.id));
      await transcript(call.id, [['user', `My name is Name${i}.`]]);
    }

    const deps = { extractor: deterministicMemoryExtractor, maxStored: 100 };
    const first = await recoverCallMemories(ctx.db, user.userId, LUNA.id, deps);
    const second = await recoverCallMemories(ctx.db, user.userId, LUNA.id, deps);
    const third = await recoverCallMemories(ctx.db, user.userId, LUNA.id, deps);

    expect(first.extracted).toBe(RECOVERY_BATCH_LIMIT);
    expect(second.extracted).toBe(5 - RECOVERY_BATCH_LIMIT);
    expect(third).toEqual({ attempted: 0, extracted: 0 });
    expect(await findCallsAwaitingExtraction(ctx.db, user.userId, LUNA.id)).toEqual([]);
  });

  it('never throws at its caller, whatever the extractor does', async () => {
    const user = await register('vm.rec.throws@example.com');
    const call = await finishedCall(user);
    await transcript(call.id, [['user', 'My name is Maya.']]);

    const result = await recoverCallMemories(ctx.db, user.userId, LUNA.id, {
      extractor: () => {
        throw new Error('model unreachable');
      },
      maxStored: 100,
    });
    expect(result).toEqual({ attempted: 1, extracted: 0 });
    // Still owed, and claimable again immediately.
    expect(await findCallsAwaitingExtraction(ctx.db, user.userId, LUNA.id)).toEqual([call.id]);
  });
});

/* ------------------------------------------------------------------ *
 * Her apparent age, when the record establishes one
 * ------------------------------------------------------------------ */

describe('the call prompt states her apparent age', () => {
  /**
   * Writes an active visual identity carrying `apparentAgeBand`.
   *
   * Inserted directly rather than through `createVisualIdentityVersion`, because
   * that path validates the band on the way in -- and several of these cases are
   * precisely the invalid data a validator would have refused. A record can still
   * hold one: rows predate validators, and operators edit databases.
   */
  async function identityWithBand(characterId: string, apparentAgeBand: unknown) {
    await ctx.db.delete(characterVisualIdentities).where(
      eq(characterVisualIdentities.characterId, characterId),
    );
    await ctx.db.insert(characterVisualIdentities).values({
      characterId,
      version: 1,
      status: 'active',
      visualDna: { apparentAgeBand } as never,
    });
  }

  /** The compiled instructions for a live call on this user's character. */
  async function instructionsFor(user: { userId: string; conversationId: string; characterId: string }) {
    const call = await finishedCall(user, 'active');
    const request = await buildProviderSessionRequest(ctx.db, call);
    expect(request).not.toBeNull();
    return request!.instructions;
  }

  it('states a verified adult band verbatim', async () => {
    const user = await register('age.adult@example.com');
    await identityWithBand(LUNA.id, 'adult (mid-20s)');

    expect(await instructionsFor(user)).toContain('Her apparent age is adult (mid-20s).');
  });

  /**
   * VERBATIM, NOT COMPUTED. The profile page shows "26" for a character whose
   * only stored datum is the word "adult" -- that number is invented in the
   * browser by `adultAgeFromBand`, which defaults to 26. None of it reaches the
   * prompt.
   */
  it('invents no number when the band carries none', async () => {
    const user = await register('age.noNumber@example.com');
    await identityWithBand(LUNA.id, 'adult');

    const instructions = await instructionsFor(user);
    expect(instructions).toContain('Her apparent age is adult.');
    expect(instructions).not.toContain('26');
  });

  it.each([
    ['no visual identity at all', null],
    ['an empty band', ''],
    ['a whitespace band', '   '],
  ])('says nothing about her age with %s', async (label, band) => {
    const user = await register(`age.missing.${label.length}@example.com`);
    if (band !== null) await identityWithBand(LUNA.id, band);
    else {
      await ctx.db
        .delete(characterVisualIdentities)
        .where(eq(characterVisualIdentities.characterId, LUNA.id));
    }

    expect(await instructionsFor(user)).not.toContain('Her apparent age');
  });

  it.each([
    ['a non-string band', 42],
    ['a null band', null],
    ['an object band', { band: 'adult' }],
  ])('says nothing about her age given %s', async (label, band) => {
    const user = await register(`age.invalid.${label.length}@example.com`);
    await identityWithBand(LUNA.id, band);

    expect(await instructionsFor(user)).not.toContain('Her apparent age');
  });

  /**
   * THE CONTRADICTORY CASE, which the existing validator already resolves the
   * safe way: its numeric check runs BEFORE the word "adult" can accept, so a
   * band that says both is refused rather than believed.
   */
  it.each([
    'adult (17)',
    'adult, 16',
    'adult teenager',
    'young adult, 15-19',
  ])('refuses the contradictory band %s', async (band) => {
    const user = await register(`age.contradictory.${band.length}@example.com`);
    await identityWithBand(LUNA.id, band);

    const instructions = await instructionsFor(user);
    expect(instructions).not.toContain('Her apparent age');
    expect(instructions).not.toContain('adult');
  });

  it.each(['teen', 'child', 'minor', 'adolescent', 'underage'])(
    'refuses the non-adult band %s',
    async (band) => {
      const user = await register(`age.minor.${band}@example.com`);
      await identityWithBand(LUNA.id, band);

      expect(await instructionsFor(user)).not.toContain('Her apparent age');
    },
  );

  it('accepts a decade band that never says the word adult', async () => {
    const user = await register('age.decade@example.com');
    await identityWithBand(LUNA.id, '30s');

    expect(await instructionsFor(user)).toContain('Her apparent age is 30s.');
  });

  /** Everything else about the persona is untouched by this line. */
  it('leaves the rest of the persona intact', async () => {
    const user = await register('age.intact@example.com');
    await identityWithBand(LUNA.id, 'adult');

    const instructions = await instructionsFor(user);
    expect(instructions).toContain('WHO SHE IS');
    expect(instructions).toContain(LUNA.displayName);
    // The age sits among the facts, not in place of them.
    expect(instructions.indexOf('Her apparent age')).toBeGreaterThan(
      instructions.indexOf('WHO SHE IS'),
    );
  });

  /**
   * TEXT CHAT IS UNCHANGED. It never reads the visual identity, so the field is
   * absent and the chat prompt is byte-for-byte what it was.
   */
  it('adds nothing to a prompt built without the field', () => {
    const withoutField = buildCharacterSystemPrompt({
      character: { id: LUNA.id, displayName: 'Luna', shortBio: '', personality: '', interests: [] } as never,
      systemPrompt: '',
      history: [],
      priorMessageCount: 0,
      userMessage: 'hello',
    });
    expect(withoutField).not.toContain('Her apparent age');
  });
});
