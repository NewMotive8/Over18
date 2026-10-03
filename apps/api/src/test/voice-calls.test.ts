import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { callSessions, characters } from '../db/schema.js';
import {
  PENDING_DEADLINE_SECONDS,
  expireIfOverdue,
  failConnect,
} from '../services/call-session-service.js';
import { SEED_CHARACTERS } from '../db/seed-data.js';
import { seedCharacters } from '../db/seed.js';
import type { VoiceSession, VoiceSessionProvider, VoiceSessionRequest } from '../voice/types.js';
import {
  createTestContext,
  destroyTestContext,
  extractSessionCookie,
  migrateTestDb,
  truncateAll,
  type TestContext,
} from './helpers.js';

/**
 * Live voice calls -- Phase 1 (session lifecycle only).
 *
 * WHAT THESE TESTS ARE PROTECTING. Phase 1 ships a path that can create a PAID
 * provider session but has no relay and no billing behind it. So the properties
 * that matter are: it is switched off by default, it is the caller's own
 * conversation or nothing, a failed provider never leaves a session looking
 * live, two simultaneous starts produce one call, and no credential or persona
 * ever reaches a response.
 *
 * NO PROVIDER IS EVER CONTACTED. Every test injects a stub; the real adapter is
 * exercised separately with no network.
 */

const LUNA_ID = SEED_CHARACTERS.find((c) => c.name === 'luna')!.id;

/** The persona the server compiles. Planted here so a leak is detectable. */
const CANARY = 'Her name is Luna.';

let ctx: TestContext;
/** Off by default — the same environment every other suite runs under. */
let gated: TestContext;
/** The misconfiguration: VOICE_CALLS_ENABLED=true with no SPICYAPI_API_KEY. */
let keyless: TestContext;

let providerCalls: VoiceSessionRequest[];
let providerImpl: (request: VoiceSessionRequest) => Promise<VoiceSession>;

const stubSession = (over: Partial<VoiceSession> = {}): VoiceSession => ({
  providerSessionId: 'rt_test_1',
  voice: 'Serena',
  maxSeconds: 780,
  url: 'wss://api.spicyapi.com/v1/realtime?session=SUPER_SECRET_TICKET',
  clientSecret: 'cs_SUPER_SECRET_VALUE',
  clientSecretExpiresAt: Math.floor(Date.now() / 1000) + 60,
  ...over,
});

const provider: VoiceSessionProvider = {
  name: 'spicyapi',
  async createSession(request) {
    providerCalls.push(request);
    return providerImpl(request);
  },
};

beforeAll(async () => {
  migrateTestDb();
  ctx = await createTestContext({ voiceCallsEnabled: true, voiceProvider: provider });
  gated = await createTestContext({ voiceProvider: provider });
  keyless = await createTestContext({ voiceCallsEnabledWithoutKey: true, voiceProvider: provider });
});

afterAll(async () => {
  await destroyTestContext(ctx);
  await destroyTestContext(gated);
  await destroyTestContext(keyless);
});

beforeEach(async () => {
  await truncateAll(ctx);
  await seedCharacters(ctx.db);
  providerCalls = [];
  providerImpl = async () => stubSession();
});

async function setup(app: TestContext, email: string) {
  const reg = await app.app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email, password: 'voice-test-pass-1' },
  });
  const cookie = extractSessionCookie(reg)!;
  const cookies = { [cookie.name]: cookie.value };
  const conv = await app.app.inject({
    method: 'POST',
    url: '/api/conversations',
    payload: { characterId: LUNA_ID },
    cookies,
  });
  return { userId: reg.json().id as string, cookies, conversationId: conv.json().id as string };
}

const start = (app: TestContext, cookies: Record<string, string>, conversationId: string) =>
  app.app.inject({ method: 'POST', url: `/api/conversations/${conversationId}/call`, cookies });

const end = (cookies: Record<string, string>, id: string) =>
  ctx.app.inject({ method: 'POST', url: `/api/calls/${id}/end`, cookies });

const status = (cookies: Record<string, string>, id: string) =>
  ctx.app.inject({ method: 'GET', url: `/api/calls/${id}`, cookies });

/* ------------------------------------------------------------------ *
 * Migration 0049 -- the transcript table's shape
 * ------------------------------------------------------------------ */

