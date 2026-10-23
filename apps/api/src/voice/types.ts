/**
 * The live-voice provider seam.
 *
 * Modelled on `LlmClient` / `ReplyProvider`: one narrow interface the service
 * depends on, with every vendor detail behind it. A second provider gets its
 * own adapter next to `spicyapi.ts` and nothing above this line changes.
 */

export type VoiceErrorKind =
  /** No provider configured. Nothing was attempted. */
  | 'not_configured'
  /** The provider refused the credential. */
  | 'unauthorized'
  /** The account cannot pay for a call right now. */
  | 'payment_required'
  /** The provider rejected the request (4xx other than the two above). */
  | 'rejected'
  /**
   * The provider refused the persona on content grounds.
   *
   * A NARROWER CASE OF `rejected`, kept separate because the two mean opposite
   * things to the person waiting. A rejection is a fault that may clear by
   * itself; a content refusal will fail identically every time, so telling
   * somebody to "try again in a moment" is advice that cannot work.
   */
  | 'content_blocked'
  /** The provider failed (5xx). */
  | 'upstream'
  /** The request exceeded its bounded timeout. */
  | 'timeout'
  /** The provider could not be reached. */
  | 'network'
  /** A 2xx whose body was not the documented shape. */
  | 'invalid_response';

/**
 * A provider failure, carrying a KIND and never a body.
 *
 * The request that failed contained the compiled persona, and providers
 * routinely echo the request back in an error. So the body is never attached,
 * never logged and never surfaced -- the kind and the HTTP status are all a
 * caller needs to decide what to do.
 */
export class VoiceProviderError extends Error {
  constructor(
    public readonly kind: VoiceErrorKind,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'VoiceProviderError';
  }

  /**
   * True when creating a session may safely be attempted again.
   *
   * Deliberately narrow. A timeout or a dropped connection may mean the
   * provider DID create a session we never heard about, so neither is retryable
   * -- retrying would create a second billable session. Only failures that
   * certainly created nothing qualify, and even then the decision to retry is
   * the caller's.
   */
  get definitelyCreatedNothing(): boolean {
    return (
      this.kind === 'not_configured' ||
      this.kind === 'unauthorized' ||
      this.kind === 'rejected' ||
      // A refusal on content grounds is a refusal: the provider declined the
      // request rather than half-performing it, so there is no session to orphan.
      this.kind === 'content_blocked'
    );
  }
}

/**
 * The only fields that may be logged about a provider failure.
 *
 * WHY THIS IS A FUNCTION AND NOT A LOG CALL. The first live Staging call failed
 * with `provider_rejected` and the log said only that -- the HTTP status was
 * captured on the error and then dropped at the call site, so "a 4xx that is not
 * 401, 402 or 403" was the entire diagnosis available. That is an unforced loss:
 * a status code is three digits and cannot contain a persona.
 *
 * The body still never appears, and that part was never the mistake. A provider
 * error body routinely echoes the request, and the request carries the compiled
 * persona -- which is exactly why `VoiceProviderError` refuses to hold one. This
 * function exists so that what IS forwarded is one reviewable, testable list
 * rather than a decision repeated at each call site.
 *
 * `unexpected` for anything that is not a provider error, preserving the
 * classification the relay already used.
 */
export function providerFailureLogFields(error: unknown): {
  voiceErrorKind: VoiceErrorKind | 'unexpected';
  voiceErrorStatus?: number;
} {
  if (!(error instanceof VoiceProviderError)) return { voiceErrorKind: 'unexpected' };
  // Omitted rather than set to undefined, so a timeout or a network failure --
  // neither of which has a status -- logs no empty field.
  return error.status === undefined
    ? { voiceErrorKind: error.kind }
    : { voiceErrorKind: error.kind, voiceErrorStatus: error.status };
}

/** What the server needs to create a session. Assembled server-side, always. */
export interface VoiceSessionRequest {
  /** The compiled persona. Never logged, never returned to a client. */
  instructions: string;
  voice: string;
  /** Opaque correlation handle for the provider. Never a raw user id. */
  userRef: string;
}

