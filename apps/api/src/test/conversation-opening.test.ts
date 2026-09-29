import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { asc } from 'drizzle-orm';
import { messages } from '../db/schema.js';
import { SEED_CHARACTERS } from '../db/seed-data.js';
import { seedCharacters } from '../db/seed.js';
import { LlmError } from '../llm/types.js';
import type { ReplyContext, ReplyProvider } from '../services/character-reply.js';
import { openingLockKey } from '../services/conversation-opening-service.js';
import {
  createTestContext,
  destroyTestContext,
  extractSessionCookie,
  migrateTestDb,
  truncateAll,
  type TestContext,
} from './helpers.js';

/**
 * The character opens the conversation.
 *
 * WHAT THESE TESTS ARE ACTUALLY FOR. The feature itself is one insert. The part
 * that can go wrong — and the reason this file is mostly about concurrency — is
 * that the trigger is "a visitor opened an empty chat", and that fires from two
 * tabs, from a double tap, from a refresh while the first request is still in
 * the air, and at the same moment he decides to type hello himself. Every one of
 * those must end with AT MOST ONE greeting, and a greeting must never appear
 * after something he said.
 *
 * NO REAL AI. The provider is injected and mocked in every test here, so
 * nothing in this suite can reach a model.
 */

let ctx: TestContext;
const LUNA_ID = SEED_CHARACTERS.find((c) => c.name === 'luna')!.id;

const GREETING = "Mm, you're here. I was just about to put the kettle on — long day?";

/**
 * The injected opening provider delegates to whatever the test set, so one app
 * (and one connection pool) serves the whole file. Reset in beforeEach.
 */
let openingImpl: ReplyProvider;
let openingCalls: ReplyContext[];

/** The reply provider for ordinary sends, also swappable per test. */
let replyImpl: ReplyProvider;

beforeAll(async () => {
  migrateTestDb();
  ctx = await createTestContext({
    openingProvider: (context) => {
      openingCalls.push(context);
      return openingImpl(context);
    },
    replyProvider: (context) => replyImpl(context),
  });
});

afterAll(async () => {
  await destroyTestContext(ctx);
});

beforeEach(async () => {
  await truncateAll(ctx);
  await seedCharacters(ctx.db);
  openingCalls = [];
  openingImpl = () => GREETING;
  replyImpl = ({ userMessage }) => `Luna hears you: ${userMessage}`;
});

async function register(email: string) {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email, password: 'opening-test-pass1' },
  });
  const cookie = extractSessionCookie(res)!;
  return { userId: res.json().id as string, cookies: { [cookie.name]: cookie.value } };
}

async function startConversation(cookies: Record<string, string>) {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/conversations',
    payload: { characterId: LUNA_ID },
    cookies,
  });
  return res.json().id as string;
}

async function setup(email: string) {
  const { userId, cookies } = await register(email);
  return { userId, cookies, conversationId: await startConversation(cookies) };
}

function openConversation(cookies: Record<string, string>, conversationId: string) {
  return ctx.app.inject({
    method: 'POST',
    url: `/api/conversations/${conversationId}/opening`,
    cookies,
  });
}

function send(cookies: Record<string, string>, conversationId: string, content: string) {
  return ctx.app.inject({
    method: 'POST',
    url: `/api/conversations/${conversationId}/messages`,
    payload: { content },
    cookies,
  });
}

/** Stored senders, oldest first — the order the visitor will actually read. */
async function storedOrder(): Promise<string[]> {
  const rows = await ctx.db
    .select({ sender: messages.sender, content: messages.content })
    .from(messages)
    .orderBy(asc(messages.seq));
  return rows.map((r) => r.sender);
}

async function storedContents(): Promise<string[]> {
  const rows = await ctx.db
    .select({ content: messages.content })
    .from(messages)
    .orderBy(asc(messages.seq));
  return rows.map((r) => r.content);
}

/* ------------------------------------------------------------------ *
 * She greets an empty conversation
 * ------------------------------------------------------------------ */

describe('POST /api/conversations/:id/opening', () => {
  it('greets an empty conversation with one character message', async () => {
    const { cookies, conversationId } = await setup('open.a@example.com');

    const res = await openConversation(cookies, conversationId);

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.created).toBe(true);
    expect(body.message.content).toBe(GREETING);
    // The field the client styles the bubble from. Omitting it once made a
    // greeting arrive looking like something the visitor had said.
    expect(body.message.sender).toBe('character');
    expect(body.message.id).toEqual(expect.any(String));
    expect(body.message.createdAt).toEqual(expect.any(String));

    expect(await storedOrder()).toEqual(['character']);
  });

  it('becomes part of the conversation history like any other message', async () => {
    const { cookies, conversationId } = await setup('open.history@example.com');
    const opened = await openConversation(cookies, conversationId);

    const history = await ctx.app.inject({
      method: 'GET',
      url: `/api/conversations/${conversationId}/messages`,
      cookies,
    });
    expect(history.json()).toHaveLength(1);
    expect(history.json()[0].id).toBe(opened.json().message.id);
    expect(history.json()[0].sender).toBe('character');
  });

  /**
   * NO SYNTHETIC USER TURN. Inventing a "hi" for her to answer would put words
   * in his mouth, and any of it that reached the database would read, forever
   * after, as something he actually said.
   */
  it('generates from an empty conversation, with no invented user message', async () => {
    const { cookies, conversationId } = await setup('open.context@example.com');
    await openConversation(cookies, conversationId);

    expect(openingCalls).toHaveLength(1);
    const context = openingCalls[0]!;
    expect(context.history).toEqual([]);
    expect(context.priorMessageCount).toBe(0);
    expect(context.userMessage).toBe('');
    expect(context.character.displayName).toBeTruthy();

    // And nothing from the visitor was stored.
    expect(await storedOrder()).toEqual(['character']);
  });
});

