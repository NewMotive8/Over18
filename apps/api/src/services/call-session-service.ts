import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import {
  callSessions,
  callTranscriptTurns,
  characterPersonas,
  characters,
  conversations,
  messages,
  type CallSessionRow,
} from '../db/schema.js';
import { getConversationForUser } from './conversation-service.js';
import { toPublicCharacter } from './character-service.js';
import { getActiveVisualIdentity, isAdultAgeBand } from './visual-identity-service.js';
import { buildCharacterSystemPrompt, selectMemoriesForPrompt } from './prompt-builder.js';
import { listMemories } from './memory-service.js';
import type { CommerceEnv } from '../env.js';
import { canStartCall } from './paid-call-service.js';
import { resolveVoice } from '../voice/voice-catalogue.js';
import { VoiceProviderError, type VoiceSessionProvider } from '../voice/types.js';

/**
 * Live voice-call sessions -- Phase 1: lifecycle only.
 *
 * ── WHAT THIS PHASE DOES AND DOES NOT DO ─────────────────────────────────────
 *
 * `startCall` CLAIMS a call and stops there. It creates no provider session,
 * because nothing could use one: the provider's URL and client secret are
 * credentials with a sixty-second life, and a browser that has not yet opened
 * its socket cannot be given them. So the provider session is created by the
 * relay, at the moment a socket connects -- see `beginConnect` and
 * `activateConnected` below.
 *
 * THAT ORDERING IS WHY THERE ARE NO ORPHANS ANY MORE. Phase 1 created the
 * provider session at POST time and then threw the credentials away, so every
 * successful start left a paid session upstream that nothing would ever use or
 * close. Creating it only when somebody is on the other end removes that
 * entire class of problem rather than mitigating it.
 *
 * It still does NOT persist transcripts or charge anything, and the whole path
 * is held shut by `env.voiceCalls.enabled`, which is off unless explicitly
 * switched on.
 *
 * ── THE ROW IS WRITTEN BEFORE THE PROVIDER IS CALLED ─────────────────────────
 *
 * Deliberately, and in that order. Creating the provider session first and
 * recording it afterwards leaves a window in which a paid session exists with
 * no local trace -- and if the write then fails, nothing will ever end it. So a
 * `pending` row is claimed first, under the unique index that allows only one
 * live session per conversation, and only then is the provider called. A
 * failure marks that row `failed`; it never stays `pending`.
 *
 * ── NOTHING FROM THE CLIENT DECIDES ANYTHING ─────────────────────────────────
 *
 * Persona, character, voice, model, duration and the provider's own identifier
 * are all resolved on the server from the conversation. The request body is
 * empty by design: there is no field a caller could use to steer this.
 */

/**
 * How long a `pending` row may live.
 *
 * A pending row exists only while the provider request is in flight, and that
 * request is bounded by `VOICE_SESSION_TIMEOUT_MS` (10s by default). Judging it
 * against the ACTIVE ceiling -- 780 seconds -- would lock a conversation out of
 * calling for thirteen minutes because of an operation that cannot legally take
 * more than ten seconds.
 *
 * Sixty seconds is deliberate slack over that bound: enough that a slow network
 * or a paused process is not mistaken for a dead one, short enough that a
 * customer who tried once and hit a database fault can try again within a
 * minute rather than a quarter of an hour.
 */
export const PENDING_DEADLINE_SECONDS = 60;

/** Ended states. A session in one of these is finished and cannot reopen. */
const TERMINAL: ReadonlySet<CallSessionRow['status']> = new Set(['ended', 'failed', 'expired']);

/** Live states. At most one of these may exist per conversation. */
const LIVE: ReadonlySet<CallSessionRow['status']> = new Set(['pending', 'active']);

/**
 * Which unique index a failed insert violated.
 *
 * Read from the driver's own `constraint` field rather than by matching on the
 * message text, which is localised and version-dependent. Anything unrecognised
 * returns null and is treated as an unknown failure rather than guessed at.
 */
