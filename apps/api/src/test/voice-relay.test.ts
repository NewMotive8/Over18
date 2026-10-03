import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import { WebSocket as WsClient } from 'ws';
import { callSessions, callTranscriptTurns } from '../db/schema.js';
import { SEED_CHARACTERS } from '../db/seed-data.js';
import { seedCharacters } from '../db/seed.js';
import { VoiceProviderError, type VoiceSession, type VoiceSessionRequest } from '../voice/types.js';
import { listMemories, storeMemories } from '../services/memory-service.js';
import { deterministicMemoryExtractor } from '../services/memory-extractor.js';
import { DEFAULT_MEMORY_INJECTION } from '../services/prompt-builder.js';
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
 * A seam for forcing the failures the relay must survive.
 *
 * `activate` makes the activation write reject, `hold` parks a named call until
 * the test releases it, and `reject` makes a named call throw. All default to
 * the real implementation, so every other test in this file runs against
 * untouched production code -- the point is to exercise the ROUTE's handling of
 * these failures, not a helper in isolation.
 */
const hooks = vi.hoisted(() => ({
  activate: null as null | (() => Promise<never>),
  hold: null as null | { fn: string; reached: () => void; release: Promise<void> },
  reject: null as null | { fn: string; error: unknown },
  /**
   * A scripted transcript-write failure: fail the next `failures` attempts, and
   * with `commitFirst`, perform the real insert BEFORE throwing -- which is the
   * case retries have to survive without duplicating a row.
   */
  transcript: null as null | { failures: number; commitFirst?: boolean; error: unknown },
}));

vi.mock('../services/call-session-service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/call-session-service.js')>();

  /** Parks inside `fn` if a test asked for it, after the real work is done. */
  const park = async (fn: string) => {
    if (hooks.hold?.fn !== fn) return;
    hooks.hold.reached();
    await hooks.hold.release;
  };

  /** Throws from `fn` if a test asked for it, before the real work happens. */
  const boom = (fn: string) => {
    if (hooks.reject?.fn === fn) throw hooks.reject.error;
  };

  return {
    ...actual,
    activateConnected: async (...args: Parameters<typeof actual.activateConnected>) =>
      hooks.activate ? hooks.activate() : actual.activateConnected(...args),
    getCallSessionForUser: async (...args: Parameters<typeof actual.getCallSessionForUser>) => {
      boom('getCallSessionForUser');
      const row = await actual.getCallSessionForUser(...args);
      await park('getCallSessionForUser');
      return row;
    },
    buildProviderSessionRequest: async (
      ...args: Parameters<typeof actual.buildProviderSessionRequest>
    ) => {
      boom('buildProviderSessionRequest');
      const built = await actual.buildProviderSessionRequest(...args);
      await park('buildProviderSessionRequest');
      return built;
    },
    settleCall: async (...args: Parameters<typeof actual.settleCall>) => {
      boom('settleCall');
      return actual.settleCall(...args);
    },
    recordTranscriptTurn: async (...args: Parameters<typeof actual.recordTranscriptTurn>) => {
      boom('recordTranscriptTurn');
      const plan = hooks.transcript;
      if (plan && plan.failures > 0) {
        plan.failures -= 1;
        // The write that commits and then reports failure anyway.
        if (plan.commitFirst) await actual.recordTranscriptTurn(...args);
        throw plan.error;
      }
      return actual.recordTranscriptTurn(...args);
    },
  };
});

/**
 * The voice relay, end to end over a real socket.
 *
 * `app.inject` cannot perform a WebSocket upgrade, so the app is listened on an
 * ephemeral port and driven with a real client. Only two things are faked: the
 * provider ADAPTER (so no session is ever bought) and the global `WebSocket`
 * the relay uses for its upstream connection (so no packet leaves the machine).
 * Everything between them -- authentication, ownership, the gate, the claim,
 * the sanitiser, the lifecycle writes -- is the production code path.
 */

const LUNA_ID = SEED_CHARACTERS.find((c) => c.name === 'luna')!.id;
/** A second character, so "wrong character" can be asserted and not assumed. */
const EMBER_ID = SEED_CHARACTERS.find((c) => c.name === 'ember')!.id;
const CANARY = 'Her name is Luna.';
const PROVIDER_URL = 'wss://api.spicyapi.com/v1/realtime?session=SUPER_SECRET_TICKET';

let ctx: TestContext;
let gated: TestContext;
let baseUrl: string;
let gatedUrl: string;

let providerCalls: VoiceSessionRequest[];
let providerImpl: (request: VoiceSessionRequest) => Promise<VoiceSession>;

const stubSession = (over: Partial<VoiceSession> = {}): VoiceSession => ({
  providerSessionId: 'rt_relay_1',
  voice: 'Serena',
  maxSeconds: 780,
  url: PROVIDER_URL,
  clientSecret: 'cs_SUPER_SECRET_VALUE',
  clientSecretExpiresAt: Math.floor(Date.now() / 1000) + 60,
  ...over,
});

const provider = {
  name: 'spicyapi',
  async createSession(request: VoiceSessionRequest) {
    providerCalls.push(request);
    return providerImpl(request);
  },
};

/* ------------------------------------------------------------------ *
 * A fake upstream socket the tests drive
 * ------------------------------------------------------------------ */

/** Every upstream socket the relay has opened, newest last. */
let upstreams: FakeUpstream[] = [];

/**
 * Stands in for the provider's WebSocket.
 *
 * Deliberately NOT auto-opening: several tests need the window between "the
 * relay created the socket" and "the socket opened", which is where a timeout,
 * a client disconnect, or a concurrent end lands.
 */
class FakeUpstream {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = FakeUpstream.CONNECTING;
  readonly sent: string[] = [];
  closeCalls = 0;
  private listeners = new Map<string, ((event: unknown) => void)[]>();

  constructor(readonly url: string) {
    upstreams.push(this);
  }

  addEventListener(type: string, fn: (event: unknown) => void) {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.closeCalls += 1;
    this.readyState = FakeUpstream.CLOSED;
  }

  private emit(type: string, event: unknown = {}) {
    for (const fn of this.listeners.get(type) ?? []) fn(event);
  }

  /* -- driven by the tests -- */
  open() {
    this.readyState = FakeUpstream.OPEN;
    this.emit('open');
  }
  deliver(frame: unknown) {
    this.emit('message', { data: typeof frame === 'string' ? frame : JSON.stringify(frame) });
  }
  fail() {
    this.emit('error', {});
  }
  hangUp() {
    this.readyState = FakeUpstream.CLOSED;
    this.emit('close', {});
  }
}

/**
 * What the BROWSER sent upstream, without the relay's own opening-line frames
 * (tagged over18_opening_*), which go out the moment a call is active. Tests
 * about relaying browser frames assert on this, so the greeting can neither
 * break them nor make them pass by accident.
 */
const fromBrowser = (up: FakeUpstream) => up.sent.filter((raw) => !raw.includes('"over18_opening_'));

beforeAll(async () => {
  migrateTestDb();
  ctx = await createTestContext({
    voiceCallsEnabled: true,
    voiceProvider: provider,
    // The SAME extractor the text path uses, so a call fills one memory.
    memoryExtractor: deterministicMemoryExtractor,
  });
  gated = await createTestContext({ voiceProvider: provider });
  const addr = await ctx.app.listen({ port: 0, host: '127.0.0.1' });
  baseUrl = addr.replace('http://', 'ws://');
  const gatedAddr = await gated.app.listen({ port: 0, host: '127.0.0.1' });
  gatedUrl = gatedAddr.replace('http://', 'ws://');
});

afterAll(async () => {
  await destroyTestContext(ctx);
  await destroyTestContext(gated);
});

beforeEach(async () => {
  await truncateAll(ctx);
  await seedCharacters(ctx.db);
  providerCalls = [];
  upstreams = [];
  providerImpl = async () => stubSession();
  hooks.activate = null;
  hooks.hold = null;
  hooks.reject = null;
  hooks.transcript = null;
  vi.stubGlobal('WebSocket', FakeUpstream);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

async function setup(app: TestContext, email: string) {
  const reg = await app.app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email, password: 'relay-test-pass-1' },
  });
  const cookie = extractSessionCookie(reg)!;
  const cookies = { [cookie.name]: cookie.value };
  const conv = await app.app.inject({
    method: 'POST',
    url: '/api/conversations',
    payload: { characterId: LUNA_ID },
    cookies,
  });
  const call = await app.app.inject({
    method: 'POST',
    url: `/api/conversations/${conv.json().id}/call`,
    cookies,
  });
  return {
    cookie: `${cookie.name}=${cookie.value}`,
    conversationId: conv.json().id as string,
    callSessionId: call.json().callSession?.id as string,
  };
}

/** What a connected browser saw, and whether the socket is still up. */
interface Client {
  ws: WsClient;
  frames: Record<string, unknown>[];
  closeCode: number | null;
  waitFor: (type: string, ms?: number) => Promise<Record<string, unknown>>;
  waitClosed: (ms?: number) => Promise<number>;
  close: () => void;
}

