import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { WebSocket as FastifyWebSocket } from '@fastify/websocket';
import type { Db } from '../db/client.js';
import {
  activateConnected,
  beginConnect,
  buildProviderSessionRequest,
  failConnect,
  getCallSessionForUser,
  recordProviderSession,
  settleCall,
  type SettleStatus,
} from '../services/call-session-service.js';
import {
  decideClientFrame,
  sanitiseProviderFrame,
  RELAY_EVENTS,
  UPSTREAM_CONNECT_TIMEOUT_MS,
} from '../voice/relay-protocol.js';
import { VoiceProviderError, type VoiceSessionProvider } from '../voice/types.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The voice relay: browser <-> this server <-> the provider.
 *
 * ── WHY THE BROWSER TALKS TO US AND NOT TO THE PROVIDER ──────────────────────
 *
 * A probe of the live API established that the provider returns the session
 * `instructions` -- the compiled persona -- to any connected client that sends
 * `session.update`, including the entirely legitimate turn-detection one. A
 * browser holding the provider's URL and client secret could therefore read the
 * persona. So it never holds them: this server opens the upstream socket, and
 * every frame in either direction is rebuilt rather than forwarded.
 *
 * ── THE PROVIDER SESSION IS CREATED HERE, NOT AT POST TIME ───────────────────
 *
 * `POST /call` only claims a row. The provider's client secret lives sixty
 * seconds, so creating the session before anyone is listening produced a paid
 * session that nothing would ever use or close. Creating it at the moment a
 * socket connects means the credentials never outlive the function holding
 * them, and an abandoned claim simply expires.
 *
 * ── EVERY CHECK HAPPENS BEFORE THE PROVIDER IS TOUCHED ───────────────────────
 *
 * Origin, authentication, ownership, the feature gate, the call's state, and
 * the single-socket claim are all settled first. Only then does anything reach
 * the network.
 */
