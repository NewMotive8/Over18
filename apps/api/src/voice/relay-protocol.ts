/**
 * What may cross the relay, in each direction.
 *
 * ── WHY THIS IS AN ALLOWLIST AND NOT A DENYLIST ──────────────────────────────
 *
 * A direct probe of the live provider established that a `session.updated`
 * event carries the full `instructions` back to whoever is connected -- the
 * compiled persona, verbatim. That was found by planting a canary string in the
 * instructions and watching it come back.
 *
 * The tempting fix is to delete `instructions` from that one event. It is the
 * wrong fix. It assumes the provider's event shapes are known and fixed, and
 * that no future event, and no nested object inside an event, will carry the
 * same field. Neither assumption is ours to make about somebody else's API.
 *
 * So nothing is forwarded. Every browser-bound frame is REBUILT from scratch:
 * for each allowed event type there is a function that reads the two or three
 * fields the browser genuinely needs and constructs a new object. A field the
 * provider adds tomorrow cannot reach the browser, because nothing copies it.
 *
 * ── AND NOTHING IS FORWARDED BY DEFAULT ──────────────────────────────────────
 *
 * An event with no builder is dropped. That includes events we merely have no
 * use for, such as `spicy.usage`, which carries cost figures that are the
 * server's business and not the customer's.
 */

/** Frames the browser may send upstream. */
export const CLIENT_TO_PROVIDER_ALLOWLIST = new Set([
  'input_audio_buffer.append',
  'input_audio_buffer.commit',
  'input_audio_buffer.clear',
  'response.create',
  'response.cancel',
]);

/**
 * `session.update` is deliberately absent.
 *
 * The provider accepts only `turn_detection` there, so it cannot be used to
 * replace the persona -- but it CAN be used to provoke a `session.updated`,
 * which is the event that echoes the instructions. The sanitiser below already
 * neutralises that, and this is the second lock on the same door: Phase 2A
 * gives the browser no reason to change turn detection mid-call.
 */

/** The largest browser frame the relay will accept, in bytes. */
export const MAX_CLIENT_FRAME_BYTES = 64 * 1024;

/**
 * How long to wait for the provider socket to open before giving up.
 * The client secret is valid for 60 seconds, so waiting longer is pointless.
 */
export const UPSTREAM_CONNECT_TIMEOUT_MS = 10_000;

export type ClientFrameDecision =
  | { action: 'forward'; type: string }
  | { action: 'drop'; type: string; reason: 'too_large' | 'unparsable' | 'no_type' | 'not_allowlisted' };

/**
 * Whether one browser frame may go upstream.
 *
 * Size is checked FIRST, on the raw bytes, so an oversized frame is refused
 * without being parsed -- parsing it is the work we are trying to avoid.
 */