/**
 * What a created session gives back.
 *
 * `clientSecret` and `url` are live credentials: they are held in memory for
 * the relay to use and are never persisted, logged, or sent to a browser.
 * Phase 0 established why the browser must not connect directly -- the provider
 * returns the persona to any client that sends `session.update`.
 */
export interface VoiceSession {
  providerSessionId: string;
  voice: string;
  maxSeconds: number;
  url: string;
  clientSecret: string;
  clientSecretExpiresAt: number;
  /**
   * WebSocket subprotocols to open the upstream socket with, when the provider
   * authenticates that way rather than through the URL.
   *
   * WHY THIS EXISTS. SpicyAPI returns a session URL that carries its own
   * credential, so the relay opens it with no second argument and this stays
   * undefined. xAI's realtime endpoint is a bare `wss://api.x.ai/v1/realtime`
   * and expects either an `Authorization` header -- which the WHATWG WebSocket
   * API cannot set -- or an ephemeral token passed as a subprotocol. The
   * subprotocol is therefore the only route that does not mean replacing the
   * global WebSocket the relay already uses.
   *
   * Live credential material, like `clientSecret`: held in memory for the relay
   * and never persisted, logged or sent to a browser.
   */
  subprotocols?: readonly string[];
  /**
   * Frames the relay must write the moment the socket opens, before anything
   * else.
   *
   * WHY A PROVIDER MAY NEED THIS. SpicyAPI takes the compiled persona in the
   * body of the REST call that creates the session, so by the time a socket
   * exists the model is already configured and this stays undefined. xAI has no
   * such call -- its `client_secrets` endpoint accepts only `model` and
   * `reasoning.effort` -- so the persona can only arrive as a `session.update`
   * frame over the open socket.
   *
   * THESE FRAMES CARRY THE PERSONA, so they are treated exactly as
   * `clientSecret` is: in memory, never logged, never forwarded to a browser.
   * They are built by the adapter from instructions the server compiled, and
   * `session.update` remains absent from the browser's allowlist so a client
   * cannot send one of its own.
   */
  onOpenFrames?: readonly string[];
}

export interface VoiceSessionProvider {
  readonly name: string;
  /**
   * The provider's published ceiling on `instructions`, or null when it
   * documents none.
   *
   * WHY IT MOVED ONTO THE SEAM. `call-session-service` imported SpicyAPI's
   * 8,000-character constant directly, which made one vendor's limit the
   * arithmetic for every vendor -- so a provider with no limit would still have
   * had a character's remembered facts trimmed to fit a number that did not
   * apply to it, and an oversized persona refused for a reason that was not
   * true.
   *
   * NULL IS NOT INFINITY WITH BETTER MANNERS. It means "this provider publishes
   * no limit", which is a fact about the documentation rather than a promise
   * about the provider. The budget code treats it as "do not trim and do not
   * refuse", because inventing a ceiling nobody published would be guessing, and
   * guessing low silently truncates a persona while guessing high does nothing
   * at all.
   */
  readonly instructionsMaxChars: number | null;
  createSession(request: VoiceSessionRequest): Promise<VoiceSession>;
}

/**
 * The provider used when none is configured.
 *
 * Fails clearly rather than pretending: the same rule `unconfiguredReplyProvider`
 * follows for chat. A voice call that cannot be created must not look like one
 * that simply had no answer.
 */
export const unconfiguredVoiceProvider: VoiceSessionProvider = {
  name: 'unconfigured',
  // Nothing will be compiled for it, so the value is immaterial; null is the
  // honest one -- an absent provider publishes no limit.
  instructionsMaxChars: null,
  // Async, not a synchronous throw: the interface promises a Promise, and a
  // caller doing `.catch()` rather than `await` must not get an uncaught error.
  async createSession() {
    throw new VoiceProviderError('not_configured', 'No live-voice provider is configured.');
  },
};