/* ------------------------------------------------------------------ *
 * Never twice
 * ------------------------------------------------------------------ */

describe('a conversation is greeted at most once', () => {
  it('adds nothing on a second call', async () => {
    const { cookies, conversationId } = await setup('open.twice@example.com');

    const first = await openConversation(cookies, conversationId);
    const second = await openConversation(cookies, conversationId);

    expect(first.json().created).toBe(true);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ created: false, message: null });
    expect(await storedOrder()).toEqual(['character']);
  });

  it('does not greet a conversation somebody has already spoken in', async () => {
    const { cookies, conversationId } = await setup('open.existing@example.com');
    await send(cookies, conversationId, 'Hi Luna');
    expect(await storedOrder()).toEqual(['user', 'character']);

    const res = await openConversation(cookies, conversationId);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ created: false, message: null });
    // Not merely "no message written" — no generation was even attempted, so an
    // existing conversation costs nothing.
    expect(openingCalls).toHaveLength(0);
    expect(await storedOrder()).toEqual(['user', 'character']);
  });

  /**
   * THE CASE THE CLIENT CANNOT SOLVE. Two tabs, a double tap, or a retry after a
   * response was lost in transit are all simultaneous requests from one person.
   */
  it('creates exactly one greeting under five simultaneous requests', async () => {
    const { cookies, conversationId } = await setup('open.concurrent@example.com');

    const results = await Promise.all(
      Array.from({ length: 5 }, () => openConversation(cookies, conversationId)),
    );

    expect(results.every((r) => r.statusCode === 200)).toBe(true);
    expect(results.filter((r) => r.json().created)).toHaveLength(1);
    expect(await storedOrder()).toEqual(['character']);

    // The honest cost of generating OUTSIDE the lock: several requests may pay
    // for a greeting and only one may keep it. Asserted rather than glossed
    // over, because the alternative — holding the lock across the model call —
    // would make the visitor's first message queue behind a greeting.
    expect(openingCalls.length).toBeGreaterThanOrEqual(1);
    expect(openingCalls.length).toBeLessThanOrEqual(5);
  });
});

/* ------------------------------------------------------------------ *
 * Failure is quiet, and never permanent
 * ------------------------------------------------------------------ */

describe('a failed greeting', () => {
  it('answers 200 with no message rather than an error', async () => {
    openingImpl = () => {
      throw new LlmError('timeout', 'took too long');
    };
    const { cookies, conversationId } = await setup('open.fail@example.com');

    const res = await openConversation(cookies, conversationId);

    // A greeting is a courtesy, not what he came for. Nothing of his was lost,
    // so there is nothing to report and nothing to retry by hand.
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ created: false, message: null });
    expect(await storedOrder()).toEqual([]);
  });

  it('writes nothing when the model returns only whitespace', async () => {
    openingImpl = () => '   \n  ';
    const { cookies, conversationId } = await setup('open.blank@example.com');

    const res = await openConversation(cookies, conversationId);

    // An empty bubble is worse than no bubble.
    expect(res.json()).toEqual({ created: false, message: null });
    expect(await storedOrder()).toEqual([]);
  });

  /**
   * WHY THE TRIGGER IS EMPTINESS AND NOT "WAS JUST CREATED". A creation flag is
   * spent the moment the conversation is made, so one failed generation would
   * leave her permanently silent. Emptiness can be re-read, so the next visit
   * simply tries again.
   */
  it('is retried the next time he opens the conversation', async () => {
    openingImpl = () => {
      throw new LlmError('http', 'provider unavailable', 502);
    };
    const { cookies, conversationId } = await setup('open.retry@example.com');
    expect((await openConversation(cookies, conversationId)).json().created).toBe(false);

    openingImpl = () => GREETING;
    const retried = await openConversation(cookies, conversationId);

    expect(retried.json().created).toBe(true);
    expect(retried.json().message.content).toBe(GREETING);
    expect(await storedOrder()).toEqual(['character']);
  });

  it('leaves the chat completely usable', async () => {
    openingImpl = () => {
      throw new LlmError('http', 'provider unavailable', 502);
    };
    const { cookies, conversationId } = await setup('open.usable@example.com');
    await openConversation(cookies, conversationId);

    const sent = await send(cookies, conversationId, 'Hello anyway');

    expect(sent.statusCode).toBe(201);
    expect(await storedOrder()).toEqual(['user', 'character']);
  });
});