export function decideClientFrame(raw: string): ClientFrameDecision {
  if (Buffer.byteLength(raw, 'utf8') > MAX_CLIENT_FRAME_BYTES) {
    return { action: 'drop', type: '<oversized>', reason: 'too_large' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { action: 'drop', type: '<unparsable>', reason: 'unparsable' };
  }
  const type = (parsed as { type?: unknown } | null)?.type;
  if (typeof type !== 'string' || type.length === 0) {
    return { action: 'drop', type: '<none>', reason: 'no_type' };
  }
  if (!CLIENT_TO_PROVIDER_ALLOWLIST.has(type)) {
    return { action: 'drop', type, reason: 'not_allowlisted' };
  }
  return { action: 'forward', type };
}

/* ------------------------------------------------------------------ *
 * Provider -> browser
 * ------------------------------------------------------------------ */

/** A string field, or undefined. Never an object, never a nested structure. */
function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Adds a key only when the value survived `str`, so no `undefined` is emitted. */
function withText(base: Record<string, unknown>, key: string, value: unknown): Record<string, unknown> {
  const text = str(value);
  return text === undefined ? base : { ...base, [key]: text };
}

/**
 * One builder per allowed event. Each returns a NEW object containing only the
 * named primitive fields -- never a copy, a spread, or a nested provider
 * object.
 *
 * Deliberately excluded:
 *   session.created / session.updated  -> the session object carries the
 *       persona. The browser is told the session is ready and nothing else.
 *   spicy.usage                        -> cost figures are the server's.
 *   error                              -> code only; see below.
 *   everything else                    -> dropped by absence.
 */
const PROVIDER_EVENT_BUILDERS: Record<string, (event: Record<string, unknown>) => Record<string, unknown>> = {
  // The session exists. No session fields cross: `instructions` lives there.
  'session.created': () => ({ type: 'session.created' }),
  'session.updated': () => ({ type: 'session.updated' }),

  // Turn taking. The browser needs these to drive the UI and stop playback.
  'input_audio_buffer.speech_started': () => ({ type: 'input_audio_buffer.speech_started' }),
  'input_audio_buffer.speech_stopped': () => ({ type: 'input_audio_buffer.speech_stopped' }),
  'input_audio_buffer.committed': (e) =>
    withText({ type: 'input_audio_buffer.committed' }, 'item_id', e.item_id),

  // What he said.
  'conversation.item.input_audio_transcription.delta': (e) =>
    withText(withText({ type: e.type as string }, 'item_id', e.item_id), 'delta', e.delta),
  'conversation.item.input_audio_transcription.completed': (e) =>
    withText(withText({ type: e.type as string }, 'item_id', e.item_id), 'transcript', e.transcript),

  // What she said, and the audio itself.
  'response.created': () => ({ type: 'response.created' }),
  'response.audio.delta': (e) => withText({ type: 'response.audio.delta' }, 'delta', e.delta),
  'response.audio_transcript.delta': (e) =>
    withText({ type: 'response.audio_transcript.delta' }, 'delta', e.delta),
  'response.audio_transcript.done': (e) =>
    withText({ type: 'response.audio_transcript.done' }, 'transcript', e.transcript),
  'response.done': () => ({ type: 'response.done' }),

  // The call is over at the provider's end.
  'spicy.session_expired': () => ({ type: 'spicy.session_expired' }),

  /**
   * ERRORS ARE THE MOST DANGEROUS EVENT, and get the strictest treatment.
   *
   * A provider error message routinely quotes the request that caused it, and
   * our request contains the persona. So `error.message` is never forwarded --
   * only `error.code`, which is one of a documented set of short slugs
   * (`content_blocked`, `payment_required`, `unsupported_field`, ...) and
   * carries no free text at all.
   */
  error: (e) => {
    const detail = e.error;
    const code =
      detail && typeof detail === 'object' ? str((detail as Record<string, unknown>).code) : undefined;
    return { type: 'error', error: { code: code ?? 'provider_error' } };
  },
};

/** The event types the browser can ever receive. Exported for the tests. */
export const PROVIDER_TO_CLIENT_ALLOWLIST: readonly string[] = Object.keys(PROVIDER_EVENT_BUILDERS);

export type ProviderFrameDecision =
  | { action: 'forward'; type: string; payload: Record<string, unknown> }
  | { action: 'drop'; type: string; reason: 'unparsable' | 'no_type' | 'not_allowlisted' };

/**
 * Rebuilds one provider frame as something the browser may see.
 *
 * Never mutates and never copies the input. The returned object shares no
 * reference with the provider's frame, so a nested field cannot ride along.
 */
export function sanitiseProviderFrame(raw: string): ProviderFrameDecision {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { action: 'drop', type: '<unparsable>', reason: 'unparsable' };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { action: 'drop', type: '<none>', reason: 'no_type' };
  }
  const event = parsed as Record<string, unknown>;
  const type = event.type;
  if (typeof type !== 'string' || type.length === 0) {
    return { action: 'drop', type: '<none>', reason: 'no_type' };
  }
  const build = PROVIDER_EVENT_BUILDERS[type];
  if (!build) return { action: 'drop', type, reason: 'not_allowlisted' };

  return { action: 'forward', type, payload: build(event) };
}