function connect(
  url: string,
  callSessionId: string,
  opts: { cookie?: string; origin?: string | null } = {},
): Client {
  const headers: Record<string, string> = {};
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.origin !== null) headers.origin = opts.origin ?? testEnv.corsOrigin;

  const ws = new WsClient(`${url}/api/calls/${callSessionId}/socket`, { headers });
  const client: Client = {
    ws,
    frames: [],
    closeCode: null,
    waitFor: (type, ms = 3_000) =>
      new Promise((resolve, reject) => {
        const found = client.frames.find((f) => f.type === type);
        if (found) return resolve(found);
        const timer = setTimeout(() => reject(new Error(`no ${type} within ${ms}ms`)), ms);
        const check = () => {
          const hit = client.frames.find((f) => f.type === type);
          if (hit) {
            clearTimeout(timer);
            clearInterval(poll);
            resolve(hit);
          }
        };
        const poll = setInterval(check, 10);
      }),
    waitClosed: (ms = 3_000) =>
      new Promise((resolve, reject) => {
        if (client.closeCode !== null) return resolve(client.closeCode);
        const timer = setTimeout(() => reject(new Error(`socket still open after ${ms}ms`)), ms);
        ws.on('close', (code) => {
          clearTimeout(timer);
          resolve(code);
        });
      }),
    close: () => ws.close(),
  };

  ws.on('message', (data) => {
    try {
      client.frames.push(JSON.parse(data.toString()));
    } catch {
      /* ignore */
    }
  });
  ws.on('close', (code) => {
    client.closeCode = code;
  });
  ws.on('error', () => {
    /* handshake refusals surface as close/error; tests assert on state */
  });
  return client;
}