export function violatedConstraint(error: unknown): string | null {
  // Drizzle wraps the driver's error, so `constraint` sits on `.cause` rather
  // than on the error itself. Verified against the real error: the outer object
  // carries { query, params, cause } and the pg error underneath carries
  // { code, constraint, table, ... }. The chain is walked rather than assuming
  // a depth, so another wrapping layer would not silently break this.
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth += 1) {
    const name = (current as { constraint?: unknown }).constraint;
    if (typeof name === 'string' && name.length > 0) return name;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/**
 * The code recorded on a session whose provider call failed.
 *
 * THE DISTINCTION THAT MATTERS IS WHETHER AN ORPHAN MAY EXIST. A refusal --
 * bad credential, rejected request -- certainly created nothing upstream. A
 * timeout or a dropped connection may mean the provider DID create a session
 * that we never heard about, and whose id we therefore do not hold.
 *
 * Those two cases are recorded differently so a later reconciliation pass can
 * find the ambiguous ones without re-deriving the rule. `orphan_risk_` is the
 * marker; it is not a claim that an orphan exists, only that one cannot be
 * ruled out.
 */
export function terminationReasonFor(error: unknown): string {
  if (error instanceof VoiceProviderError) {
    return error.definitelyCreatedNothing ? `provider_${error.kind}` : `orphan_risk_${error.kind}`;
  }
  // An unexpected error is ambiguous by definition: we do not know how far it
  // got, so it is treated as possibly having left something behind.
  return 'orphan_risk_unexpected';
}

export type StartCallFailure =
  /** The conversation is not the caller's, or does not exist. Answer 404. */
  | { ok: false; reason: 'not_found' }
  /** Calls are switched off, or no provider is configured. */
  | { ok: false; reason: 'unavailable' }
  /** This conversation already has a live session. */
  | { ok: false; reason: 'already_active'; callSessionId: string }
  /** This person is already on a call, in some other conversation. */
  | { ok: false; reason: 'user_busy' }
  /** The provider refused or could not be reached. */
  | { ok: false; reason: 'provider_error'; kind: string }
  /**
   * The caller cannot pay for the first minute, or nothing prices a call.
   * Decided BEFORE a row is claimed, so a refused start leaves no trace and
   * nothing for the caller to resume. `creditsRequired` is null when the
   * refusal was a missing price rather than an empty wallet.
   */
  | { ok: false; reason: 'insufficient_credits' | 'not_priced'; creditsRequired: number | null };

export type StartCallResult =
  | {
      ok: true;
      /**
       * The claimed record, `pending`. It becomes `active` only once a relay
       * has a live provider socket -- see `activateConnected`.
       */
      session: PublicCallSession;
    }
  | StartCallFailure;

/** What a client may see. No URL, no secret, no persona, no key. */
export interface PublicCallSession {
  id: string;
  status: CallSessionRow['status'];
  voice: string;
  maxSeconds: number;
  startedAt: string | null;
  endedAt: string | null;
  durationSeconds: number | null;
  terminationReason: string | null;
}

export function toPublicCallSession(row: CallSessionRow): PublicCallSession {
  return {
    id: row.id,
    status: row.status,
    voice: row.voice,
    maxSeconds: row.maxSeconds,
    startedAt: row.startedAt?.toISOString() ?? null,
    endedAt: row.endedAt?.toISOString() ?? null,
    durationSeconds: row.durationSeconds,
    terminationReason: row.terminationReason,
  };
}

/** Whole seconds between two instants, floored at zero. */
function secondsBetween(from: Date, to: Date): number {
  return Math.max(0, Math.round((to.getTime() - from.getTime()) / 1000));
}

/**
 * True when a live session has outlived the ceiling it was created under.
 *
 * Phase 1 has no relay watching the socket, so nothing else would ever notice.
 * A `pending` row is judged from `created_at`, because it has no start.
 */
export function isOverdue(row: CallSessionRow, now: Date): boolean {
  if (!LIVE.has(row.status)) return false;
  // Two different clocks for two different things. A pending row is timing a
  // network request; an active row is timing a conversation.
  if (row.status === 'pending') {
    return secondsBetween(row.createdAt, now) > PENDING_DEADLINE_SECONDS;
  }
  return secondsBetween(row.startedAt ?? row.createdAt, now) > row.maxSeconds;
}

/**
 * Settles a session that ran past its deadline.
 *
 * Called on every read and before every start, so an abandoned call cannot keep
 * a conversation locked out. This is the Phase 1 stand-in for the relay
 * observing a closed socket -- narrower, but it guarantees the one property
 * that matters: no row stays live for ever.
 */
export async function expireIfOverdue(
  db: Db,
  row: CallSessionRow,
  now = new Date(),
): Promise<CallSessionRow | null> {
  if (!isOverdue(row, now)) return row;
  const [updated] = await db
    .update(callSessions)
    .set({
      status: 'expired',
      endedAt: now,
      durationSeconds: secondsBetween(row.startedAt ?? row.createdAt, now),
      terminationReason: 'expired',
      updatedAt: now,
    })
    .where(and(eq(callSessions.id, row.id), sql`${callSessions.status} in ('pending', 'active')`))
    .returning();
  if (updated) return updated;

  /**
   * THE UPDATE MATCHED NOTHING, so somebody settled this session between the
   * read that produced `row` and this write -- an end, or another sweep.
   *
   * Returning `row` would report the state as it was BEFORE that happened: a
   * caller would be told the call is still active moments after it ended. The
   * row in hand is provably stale the instant the update misses, so it is
   * re-read rather than reported. `endCall` already resolves the identical
   * race this way.
   *
   * Null when the row is genuinely gone -- a cascade from a deleted user, say.
   * There is no truthful row to return in that case, and inventing one would
   * be worse than saying so.
   */
  const [current] = await db.select().from(callSessions).where(eq(callSessions.id, row.id)).limit(1);
  return current ?? null;
}

/** One session by id, restricted to its owner. Null reads as 404 upstream. */
export async function getCallSessionForUser(
  db: Db,
  userId: string,
  callSessionId: string,
): Promise<CallSessionRow | null> {
  const [row] = await db
    .select()
    .from(callSessions)
    .where(and(eq(callSessions.id, callSessionId), eq(callSessions.userId, userId)))
    .limit(1);
  if (!row) return null;
  return expireIfOverdue(db, row);
}

/** The live session for a conversation, if one survives the overdue check. */
export async function getLiveSessionForConversation(
  db: Db,
  conversationId: string,
): Promise<CallSessionRow | null> {
  const [row] = await db
    .select()
    .from(callSessions)
    .where(
      and(eq(callSessions.conversationId, conversationId), sql`${callSessions.status} in ('pending', 'active')`),
    )
    .limit(1);
  if (!row) return null;
  const settled = await expireIfOverdue(db, row);
  // Gone, or no longer live: either way there is no live session here.
  if (!settled) return null;
  return LIVE.has(settled.status) ? settled : null;
}

export interface StartCallDeps {
  provider: VoiceSessionProvider;
  enabled: boolean;
  maxSeconds: number;
  /** Whether a call costs Credits. Off means calls are not a paid action. */
  commerce: Pick<CommerceEnv, 'enabled'>;
}

/**
 * Starts a call for a conversation the caller owns.
 *
 * Ordering is the whole design: gate, ownership, claim the row, then the
 * network. Every failure after the claim marks that row `failed`, so a refused
 * provider can never leave a conversation believing it is mid-call.
 */
export async function startCall(
  db: Db,
  userId: string,
  conversationId: string,
  deps: StartCallDeps,
): Promise<StartCallResult> {
  // 1. The gate, before anything is read or written. Fails closed.
  if (!deps.enabled) return { ok: false, reason: 'unavailable' };

  // 2. Ownership. Unknown and foreign are the same answer, as everywhere else.
  const conversation = await getConversationForUser(db, userId, conversationId);
  if (!conversation) return { ok: false, reason: 'not_found' };

  // 3. An existing live session wins; a second is never started.
  const existing = await getLiveSessionForConversation(db, conversationId);
  if (existing) return { ok: false, reason: 'already_active', callSessionId: existing.id };

  /**
   * 3a. CAN THEY PAY FOR THE FIRST MINUTE? Asked here, before a row exists.
   *
   * The authoritative reservation still happens in the call socket and still
   * fails closed; this only moves the ANSWER earlier, so somebody with no
   * Credits is told so instead of watching a call claim a session, open a
   * socket and die with "the call ended unexpectedly". Nothing failed in that
   * story -- they just could not pay, and that was knowable up front.
   *
   * Placed after ownership so it cannot be used to probe another person's
   * conversations, and before the character read and the claim so a refusal
   * costs a wallet read and writes nothing at all.
   */
  const affordable = await canStartCall(db, deps.commerce, userId);
  if (!affordable.ok) {
    return { ok: false, reason: affordable.reason, creditsRequired: affordable.creditsRequired };
  }

  // 4. Everything the provider is told is resolved here, from the server.
  const [characterRow] = await db
    .select()
    .from(characters)
    .where(eq(characters.id, conversation.character.id))
    .limit(1);
  if (!characterRow) return { ok: false, reason: 'not_found' };

  const voice = resolveVoice(characterRow.liveCallVoice);

  // 5. Claim the row FIRST. The unique index is what makes two simultaneous
  //    starts resolve to one: the loser's insert violates it and is told a
  //    session is already active.
  let claimed: CallSessionRow;
  try {
    const [row] = await db
      .insert(callSessions)
      .values({
        userId,
        conversationId,
        characterId: characterRow.id,
        provider: deps.provider.name,
        voice,
        status: 'pending',
        maxSeconds: deps.maxSeconds,
      })
      .returning();
    claimed = row!;
  } catch (error) {
    /**
     * TWO INDEXES CAN REFUSE THIS INSERT, and they mean different things: this
     * conversation is already on a call, or this person is. The driver names
     * the one that fired, which is read directly rather than inferred from a
     * follow-up query that could race again.
     */
    const constraint = violatedConstraint(error);
    if (constraint === 'call_sessions_user_live_idx') {
      return { ok: false, reason: 'user_busy' };
    }
    if (constraint === 'call_sessions_live_idx') {
      const live = await getLiveSessionForConversation(db, conversationId);
      return live
        ? { ok: false, reason: 'already_active', callSessionId: live.id }
        : { ok: false, reason: 'provider_error', kind: 'claim_failed' };
    }
    // An unnamed failure is not assumed to be a conflict. Fall back to a read,
    // and if nothing is live, report it as what it is: a failure to claim.
    const live = await getLiveSessionForConversation(db, conversationId);
    return live
      ? { ok: false, reason: 'already_active', callSessionId: live.id }
      : { ok: false, reason: 'provider_error', kind: 'claim_failed' };
  }

  // 6. That is all. No provider session exists yet, and none should: nothing
  //    can hold its credentials until a socket is open. The relay creates it.
  return { ok: true, session: toPublicCallSession(claimed) };
}

/* ------------------------------------------------------------------ *
 * The relay's half of the lifecycle
 * ------------------------------------------------------------------ */

export type BeginConnectOutcome =
  /** This socket won the claim and must now create the provider session. */
  | { status: 'claimed'; row: CallSessionRow }
  /** Not the caller's, or gone. Reads as 404 upstream. */
  | { status: 'not_found' }
  /** Another socket is already connecting, or the call is no longer pending. */
  | { status: 'unavailable'; reason: 'already_connecting' | 'not_pending' };

/**
 * Claims the right to establish the provider connection for a call.
 *
 * ONE SOCKET, ONE PROVIDER SESSION. Two browser tabs can open a socket for the
 * same call session at the same moment, and without this both would create a
 * provider session -- two paid sessions for one call, one of them untracked.
 * The conditional update lets exactly one win: it matches only while the row is
 * `pending` AND unclaimed, so the loser's update touches nothing.
 *
 * The row stays `pending` throughout, which matters: `pending` is inside the
 * two partial unique indexes, so a connecting call still blocks a second call
 * from being started for the same conversation or the same person.
 */
export async function beginConnect(
  db: Db,
  userId: string,
  callSessionId: string,
  now = new Date(),
): Promise<BeginConnectOutcome> {
  const existing = await getCallSessionForUser(db, userId, callSessionId);
  if (!existing) return { status: 'not_found' };
  if (existing.status !== 'pending') return { status: 'unavailable', reason: 'not_pending' };

  const [claimed] = await db
    .update(callSessions)
    .set({ connectClaimedAt: now, updatedAt: now })
    .where(
      and(
        eq(callSessions.id, callSessionId),
        eq(callSessions.status, 'pending'),
        isNull(callSessions.connectClaimedAt),
      ),
    )
    .returning();

  if (!claimed) return { status: 'unavailable', reason: 'already_connecting' };
  return { status: 'claimed', row: claimed };
}

/**
 * Everything the provider is told, compiled from the server's own records.
 *
 * LIVES HERE, NOT IN THE RELAY. The persona is internal prompt material; the
 * fewer places that hold it the better, and this is already the module that
 * owns what a call knows about its character. The relay receives the finished
 * string, hands it to the adapter, and never stores or logs it.
 *
 * Null when the character has vanished underneath the call -- the caller must
 * treat that as a failure rather than calling the provider with an empty
 * persona.
 */
export async function buildProviderSessionRequest(
  db: Db,
  row: CallSessionRow,
): Promise<{ instructions: string; voice: string; userRef: string } | null> {
  const [characterRow] = await db
    .select()
    .from(characters)
    .where(eq(characters.id, row.characterId))
    .limit(1);
  if (!characterRow) return null;

  const [personaRow] = await db
    .select({ persona: characterPersonas.persona })
    .from(characterPersonas)
    .where(eq(characterPersonas.characterId, characterRow.id))
    .limit(1);

  /**
   * ONE MEMORY, BOTH CHANNELS. What someone told her in text, she knows on the
   * phone -- and the reverse, once calls start contributing facts of their own.
   * `memories` is scoped to (user, character) rather than to a conversation, so
   * this needed no new table and no migration: the voice path was simply passing
   * an empty list where the text path passes the real one.
   *
   * SCOPED FROM THE ROW, NEVER FROM THE CLIENT. `row` is the call session the
   * server itself claimed in `beginConnect`, after ownership was checked. The
   * browser supplies a call session id and nothing else, so it cannot ask for
   * another person's memories or another character's by any route.
   *
   * BOUNDED EXACTLY AS TEXT BOUNDS IT. `createPromptBuilder` applies
   * `selectMemoriesForPrompt` before rendering, and this path does not go
   * through it, so the same selection is applied here on purpose. Without it a
   * long-standing user's hundred stored facts would all be rendered into a field
   * the provider truncates at eight thousand characters -- which would silently
   * cut the persona's closing lines to make room for trivia.
   */
  const rememberedFacts = await listMemories(db, row.userId, row.characterId);

  /**
   * Her apparent age, if the record actually establishes one.
   *
   * THE SOURCE IS THE ACTIVE VISUAL IDENTITY, not the profile page's number --
   * that number is invented in the browser. `apparentAgeBand` is the stored
   * free-text band, and `isAdultAgeBand` is the same conservative check that
   * guards it on the way in: minor terms reject, any number below eighteen
   * rejects before "adult" can accept it, and anything ambiguous rejects.
   *
   * FAILS CLOSED, DELIBERATELY. A missing identity, a missing band, an invalid
   * one, or a contradictory one like "adult (17)" all produce nothing, and the
   * prompt simply says nothing about her age. This does not assert adulthood on
   * a character whose record does not establish it, and it is not an attempt to
   * influence anybody's moderation decision -- it states a fact we hold and were
   * dropping.
   */
  const identity = await getActiveVisualIdentity(db, row.characterId);
  const band = identity?.visualDna?.apparentAgeBand;
  const verifiedAdultAgeBand =
    typeof band === 'string' && isAdultAgeBand(band) ? band.trim() : null;

  /**
   * HOW WELL THESE TWO ALREADY KNOW EACH OTHER, which decides her stage.
   *
   * This was hardcoded to 0, so `conversationStage` returned `new` on every call
   * a customer ever made. On the text layer that meant "stay light and brief,
   * answer what he actually said and leave it there" — the most reactive rule in
   * the prompt, permanently in force, no matter how long they had known each
   * other. A caller who had exchanged three hundred messages with her was
   * greeted by someone behaving as though they had just met.
   *
   * Counted across ALL their conversations, because the relationship is with the
   * character and not with one thread — the same scope `memories` already uses.
   *
   * IT CANNOT ADVANCE MID-CALL, and nothing here pretends otherwise: the
   * instructions are sent once at session creation and the provider accepts only
   * `turn_detection` on a session update. The voice layer covers the rest in
   * words ("a call warms up as it runs"). Turns taken during the call are
   * recorded as transcript rows and will count towards the NEXT call.
   */
  const [priorMessages] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(and(eq(conversations.userId, row.userId), eq(conversations.characterId, row.characterId)));

  return {
    instructions: buildCharacterSystemPrompt({
      character: toPublicCharacter(characterRow, null),
      systemPrompt: characterRow.systemPrompt,
      persona: personaRow?.persona ?? null,
      history: [],
      // A call is a conversation, not a message exchange: the behaviour layer
      // branches on this and nothing else does.
      channel: 'voice',
      priorMessageCount: priorMessages?.count ?? 0,
      userMessage: '',
      memories: selectMemoriesForPrompt(rememberedFacts),
      verifiedAdultAgeBand,
    }),
    // The voice resolved when the call was claimed, so a change to the
    // character mid-call cannot swap her voice underneath the caller.
    voice: row.voice,
    // The call session's own id: opaque, rotates per call, and tells the
    // provider nothing about the person. Never the raw user id.
    userRef: row.id,
  };
}

/**
 * Records the provider handle as soon as it exists, before anything else.
 *
 * Separated from activation so that a crash between the two leaves a row that
 * still identifies the upstream session. The reverse order leaves an orphan
 * nobody can name.
 */
export async function recordProviderSession(
  db: Db,
  callSessionId: string,
  providerSessionId: string,
): Promise<void> {
  await db
    .update(callSessions)
    .set({ providerSessionId, updatedAt: new Date() })
    .where(eq(callSessions.id, callSessionId));
}

/** Who said a transcript turn, in the schema's own vocabulary. */
export type TranscriptSpeaker = 'user' | 'character';

/**
 * The most text one spoken turn may contribute to the record.
 *
 * DERIVED FROM WHAT SPEECH ACTUALLY IS, not picked for roundness. Speech runs
 * around 150 words a minute, so roughly thirteen characters a second: the
 * provider's entire 780-second ceiling is about ten thousand characters, shared
 * between both speakers across many turns. Four thousand is therefore five
 * straight minutes of one person talking without a break -- possible in
 * principle, effectively absent in practice.
 *
 * It sits between the two limits already in this codebase for related things: a
 * remembered fact is capped at 300 characters, a whole compiled persona at
 * 8,000. A conversational turn belongs between them.
 */
export const TRANSCRIPT_MAX_CHARS = 4_000;

/**
 * Trims a turn to the limit without cutting a word in half.
 *
 * TRUNCATED, NEVER REJECTED. Refusing an over-long turn would leave a silent
 * hole in the conversation, and the next step extracts memories from this
 * record -- a transcript where somebody appears not to have spoken is worse than
 * one where they said slightly less than they did. The beginning of a turn is
 * also where its meaning is, so what survives is the useful part.
 *
 * The word boundary is only honoured if it keeps most of the budget, exactly as
 * `truncateInstructions` does for the persona: a turn with no spaces in four
 * thousand characters is not prose, and chopping it at the last space would
 * throw away nearly all of it.
 */
export function boundTranscript(content: string): { content: string; truncated: boolean } {
  const text = content.trim();
  if (text.length <= TRANSCRIPT_MAX_CHARS) return { content: text, truncated: false };
  const slice = text.slice(0, TRANSCRIPT_MAX_CHARS);
  const lastSpace = slice.lastIndexOf(' ');
  const cut = lastSpace > TRANSCRIPT_MAX_CHARS * 0.5 ? slice.slice(0, lastSpace) : slice;
  return { content: cut.trimEnd(), truncated: true };
}

/** What a write did, in terms the caller can safely log. */
export interface TranscriptWriteOutcome {
  /** False only when there was nothing left to store after trimming. */
  stored: boolean;
  /** True when the turn was longer than the limit and was cut. */
  truncated: boolean;
  /** The persisted length. A number, so it can be logged without the content. */
  length: number;
}

/**
 * Writes one finished transcript turn, idempotently.
 *
 * THE ID COMES FROM THE CALLER, AND THAT IS WHAT MAKES A RETRY SAFE. An insert
 * can fail after the row has already committed -- a connection dropped while the
 * acknowledgement was in flight looks identical to a connection dropped before
 * the write. Retrying a server-generated id would duplicate the turn in exactly
 * that case. With the caller holding one id for all attempts, the second attempt
 * conflicts on the primary key and does nothing, so "insert once" holds however
 * many times this is called.
 *
 * SCOPED BY THE CALL SESSION ALONE. The row carries no user or character id --
 * both are reachable through `call_sessions` -- so there is nothing here for a
 * client-supplied identifier to influence. The caller passes the id of the
 * session the server itself claimed.
 *
 * `seq` is assigned by the database, so the order of these calls IS the order of
 * the transcript. That is why the relay serialises them rather than firing them
 * off in parallel: two concurrent inserts would take their sequence numbers in
 * whatever order they reached the server, which is not necessarily the order the
 * words were spoken.
 *
 * Empty content is refused here as well as at the call site. A turn with nothing
 * in it is not a turn, and a provider that sends one should not be able to put a
 * blank row between two real ones.
 */
export async function recordTranscriptTurn(
  db: Db,
  turn: {
    /** Stable across every retry of this turn. See the note above. */
    id: string;
    callSessionId: string;
    speaker: TranscriptSpeaker;
    content: string;
  },
): Promise<TranscriptWriteOutcome> {
  const { content, truncated } = boundTranscript(turn.content);
  if (content.length === 0) return { stored: false, truncated, length: 0 };

  await db
    .insert(callTranscriptTurns)
    .values({
      id: turn.id,
      callSessionId: turn.callSessionId,
      speaker: turn.speaker,
      content,
    })
    .onConflictDoNothing({ target: callTranscriptTurns.id });

  return { stored: true, truncated, length: content.length };
}

/**
 * Marks the call `active` -- and ONLY once the upstream socket is open.
 *
 * Returns null when the row is no longer `pending`, which means it was ended or
 * swept while the connection was being made. The caller must then tear the
 * upstream socket down rather than report a live call.
 */
export async function activateConnected(
  db: Db,
  callSessionId: string,
  maxSeconds: number,
  now = new Date(),
): Promise<CallSessionRow | null> {
  const [activated] = await db
    .update(callSessions)
    .set({ status: 'active', maxSeconds, startedAt: now, updatedAt: now })
    .where(and(eq(callSessions.id, callSessionId), eq(callSessions.status, 'pending')))
    .returning();
  return activated ?? null;
}

/** How a live call finished. Each is a distinct fact, not a shade of failure. */
export type SettleStatus = 'ended' | 'failed' | 'expired';

/**
 * Settles a live call with the state that actually describes what happened.
 *
 * THE DISTINCTION IS NOT COSMETIC. A call that ran its full thirteen minutes
 * and a call whose provider refused to connect are different events, and
 * recording both as `failed` would make the table useless for the very
 * questions it exists to answer -- how many calls completed, how many broke.
 * A browser hanging up after a good conversation is `ended`; reaching the
 * ceiling is `expired`; never getting connected is `failed`.
 *
 * Guarded like every other settle: only a live row moves, so a session already
 * ended by its owner is not overwritten, and a failure to write is swallowed so
 * it cannot throw over the reason the call is ending.
 */
export async function settleCall(
  db: Db,
  callSessionId: string,
  status: SettleStatus,
  reason: string,
): Promise<CallSessionRow | null> {
  try {
    const [row] = await db
      .select()
      .from(callSessions)
      .where(eq(callSessions.id, callSessionId))
      .limit(1);
    if (!row) return null;
    const now = new Date();
    /**
     * RETURNS THE SETTLED ROW, so a caller can tell a settled call from one the
     * database refused. The relay needs that distinction: memory extraction must
     * run for a call that genuinely finished and must NOT run for one whose
     * settlement failed, and `void` made those two outcomes indistinguishable.
     *
     * Null when the write failed or matched nothing -- the row was already
     * settled by somebody else, or the deadline sweep got there first.
     */
    const [settled] = await db
      .update(callSessions)
      .set({
        status,
        endedAt: now,
        durationSeconds: secondsBetween(row.startedAt ?? row.createdAt, now),
        terminationReason: reason,
        updatedAt: now,
      })
      .where(and(eq(callSessions.id, callSessionId), sql`${callSessions.status} in ('pending', 'active')`))
      .returning();
    return settled ?? null;
  } catch {
    // Left live on purpose; the deadline sweep settles it.
    return null;
  }
}

/**
 * Settles a call that never got connected.
 *
 * Kept as its own name because "failed to connect" is the common case and
 * reads better at the call site than `settleCall(db, id, 'failed', ...)`.
 */
export async function failConnect(db: Db, callSessionId: string, reason: string): Promise<void> {
  await settleFailed(db, callSessionId, reason);
}

/**
 * Marks a claimed row `failed`, swallowing any failure to do so.
 *
 * SWALLOWED DELIBERATELY, AND ONLY HERE. This runs on the error path, where the
 * caller already has a reason for the failure that is more useful than
 * "and then the database was also unreachable". An unguarded write here would
 * throw a second error over the first and lose it -- which is exactly the bug
 * this replaces.
 *
 * When it does fail, the row stays `pending` and is settled by the pending
 * deadline instead. That is why PENDING_DEADLINE_SECONDS exists.
 */
async function settleFailed(db: Db, callSessionId: string, reason: string): Promise<void> {
  try {
    const now = new Date();
    await db
      .update(callSessions)
      .set({
        status: 'failed',
        endedAt: now,
        durationSeconds: 0,
        terminationReason: reason,
        updatedAt: now,
      })
      .where(and(eq(callSessions.id, callSessionId), sql`${callSessions.status} in ('pending', 'active')`));
  } catch {
    // Left pending on purpose; the deadline sweep will settle it.
  }
}

export type EndCallOutcome =
  | { status: 'ended'; session: PublicCallSession }
  /** Already finished. Idempotent: the same answer however often it is asked. */
  | { status: 'already_ended'; session: PublicCallSession }
  | { status: 'not_found' };

/**
 * Ends a session the caller owns.
 *
 * IDEMPOTENT. Ending an already-ended session is not an error: a browser that
 * loses its response and retries, and a user who presses End twice, must both
 * see the same settled session rather than a failure.
 *
 * ⚠️ PHASE BOUNDARY. This ends the APPLICATION's record only. The provider's
 * WebSocket is closed by the relay in Phase 2; SpicyAPI documents no
 * server-side termination call, so a session left open at the provider ends by
 * reaching `max_seconds`. Until Phase 2 exists, no socket is ever opened, so
 * there is nothing to leak.
 */
export async function endCall(
  db: Db,
  userId: string,
  callSessionId: string,
  reason = 'user_ended',
): Promise<EndCallOutcome> {
  const row = await getCallSessionForUser(db, userId, callSessionId);
  if (!row) return { status: 'not_found' };
  if (TERMINAL.has(row.status)) return { status: 'already_ended', session: toPublicCallSession(row) };

  const now = new Date();
  const [ended] = await db
    .update(callSessions)
    .set({
      status: 'ended',
      endedAt: now,
      durationSeconds: secondsBetween(row.startedAt ?? row.createdAt, now),
      terminationReason: reason,
      updatedAt: now,
    })
    .where(and(eq(callSessions.id, row.id), sql`${callSessions.status} in ('pending', 'active')`))
    .returning();

  // Lost a race with another ender: re-read and report it settled.
  if (!ended) {
    const settled = await getCallSessionForUser(db, userId, callSessionId);
    return settled
      ? { status: 'already_ended', session: toPublicCallSession(settled) }
      : { status: 'not_found' };
  }
  return { status: 'ended', session: toPublicCallSession(ended) };
}