export default async function callSocketRoutes(
  app: FastifyInstance,
  opts: {
    db: Db;
    provider: VoiceSessionProvider;
    enabled: boolean;
    /** Comma-separated list, as CORS_ORIGIN is written. */
    allowedOrigin: string;
  },
) {
  const allowedOrigins = new Set(
    opts.allowedOrigin
      .split(',')
      .map((o) => o.trim().replace(/\/$/, ''))
      .filter(Boolean),
  );

  /**
   * The browser's own origin check, because CORS does not apply to WebSockets.
   *
   * A cross-origin page can open a WebSocket to us and the browser will happily
   * attach the session cookie -- SameSite=none is required for the API to work
   * at all. So the handshake is refused unless the Origin header is one we
   * already trust for HTTP. No wildcard, and a missing Origin is refused too:
   * every real browser sends one.
   */
  const originAllowed = (request: FastifyRequest): boolean => {
    const origin = request.headers.origin;
    if (typeof origin !== 'string') return false;
    return allowedOrigins.has(origin.replace(/\/$/, ''));
  };

  app.get<{ Params: { callSessionId: string } }>(
    '/api/calls/:callSessionId/socket',
    { websocket: true, preHandler: app.requireAuth },
    async (socket: FastifyWebSocket, request) => {
      const { callSessionId } = request.params;

      /* ---------------------------------------------------------------- *
       * State and listeners FIRST, before anything can be awaited
       * ---------------------------------------------------------------- */

      let upstream: WebSocket | null = null;
      let closed = false;
      /** True once the upstream socket opened and the row went `active`. */
      let connected = false;
      /**
       * True once THIS socket won `beginConnect`.
       *
       * Teardown settles the row only when it is set. Before the claim the row
       * is the pending call `POST /call` created and is not ours to end -- the
       * visitor may simply reconnect, and the sixty-second deadline is what
       * settles it if they do not.
       */
      let claimed = false;
      let durationTimer: ReturnType<typeof setTimeout> | null = null;
      let connectTimer: ReturnType<typeof setTimeout> | null = null;

      /**
       * Close everything, once.
       *
       * Competing close, error and timeout events all land here, from both
       * sockets, and any of them may fire more than once. The `closed` flag
       * makes every call after the first a no-op, so the FIRST reason wins --
       * without it a provider error arriving during a browser disconnect would
       * settle the row twice and overwrite the real cause.
       */
      const teardown = async (
        reason: string,
        settle?: { status: SettleStatus; reason: string },
      ): Promise<void> => {
        if (closed) return;
        closed = true;
        if (connectTimer) clearTimeout(connectTimer);
        if (durationTimer) clearTimeout(durationTimer);
        try {
          upstream?.close();
        } catch {
          /* already gone */
        }
        try {
          socket.send(JSON.stringify(RELAY_EVENTS.closed(reason)));
        } catch {
          /* already gone */
        }
        try {
          socket.close(1000, reason);
        } catch {
          /* already gone */
        }
        if (settle && claimed) {
          // Swallowed inside settleCall; a database fault here must not throw
          // over the reason the call ended.
          await settleCall(opts.db, callSessionId, settle.status, settle.reason);
        }
      };

      /**
       * A disconnect after a good call is an ENDING, not a failure.
       *
       * Both sides hang up normally all the time -- the visitor closes the tab,
       * the provider finishes. Recording those as `failed` would drown the
       * genuine failures in noise.
       */
      const settleForDisconnect = (reason: string) =>
        connected
          ? ({ status: 'ended', reason } as const)
          : ({ status: 'failed', reason: `${reason}_before_connect` } as const);

      /**
       * REGISTERED BEFORE THE FIRST AWAIT, and that ordering is the fix.
       *
       * The handler awaits three database round trips before it reaches the
       * provider. A visitor closing the tab during them used to go unnoticed,
       * because `ws` had already emitted `close` by the time a later listener
       * was attached: `closed` stayed false, a provider session was created for
       * a socket that no longer existed, and the call sat `active` for the full
       * thirteen minutes. Listening from the first line closes that window.
       */
      socket.on('close', () => void teardown('client_closed', settleForDisconnect('client_disconnected')));
      socket.on('error', () => void teardown('client_error', settleForDisconnect('client_socket_error')));

      /** One reason slug, then the socket goes. Never a provider message. */
      const refuse = (reason: string): void => {
        // Marked closed first so the close listener's teardown is a no-op:
        // nothing is open yet, and a refusal is not a call that ended.
        closed = true;
        try {
          socket.send(JSON.stringify(RELAY_EVENTS.error(reason)));
        } catch {
          /* already gone */
        }
        socket.close(1008, reason);
      };

      /** True while the browser socket is genuinely still there. */
      const clientGone = (): boolean => closed || socket.readyState !== socket.OPEN;

      if (!originAllowed(request)) return refuse('forbidden_origin');
      if (!opts.enabled) return refuse('voice_unavailable');

      // Malformed, unknown and somebody else's are one answer, as everywhere.
      if (!UUID_RE.test(callSessionId)) return refuse('not_found');

      const userId = request.currentUser!.id;
      const owned = await getCallSessionForUser(opts.db, userId, callSessionId);
      if (!owned) return refuse('not_found');

      /**
       * Nothing is claimed for a browser that has already gone.
       *
       * No settle here on purpose: the row is still the pending call `POST
       * /call` created and nothing has taken ownership of it, so the visitor may
       * reconnect and the sixty-second deadline settles it if they do not.
       */
      if (clientGone()) {
        await teardown('client_gone_during_setup');
        return;
      }

      // One socket per call: the loser of this race is refused outright rather
      // than being allowed to create a second provider session.
      const claim = await beginConnect(opts.db, userId, callSessionId);
      if (claim.status === 'not_found') return refuse('not_found');
      if (claim.status === 'unavailable') {
        return refuse(claim.reason === 'already_connecting' ? 'already_connecting' : 'invalid_state');
      }

      claimed = true;

      const request_ = await buildProviderSessionRequest(opts.db, claim.row);
      if (!request_) {
        await failConnect(opts.db, callSessionId, 'provider_character_missing');
        return refuse('not_found');
      }

      /**
       * NOTHING IS BOUGHT FOR A BROWSER THAT HAS ALREADY GONE.
       *
       * Checked against both the flag and the socket's own state: the flag
       * catches a close our listener saw, `readyState` catches one it somehow
       * did not. A provider session created here would be paid for, unusable,
       * and unclosable.
       */
      if (clientGone()) {
        // Settled here rather than through teardown: the close listener may
        // already have fired, back when the claim was not yet ours to end, and
        // teardown runs once. `failConnect` only moves a row that is still
        // live, so a genuine earlier outcome is not overwritten.
        await failConnect(opts.db, callSessionId, 'client_disconnected_before_connect');
        await teardown('client_gone_during_setup');
        return;
      }

      /* ---------------------------------------------------------------- *
       * The provider session, created now that everything has passed
       * ---------------------------------------------------------------- */
      let session;
      try {
        session = await opts.provider.createSession(request_);
      } catch (error) {
        const kind = error instanceof VoiceProviderError ? error.kind : 'unexpected';
        const ambiguous = !(error instanceof VoiceProviderError && error.definitelyCreatedNothing);
        // Kind only. A provider error body can quote the request, and the
        // request carried the persona.
        request.log.warn({ voiceErrorKind: kind }, 'voice relay: provider session creation failed');
        await teardown('provider_unavailable', {
          status: 'failed',
          reason: `${ambiguous ? 'orphan_risk' : 'provider'}_${kind}`,
        });
        return;
      }

      // Recorded before anything else, so a crash from here leaves a row that
      // can still name the upstream session.
      await recordHandle(opts.db, callSessionId, session.providerSessionId);

      if (closed) {
        // The browser left while the session was being created. Nothing to
        // relay; the row is settled as a failed connect.
        await failConnect(opts.db, callSessionId, 'client_gone_before_connect');
        return;
      }

      /* ---------------------------------------------------------------- *
       * Upstream socket
       * ---------------------------------------------------------------- */
      upstream = new WebSocket(session.url);

      connectTimer = setTimeout(() => {
        void teardown('provider_timeout', {
          status: 'failed',
          reason: 'orphan_risk_connect_timeout',
        });
      }, UPSTREAM_CONNECT_TIMEOUT_MS);

      upstream.addEventListener('open', () => {
        if (connectTimer) clearTimeout(connectTimer);
        if (closed) {
          try {
            upstream?.close();
          } catch {
            /* already gone */
          }
          return;
        }

        void (async () => {
          try {
            // ACTIVE ONLY NOW: the upstream socket is genuinely open.
            const activated = await activateConnected(opts.db, callSessionId, session.maxSeconds);
            if (!activated) {
              // Ended or swept underneath us. Never report a live call, and do
              // not settle: whatever moved the row already recorded why.
              await teardown('invalid_state');
              return;
            }
            connected = true;
            try {
              socket.send(JSON.stringify(RELAY_EVENTS.connected()));
            } catch {
              /* already gone */
            }
            // The provider's own ceiling, enforced locally too: a socket
            // that outlives it is closed rather than left running. Reaching
            // the ceiling is an expiry, not a failure: the call did everything
            // it was allowed to do.
            durationTimer = setTimeout(
              () => void teardown('max_duration', { status: 'expired', reason: 'max_duration' }),
              session.maxSeconds * 1000,
            );
          } catch {
            /**
             * THE WRITE FAILED WITH A LIVE PROVIDER SESSION ON THE OTHER END.
             *
             * Unguarded, this rejection escaped into `void` and Node's default
             * for an unhandled rejection is to terminate the process -- one
             * database blip would have taken down the whole API, every request
             * and every other call with it.
             *
             * The error itself is never logged: it can carry the failing
             * statement and its parameters. The session is real and we could
             * not record that it started, so it is marked as a possible orphan.
             * Teardown's `closed` flag means a terminal outcome that already
             * won is not overwritten.
             */
            await teardown('activation_failed', {
              status: 'failed',
              reason: 'orphan_risk_activation_unwritten',
            });
          }
        })();
      });

      upstream.addEventListener('message', (event) => {
        if (closed) return;
        if (typeof event.data !== 'string') return; // transport is json
        const decision = sanitiseProviderFrame(event.data);
        if (decision.action === 'drop') return;
        try {
          socket.send(JSON.stringify(decision.payload));
        } catch {
          /* browser gone; its close handler tears down */
        }
      });

      upstream.addEventListener('error', () => {
        void teardown('provider_error', { status: 'failed', reason: 'provider_socket_error' });
      });

      upstream.addEventListener('close', () => {
        void teardown('provider_closed', settleForDisconnect('provider_disconnected'));
      });

      /* ---------------------------------------------------------------- *
       * Browser -> provider
       * ---------------------------------------------------------------- */
      socket.on('message', (raw: Buffer | string) => {
        if (closed) return;
        // Binary is never expected: the session uses the json transport.
        const text = typeof raw === 'string' ? raw : raw.toString('utf8');
        const decision = decideClientFrame(text);
        if (decision.action === 'drop') {
          if (decision.reason === 'too_large') {
            // Oversized is treated as hostile rather than clumsy: a client that
            // can send 64 KiB frames can exhaust us with them.
            void teardown('frame_too_large');
          }
          return;
        }
        if (upstream?.readyState === WebSocket.OPEN) upstream.send(text);
      });
    },
  );
}

/**
 * Records the provider handle, swallowing a failure to do so.
 *
 * If this write fails the row stays `pending` and the sixty-second deadline
 * sweeps it. Throwing instead would replace the reason the call is ending with
 * "and the database was also unreachable", which is the less useful of the two.
 */
async function recordHandle(db: Db, callSessionId: string, providerSessionId: string): Promise<void> {
  try {
    await recordProviderSession(db, callSessionId, providerSessionId);
  } catch {
    /* swept by the pending deadline */
  }
}