/* ------------------------------------------------------------------ *
 * Ownership
 * ------------------------------------------------------------------ */

describe('it is only ever his own conversation', () => {
  it("answers 404 for somebody else's conversation, and generates nothing", async () => {
    const owner = await setup('open.owner@example.com');
    const stranger = await register('open.stranger@example.com');

    const res = await openConversation(stranger.cookies, owner.conversationId);

    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('not_found');
    // 404, not 403: the same "no existence leaks" answer every other read of a
    // foreign conversation gives.
    expect(openingCalls).toHaveLength(0);
    expect(await storedOrder()).toEqual([]);
  });

  it('answers 401 without a session', async () => {
    const { conversationId } = await setup('open.anon@example.com');

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/conversations/${conversationId}/opening`,
    });

    expect(res.statusCode).toBe(401);
    expect(await storedOrder()).toEqual([]);
  });

  it('answers 404 for an unknown or malformed id', async () => {
    const { cookies } = await setup('open.unknown@example.com');

    const missing = await openConversation(cookies, '00000000-0000-4000-8000-000000000000');
    const malformed = await openConversation(cookies, 'not-a-uuid');

    expect(missing.statusCode).toBe(404);
    expect(malformed.statusCode).toBe(404);
    expect(openingCalls).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ *
 * The race against his own first message
 * ------------------------------------------------------------------ */

/**
 * BOTH SIDES OF THE RACE, AND NEITHER LEFT TO CHANCE.
 *
 * He can type hello while the greeting is still being generated. Whoever wins,
 * the result has to read correctly: a greeting must never land after something
 * he said, and his message must never be lost or reordered.
 *
 * The two tests below force each outcome deterministically rather than firing
 * both requests and hoping. A test that depended on which of two in-flight
 * requests reached a lock first would pass or fail by timing.
 */
describe('the race with his first message', () => {
  /**
   * HIS MESSAGE WINS. The greeting is held inside generation — outside the lock,
   * exactly where a slow model call sits — until his send has fully completed.
   * It then takes the lock, re-reads the conversation, finds he has spoken, and
   * throws itself away.
   */
  it('discards the greeting when he speaks first', async () => {
    const { cookies, conversationId } = await setup('open.race.user@example.com');

    let releaseGreeting!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseGreeting = resolve;
    });
    openingImpl = async () => {
      await held;
      return GREETING;
    };

    const greeting = openConversation(cookies, conversationId);
    const sent = await send(cookies, conversationId, 'hey, you there?');
    expect(sent.statusCode).toBe(201);

    releaseGreeting();
    const res = await greeting;

    // Generated, paid for, and deliberately thrown away: writing it would have
    // shown her greeting a conversation already in progress.
    expect(openingCalls).toHaveLength(1);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ created: false, message: null });

    expect(await storedOrder()).toEqual(['user', 'character']);
    expect(await storedContents()).not.toContain(GREETING);
  });

  /**
   * THE GREETING WINS, with both requests genuinely in flight and genuinely
   * contending.
   *
   * The test holds the conversation's advisory lock on its own connection so
   * both requests pile up behind it, then confirms through `pg_locks` that each
   * is really waiting before releasing. Postgres grants a queued exclusive lock
   * in arrival order, so the greeting — queued first — goes first.
   */
  it('puts the greeting first when it wins, and his message after it', async () => {
    const { cookies, conversationId } = await setup('open.race.greeting@example.com');

    const blocker = await ctx.pool.connect();
    let greeting: Promise<unknown>;
    let sent: Promise<unknown>;
    try {
      await blocker.query('begin');
      await blocker.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
        openingLockKey(conversationId),
      ]);

      // Both requests reach the lock and stop there. Waiting for the waiter
      // COUNT rather than for a timeout is what makes the order deterministic.
      greeting = openConversation(cookies, conversationId);
      await waitForLockWaiters(1);
      sent = send(cookies, conversationId, 'and hello from me');
      await waitForLockWaiters(2);
    } finally {
      await blocker.query('rollback');
      blocker.release();
    }

    const greetingRes = (await greeting) as { statusCode: number; json: () => { created: boolean } };
    const sentRes = (await sent) as { statusCode: number };

    expect(greetingRes.json().created).toBe(true);
    expect(sentRes.statusCode).toBe(201);

    // The order he reads: she spoke, then he answered, then she replied.
    expect(await storedOrder()).toEqual(['character', 'user', 'character']);
    expect((await storedContents())[0]).toBe(GREETING);
  });
});

/**
 * Waits until exactly `n` transactions are blocked on an advisory lock.
 *
 * The suite runs test files sequentially against this database (vitest
 * `fileParallelism: false`), so the only advisory-lock waiters are the ones this
 * test created.
 */
async function waitForLockWaiters(n: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const { rows } = await ctx.pool.query<{ waiting: string }>(
      "select count(*) as waiting from pg_locks where locktype = 'advisory' and not granted",
    );
    if (Number(rows[0]!.waiting) >= n) return;
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${n} advisory-lock waiter(s).`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