describe('call_transcript_turns schema / migration', () => {
  it('created the table with the expected columns', async () => {
    const res = await ctx.pool.query(
      `SELECT column_name, data_type, is_nullable FROM information_schema.columns
       WHERE table_name = 'call_transcript_turns' ORDER BY column_name`,
    );
    const columns = Object.fromEntries(res.rows.map((r) => [r.column_name, r]));
    expect(Object.keys(columns).sort()).toEqual([
      'call_session_id',
      'content',
      'created_at',
      'id',
      'seq',
      'speaker',
    ]);
    expect(columns.id.data_type).toBe('uuid');
    expect(columns.call_session_id.data_type).toBe('uuid');
    // bigserial reports as bigint with a sequence default -- see the next test.
    expect(columns.seq.data_type).toBe('bigint');
    expect(columns.speaker.data_type).toBe('USER-DEFINED'); // call_turn_speaker enum
    expect(columns.content.data_type).toBe('text');
    expect(columns.created_at.data_type).toBe('timestamp with time zone');
    // Nothing here is optional: a turn with no speaker or no text is not a turn.
    for (const name of Object.keys(columns)) {
      expect(columns[name].is_nullable).toBe('NO');
    }
  });

  /** `seq` must be a real sequence, not a column someone remembers to set. */
  it('orders turns by a database-assigned sequence', async () => {
    const res = await ctx.pool.query(
      `SELECT column_default FROM information_schema.columns
       WHERE table_name = 'call_transcript_turns' AND column_name = 'seq'`,
    );
    expect(res.rows[0].column_default).toContain('nextval');
  });

  it('permits exactly two speakers', async () => {
    const res = await ctx.pool.query(
      `SELECT e.enumlabel FROM pg_enum e
       JOIN pg_type t ON t.oid = e.enumtypid
       WHERE t.typname = 'call_turn_speaker' ORDER BY e.enumsortorder`,
    );
    expect(res.rows.map((r) => r.enumlabel)).toEqual(['user', 'character']);
  });

  /**
   * ONE INDEX, LEADING ON call_session_id. Reading a transcript is always "this
   * call, in order", and Postgres does not index a foreign key on its own -- so
   * the composite covers both and a separate index on the key alone would be
   * redundant with this one's leading column.
   */
  it('indexes (call_session_id, seq) and nothing redundant', async () => {
    const res = await ctx.pool.query(
      `SELECT indexname, indexdef FROM pg_indexes
       WHERE tablename = 'call_transcript_turns' ORDER BY indexname`,
    );
    const names = res.rows.map((r) => r.indexname);
    // The primary key's own index, plus exactly one of ours.
    expect(names).toContain('call_transcript_turns_call_seq_idx');
    expect(names).toHaveLength(2);
    const composite = res.rows.find((r) => r.indexname === 'call_transcript_turns_call_seq_idx');
    expect(composite.indexdef).toMatch(/\(call_session_id, seq\)/);
  });

  it('is scoped only through its call session -- no user or character column', async () => {
    const res = await ctx.pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'call_transcript_turns'`,
    );
    const names = res.rows.map((r) => r.column_name);
    // Ownership is inherited through call_sessions. A copy here would be a
    // second place for it to be true, and therefore a place to disagree.
    expect(names).not.toContain('user_id');
    expect(names).not.toContain('character_id');
  });

  it('cascades from its call session, so a transcript cannot outlive the call', async () => {
    const res = await ctx.pool.query(
      `SELECT rc.delete_rule, kcu.column_name, ccu.table_name AS references_table
         FROM information_schema.referential_constraints rc
         JOIN information_schema.key_column_usage kcu
           ON kcu.constraint_name = rc.constraint_name
         JOIN information_schema.constraint_column_usage ccu
           ON ccu.constraint_name = rc.constraint_name
        WHERE kcu.table_name = 'call_transcript_turns'`,
    );
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0].delete_rule).toBe('CASCADE');
    expect(res.rows[0].column_name).toBe('call_session_id');
    expect(res.rows[0].references_table).toBe('call_sessions');
  });

  /** Inert on purpose: the relay is unchanged in this step. */
  it('is empty after a call has been started and ended', async () => {
    const user = await setup(ctx, 'transcript.inert@example.com');
    const started = await start(ctx, user.cookies, user.conversationId);
    expect(started.statusCode).toBe(201);
    await end(user.cookies, started.json().callSession.id);

    const res = await ctx.pool.query('SELECT count(*)::int AS n FROM call_transcript_turns');
    expect(res.rows[0].n).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * The gate
 * ------------------------------------------------------------------ */

describe('voice calls are switched off by default', () => {
  /**
   * THE MOST IMPORTANT TEST IN THIS FILE. Phase 1 can create a billable
   * provider session and has no billing behind it. Default-off is what stops
   * that being reachable.
   */
  it('refuses to start a call with the default configuration', async () => {
    const user = await setup(gated, 'voice.gate@example.com');
    const res = await start(gated, user.cookies, user.conversationId);

    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('voice_unavailable');
    // Not merely refused — nothing was attempted and nothing was recorded.
    expect(providerCalls).toHaveLength(0);
    expect(await gated.db.select().from(callSessions)).toHaveLength(0);
  });

  it('still requires authentication when disabled', async () => {
    const user = await setup(gated, 'voice.gate.anon@example.com');
    const res = await gated.app.inject({
      method: 'POST',
      url: `/api/conversations/${user.conversationId}/call`,
    });
    expect(res.statusCode).toBe(401);
  });
});

/* ------------------------------------------------------------------ *
 * Authentication and ownership
 * ------------------------------------------------------------------ */

describe('it is only ever his own conversation', () => {
  it('answers 401 without a session', async () => {
    const user = await setup(ctx, 'voice.anon@example.com');
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/conversations/${user.conversationId}/call`,
    });
    expect(res.statusCode).toBe(401);
    expect(providerCalls).toHaveLength(0);
  });

  it("answers 404 for somebody else's conversation, and contacts no provider", async () => {
    const owner = await setup(ctx, 'voice.owner@example.com');
    const stranger = await setup(ctx, 'voice.stranger@example.com');

    const res = await start(ctx, stranger.cookies, owner.conversationId);

    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('not_found');
    expect(providerCalls).toHaveLength(0);
  });

  it('answers 404 for an unknown or malformed conversation id', async () => {
    const user = await setup(ctx, 'voice.unknown@example.com');
    expect((await start(ctx, user.cookies, '00000000-0000-4000-8000-000000000000')).statusCode).toBe(404);
    expect((await start(ctx, user.cookies, 'not-a-uuid')).statusCode).toBe(404);
    expect(providerCalls).toHaveLength(0);
  });

  it("answers 404 for another user's call session", async () => {
    const owner = await setup(ctx, 'voice.cs.owner@example.com');
    const stranger = await setup(ctx, 'voice.cs.stranger@example.com');
    const id = (await start(ctx, owner.cookies, owner.conversationId)).json().callSession.id;

    expect((await status(stranger.cookies, id)).statusCode).toBe(404);
    expect((await end(stranger.cookies, id)).statusCode).toBe(404);
    // ...and it is untouched: still the pending claim POST /call created.
    expect((await status(owner.cookies, id)).json().callSession.status).toBe('pending');
  });
});