/**
 * A PostgreSQL SQLSTATE, by the server's own definition: exactly five
 * characters, digits and upper-case ASCII letters only. `08006`, `57P01`,
 * `23505`, `XX000`, `P0001`.
 *
 * Matched by SHAPE rather than against a table of the ~250 defined values,
 * because that table grows: a code Postgres adds next year is exactly the one
 * an operator would need, and an enumeration would silently withhold it. Five
 * characters of upper-case alphanumerics cannot carry a credential, so the
 * shape is a safe thing to trust.
 */
const SQLSTATE = /^[0-9A-Z]{5}$/;

/**
 * System and transport codes that may be logged, enumerated deliberately.
 *
 * ENUMERATED RATHER THAN PATTERN-MATCHED, unlike SQLSTATE. These are
 * free-form upper-case identifiers, and a pattern loose enough to admit
 * `ECONNREFUSED` is also loose enough to admit `SK_LIVE_ABCDEF` -- an
 * upper-case token with underscores is indistinguishable from a credential by
 * shape alone. So the set is closed, and it is short on purpose: these are the
 * codes someone would actually act on when the relay cannot reach the database
 * or the provider. Anything else is reported as withheld, which is a visible
 * gap rather than a silent one.
 */
const LOGGABLE_CODES = new Set([
  // The database or the provider is unreachable, or went away mid-request.
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENETDOWN',
  'EADDRNOTAVAIL',
  'EPIPE',
  'EAI_AGAIN',
  // TLS, which is how both the staging and production databases are reached.
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  // The socket or stream was already gone when something wrote to it.
  'ABORT_ERR',
  'ERR_SOCKET_CLOSED',
  'ERR_STREAM_DESTROYED',
  'ERR_STREAM_WRITE_AFTER_END',
  // undici, which backs the global WebSocket the relay opens upstream.
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_ABORTED',
]);

/**
 * The only things that may be logged about a failure.
 *
 * A DRIZZLE REJECTION'S MESSAGE IS THE STATEMENT AND ITS BOUND VALUES --
 * literally `Failed query: <sql>\nparams: <values>` -- and its stack begins with
 * that same message. So handing the error object to a logger writes the query
 * and every parameter into the application log, where an identifier, a token
 * stored in a column, or a connection string in a parameter would then sit in
 * plain text for anyone with log access.
 *
 * The error is therefore reduced to the class it was, plus a code only when that
 * code is recognisably a code. An earlier version accepted any string of twelve
 * characters or fewer, which was wrong twice over: `pw:hunter2` would have been
 * logged verbatim, and a junk `code` on an outer wrapper would have stopped the
 * search before the real SQLSTATE underneath it was ever reached.
 *
 * So the chain is walked to the end looking for something recognised, and a code
 * that is present but unrecognised is reported as `errorCodeWithheld` rather
 * than dropped in silence -- otherwise "there was no code" and "there was a code
 * I would not print" look identical in the log, and the second is worth knowing.
 *
 * The `cause` chain is walked because drizzle wraps the pg error rather than
 * replacing it, exactly as `violatedConstraint` does, with the same depth bound
 * -- which also makes a circular chain terminate.
 */
export function describeError(error: unknown): {
  errorName: string;
  errorCode?: string;
  errorCodeWithheld?: true;
} {
  const errorName =
    error instanceof Error && typeof error.name === 'string' && error.name.length > 0
      ? error.name
      : typeof error;

  let withheld = false;
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && (SQLSTATE.test(code) || LOGGABLE_CODES.has(code))) {
      return { errorName, errorCode: code };
    }
    // Present but not recognised -- including a number, which is not trusted
    // either: keep looking deeper, and remember that something was refused.
    if (code !== undefined && code !== null) withheld = true;
    current = (current as { cause?: unknown }).cause;
  }
  return withheld ? { errorName, errorCodeWithheld: true } : { errorName };
}

/** Relay-originated notices. Distinct prefix so they cannot collide upstream. */
export const RELAY_EVENTS = {
  connected: () => ({ type: 'relay.connected' }),
  /** A short reason slug -- never a provider message. */
  closed: (reason: string) => ({ type: 'relay.closed', reason }),
  error: (reason: string) => ({ type: 'relay.error', reason }),
} as const;
