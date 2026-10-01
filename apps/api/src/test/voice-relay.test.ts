import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { WebSocket as WsClient } from 'ws';
import { callSessions } from '../db/schema.js';
import { SEED_CHARACTERS } from '../db/seed-data.js';
import { seedCharacters } from '../db/seed.js';
import { VoiceProviderError, type VoiceSession, type VoiceSessionRequest } from '../voice/types.js';
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

beforeAll(async () => {
  migrateTestDb();
  ctx = await createTestContext({ voiceCallsEnabled: true, voiceProvider: provider });
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
async function waitForUpstream(ms = 3_000): Promise<FakeUpstream> {
  const deadline = Date.now() + ms;
  for (;;) {
    const last = upstreams.at(-1);
    if (last) return last;
    if (Date.now() > deadline) throw new Error('no upstream socket was created');
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
    await vi.waitFor(() => expect(up.sent.length).toBeGreaterThan(0));
    expect(JSON.parse(up.sent[0]!).type).toBe('input_audio_buffer.append');

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
    await vi.waitFor(() => expect(up.sent.length).toBe(1));

    expect(JSON.parse(up.sent[0]!).type).toBe('input_audio_buffer.commit');
    expect(up.sent.join()).not.toContain('session.update');
    client.close();
  });

  it('closes the socket on an oversized frame', async () => {
    const { client, up } = await live('relay.oversized@example.com');

    client.ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: 'A'.repeat(70_000) }));

    expect(await client.waitClosed()).toBe(1000);
    expect(up.sent).toHaveLength(0);
    client.close();
  });

  it('ignores a malformed frame without closing the call', async () => {
    const { client, up } = await live('relay.malformed@example.com');

    client.ws.send('not json at all');
    client.ws.send(JSON.stringify({ nope: true }));
    client.ws.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
    await vi.waitFor(() => expect(up.sent.length).toBe(1));

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