/* ------------------------------------------------------------------ *
 * Starting a call
 * ------------------------------------------------------------------ */

describe('starting a call', () => {
  /**
   * PENDING, NOT ACTIVE, and no provider was contacted.
   *
   * The provider's client secret lives sixty seconds, so a session created
   * here -- before anyone is listening -- would be a paid session nothing could
   * ever use or close. The relay creates it when a socket connects.
   */
  it('claims a pending session and contacts no provider', async () => {
    const user = await setup(ctx, 'voice.start@example.com');
    const res = await start(ctx, user.cookies, user.conversationId);

    expect(res.statusCode).toBe(201);
    const session = res.json().callSession;
    expect(session.status).toBe('pending');
    expect(session.voice).toBe('Serena');
    expect(session.maxSeconds).toBe(780);
    // Not live yet, so no start time and no provider handle.
    expect(session.startedAt).toBeNull();

    const [row] = await ctx.db.select().from(callSessions);
    expect(row!.status).toBe('pending');
    expect(row!.provider).toBe('spicyapi');
    expect(row!.providerSessionId).toBeNull();
    expect(row!.startedAt).toBeNull();
    expect(row!.connectClaimedAt).toBeNull();

    expect(providerCalls).toHaveLength(0);
  });

  /** The request body is empty by design, so nothing a client sends counts. */
  it('accepts no client input at all', async () => {
    const user = await setup(ctx, 'voice.persona@example.com');
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/conversations/${user.conversationId}/call`,
      payload: { voice: 'Zane', instructions: 'you are a pirate', maxSeconds: 99999 },
      cookies: user.cookies,
    });

    expect(res.statusCode).toBe(201);
    const [row] = await ctx.db.select().from(callSessions);
    // Every one of those was ignored: resolved server-side or not accepted.
    expect(row!.voice).toBe('Serena');
    expect(row!.maxSeconds).toBe(780);
  });

  it('uses the character voice when one is configured, and the default otherwise', async () => {
    await ctx.db.update(characters).set({ liveCallVoice: 'Chloe' }).where(eq(characters.id, LUNA_ID));
    const user = await setup(ctx, 'voice.configured@example.com');
    await start(ctx, user.cookies, user.conversationId);
    // Resolved at claim time and stored, so a later character edit cannot
    // change the voice of a call already in flight.
    const [row] = await ctx.db.select().from(callSessions);
    expect(row!.voice).toBe('Chloe');
  });

  /**
   * A retired or mistyped voice must not make a character uncallable, so an
   * unknown value falls back rather than failing.
   */
  it('falls back to the default for a voice not in the catalogue', async () => {
    await ctx.db.update(characters).set({ liveCallVoice: 'NotARealVoice' }).where(eq(characters.id, LUNA_ID));
    const user = await setup(ctx, 'voice.badvoice@example.com');
    const res = await start(ctx, user.cookies, user.conversationId);

    expect(res.statusCode).toBe(201);
    expect(res.json().callSession.voice).toBe('Serena');
  });
});

/* ------------------------------------------------------------------ *
 * Nothing secret reaches the client
 * ------------------------------------------------------------------ */

describe('credentials and persona never reach a response', () => {
  /**
   * THE PHASE 0 FINDING, ENFORCED. A client holding the URL and secret can
   * connect directly to SpicyAPI, and SpicyAPI returns the persona to any
   * client that sends `session.update`. So neither may ever be serialised.
   */
  it('returns no provider URL, no client secret and no persona', async () => {
    const user = await setup(ctx, 'voice.secrets@example.com');
    const res = await start(ctx, user.cookies, user.conversationId);
    const body = res.body;

    expect(body).not.toContain('SUPER_SECRET_TICKET');
    expect(body).not.toContain('cs_SUPER_SECRET_VALUE');
    expect(body).not.toContain('wss://');
    expect(body).not.toContain(CANARY);
    expect(body).not.toContain('client_secret');
    expect(body).not.toContain('clientSecret');
  });

  it('stores no credential, URL or persona in the database', async () => {
    const user = await setup(ctx, 'voice.nostore@example.com');
    await start(ctx, user.cookies, user.conversationId);

    const [row] = await ctx.db.select().from(callSessions);
    const serialised = JSON.stringify(row);
    expect(serialised).not.toContain('SUPER_SECRET_TICKET');
    expect(serialised).not.toContain('cs_SUPER_SECRET_VALUE');
    expect(serialised).not.toContain('wss://');
    expect(serialised).not.toContain(CANARY);
  });

  it('leaks nothing through the status route either', async () => {
    const user = await setup(ctx, 'voice.statusleak@example.com');
    const id = (await start(ctx, user.cookies, user.conversationId)).json().callSession.id;

    const res = await status(user.cookies, id);
    expect(res.body).not.toContain('SUPER_SECRET_TICKET');
    expect(res.body).not.toContain(CANARY);
  });
});


/* ------------------------------------------------------------------ *
 * One call at a time
 * ------------------------------------------------------------------ */

describe('one live call per conversation', () => {
  it('refuses a second start while one is active', async () => {
    const user = await setup(ctx, 'voice.second@example.com');
    const first = await start(ctx, user.cookies, user.conversationId);

    const second = await start(ctx, user.cookies, user.conversationId);

    /**
     * A duplicate start in the SAME conversation violates BOTH unique indexes
     * at once -- the per-conversation one and the per-user one. PostgreSQL
     * reports whichever it checks first, which follows index creation order and
     * is therefore an implementation detail, not a guarantee.
     *
     * Both outcomes are a 409 refusal and both are truthful, so the contract
     * asserted here is the pair, not the ordering. Pinning one would make this
     * test fail if the indexes were ever rebuilt in a different order, which
     * would say nothing about the behaviour customers see.
     */
    expect(second.statusCode).toBe(409);
    const body = second.json();
    expect(['call_already_active', 'user_call_already_active']).toContain(body.error);
    // The per-conversation refusal carries the id, so a client that lost its
    // response can resume rather than being told to start what it already has.
    if (body.error === 'call_already_active') {
      expect(body.callSessionId).toBe(first.json().callSession.id);
    }
    // Whichever index fired, nothing about the database may escape.
    expect(second.body).not.toContain('call_sessions');
    expect(second.body).not.toContain('_idx');
    expect(second.body).not.toContain('constraint');
    expect(second.body).not.toContain('duplicate key');

    expect(await ctx.db.select().from(callSessions)).toHaveLength(1);
    expect(providerCalls).toHaveLength(0);
  });

  /** THE CASE THE CLIENT CANNOT SOLVE: two presses in flight at once. */
  it('creates exactly one session under simultaneous starts', async () => {
    const user = await setup(ctx, 'voice.concurrent@example.com');

    const results = await Promise.all(
      Array.from({ length: 4 }, () => start(ctx, user.cookies, user.conversationId)),
    );

    expect(results.filter((r) => r.statusCode === 201)).toHaveLength(1);
    expect(results.filter((r) => r.statusCode === 409)).toHaveLength(3);
    const rows = await ctx.db.select().from(callSessions);
    expect(rows.filter((r) => r.status === 'pending')).toHaveLength(1);
  });

  it('allows a new call once the previous one ended', async () => {
    const user = await setup(ctx, 'voice.after@example.com');
    const first = (await start(ctx, user.cookies, user.conversationId)).json().callSession.id;
    await end(user.cookies, first);

    const second = await start(ctx, user.cookies, user.conversationId);
    expect(second.statusCode).toBe(201);
    expect(second.json().callSession.id).not.toBe(first);
  });
});

/* ------------------------------------------------------------------ *
 * Ending
 * ------------------------------------------------------------------ */

describe('ending a call', () => {
  it('settles the session and records a duration', async () => {
    const user = await setup(ctx, 'voice.end@example.com');
    const id = (await start(ctx, user.cookies, user.conversationId)).json().callSession.id;

    const res = await end(user.cookies, id);

    expect(res.statusCode).toBe(200);
    expect(res.json().callSession.status).toBe('ended');
    expect(res.json().callSession.terminationReason).toBe('user_ended');
    expect(res.json().callSession.durationSeconds).toBeGreaterThanOrEqual(0);
    expect(res.json().alreadyEnded).toBe(false);
  });

  /** A retry after a lost response must not look like a failure. */
  it('is idempotent', async () => {
    const user = await setup(ctx, 'voice.endtwice@example.com');
    const id = (await start(ctx, user.cookies, user.conversationId)).json().callSession.id;

    const first = await end(user.cookies, id);
    const second = await end(user.cookies, id);
    const third = await end(user.cookies, id);

    expect([first.statusCode, second.statusCode, third.statusCode]).toEqual([200, 200, 200]);
    expect(second.json().alreadyEnded).toBe(true);
    expect(third.json().alreadyEnded).toBe(true);
    // The settled values never move after the first end.
    expect(second.json().callSession.endedAt).toBe(first.json().callSession.endedAt);
  });

  it('is idempotent under simultaneous ends', async () => {
    const user = await setup(ctx, 'voice.endrace@example.com');
    const id = (await start(ctx, user.cookies, user.conversationId)).json().callSession.id;

    const results = await Promise.all(Array.from({ length: 4 }, () => end(user.cookies, id)));

    expect(results.every((r) => r.statusCode === 200)).toBe(true);
    const [row] = await ctx.db.select().from(callSessions);
    expect(row!.status).toBe('ended');
  });

  it('cannot revive a failed session', async () => {
    const user = await setup(ctx, 'voice.endfailed@example.com');
    const id = (await start(ctx, user.cookies, user.conversationId)).json().callSession.id;
    // As the relay settles a session whose provider connection failed.
    await failConnect(ctx.db, id, 'provider_upstream');
    const [row] = await ctx.db.select().from(callSessions);

    const res = await end(user.cookies, row!.id);

    expect(res.json().alreadyEnded).toBe(true);
    expect(res.json().callSession.status).toBe('failed');
  });

  it('answers 404 for an unknown or malformed call session id', async () => {
    const user = await setup(ctx, 'voice.endunknown@example.com');
    expect((await end(user.cookies, '00000000-0000-4000-8000-000000000000')).statusCode).toBe(404);
    expect((await end(user.cookies, 'not-a-uuid')).statusCode).toBe(404);
  });
});

/* ------------------------------------------------------------------ *
 * Nothing stays live for ever
 * ------------------------------------------------------------------ */

describe('a session past its deadline settles itself', () => {
  /**
   * Phase 1 has no relay watching the socket, so without this an abandoned
   * browser would leave a row reading `active` for ever and lock the
   * conversation out of ever calling again.
   */
  it('reads an overdue session as expired', async () => {
    const user = await setup(ctx, 'voice.overdue@example.com');
    const id = (await start(ctx, user.cookies, user.conversationId)).json().callSession.id;

    // Promote it to active and backdate well past the ceiling, as a call that
    // genuinely connected and was then abandoned would look.
    await ctx.db
      .update(callSessions)
      .set({ status: 'active', startedAt: new Date(Date.now() - 800_000) })
      .where(eq(callSessions.id, id));

    const res = await status(user.cookies, id);

    expect(res.json().callSession.status).toBe('expired');
    expect(res.json().callSession.terminationReason).toBe('expired');
    expect(res.json().callSession.durationSeconds).toBeGreaterThan(0);
  });

  it('frees the conversation for a new call', async () => {
    const user = await setup(ctx, 'voice.overdue.free@example.com');
    const id = (await start(ctx, user.cookies, user.conversationId)).json().callSession.id;
    await ctx.db
      .update(callSessions)
      .set({ status: 'active', startedAt: new Date(Date.now() - 800_000) })
      .where(eq(callSessions.id, id));

    const second = await start(ctx, user.cookies, user.conversationId);
    expect(second.statusCode).toBe(201);
  });
});

/* ------------------------------------------------------------------ *
 * Text chat is untouched
 * ------------------------------------------------------------------ */

describe('existing behaviour is unchanged', () => {
  it('text chat still works with voice calls enabled', async () => {
    const user = await setup(ctx, 'voice.textchat@example.com');

    const sent = await ctx.app.inject({
      method: 'POST',
      url: `/api/conversations/${user.conversationId}/messages`,
      payload: { content: 'hello there' },
      cookies: user.cookies,
    });

    expect(sent.statusCode).toBe(201);
    expect(sent.json().characterMessage.sender).toBe('character');
    expect(providerCalls).toHaveLength(0); // sending a message is not a call
  });

  it('a call does not disturb the conversation or its messages', async () => {
    const user = await setup(ctx, 'voice.nodisturb@example.com');
    await ctx.app.inject({
      method: 'POST',
      url: `/api/conversations/${user.conversationId}/messages`,
      payload: { content: 'before the call' },
      cookies: user.cookies,
    });

    const id = (await start(ctx, user.cookies, user.conversationId)).json().callSession.id;
    await end(user.cookies, id);

    const history = await ctx.app.inject({
      method: 'GET',
      url: `/api/conversations/${user.conversationId}/messages`,
      cookies: user.cookies,
    });
    // Phase 1 persists no transcript, so the history is exactly the exchange.
    expect(history.json()).toHaveLength(2);
  });
});

/* ------------------------------------------------------------------ *
 * The flag on, the key absent
 * ------------------------------------------------------------------ */

/**
 * THE MISCONFIGURATION AN OPERATOR CAN ACTUALLY MAKE: switching calls on and
 * forgetting the credential, or setting the key on the wrong service. Both
 * conditions are required, so this must fail closed rather than reaching for a
 * provider that does not exist.
 */
describe('VOICE_CALLS_ENABLED=true with no provider key', () => {
  it('fails closed and creates nothing', async () => {
    const user = await setup(keyless, 'voice.keyless@example.com');

    const res = await start(keyless, user.cookies, user.conversationId);

    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('voice_unavailable');
    expect(providerCalls).toHaveLength(0);
    expect(await keyless.db.select().from(callSessions)).toHaveLength(0);
  });

  it('still requires authentication', async () => {
    const owner = await setup(keyless, 'voice.keyless.owner@example.com');
    const anon = await keyless.app.inject({
      method: 'POST',
      url: `/api/conversations/${owner.conversationId}/call`,
    });
    expect(anon.statusCode).toBe(401);
  });
});

/* ------------------------------------------------------------------ *
 * One live call per person
 * ------------------------------------------------------------------ */

/** A second conversation for the same user, so two calls could be attempted. */
async function secondConversation(cookies: Record<string, string>) {
  const other = SEED_CHARACTERS.find((c) => c.name !== 'luna')!;
  const conv = await ctx.app.inject({
    method: 'POST',
    url: '/api/conversations',
    payload: { characterId: other.id },
    cookies,
  });
  return conv.json().id as string;
}

describe('one live call per person, across conversations', () => {
  /**
   * The per-conversation index cannot express this: each call is legal on its
   * own. Without the per-user index a customer with twenty characters could
   * hold twenty concurrent provider sessions, and once billing exists, twenty
   * meters running at once.
   */
  it('refuses a call in a second conversation while one is live', async () => {
    const user = await setup(ctx, 'voice.user.busy@example.com');
    const second = await secondConversation(user.cookies);

    const first = await start(ctx, user.cookies, user.conversationId);
    const blocked = await start(ctx, user.cookies, second);

    expect(first.statusCode).toBe(201);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error).toBe('user_call_already_active');
    expect(providerCalls).toHaveLength(0);
  });

  /** THE RACE: two conversations, two presses, at the same instant. */
  it('creates exactly one session under simultaneous starts in different conversations', async () => {
    const user = await setup(ctx, 'voice.user.race@example.com');
    const second = await secondConversation(user.cookies);

    const [a, b] = await Promise.all([
      start(ctx, user.cookies, user.conversationId),
      start(ctx, user.cookies, second),
    ]);

    expect([a.statusCode, b.statusCode].sort()).toEqual([201, 409]);
    const rows = await ctx.db.select().from(callSessions);
    expect(rows.filter((r) => r.status === 'pending')).toHaveLength(1);
    expect(providerCalls).toHaveLength(0);
  });

  /** The conflict must not expose the index, the table or the driver message. */
  it('exposes no database internals in the conflict response', async () => {
    const user = await setup(ctx, 'voice.user.clean@example.com');
    const second = await secondConversation(user.cookies);
    await start(ctx, user.cookies, user.conversationId);

    const blocked = await start(ctx, user.cookies, second);

    expect(blocked.body).not.toContain('call_sessions');
    expect(blocked.body).not.toContain('_idx');
    expect(blocked.body).not.toContain('constraint');
    expect(blocked.body).not.toContain('duplicate key');
  });

  it('does not stop a different person calling at the same time', async () => {
    const a = await setup(ctx, 'voice.two.a@example.com');
    const b = await setup(ctx, 'voice.two.b@example.com');

    expect((await start(ctx, a.cookies, a.conversationId)).statusCode).toBe(201);
    expect((await start(ctx, b.cookies, b.conversationId)).statusCode).toBe(201);
  });

  it('frees the person once their call ends', async () => {
    const user = await setup(ctx, 'voice.user.free@example.com');
    const second = await secondConversation(user.cookies);
    const id = (await start(ctx, user.cookies, user.conversationId)).json().callSession.id;
    await end(user.cookies, id);

    expect((await start(ctx, user.cookies, second)).statusCode).toBe(201);
  });
});

/* ------------------------------------------------------------------ *
 * Pending has its own clock
 * ------------------------------------------------------------------ */

describe('a pending session expires on its own, much shorter deadline', () => {
  /** Backdates a row into the past, leaving it pending. */
  const agePending = (id: string, seconds: number) =>
    ctx.db
      .update(callSessions)
      .set({ status: 'pending', startedAt: null, createdAt: new Date(Date.now() - seconds * 1000) })
      .where(eq(callSessions.id, id));

  it('is not held for the 780-second active ceiling', async () => {
    const user = await setup(ctx, 'voice.pending.expire@example.com');
    const id = (await start(ctx, user.cookies, user.conversationId)).json().callSession.id;
    // Past the pending deadline, nowhere near the active one.
    await agePending(id, PENDING_DEADLINE_SECONDS + 30);

    expect((await status(user.cookies, id)).json().callSession.status).toBe('expired');
  });

  it('frees the conversation within the minute rather than the quarter hour', async () => {
    const user = await setup(ctx, 'voice.pending.free@example.com');
    const id = (await start(ctx, user.cookies, user.conversationId)).json().callSession.id;
    await agePending(id, PENDING_DEADLINE_SECONDS + 30);

    expect((await start(ctx, user.cookies, user.conversationId)).statusCode).toBe(201);
  });

  /** THE BOUNDARY: just inside the deadline is still pending, and still blocks. */
  it('leaves a pending session alone just inside the deadline', async () => {
    const user = await setup(ctx, 'voice.pending.inside@example.com');
    const id = (await start(ctx, user.cookies, user.conversationId)).json().callSession.id;
    await agePending(id, PENDING_DEADLINE_SECONDS - 10);

    expect((await status(user.cookies, id)).json().callSession.status).toBe('pending');
    expect((await start(ctx, user.cookies, user.conversationId)).statusCode).toBe(409);
  });

  /** The ACTIVE rule is unchanged: judged against maxSeconds, not the deadline. */
  it('does not apply the pending deadline to an active session', async () => {
    const user = await setup(ctx, 'voice.active.rule@example.com');
    const id = (await start(ctx, user.cookies, user.conversationId)).json().callSession.id;
    // Active, older than the pending deadline, far younger than the ceiling.
    await ctx.db
      .update(callSessions)
      .set({
        status: 'active',
        startedAt: new Date(Date.now() - (PENDING_DEADLINE_SECONDS + 120) * 1000),
      })
      .where(eq(callSessions.id, id));

    expect((await status(user.cookies, id)).json().callSession.status).toBe('active');
  });
});


/* ------------------------------------------------------------------ *
 * A read that races a concurrent end
 * ------------------------------------------------------------------ */

/**
 * `expireIfOverdue` sweeps an overdue session when one is read. Its conditional
 * update can match nothing, because somebody settled the session between the
 * read that produced the row and the write -- and the row in hand is then
 * provably stale.
 *
 * Exercised directly rather than through HTTP: the window between a SELECT and
 * an UPDATE inside one request cannot be opened from outside it, and a test
 * that tried would be timing-dependent. Handing the function a snapshot while
 * the real row has moved reproduces exactly the state it must cope with.
 */
describe('a status read racing a concurrent end', () => {
  it('reports what the session actually became, not the stale row', async () => {
    const user = await setup(ctx, 'voice.stale.read@example.com');
    const id = (await start(ctx, user.cookies, user.conversationId)).json().callSession.id;
    await ctx.db.update(callSessions).set({ status: 'active' }).where(eq(callSessions.id, id));

    // The row as a reader would have loaded it, made to look overdue.
    const [snapshot] = await ctx.db.select().from(callSessions).where(eq(callSessions.id, id));
    const stale = { ...snapshot!, startedAt: new Date(Date.now() - 800_000) };

    // Meanwhile somebody ends the call, so the sweep's update will miss.
    await end(user.cookies, id);

    const settled = await expireIfOverdue(ctx.db, stale);

    // NOT 'active' (the stale value) and NOT 'expired' (the sweep it lost).
    expect(settled?.status).toBe('ended');
    expect(settled?.terminationReason).toBe('user_ended');
  });

  it('returns null when the row no longer exists', async () => {
    const user = await setup(ctx, 'voice.stale.gone@example.com');
    const id = (await start(ctx, user.cookies, user.conversationId)).json().callSession.id;
    await ctx.db.update(callSessions).set({ status: 'active' }).where(eq(callSessions.id, id));
    const [snapshot] = await ctx.db.select().from(callSessions).where(eq(callSessions.id, id));
    const stale = { ...snapshot!, startedAt: new Date(Date.now() - 800_000) };

    await ctx.db.delete(callSessions).where(eq(callSessions.id, id));

    expect(await expireIfOverdue(ctx.db, stale)).toBeNull();
  });

  /** The ordinary sweep is unchanged: an overdue session still expires. */
  it('still expires an overdue session that nobody else touched', async () => {
    const user = await setup(ctx, 'voice.stale.normal@example.com');
    const id = (await start(ctx, user.cookies, user.conversationId)).json().callSession.id;
    await ctx.db.update(callSessions).set({ status: 'active' }).where(eq(callSessions.id, id));
    const [snapshot] = await ctx.db.select().from(callSessions).where(eq(callSessions.id, id));

    const settled = await expireIfOverdue(ctx.db, {
      ...snapshot!,
      startedAt: new Date(Date.now() - 800_000),
    });

    expect(settled?.status).toBe('expired');
    expect(settled?.terminationReason).toBe('expired');
  });

  /** And a session that is not overdue is returned untouched. */
  it('leaves a session that is not overdue alone', async () => {
    const user = await setup(ctx, 'voice.stale.fresh@example.com');
    const id = (await start(ctx, user.cookies, user.conversationId)).json().callSession.id;
    await ctx.db.update(callSessions).set({ status: 'active' }).where(eq(callSessions.id, id));
    const [snapshot] = await ctx.db.select().from(callSessions).where(eq(callSessions.id, id));

    const settled = await expireIfOverdue(ctx.db, snapshot!);

    expect(settled?.status).toBe('active');
  });
});