/** Waits until the relay has created an upstream socket. */
async function waitForUpstream(ms = 3_000, minCount = 1): Promise<FakeUpstream> {
  const deadline = Date.now() + ms;
  for (;;) {
    // `minCount` matters once a test drives TWO calls: with the default, the
    // already-open upstream of the first satisfies the wait instantly and the
    // second call's socket is never opened.
    const last = upstreams.length >= minCount ? upstreams.at(-1) : undefined;
    if (last) return last;
    if (Date.now() > deadline) {
      throw new Error(`fewer than ${minCount} upstream sockets were created`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

const rowFor = async (id: string) => {
  const [row] = await ctx.db.select().from(callSessions).where(eq(callSessions.id, id));
  return row!;
};

/**
 * Waits for a settled row rather than sampling one.
 *
 * `teardown` closes the socket BEFORE awaiting its database write, so a read
 * taken the moment the socket closes is racing that write. Polling for the
 * expected state makes these assertions deterministic instead of usually-true.
 */
async function waitForStatus(id: string, status: string, ms = 5_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const row = await rowFor(id);
    if (row.status === status) return row;
    if (Date.now() > deadline) {
      throw new Error(`call ${id} was '${row.status}', not '${status}', after ${ms}ms`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

/**
 * Parks the handler inside a named setup call until the test lets it go.
 *
 * `reached` resolves once the handler is genuinely suspended there, which is
 * what makes these races deterministic instead of a sleep and a hope.
 */
function holdAt(fn: string) {
  let reached!: () => void;
  let release!: () => void;
  const reachedAt = new Promise<void>((r) => {
    reached = r;
  });
  const released = new Promise<void>((r) => {
    release = r;
  });
  hooks.hold = { fn, reached, release: released };
  return { reachedAt, release };
}

/**
 * Watches for a rejection escaping into the process.
 *
 * Node's default for an unhandled rejection is to terminate, so "did anything
 * escape" is the actual assertion behind this hardening -- not a proxy for it.
 */
function watchUnhandled() {
  const escaped: unknown[] = [];
  const onUnhandled = (reason: unknown) => escaped.push(reason);
  process.on('unhandledRejection', onUnhandled);
  return {
    escaped,
    stop: () => process.off('unhandledRejection', onUnhandled),
  };
}

/** A drizzle rejection, shaped like the real thing: SQL and params in the message. */
const drizzleFailure = () =>
  Object.assign(
    new Error(
      `Failed query: select * from "call_sessions" where "id" = $1\nparams: ${CANARY}`,
    ),
    { name: 'DrizzleQueryError', cause: Object.assign(new Error('terminating connection'), { code: '57P01' }) },
  );

/** A shut laptop, not a polite goodbye: no close frame, no handshake. */
async function vanish(client: Client) {
  client.ws.terminate();
  await client.waitClosed().catch(() => undefined);
}

/** Gives the handler room to do the wrong thing, so the test can prove it did not. */
const settleEventLoop = () => new Promise((r) => setTimeout(r, 200));

/** The stored transcript for a call, in `seq` order -- the order it reads in. */
async function turnsFor(callSessionId: string) {
  return ctx.db
    .select({ speaker: callTranscriptTurns.speaker, content: callTranscriptTurns.content, seq: callTranscriptTurns.seq })
    .from(callTranscriptTurns)
    .where(eq(callTranscriptTurns.callSessionId, callSessionId))
    .orderBy(asc(callTranscriptTurns.seq));
}

/**
 * Waits for a given number of stored turns.
 *
 * Transcript writes are queued and never awaited by the relay, so a read taken
 * the instant an event is delivered is racing them. Polling makes these
 * assertions deterministic rather than usually-true.
 */
async function waitForTurns(callSessionId: string, count: number, ms = 5_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const rows = await turnsFor(callSessionId);
    if (rows.length >= count) return rows;
    if (Date.now() > deadline) {
      throw new Error(`call ${callSessionId} had ${rows.length} turns, not ${count}, after ${ms}ms`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

const userSaid = (transcript: string, itemId = `item_${Math.random().toString(36).slice(2)}`) => ({
  type: 'conversation.item.input_audio_transcription.completed',
  item_id: itemId,
  transcript,
});

const sheSaid = (transcript: string) => ({ type: 'response.audio_transcript.done', transcript });

/** A live relay: connected, upstream open, call active. */
async function live(email: string) {
  const user = await setup(ctx, email);
  const client = connect(baseUrl, user.callSessionId, { cookie: user.cookie });
  const up = await waitForUpstream();
  up.open();
  await client.waitFor('relay.connected');
  return { user, client, up };
}

/* ------------------------------------------------------------------ *
 * Refusals, before any provider is touched
 * ------------------------------------------------------------------ */

describe('the handshake is refused before anything upstream happens', () => {
  it('rejects an unauthenticated connection', async () => {
    const user = await setup(ctx, 'relay.anon@example.com');
    const client = connect(baseUrl, user.callSessionId); // no cookie

    expect(await client.waitClosed()).toBeGreaterThan(0);
    expect(providerCalls).toHaveLength(0);
    expect(upstreams).toHaveLength(0);
  });

  it('rejects a cross-origin handshake', async () => {
    const user = await setup(ctx, 'relay.origin@example.com');
    const client = connect(baseUrl, user.callSessionId, {
      cookie: user.cookie,
      origin: 'https://evil.example.com',
    });

    await client.waitClosed();
    expect(client.frames.find((f) => f.type === 'relay.error')?.reason).toBe('forbidden_origin');
    expect(providerCalls).toHaveLength(0);
  });

  it('rejects a handshake with no Origin at all', async () => {
    const user = await setup(ctx, 'relay.noorigin@example.com');
    const client = connect(baseUrl, user.callSessionId, { cookie: user.cookie, origin: null });

    await client.waitClosed();
    expect(client.frames.find((f) => f.type === 'relay.error')?.reason).toBe('forbidden_origin');
  });

  /** Foreign, unknown and malformed are one answer: no existence is disclosed. */
  it("refuses another user's session identically to one that does not exist", async () => {
    const owner = await setup(ctx, 'relay.owner@example.com');
    const stranger = await setup(ctx, 'relay.stranger@example.com');

    const foreign = connect(baseUrl, owner.callSessionId, { cookie: stranger.cookie });
    await foreign.waitClosed();
    const foreignReason = foreign.frames.find((f) => f.type === 'relay.error')?.reason;

    const unknown = connect(baseUrl, '00000000-0000-4000-8000-000000000000', {
      cookie: stranger.cookie,
    });
    await unknown.waitClosed();
    const unknownReason = unknown.frames.find((f) => f.type === 'relay.error')?.reason;

    const malformed = connect(baseUrl, 'not-a-uuid', { cookie: stranger.cookie });
    await malformed.waitClosed();
    const malformedReason = malformed.frames.find((f) => f.type === 'relay.error')?.reason;

    expect(foreignReason).toBe('not_found');
    expect(unknownReason).toBe('not_found');
    expect(malformedReason).toBe('not_found');
    expect(providerCalls).toHaveLength(0);

    // ...and the owner's session is untouched.
    expect((await rowFor(owner.callSessionId)).status).toBe('pending');
  });

  it('refuses when the feature gate is off', async () => {
    const user = await setup(gated, 'relay.gated@example.com');
    // The gated app cannot even claim a call, so connect by a synthetic id.
    const client = connect(gatedUrl, '00000000-0000-4000-8000-000000000001', {
      cookie: user.cookie,
    });

    await client.waitClosed();
    expect(client.frames.find((f) => f.type === 'relay.error')?.reason).toBe('voice_unavailable');
    expect(providerCalls).toHaveLength(0);
  });

  it('refuses a call that is not pending', async () => {
    const user = await setup(ctx, 'relay.state@example.com');
    await ctx.db
      .update(callSessions)
      .set({ status: 'ended', endedAt: new Date() })
      .where(eq(callSessions.id, user.callSessionId));

    const client = connect(baseUrl, user.callSessionId, { cookie: user.cookie });
    await client.waitClosed();

    expect(client.frames.find((f) => f.type === 'relay.error')?.reason).toBe('invalid_state');
    expect(providerCalls).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ *
 * The happy path
 * ------------------------------------------------------------------ */

describe('a connected relay', () => {
  it('creates the provider session only once a socket is connected', async () => {
    const user = await setup(ctx, 'relay.connect@example.com');
    expect(providerCalls).toHaveLength(0); // POST /call contacted nobody

    const client = connect(baseUrl, user.callSessionId, { cookie: user.cookie });
    const up = await waitForUpstream();

    expect(providerCalls).toHaveLength(1);
    expect(providerCalls[0]!.instructions).toContain(CANARY);
    expect(providerCalls[0]!.userRef).toBe(user.callSessionId);
    expect(up.url).toBe(PROVIDER_URL);

    // NOT active until the upstream socket opens.
    expect((await rowFor(user.callSessionId)).status).toBe('pending');

    up.open();
    await client.waitFor('relay.connected');
    const row = await rowFor(user.callSessionId);
    expect(row.status).toBe('active');
    expect(row.providerSessionId).toBe('rt_relay_1');
    expect(row.startedAt).not.toBeNull();
    client.close();
  });

  it('relays browser audio upstream and provider audio back', async () => {
    const { client, up } = await live('relay.audio@example.com');

    client.ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: 'QUJD' }));
    await vi.waitFor(() => expect(fromBrowser(up).length).toBeGreaterThan(0));
    expect(JSON.parse(fromBrowser(up)[0]!).type).toBe('input_audio_buffer.append');

    up.deliver({ type: 'response.audio.delta', delta: 'WllY' });
    const frame = await client.waitFor('response.audio.delta');
    expect(frame.delta).toBe('WllY');
    client.close();
  });

  /** The credentials are never serialised to the browser, on any frame. */
  it('never sends the provider URL, secret or persona to the browser', async () => {
    const { client, up } = await live('relay.nosecrets@example.com');

    up.deliver({
      type: 'session.updated',
      session: { instructions: `You are Luna. ${CANARY}`, url: PROVIDER_URL },
    });
    await client.waitFor('session.updated');
    // Her opening turn has begun, so the error below is a real one and reaches
    // the browser (while the opening is outstanding, errors are held back).
    up.deliver({ type: 'response.created' });
    up.deliver({ type: 'error', error: { code: 'content_blocked', message: CANARY } });
    await client.waitFor('error');

    const all = JSON.stringify(client.frames);
    expect(all).not.toContain('SUPER_SECRET');
    expect(all).not.toContain('wss://');
    expect(all).not.toContain(CANARY);
    expect(all).not.toContain('instructions');
    client.close();
  });

  it('drops browser frames that are not allowlisted', async () => {
    const { client, up } = await live('relay.clientallow@example.com');

    client.ws.send(JSON.stringify({ type: 'session.update', session: { instructions: 'pirate' } }));
    client.ws.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
    await vi.waitFor(() => expect(fromBrowser(up).length).toBe(1));

    expect(JSON.parse(fromBrowser(up)[0]!).type).toBe('input_audio_buffer.commit');
    expect(up.sent.join()).not.toContain('session.update');
    client.close();
  });

  it('closes the socket on an oversized frame', async () => {
    const { client, up } = await live('relay.oversized@example.com');

    client.ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: 'A'.repeat(70_000) }));

    expect(await client.waitClosed()).toBe(1000);
    expect(fromBrowser(up)).toHaveLength(0);
    client.close();
  });

  it('ignores a malformed frame without closing the call', async () => {
    const { client, up } = await live('relay.malformed@example.com');

    client.ws.send('not json at all');
    client.ws.send(JSON.stringify({ nope: true }));
    client.ws.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
    await vi.waitFor(() => expect(fromBrowser(up).length).toBe(1));

    expect(client.closeCode).toBeNull(); // still up
    client.close();
  });
});

/* ------------------------------------------------------------------ *
 * Failure and cleanup
 * ------------------------------------------------------------------ */

describe('a provider that will not connect', () => {
  it('settles the call and never marks it active when creation fails', async () => {
    providerImpl = async () => {
      throw new VoiceProviderError('upstream', 'down', 503);
    };
    const user = await setup(ctx, 'relay.createfail@example.com');

    const client = connect(baseUrl, user.callSessionId, { cookie: user.cookie });
    await client.waitClosed();

    expect(client.frames.find((f) => f.type === 'relay.closed')?.reason).toBe('provider_unavailable');
    const row = await waitForStatus(user.callSessionId, 'failed');
    // Ambiguous kind, so recorded as a possible orphan.
    expect(row.terminationReason).toBe('orphan_risk_upstream');
    expect(row.startedAt).toBeNull();
    expect(upstreams).toHaveLength(0);
  });

  /**
   * THE DEFECT THIS CLOSES. A refused persona and an unreachable provider were
   * reported to the browser with the SAME reason, so a refusal -- which fails
   * identically every time -- was shown as "she could not be reached just now,
   * try again in a moment". The browser already understood `content_blocked`;
   * the server simply never sent it.
   */
  it('tells the browser a refusal was a refusal, not an outage', async () => {
    providerImpl = async () => {
      throw new VoiceProviderError('content_blocked', 'HTTP 422.', 422);
    };
    const user = await setup(ctx, 'relay.blocked@example.com');

    const client = connect(baseUrl, user.callSessionId, { cookie: user.cookie });
    await client.waitClosed();

    expect(client.frames.find((f) => f.type === 'relay.closed')?.reason).toBe('content_blocked');
    // And emphatically not the reason that invites a pointless retry.
    expect(client.frames.find((f) => f.type === 'relay.closed')?.reason).not.toBe(
      'provider_unavailable',
    );
  });

  /**
   * The cleanup is the part a new reason could quietly break: the row must still
   * settle, stay un-started, carry the documented short code, and leave no
   * upstream socket behind.
   */
  it('settles a refused call with no orphan and no upstream', async () => {
    providerImpl = async () => {
      throw new VoiceProviderError('content_blocked', 'HTTP 422.', 422);
    };
    const user = await setup(ctx, 'relay.blockedrow@example.com');

    const client = connect(baseUrl, user.callSessionId, { cookie: user.cookie });
    await client.waitClosed();

    const row = await waitForStatus(user.callSessionId, 'failed');
    // Definite, so no orphan marker -- the provider refused rather than half-acted.
    expect(row.terminationReason).toBe('provider_content_blocked');
    expect(row.startedAt).toBeNull();
    expect(row.providerSessionId).toBeNull();
    expect(upstreams).toHaveLength(0);
  });

  /** A refusal body can quote the request, so nothing of it may reach the browser. */
  it('leaks nothing from a refusal to the browser', async () => {
    providerImpl = async () => {
      throw new VoiceProviderError('content_blocked', `blocked: ${CANARY}`, 422);
    };
    const user = await setup(ctx, 'relay.blockedleak@example.com');

    const client = connect(baseUrl, user.callSessionId, { cookie: user.cookie });
    await client.waitClosed();

    expect(JSON.stringify(client.frames)).not.toContain(CANARY);
  });

  /**
   * THE FALLBACK, HELD STILL. Every other rejection keeps the old reason: only a
   * confirmed content refusal changes what the person is told.
   */
  it.each([
    ['rejected', 400, 'provider_rejected'],
    // Not a definite refusal: a 402 is not on `definitelyCreatedNothing`, so it
    // keeps the orphan marker it already had. Unchanged by this work.
    ['payment_required', 402, 'orphan_risk_payment_required'],
    ['network', undefined, 'orphan_risk_network'],
  ] as const)(
    'still reports %s as provider_unavailable',
    async (kind, status, settled) => {
      providerImpl = async () => {
        throw new VoiceProviderError(kind, 'x', status);
      };
      const user = await setup(ctx, `relay.fallback.${kind}@example.com`);

      const client = connect(baseUrl, user.callSessionId, { cookie: user.cookie });
      await client.waitClosed();

      expect(client.frames.find((f) => f.type === 'relay.closed')?.reason).toBe(
        'provider_unavailable',
      );
      expect((await waitForStatus(user.callSessionId, 'failed')).terminationReason).toBe(settled);
    },
  );

  it('records a definite refusal without an orphan marker', async () => {
    providerImpl = async () => {
      throw new VoiceProviderError('unauthorized', 'bad key', 401);
    };
    const user = await setup(ctx, 'relay.unauth@example.com');
    const client = connect(baseUrl, user.callSessionId, { cookie: user.cookie });
    await client.waitClosed();

    expect((await waitForStatus(user.callSessionId, 'failed')).terminationReason).toBe(
      'provider_unauthorized',
    );
  });

  it('never leaks the provider message to the browser', async () => {
    providerImpl = async () => {
      throw new VoiceProviderError('rejected', `instructions rejected: ${CANARY}`, 400);
    };
    const user = await setup(ctx, 'relay.failleak@example.com');
    const client = connect(baseUrl, user.callSessionId, { cookie: user.cookie });
    await client.waitClosed();

    expect(JSON.stringify(client.frames)).not.toContain(CANARY);
  });

  it('gives up when the upstream socket never opens', async () => {
    const user = await setup(ctx, 'relay.timeout@example.com');
    const client = connect(baseUrl, user.callSessionId, { cookie: user.cookie });
    const up = await waitForUpstream();

    // The socket is created but never opens: the connect timeout must fire.
    expect(await client.waitClosed(15_000)).toBe(1000);
    expect(up.closeCalls).toBeGreaterThan(0);
    const row = await waitForStatus(user.callSessionId, 'failed');
    expect(row.terminationReason).toBe('orphan_risk_connect_timeout');
    // The handle was recorded before the wait, so the orphan is identifiable.
    expect(row.providerSessionId).toBe('rt_relay_1');
  }, 20_000);
});

describe('disconnects', () => {
  it('closes the upstream when the browser goes away', async () => {
    const { client, up } = await live('relay.clientgone@example.com');

    client.ws.terminate();
    await vi.waitFor(() => expect(up.closeCalls).toBeGreaterThan(0), { timeout: 3_000 });

    // The visitor closing the tab is an ending too.
    const id = (await ctx.db.select().from(callSessions))[0]!.id;
    expect((await waitForStatus(id, 'ended')).terminationReason).toBe('client_disconnected');
  });

  it('closes the browser socket when the provider hangs up', async () => {
    const { client, up } = await live('relay.providergone@example.com');

    up.hangUp();

    expect(await client.waitClosed()).toBe(1000);
    expect(client.frames.find((f) => f.type === 'relay.closed')?.reason).toBe('provider_closed');
    // A provider hanging up after a good call is an ENDING, not a failure.
    const id = (await ctx.db.select().from(callSessions))[0]!.id;
    expect((await waitForStatus(id, 'ended')).terminationReason).toBe('provider_disconnected');
  });

  it('closes both on an upstream error', async () => {
    const { client, up } = await live('relay.providererror@example.com');

    up.fail();

    expect(await client.waitClosed()).toBe(1000);
    const id = (await ctx.db.select().from(callSessions))[0]!.id;
    expect((await waitForStatus(id, 'failed')).terminationReason).toBe('provider_socket_error');
  });

  /**
   * CLEANUP MUST SURVIVE BEING CALLED FROM EVERY DIRECTION AT ONCE. A provider
   * error, a provider close and a browser close can all land together; the row
   * must be settled once, by the first of them.
   */
  it('settles exactly once when error, close and disconnect all fire', async () => {
    const { client, up } = await live('relay.stampede@example.com');
    const id = (await ctx.db.select().from(callSessions))[0]!.id;

    up.fail();
    up.hangUp();
    up.fail();
    client.ws.terminate();
    await client.waitClosed().catch(() => undefined);

    // The FIRST reason wins; later events do not overwrite it.
    const row = await waitForStatus(id, 'failed');
    expect(row.terminationReason).toBe('provider_socket_error');
  });

  it('forces the call down at the maximum duration', async () => {
    providerImpl = async () => stubSession({ maxSeconds: 1 });
    const user = await setup(ctx, 'relay.maxduration@example.com');
    const client = connect(baseUrl, user.callSessionId, { cookie: user.cookie });
    const up = await waitForUpstream();
    up.open();
    await client.waitFor('relay.connected');

    expect(await client.waitClosed(5_000)).toBe(1000);
    expect(client.frames.find((f) => f.type === 'relay.closed')?.reason).toBe('max_duration');
    expect(up.closeCalls).toBeGreaterThan(0);
    expect((await waitForStatus(user.callSessionId, 'expired')).terminationReason).toBe('max_duration');
  }, 10_000);

  it('passes provider session expiry through and ends the call', async () => {
    const { client, up } = await live('relay.expired@example.com');

    up.deliver({ type: 'spicy.session_expired' });
    await client.waitFor('spicy.session_expired');
    up.hangUp();

    expect(await client.waitClosed()).toBe(1000);
  });
});

/* ------------------------------------------------------------------ *
 * One socket, one provider session
 * ------------------------------------------------------------------ */

describe('duplicate connections', () => {
  it('refuses a second socket for the same call', async () => {
    const { user, client } = await live('relay.dupe@example.com');

    const second = connect(baseUrl, user.callSessionId, { cookie: user.cookie });
    await second.waitClosed();

    // The first is untouched; the second created no provider session.
    expect(client.closeCode).toBeNull();
    expect(providerCalls).toHaveLength(1);
    expect(upstreams).toHaveLength(1);
    client.close();
  });

  it('creates exactly one provider session under simultaneous sockets', async () => {
    const user = await setup(ctx, 'relay.dupe.race@example.com');

    const clients = [
      connect(baseUrl, user.callSessionId, { cookie: user.cookie }),
      connect(baseUrl, user.callSessionId, { cookie: user.cookie }),
      connect(baseUrl, user.callSessionId, { cookie: user.cookie }),
    ];
    await vi.waitFor(() => expect(upstreams.length).toBeGreaterThan(0), { timeout: 3_000 });
    await new Promise((r) => setTimeout(r, 300));

    expect(providerCalls).toHaveLength(1);
    expect(upstreams).toHaveLength(1);
    for (const c of clients) c.close();
  });

  it('refuses a socket for a call whose connect was already claimed', async () => {
    const user = await setup(ctx, 'relay.claimed@example.com');
    await ctx.db
      .update(callSessions)
      .set({ connectClaimedAt: new Date() })
      .where(eq(callSessions.id, user.callSessionId));

    const client = connect(baseUrl, user.callSessionId, { cookie: user.cookie });
    await client.waitClosed();

    expect(client.frames.find((f) => f.type === 'relay.error')?.reason).toBe('already_connecting');
    expect(providerCalls).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ *
 * Failures during setup and activation
 * ------------------------------------------------------------------ */

describe('an activation write that fails with the provider already live', () => {
  /**
   * THE DEFECT: the activation ran inside a bare `void (async () => ...)()`. A
   * database blip between the upstream socket opening and the activation write
   * produced an unhandled rejection, and Node's default for one is to terminate
   * the process -- taking every unrelated request and every other call with it.
   */
  it('tears the call down instead of letting the rejection escape', async () => {
    const escaped: unknown[] = [];
    const watch = (reason: unknown) => escaped.push(reason);
    process.on('unhandledRejection', watch);

    try {
      // Shaped like the real thing: drizzle puts the statement in the message.
      hooks.activate = () =>
        Promise.reject(new Error('Failed query: update "call_sessions" set ...\nparams: ...'));

      const user = await setup(ctx, 'relay.activatefail@example.com');
      const client = connect(baseUrl, user.callSessionId, { cookie: user.cookie });
      const up = await waitForUpstream();
      up.open();

      // The browser is told the call is closing, and never that it connected.
      expect((await client.waitFor('relay.closed')).reason).toBe('activation_failed');
      expect(client.frames.some((f) => f.type === 'relay.connected')).toBe(false);

      // A real provider session exists that we could not record as started, so
      // it is named as a possible orphan rather than a clean failure.
      const row = await waitForStatus(user.callSessionId, 'failed');
      expect(row.terminationReason).toBe('orphan_risk_activation_unwritten');
      expect(row.startedAt).toBeNull();

      // The paid session is closed, not left running for thirteen minutes.
      expect(up.closeCalls).toBeGreaterThan(0);
      await client.waitClosed();

      // THE POINT OF THE FIX.
      await settleEventLoop();
      expect(escaped).toEqual([]);
    } finally {
      process.off('unhandledRejection', watch);
    }
  });

  it('leaks nothing about the failure to the browser', async () => {
    hooks.activate = () => Promise.reject(new Error(`Failed query: ... ${CANARY} ... ${PROVIDER_URL}`));

    const user = await setup(ctx, 'relay.activateleak@example.com');
    const client = connect(baseUrl, user.callSessionId, { cookie: user.cookie });
    (await waitForUpstream()).open();
    await client.waitFor('relay.closed');

    const seen = JSON.stringify(client.frames);
    expect(seen).not.toContain(CANARY);
    expect(seen).not.toContain('wss://');
    expect(seen).not.toContain('Failed query');
    expect(seen).not.toContain('call_sessions');
  });
});

describe('a browser that disconnects during setup', () => {
  /**
   * THE DEFECT: the close and error listeners were registered after three
   * database round trips. A visitor closing the tab during them went unnoticed,
   * because `ws` had already emitted `close` before anything was listening: a
   * provider session was bought for a socket that no longer existed and the
   * call sat `active` for the full thirteen minutes, blocking the user and the
   * conversation from calling again.
   */
  it('never buys a provider session once it has gone', async () => {
    const held = holdAt('buildProviderSessionRequest');
    const user = await setup(ctx, 'relay.gone.setup@example.com');
    const client = connect(baseUrl, user.callSessionId, { cookie: user.cookie });

    // Suspended mid-setup, with the claim taken and the provider not yet called.
    await held.reachedAt;
    await vanish(client);
    held.release();
    await settleEventLoop();

    // NOTHING WAS BOUGHT, and nothing was opened to it.
    expect(providerCalls).toHaveLength(0);
    expect(upstreams).toHaveLength(0);

    // And the call is settled rather than left to look live.
    const row = await waitForStatus(user.callSessionId, 'failed');
    expect(row.terminationReason).toBe('client_disconnected_before_connect');
    expect(row.startedAt).toBeNull();
  });

  it('does not even claim the call when it goes before the claim', async () => {
    const held = holdAt('getCallSessionForUser');
    const user = await setup(ctx, 'relay.gone.preclaim@example.com');
    const client = connect(baseUrl, user.callSessionId, { cookie: user.cookie });

    await held.reachedAt;
    await vanish(client);
    held.release();
    await settleEventLoop();

    expect(providerCalls).toHaveLength(0);

    /**
     * Left exactly as `POST /call` created it, on purpose. Nothing had taken
     * ownership of this row, so it is not ours to end: the visitor may simply
     * reconnect, and the sixty-second deadline settles it if they do not.
     */
    const row = await rowFor(user.callSessionId);
    expect(row.status).toBe('pending');
    expect(row.connectClaimedAt).toBeNull();
    expect(row.startedAt).toBeNull();
  });

  it('does not activate a call whose browser left while the provider connected', async () => {
    const user = await setup(ctx, 'relay.gone.upstream@example.com');
    const client = connect(baseUrl, user.callSessionId, { cookie: user.cookie });
    const up = await waitForUpstream();

    // Gone in the window between "socket created" and "socket open".
    await vanish(client);
    const settled = await waitForStatus(user.callSessionId, 'failed');
    expect(settled.terminationReason).toBe('client_disconnected_before_connect');

    // The provider connects a moment later, to nobody.
    up.open();
    await settleEventLoop();

    const row = await rowFor(user.callSessionId);
    expect(row.status).toBe('failed');
    expect(row.terminationReason).toBe('client_disconnected_before_connect');
    // Never activated: `activateConnected` is the only thing that sets this.
    expect(row.startedAt).toBeNull();
    // And the upstream socket is closed rather than left dangling.
    expect(up.closeCalls).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ *
 * The transcript: what was actually said, stored in order
 * ------------------------------------------------------------------ */

describe('finished transcript turns are stored', () => {
  it('stores both sides, in the order they were spoken', async () => {
    const { user, client, up } = await live('relay.tx.both@example.com');

    up.deliver(userSaid('Hi, can you hear me?'));
    up.deliver(sheSaid('I can hear you perfectly.'));
    up.deliver(userSaid('Good. My name is Maya.'));

    const turns = await waitForTurns(user.callSessionId, 3);
    expect(turns.map((t) => [t.speaker, t.content])).toEqual([
      ['user', 'Hi, can you hear me?'],
      ['character', 'I can hear you perfectly.'],
      ['user', 'Good. My name is Maya.'],
    ]);
    // seq is a GLOBAL bigserial: strictly increasing, never assumed to start at 1.
    expect(turns[1]!.seq).toBeGreaterThan(turns[0]!.seq);
    expect(turns[2]!.seq).toBeGreaterThan(turns[1]!.seq);
    client.close();
  });

  /**
   * Deltas are fragments of one sentence. Storing them would record each turn
   * several times over, in pieces -- while the browser still needs them to show
   * speech as it arrives.
   */
  it('stores nothing from the interim delta events, but still relays them', async () => {
    const { user, client, up } = await live('relay.tx.deltas@example.com');

    up.deliver({ type: 'response.audio_transcript.delta', delta: 'I can ' });
    up.deliver({ type: 'response.audio_transcript.delta', delta: 'hear you.' });
    up.deliver({
      type: 'conversation.item.input_audio_transcription.delta',
      item_id: 'item_delta_1',
      delta: 'Hel',
    });
    await client.waitFor('response.audio_transcript.delta');

    // Relayed as before...
    expect(client.frames.filter((f) => String(f.type).endsWith('.delta')).length).toBeGreaterThan(0);
    // ...and stored not at all.
    await settleEventLoop();
    expect(await turnsFor(user.callSessionId)).toHaveLength(0);

    // The finished turn that follows them IS stored, exactly once.
    up.deliver(sheSaid('I can hear you.'));
    const turns = await waitForTurns(user.callSessionId, 1);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.content).toBe('I can hear you.');
    client.close();
  });

  it.each([
    ['empty', ''],
    ['whitespace', '   \n\t  '],
  ])('never stores a turn whose transcript is %s', async (label, transcript) => {
    const { user, client, up } = await live(`relay.tx.blank.${label}@example.com`);

    up.deliver(userSaid(transcript));
    up.deliver(sheSaid(transcript));
    // A real turn after them, so the wait has something to land on.
    up.deliver(sheSaid('Still here.'));

    const turns = await waitForTurns(user.callSessionId, 1);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.content).toBe('Still here.');
    client.close();
  });

  it('trims surrounding whitespace rather than storing it', async () => {
    const { user, client, up } = await live('relay.tx.trim@example.com');
    up.deliver(userSaid('  padded on both sides  '));
    const turns = await waitForTurns(user.callSessionId, 1);
    expect(turns[0]!.content).toBe('padded on both sides');
    client.close();
  });

  /**
   * The user event carries `item_id`, so the same event arriving twice is
   * recognised. The character's `.done` event exposes no identifier, so it is
   * NOT deduplicated -- see the report.
   */
  it('stores a repeated user event once, keyed on its item id', async () => {
    const { user, client, up } = await live('relay.tx.dupe@example.com');

    const repeated = userSaid('Said exactly once.', 'item_stable_1');
    up.deliver(repeated);
    up.deliver(repeated);
    up.deliver(repeated);
    // A different id with the SAME text is a different turn and must survive.
    up.deliver(userSaid('Said exactly once.', 'item_stable_2'));

    const turns = await waitForTurns(user.callSessionId, 2);
    expect(turns).toHaveLength(2);
    expect(turns.map((t) => t.content)).toEqual(['Said exactly once.', 'Said exactly once.']);
    client.close();
  });

  /** A lost line of transcript is not a reason to hang up on someone. */
  it('keeps the call alive when the transcript write fails', async () => {
    const { user, client, up } = await live('relay.tx.writefail@example.com');
    /**
     * Exactly three failures: the three attempts this turn is allowed. A hook
     * that always throws would be non-deterministic here, because the retries
     * outlive any fixed sleep -- the turn would succeed the moment the hook was
     * cleared for the next one.
     */
    hooks.transcript = { failures: 3, error: drizzleFailure() };

    up.deliver(userSaid('This line will not be stored.'));
    // The turn after it, which must still go in.
    up.deliver(sheSaid('This one works.'));

    const turns = await waitForTurns(user.callSessionId, 1);
    expect(turns.map((t) => t.content)).toEqual(['This one works.']);

    // The call is untouched.
    expect(client.closeCode).toBeNull();
    expect((await rowFor(user.callSessionId)).status).toBe('active');

    // Nothing about the DATABASE failure reached the browser. The transcript
    // text itself does reach it, by design -- that is the live transcript.
    const seen = JSON.stringify(client.frames);
    expect(seen).not.toContain('Failed query');
    expect(seen).not.toContain('call_transcript_turns');
    expect(seen).not.toContain('57P01');
    client.close();
  });

  it('keeps a transcript scoped to its own call session', async () => {
    // Driven explicitly rather than through `live()` twice: two calls means two
    // upstream sockets, and the second has to be waited for by count.
    const a = await setup(ctx, 'relay.tx.scopea@example.com');
    const clientA = connect(baseUrl, a.callSessionId, { cookie: a.cookie });
    const upA = await waitForUpstream();
    upA.open();
    await clientA.waitFor('relay.connected');
    upA.deliver(userSaid('Belongs to A.'));
    await waitForTurns(a.callSessionId, 1);
    clientA.close();

    const b = await setup(ctx, 'relay.tx.scopeb@example.com');
    const clientB = connect(baseUrl, b.callSessionId, { cookie: b.cookie });
    const upB = await waitForUpstream(3_000, 2);
    upB.open();
    await clientB.waitFor('relay.connected');
    upB.deliver(userSaid('Belongs to B.'));
    await waitForTurns(b.callSessionId, 1);

    expect((await turnsFor(a.callSessionId)).map((t) => t.content)).toEqual(['Belongs to A.']);
    expect((await turnsFor(b.callSessionId)).map((t) => t.content)).toEqual(['Belongs to B.']);
    clientB.close();
  });

  it('stores nothing once the call has been torn down', async () => {
    const { user, client, up } = await live('relay.tx.afterclose@example.com');
    up.deliver(userSaid('Before.'));
    await waitForTurns(user.callSessionId, 1);

    await vanish(client);
    await waitForStatus(user.callSessionId, 'ended');

    up.deliver(userSaid('After.'));
    await settleEventLoop();
    expect((await turnsFor(user.callSessionId)).map((t) => t.content)).toEqual(['Before.']);
  });

  /** Retention is indefinite, but a transcript has no meaning without its call. */
  it('cascades away with its call session', async () => {
    const { user, client, up } = await live('relay.tx.cascade@example.com');
    up.deliver(userSaid('Will be deleted with the call.'));
    await waitForTurns(user.callSessionId, 1);
    client.close();

    await ctx.db.delete(callSessions).where(eq(callSessions.id, user.callSessionId));
    expect(await turnsFor(user.callSessionId)).toHaveLength(0);
  });

  /* ---------------- retries, idempotency and bounds ---------------- */

  it('retries a failing write and stores exactly one row', async () => {
    const { user, client, up } = await live('relay.tx.retry@example.com');
    hooks.transcript = { failures: 2, error: drizzleFailure() };

    up.deliver(userSaid('Stored on the third attempt.'));

    const turns = await waitForTurns(user.callSessionId, 1);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.content).toBe('Stored on the third attempt.');
    expect(hooks.transcript.failures).toBe(0); // both failures were consumed
    client.close();
  });

  /**
   * THE CASE THE CALLER-CHOSEN ID EXISTS FOR. An insert can commit and still
   * report failure -- a connection dropped while the acknowledgement was in
   * flight is indistinguishable from one dropped before the write. A retry under
   * a fresh row id would duplicate the turn; under the same id it conflicts.
   */
  it('does not duplicate a row when a committed write reports failure', async () => {
    const { user, client, up } = await live('relay.tx.commitfail@example.com');
    hooks.transcript = { failures: 1, commitFirst: true, error: drizzleFailure() };

    up.deliver(userSaid('Written once, acknowledged never.'));

    const turns = await waitForTurns(user.callSessionId, 1);
    await settleEventLoop();
    expect(await turnsFor(user.callSessionId)).toHaveLength(1);
    expect(turns[0]!.content).toBe('Written once, acknowledged never.');
    client.close();
  });

  it('loses only the exhausted turn, and keeps taking the ones after it', async () => {
    const { user, client, up } = await live('relay.tx.exhausted@example.com');
    // Three failures: exactly the three attempts the first turn is allowed.
    hooks.transcript = { failures: 3, error: drizzleFailure() };

    up.deliver(userSaid('This turn is lost.'));
    up.deliver(sheSaid('This turn is not.'));

    const turns = await waitForTurns(user.callSessionId, 1);
    await settleEventLoop();
    expect(turns.map((t) => t.content)).toEqual(['This turn is not.']);

    // The call is untouched, and nothing about the failure reached the browser.
    expect(client.closeCode).toBeNull();
    expect((await rowFor(user.callSessionId)).status).toBe('active');
    const seen = JSON.stringify(client.frames);
    expect(seen).not.toContain('Failed query');
    expect(seen).not.toContain('call_transcript_turns');
    expect(seen).not.toContain('57P01');
    // NOTE: the transcript text itself IS relayed to the browser, by design --
    // it is the live transcript. What must not leak is the database failure.
    client.close();
  });

  /** Retries live INSIDE the serial chain, so a slow turn still goes in first. */
  it('keeps order when an earlier turn needs retries', async () => {
    const { user, client, up } = await live('relay.tx.retryorder@example.com');
    hooks.transcript = { failures: 2, error: drizzleFailure() };

    up.deliver(userSaid('First, after two retries.'));
    up.deliver(sheSaid('Second.'));
    up.deliver(userSaid('Third.'));

    const turns = await waitForTurns(user.callSessionId, 3);
    expect(turns.map((t) => t.content)).toEqual([
      'First, after two retries.',
      'Second.',
      'Third.',
    ]);
    expect(turns[1]!.seq).toBeGreaterThan(turns[0]!.seq);
    expect(turns[2]!.seq).toBeGreaterThan(turns[1]!.seq);
    client.close();
  });

  it('stores an over-long turn at the limit, cut on a word boundary', async () => {
    const { user, client, up } = await live('relay.tx.toolong@example.com');

    // 2000 x 'word ' = 10,000 characters; trimmed, 9,999.
    up.deliver(userSaid('word '.repeat(2000)));

    const turns = await waitForTurns(user.callSessionId, 1);
    const stored = turns[0]!.content;
    /**
     * The budget is 4,000. The first 4,000 characters end exactly on a space
     * (800 x 'word '), so the last word boundary is at 3,999 -- which is where
     * this must cut. Not 4,000, and never mid-word.
     */
    expect(stored).toHaveLength(3_999);
    expect(stored.endsWith('word')).toBe(true);
    expect(stored.endsWith(' ')).toBe(false);
    expect(stored.startsWith('word word')).toBe(true);
    client.close();
  });

  it('leaves a turn at exactly the limit untouched', async () => {
    const { user, client, up } = await live('relay.tx.atlimit@example.com');
    const exact = 'x'.repeat(4_000);
    up.deliver(userSaid(exact));

    const turns = await waitForTurns(user.callSessionId, 1);
    expect(turns[0]!.content).toHaveLength(4_000);
    expect(turns[0]!.content).toBe(exact);
    client.close();
  });

  /**
   * A 4,000-character run with no space in it is not prose. Cutting at the last
   * space would throw away nearly all of it, so the budget wins over the
   * boundary -- the same rule `truncateInstructions` uses for the persona.
   */
  it('cuts at the budget when there is no sensible boundary', async () => {
    const { user, client, up } = await live('relay.tx.nospace@example.com');
    up.deliver(userSaid('y'.repeat(5_000)));

    const turns = await waitForTurns(user.callSessionId, 1);
    expect(turns[0]!.content).toHaveLength(4_000);
    client.close();
  });

  /**
   * THE HOOK STEP 4 NEEDS. The call is recorded as finished only after the
   * transcript is, retries included -- otherwise extraction, which keys off a
   * settled call, would read a transcript missing its ending.
   */
  it('finishes the transcript before the call is settled', async () => {
    const { user, client, up } = await live('relay.tx.flush@example.com');
    hooks.transcript = { failures: 2, error: drizzleFailure() };

    up.deliver(userSaid('The last thing said.'));
    // Hang up immediately: the write is still retrying at this point.
    await vanish(client);

    await waitForStatus(user.callSessionId, 'ended');
    // Read ONCE, with no polling: if the flush did not hold the settle back,
    // the row would already say `ended` with the turn still in flight.
    expect((await turnsFor(user.callSessionId)).map((t) => t.content)).toEqual([
      'The last thing said.',
    ]);
  });

  it('settles the call even when the transcript can never be written', async () => {
    const { user, client, up } = await live('relay.tx.flushfail@example.com');
    hooks.transcript = { failures: 99, error: drizzleFailure() };

    up.deliver(userSaid('Never stored.'));
    await vanish(client);

    // The flush gives up with the chain, so the lifecycle still completes.
    const row = await waitForStatus(user.callSessionId, 'ended');
    expect(row.terminationReason).toBe('client_disconnected');
    expect(await turnsFor(user.callSessionId)).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ *
 * A finished call becomes memory, end to end through the socket
 * ------------------------------------------------------------------ */

describe('hanging up turns the call into memory', () => {
  /** Polls, because extraction is deliberately not awaited by teardown. */
  async function waitForMemories(userId: string, characterId: string, count: number, ms = 5_000) {
    const deadline = Date.now() + ms;
    for (;;) {
      const facts = await listMemories(ctx.db, userId, characterId);
      if (facts.length >= count) return facts;
      if (Date.now() > deadline) {
        throw new Error(`user ${userId} had ${facts.length} memories, not ${count}, after ${ms}ms`);
      }
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  it('remembers what was said once the call ends', async () => {
    const { user, client, up } = await live('relay.mem.fromcall@example.com');
    const userId = (await rowFor(user.callSessionId)).userId;

    up.deliver(userSaid('Hi. My name is Maya.'));
    up.deliver(sheSaid('Nice to meet you, Maya.'));
    up.deliver(userSaid('I live in Haifa, by the way.'));
    await waitForTurns(user.callSessionId, 3);

    // Nothing is remembered while the call is still running.
    expect(await listMemories(ctx.db, userId, LUNA_ID)).toEqual([]);

    client.close();
    await waitForStatus(user.callSessionId, 'ended');

    const facts = await waitForMemories(userId, LUNA_ID, 2);
    expect(facts.sort()).toEqual(['Their name is Maya.', 'They live in Haifa.'].sort());
    expect((await rowFor(user.callSessionId)).memoriesExtractedAt).not.toBeNull();
  });

  /**
   * A call whose settlement never landed is NOT a finished call, so it is not
   * extracted -- and it keeps a null marker, which is what leaves it eligible.
   */
  it('does not extract when settlement failed', async () => {
    const { user, client, up } = await live('relay.mem.settlefail@example.com');
    const userId = (await rowFor(user.callSessionId)).userId;

    up.deliver(userSaid('My name is Maya.'));
    await waitForTurns(user.callSessionId, 1);

    hooks.reject = { fn: 'settleCall', error: drizzleFailure() };
    client.close();
    await settleEventLoop();

    // The row never settled, so nothing was extracted and nothing was marked.
    const row = await rowFor(user.callSessionId);
    expect(row.status).toBe('active');
    expect(row.memoriesExtractedAt).toBeNull();
    expect(await listMemories(ctx.db, userId, LUNA_ID)).toEqual([]);
  });

  /** Every close, error and timeout event lands in teardown; one extraction. */
  it('extracts once under a stampede of teardown events', async () => {
    const { user, client, up } = await live('relay.mem.stampede@example.com');
    const userId = (await rowFor(user.callSessionId)).userId;

    up.deliver(userSaid('My name is Maya.'));
    await waitForTurns(user.callSessionId, 1);

    /**
     * The visitor hangs up FIRST, so the call settles as `ended` -- an outcome
     * that IS extracted. The provider events after it are the duplicates under
     * test: each one re-enters teardown and must change nothing.
     *
     * Leading with `up.fail()` instead would settle the row `failed`, which is
     * deliberately not extracted, and would prove nothing about duplication.
     */
    client.ws.terminate();
    await client.waitClosed().catch(() => undefined);
    up.fail();
    up.hangUp();
    up.fail();

    await waitForStatus(user.callSessionId, 'ended');
    const facts = await waitForMemories(userId, LUNA_ID, 1);
    await settleEventLoop();
    // One fact, not four. The unique index would hide duplicates, so the marker
    // is checked too: set exactly once.
    expect(await listMemories(ctx.db, userId, LUNA_ID)).toEqual(['Their name is Maya.']);
    expect(facts).toHaveLength(1);
    expect((await rowFor(user.callSessionId)).memoriesExtractedAt).not.toBeNull();
  });

  it('remembers nothing from a call where only she spoke', async () => {
    const { user, client, up } = await live('relay.mem.onlyher@example.com');
    const userId = (await rowFor(user.callSessionId)).userId;

    up.deliver(sheSaid('Hello? Are you there?'));
    await waitForTurns(user.callSessionId, 1);
    client.close();
    await waitForStatus(user.callSessionId, 'ended');
    await settleEventLoop();

    expect(await listMemories(ctx.db, userId, LUNA_ID)).toEqual([]);
    // Marked done all the same: there is nothing owed for an empty call.
    expect((await rowFor(user.callSessionId)).memoriesExtractedAt).not.toBeNull();
  });

  /** A call that never connected has nothing to remember. */
  it('does not extract a call that failed to connect', async () => {
    providerImpl = async () => {
      throw new VoiceProviderError('upstream', 'nope', 503);
    };
    const user = await setup(ctx, 'relay.mem.neverconnected@example.com');
    const client = connect(baseUrl, user.callSessionId, { cookie: user.cookie });
    await client.waitClosed();

    const row = await waitForStatus(user.callSessionId, 'failed');
    expect(row.memoriesExtractedAt).toBeNull();
    expect(await listMemories(ctx.db, row.userId, LUNA_ID)).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * Shared memory: what she was told in text, she knows on the phone
 * ------------------------------------------------------------------ */

describe('memories reach the character on a call', () => {
  /** The call session row is the only source of who and which character. */
  const ownerOf = async (callSessionId: string) => (await rowFor(callSessionId)).userId;

  /** The provider request the relay built, once the socket has connected. */
  async function instructionsFor(user: { cookie: string; callSessionId: string }) {
    const client = connect(baseUrl, user.callSessionId, { cookie: user.cookie });
    await waitForUpstream();
    expect(providerCalls).toHaveLength(1);
    return { instructions: providerCalls[0]!.instructions, client };
  }

  it('includes facts stored for THIS user and THIS character', async () => {
    const user = await setup(ctx, 'relay.mem.mine@example.com');
    await storeMemories(ctx.db, await ownerOf(user.callSessionId), LUNA_ID, [
      'Their name is Maya.',
      'They live in Haifa.',
    ]);

    const { instructions, client } = await instructionsFor(user);
    expect(instructions).toContain('Their name is Maya.');
    expect(instructions).toContain('They live in Haifa.');
    // Rendered through the SAME section the text path uses, not a new one.
    expect(instructions).toContain(
      'Things you remember about this person from your conversations so far:',
    );
    client.close();
  });

  /** THE ISOLATION THAT MATTERS MOST: another person's life is not hers to know. */
  it("never includes another user's facts for the same character", async () => {
    const stranger = await setup(ctx, 'relay.mem.stranger@example.com');
    await storeMemories(ctx.db, await ownerOf(stranger.callSessionId), LUNA_ID, [
      'Their name is Boris.',
    ]);

    const user = await setup(ctx, 'relay.mem.notstranger@example.com');
    await storeMemories(ctx.db, await ownerOf(user.callSessionId), LUNA_ID, [
      'Their name is Maya.',
    ]);

    const { instructions, client } = await instructionsFor(user);
    expect(instructions).toContain('Their name is Maya.');
    expect(instructions).not.toContain('Boris');
    client.close();
  });

  it("never includes the same user's facts for a DIFFERENT character", async () => {
    const user = await setup(ctx, 'relay.mem.othercharacter@example.com');
    const userId = await ownerOf(user.callSessionId);
    await storeMemories(ctx.db, userId, LUNA_ID, ['Their name is Maya.']);
    await storeMemories(ctx.db, userId, EMBER_ID, ['They told Ember a secret.']);

    const { instructions, client } = await instructionsFor(user);
    expect(instructions).toContain('Their name is Maya.');
    expect(instructions).not.toContain('secret');
    client.close();
  });

  it('says nothing about memory when there is nothing remembered', async () => {
    const user = await setup(ctx, 'relay.mem.none@example.com');
    const { instructions, client } = await instructionsFor(user);

    // No empty heading, and no claim to remember anything -- a character who
    // opens with "I remember nothing about you" is worse than one who does not
    // raise it. The persona itself is still there.
    expect(instructions).not.toContain('Things you remember about this person');
    expect(instructions).toContain(CANARY);
    client.close();
  });

  /**
   * The voice path does not go through `createPromptBuilder`, so the bound is
   * applied explicitly. Without it, a long-standing user's hundred stored facts
   * would be rendered into a field the provider truncates at 8000 characters.
   */
  it('bounds the injected facts exactly as the text path bounds them', async () => {
    const user = await setup(ctx, 'relay.mem.bounded@example.com');
    const userId = await ownerOf(user.callSessionId);
    const facts = Array.from({ length: 40 }, (_, i) => `They own item number ${i}.`);
    await storeMemories(ctx.db, userId, LUNA_ID, facts);

    const { instructions, client } = await instructionsFor(user);
    const injected = facts.filter((f) => instructions.includes(f));
    expect(injected).toHaveLength(DEFAULT_MEMORY_INJECTION.maxMemories);
    client.close();
  });

  /**
   * Recency is asserted across SEPARATE batches, not within one.
   *
   * `storeMemories` inserts a batch in a single statement, so every row in it
   * shares one `created_at` and `listMemories` breaks the tie on a random uuid
   * -- which ten of forty survive is therefore arbitrary. That is pre-existing
   * behaviour of the memory service and applies to the text path identically;
   * this test pins the property that IS deterministic, which is that a fact
   * stored later outranks a batch stored earlier.
   */
  it('prefers the newest facts when there are more than fit', async () => {
    const user = await setup(ctx, 'relay.mem.newest@example.com');
    const userId = await ownerOf(user.callSessionId);
    await storeMemories(
      ctx.db,
      userId,
      LUNA_ID,
      Array.from({ length: 20 }, (_, i) => `They own old item ${i}.`),
    );
    await storeMemories(ctx.db, userId, LUNA_ID, ['They just adopted a cat called Pepper.']);

    const { instructions, client } = await instructionsFor(user);
    expect(instructions).toContain('They just adopted a cat called Pepper.');
    client.close();
  });

  /** Memory is prompt material, like the persona: it must not come back out. */
  it('never sends a remembered fact to the browser', async () => {
    const user = await setup(ctx, 'relay.mem.noleak@example.com');
    await storeMemories(ctx.db, await ownerOf(user.callSessionId), LUNA_ID, [
      'Their name is Maya.',
    ]);

    const client = connect(baseUrl, user.callSessionId, { cookie: user.cookie });
    const up = await waitForUpstream();
    up.open();
    await client.waitFor('relay.connected');
    // The provider echoing the persona back is the leak Phase 0 found.
    up.deliver({ type: 'session.updated', session: { instructions: 'Their name is Maya.' } });
    await new Promise((r) => setTimeout(r, 100));

    expect(JSON.stringify(client.frames)).not.toContain('Maya');
    client.close();
  });
});

/* ------------------------------------------------------------------ *
 * Teardown and setup failures cannot reach the process
 * ------------------------------------------------------------------ */

describe('a settlement write that fails during teardown', () => {
  /**
   * Seven fire-and-forget callers depend on teardown never rejecting. This
   * forces the one await inside it to throw and checks the guarantee holds at
   * the call site rather than only inside the service.
   */
  it('still closes the call cleanly and lets nothing escape', async () => {
    const watcher = watchUnhandled();
    try {
      const { user, client, up } = await live('relay.settlefail@example.com');
      hooks.reject = { fn: 'settleCall', error: drizzleFailure() };

      // An upstream error reaches teardown through a listener that cannot await.
      up.fail();

      // The browser is still told why, and the socket closes politely.
      expect((await client.waitFor('relay.closed')).reason).toBe('provider_error');
      expect(await client.waitClosed()).toBe(1000);
      expect(up.closeCalls).toBeGreaterThan(0);

      // The write failed, so the row stays live on purpose -- the duration
      // deadline sweeps it. What must NOT happen is a rejection escaping.
      await settleEventLoop();
      expect(watcher.escaped).toEqual([]);

      const row = await rowFor(user.callSessionId);
      expect(row.status).toBe('active');
      expect(row.terminationReason).toBeNull();
    } finally {
      watcher.stop();
    }
  });

  it('leaks nothing from the failed write to the browser', async () => {
    const { client, up } = await live('relay.settleleak@example.com');
    hooks.reject = { fn: 'settleCall', error: drizzleFailure() };
    up.fail();
    await client.waitClosed();

    const seen = JSON.stringify(client.frames);
    expect(seen).not.toContain(CANARY);
    expect(seen).not.toContain('Failed query');
    expect(seen).not.toContain('call_sessions');
    expect(seen).not.toContain('57P01');
  });
});

describe('a database fault during relay setup', () => {
  /**
   * THE DEFECT THIS CLOSES: @fastify/websocket's default error handler is
   * `request.log.error(error)`, and a drizzle message is the failing statement
   * plus its bound values. An ordinary database blip during setup therefore
   * wrote the SQL and its parameters into the application log.
   */
  it('answers a generic server error and never the statement', async () => {
    const watcher = watchUnhandled();
    try {
      hooks.reject = { fn: 'getCallSessionForUser', error: drizzleFailure() };

      const user = await setup(ctx, 'relay.setupfault@example.com');
      const client = connect(baseUrl, user.callSessionId, { cookie: user.cookie });

      // One generic slug, and 1011 Internal Error rather than a bare 1006 --
      // the clean close is what lets the frame flush at all.
      expect((await client.waitFor('relay.error')).reason).toBe('server_error');
      expect(await client.waitClosed()).toBe(1011);

      const seen = JSON.stringify(client.frames);
      expect(seen).not.toContain(CANARY);
      expect(seen).not.toContain('Failed query');
      expect(seen).not.toContain('call_sessions');
      expect(seen).not.toContain('$1');

      // Nothing was bought, and the row is untouched: the fault was ours.
      expect(providerCalls).toHaveLength(0);
      expect(upstreams).toHaveLength(0);
      const row = await rowFor(user.callSessionId);
      expect(row.status).toBe('pending');
      expect(row.connectClaimedAt).toBeNull();

      await settleEventLoop();
      expect(watcher.escaped).toEqual([]);
    } finally {
      watcher.stop();
    }
  });

  /** Authentication still happens first, and is not routed through this handler. */
  it('does not change what an unauthenticated socket gets', async () => {
    hooks.reject = { fn: 'getCallSessionForUser', error: drizzleFailure() };
    const user = await setup(ctx, 'relay.setupfault.anon@example.com');
    const client = connect(baseUrl, user.callSessionId); // no cookie

    expect(await client.waitClosed()).toBeGreaterThan(0);
    // Refused before the handler ran at all, so no server_error frame.
    expect(client.frames.find((f) => f.type === 'relay.error')?.reason).not.toBe('server_error');
    expect(providerCalls).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ *
 * The rest of the lifecycle still behaves
 * ------------------------------------------------------------------ */

describe('existing lifecycle behaviour is intact', () => {
  it('a call ended over HTTP while connected is not reported active', async () => {
    const { user, client } = await live('relay.endhttp@example.com');

    await ctx.app.inject({
      method: 'POST',
      url: `/api/calls/${user.callSessionId}/end`,
      cookies: Object.fromEntries([user.cookie.split('=')]),
    });

    expect((await waitForStatus(user.callSessionId, 'ended')).status).toBe('ended');
    client.close();
  });

  it('a pending call that is never connected still blocks a second start', async () => {
    const user = await setup(ctx, 'relay.stillblocks@example.com');
    const again = await ctx.app.inject({
      method: 'POST',
      url: `/api/conversations/${user.conversationId}/call`,
      cookies: Object.fromEntries([user.cookie.split('=')]),
    });
    expect(again.statusCode).toBe(409);
  });
});

/* ------------------------------------------------------------------ *
 * She speaks first
 * ------------------------------------------------------------------ */

describe('she answers the phone: the opening line', () => {
  const opening = (up: FakeUpstream) =>
    up.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>).filter((f) => String(f.event_id ?? '').startsWith('over18_opening_'));
  /** The provider's real order, measured on Staging: session, cue sent, cue confirmed, response sent. */
  const greet = async (up: FakeUpstream) => {
    up.deliver({ type: 'session.created', session: { id: 's1' } });
    await vi.waitFor(() => expect(opening(up)).toHaveLength(1));
    up.deliver({ type: 'conversation.item.created', item: { role: 'user', type: 'message' } });
    await vi.waitFor(() => expect(opening(up)).toHaveLength(2));
  };

  it('sends the cue the moment the call is active, without waiting for session.created, on the same upstream session', async () => {
    const { client, up } = await live('relay.opening@example.com');
    // Measured on Staging: a cue sent on open is accepted and confirmed sooner.
    await vi.waitFor(() => expect(opening(up)).toHaveLength(1));
    const [item] = opening(up);
    expect(item!.type).toBe('conversation.item.create');
    expect((item!.item as { role: string }).role).toBe('user');
    expect(upstreams).toHaveLength(1);
    client.close();
  });

  /**
   * THE REGRESSION. Sent together, the provider refused the response ("Cannot
   * create response without input, history, or instructions") because the cue
   * was still being screened -- and she said nothing. The response must wait
   * for the cue's confirmation.
   */
  it('asks for her turn only AFTER the provider confirms the cue', async () => {
    const { client, up } = await live('relay.opening.order@example.com');
    up.deliver({ type: 'session.created' });
    up.deliver({ type: 'session.updated' });
    await client.waitFor('session.updated');
    expect(opening(up).map((f) => f.type)).toEqual(['conversation.item.create']);

    up.deliver({ type: 'conversation.item.created', item: { role: 'user', type: 'message' } });
    await vi.waitFor(() => expect(opening(up)).toHaveLength(2));
    expect(opening(up).map((f) => f.type)).toEqual(['conversation.item.create', 'response.create']);
    expect(opening(up)[1]!.response).toBeUndefined(); // her persona, untouched
    client.close();
  });

  it('never before the call is active, then exactly once', async () => {
    const user = await setup(ctx, 'relay.opening.early@example.com');
    const client = connect(baseUrl, user.callSessionId, { cookie: user.cookie });
    const up = await waitForUpstream();
    up.readyState = FakeUpstream.OPEN;
    up.deliver({ type: 'session.created' });
    expect(opening(up)).toHaveLength(0); // not active yet
    up.open();
    await client.waitFor('relay.connected');
    await vi.waitFor(() => expect(opening(up)).toHaveLength(1));
    up.deliver({ type: 'conversation.item.created' });
    await vi.waitFor(() => expect(opening(up)).toHaveLength(2));
    client.close();
  });

  it('never repeats: later session events and later items do not ask again', async () => {
    const { client, up } = await live('relay.opening.once@example.com');
    await greet(up);
    up.deliver({ type: 'session.created' });
    up.deliver({ type: 'conversation.item.created' });
    up.deliver({ type: 'conversation.item.created' });
    up.deliver({ type: 'session.updated' });
    await client.waitFor('session.updated');
    expect(opening(up)).toHaveLength(2);
    client.close();
  });

  it('if he speaks before the cue is confirmed, there is no opening: his turn is first', async () => {
    const { client, up } = await live('relay.opening.barge@example.com');
    up.deliver({ type: 'session.created' });
    await vi.waitFor(() => expect(opening(up)).toHaveLength(1));
    up.deliver({ type: 'input_audio_buffer.speech_started' });
    await client.waitFor('input_audio_buffer.speech_started');
    up.deliver({ type: 'conversation.item.created' });
    up.deliver({ type: 'session.updated' });
    await client.waitFor('session.updated');
    expect(opening(up)).toHaveLength(1); // no response.create
    client.close();
  });

  it('a refused opening leaves the call usable: the error is held back and audio still flows', async () => {
    const { user, client, up } = await live('relay.opening.refused@example.com');
    up.deliver({ type: 'session.created' });
    await vi.waitFor(() => expect(opening(up)).toHaveLength(1));

    up.deliver({ type: 'error', error: { type: 'invalid_request_error', message: 'refused', param: 'response' } });
    up.deliver({ type: 'response.audio.delta', delta: 'WllY' });
    await client.waitFor('response.audio.delta');

    expect(client.frames.some((f) => f.type === 'error')).toBe(false);
    expect(client.closeCode).toBeNull();
    expect((await rowFor(user.callSessionId)).status).toBe('active');
    client.close();
  });

  it('a real provider error after she has begun is still passed through', async () => {
    const { client, up } = await live('relay.opening.later@example.com');
    await greet(up);
    up.deliver({ type: 'response.created' });
    up.deliver({ type: 'error', error: { code: 'rate_limited' } });
    const frame = await client.waitFor('error');
    expect(frame.error).toEqual({ code: 'rate_limited' });
    client.close();
  });

  it('the cue never reaches the browser or the transcript; her spoken greeting is stored like any turn', async () => {
    const { user, client, up } = await live('relay.opening.private@example.com');
    await greet(up);
    up.deliver({ type: 'response.created' });
    up.deliver(sheSaid("Hey, what's up?"));
    const turns = await waitForTurns(user.callSessionId, 1);
    expect(turns.map((t) => [t.speaker, t.content])).toEqual([['character', "Hey, what's up?"]]);
    expect(JSON.stringify(client.frames)).not.toContain('The call has just connected');
    expect(client.frames.some((f) => f.type === 'conversation.item.created')).toBe(false);
    client.close();
  });
});
