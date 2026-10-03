import { and, asc, desc, eq, isNull, or, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { callSessions, callTranscriptTurns, characters } from '../db/schema.js';
import { toPublicCharacter } from './character-service.js';
import { DEFAULT_MEMORY_MAX_STORED, storeMemories } from './memory-service.js';
import { noopMemoryExtractor, type MemoryExtractor, type TranscriptTurn } from './memory-extractor.js';
import { describeError } from '../voice/relay-protocol.js';

/**
 * Turning a finished call into remembered facts (shared voice/text memory).
 *
 * ── ONE MEMORY, NOT A VOICE MEMORY ───────────────────────────────────────────
 *
 * Nothing here stores anything new. Facts go into the SAME `memories` table the
 * text chat has always written to, under the same (user, character) scope, with
 * the same normalisation, the same unique-index deduplication and the same
 * hundred-row cap. That is what makes a call discussable in a later text chat:
 * there is only one place a character's memory of someone lives, and both
 * channels read it through `listMemories`.
 *
 * Because the facts live there and not beside the transcript, they also outlive
 * it. `memories` has no foreign key to `call_sessions` or
 * `call_transcript_turns`, so deleting transcripts later -- whenever retention
 * stops being "indefinite" -- cannot take the memories with them.
 *
 * ── WHAT COUNTS AS DONE ──────────────────────────────────────────────────────
 *
 * `call_sessions.memories_extracted_at` is set LAST, after the facts are stored.
 * Every failure before that point therefore leaves it null, which is the record
 * that this call is still owed its extraction. See the column's own note.
 */

/** Why extraction did nothing, when it did nothing. All of these are normal. */
export type CallMemorySkip =
  /** The call has already been extracted. The common case for a repeat. */
  | 'already_extracted'
  /** Gone, or in a state this does not extract from. See ELIGIBLE_STATUSES. */
  | 'not_eligible'
  /** Connected, but nobody said anything worth reading. */
  | 'empty_transcript'
  /** Somebody else is extracting it right now. Theirs to finish. */
  | 'already_claimed';

export type CallMemoryOutcome =
  /**
   * `firstToComplete` is false when the completion marker was already set by
   * somebody else -- the facts are stored either way, but this attempt lost.
   */
  | { status: 'extracted'; facts: number; firstToComplete: boolean }
  | { status: 'skipped'; reason: CallMemorySkip }
  | { status: 'failed' };

/**
 * The call states a transcript is extracted from.
 *
 * `ended` is a conversation somebody hung up on; `expired` is one that ran to the
 * provider's ceiling. Both are real conversations and both are worth remembering.
 *
 * `failed` is NOT extracted, and that is a deliberate choice rather than an
 * oversight: a failed call either never connected or broke while connecting, so
 * either there is no transcript at all or there is a fragment of one whose
 * completeness we cannot vouch for. A `pending` or `active` row is not finished
 * and is not read.
 *
 * NOTE on `expired`: the overdue sweep can also mark a row `expired` long after
 * the relay has gone, and when it does, nothing in this process is listening. Such
 * a call stays eligible -- `memories_extracted_at` is null -- and is simply never
 * picked up, because there is no sweeper for extraction. That limitation is
 * documented rather than hidden, and the column is what makes fixing it a query.
 */
export const ELIGIBLE_STATUSES = ['ended', 'expired'] as const;

export interface CallMemoryDeps {
  extractor: MemoryExtractor;
  maxStored: number;
  /** Receives a failure that has already been logged safely. Tests use it. */
  onError?: (error: unknown) => void;
}

export const DEFAULT_CALL_MEMORY_DEPS: CallMemoryDeps = {
  extractor: noopMemoryExtractor,
  maxStored: DEFAULT_MEMORY_MAX_STORED,
};

/** The turns of one call, in the order they were spoken. */
export async function listTranscriptTurns(
  db: Db,
  callSessionId: string,
): Promise<TranscriptTurn[]> {
  const rows = await db
    .select({ speaker: callTranscriptTurns.speaker, content: callTranscriptTurns.content })
    .from(callTranscriptTurns)
    .where(eq(callTranscriptTurns.callSessionId, callSessionId))
    // `seq` and not `created_at`: turns written inside one moment share a
    // timestamp, and the sequence is what actually orders a conversation.
    .orderBy(asc(callTranscriptTurns.seq));
  return rows;
}

/**
 * Marks the call as extracted, only if it was not already.
 *
 * Conditional on `IS NULL` so that two attempts cannot both claim to have done
 * the work -- the same "let the database decide" rule `connect_claimed_at` uses
 * for sockets. Returns false when somebody else got there first.
 */
/**
 * How long a claim is honoured before it is treated as abandoned.
 *
 * Extraction is one short inference and a couple of writes -- seconds. Fifteen
 * minutes is far longer than it can legitimately take, which is the point: the
 * lease exists to be generous enough that it never expires under a slow but
 * living process, and short enough that a call orphaned by a crash becomes
 * workable again the same afternoon rather than never.
 */
export const EXTRACTION_CLAIM_STALE_SECONDS = 900;

/** A claim is free if nobody holds it, or whoever did has gone quiet. */
const claimIsFree = () =>
  or(
    isNull(callSessions.memoriesExtractionClaimedAt),
    sql`${callSessions.memoriesExtractionClaimedAt} < now() - make_interval(secs => ${EXTRACTION_CLAIM_STALE_SECONDS})`,
  );

/**
 * Takes the extraction lease for one call, atomically.
 *
 * ONE STATEMENT, AND THE RESULT IS CHECKED. The database decides the race: the
 * conditional update matches for exactly one caller, and everybody else gets no
 * row back and leaves the work alone. The previous version read the row, decided,
 * and then worked -- three awaits during which a second caller could make the
 * same decision and buy the same inference.
 *
 * Null also when the call has meanwhile been extracted, since the completion
 * marker is part of the condition.
 *
 * RETURNS THE TIMESTAMP IT WROTE, which is what makes the claim a thing a worker
 * can prove it holds. `releaseClaim` requires it, so a release can only ever undo
 * this particular claim and not whatever claim happens to be on the row.
 */
async function claimForExtraction(db: Db, callSessionId: string): Promise<Date | null> {
  const now = new Date();
  const [claimed] = await db
    .update(callSessions)
    .set({ memoriesExtractionClaimedAt: now, updatedAt: now })
    .where(
      and(
        eq(callSessions.id, callSessionId),
        isNull(callSessions.memoriesExtractedAt),
        claimIsFree(),
      ),
    )
    .returning({ id: callSessions.id });
  return claimed === undefined ? null : now;
}

/**
 * Gives back THIS WORKER'S lease after a failure, so a retry need not wait it out.
 *
 * `claimedAt` IS THE WHOLE POINT, and its absence was a real defect. Matching on
 * the session id alone meant any caller could clear any live claim -- and the
 * catch block could be reached by a failure that happened BEFORE this worker ever
 * claimed anything, so an ordinary database blip would hand somebody else's
 * in-progress extraction away and a third caller would buy the same inference
 * again. Requiring the exact timestamp this worker wrote makes that impossible:
 * a release that is not the holder's matches no rows and does nothing.
 *
 * It also makes the stale case safe. A worker that overran the lease and was
 * replaced no longer matches, so it cannot release its successor's claim.
 *
 * Best effort beyond that: if the write itself fails, the lease simply expires on
 * its own. Never releases a call that has since been completed.
 */
async function releaseClaim(db: Db, callSessionId: string, claimedAt: Date): Promise<void> {
  try {
    await db
      .update(callSessions)
      .set({ memoriesExtractionClaimedAt: null, updatedAt: new Date() })
      .where(
        and(
          eq(callSessions.id, callSessionId),
          isNull(callSessions.memoriesExtractedAt),
          eq(callSessions.memoriesExtractionClaimedAt, claimedAt),
        ),
      );
  } catch {
    /* the lease expires by itself */
  }
}

async function markExtracted(db: Db, callSessionId: string): Promise<boolean> {
  const now = new Date();
  const [updated] = await db
    .update(callSessions)
    .set({ memoriesExtractedAt: now, updatedAt: now })
    .where(and(eq(callSessions.id, callSessionId), isNull(callSessions.memoriesExtractedAt)))
    .returning({ id: callSessions.id });
  return updated !== undefined;
}

/**
 * Reads a finished call's transcript and remembers what the person said.
 *
 * NOTHING HERE TRUSTS A CALLER FOR OWNERSHIP. The user and the character are read
 * from the call-session row, which the server itself claimed; this takes a call
 * session id and nothing else, so there is no parameter through which a client
 * could aim extraction at somebody else's memories.
 *
 * Never throws. A caller on the teardown path has a call to finish and cannot be
 * handed an exception, so a failure is logged, reported through `onError`, and
 * returned as `failed` -- with the row left eligible for another attempt.
 */
export async function extractCallMemories(
  db: Db,
  callSessionId: string,
  deps: CallMemoryDeps = DEFAULT_CALL_MEMORY_DEPS,
  log?: { warn: (obj: unknown, msg: string) => void; error: (obj: unknown, msg: string) => void },
): Promise<CallMemoryOutcome> {
  /** The claim this worker wrote, or null while it holds none. */
  let heldClaim: Date | null = null;
  try {
    const [session] = await db
      .select()
      .from(callSessions)
      .where(eq(callSessions.id, callSessionId))
      .limit(1);
    if (!session) return { status: 'skipped', reason: 'not_eligible' };

    if (session.memoriesExtractedAt !== null) {
      return { status: 'skipped', reason: 'already_extracted' };
    }
    if (!(ELIGIBLE_STATUSES as readonly string[]).includes(session.status)) {
      return { status: 'skipped', reason: 'not_eligible' };
    }

    /**
     * THE LEASE IS TAKEN HERE, BEFORE ANYTHING IS SPENT.
     *
     * The read above is a cheap early exit, not the guard -- two callers can both
     * pass it. This is the guard: one conditional update, one winner, and the
     * loser returns without calling the model. Everything after this point is
     * either cheap or billable, and none of it runs twice concurrently.
     */
    heldClaim = await claimForExtraction(db, callSessionId);
    if (heldClaim === null) {
      return { status: 'skipped', reason: 'already_claimed' };
    }

    const transcript = await listTranscriptTurns(db, callSessionId);
    /**
     * No model call for a call with nothing in it.
     *
     * Marked extracted all the same: there is no work owed here, and leaving it
     * null would keep an empty call forever eligible for an extraction that can
     * only ever produce nothing.
     */
    if (!transcript.some((turn) => turn.speaker === 'user')) {
      await markExtracted(db, callSessionId);
      return { status: 'skipped', reason: 'empty_transcript' };
    }

    const [characterRow] = await db
      .select()
      .from(characters)
      .where(eq(characters.id, session.characterId))
      .limit(1);
    if (!characterRow) {
      // Nothing can be extracted without her, so hand the lease back rather
      // than holding it for fifteen minutes over a call nobody can process.
      await releaseClaim(db, callSessionId, heldClaim);
      return { status: 'skipped', reason: 'not_eligible' };
    }

    const facts = await deps.extractor({
      character: toPublicCharacter(characterRow, null),
      // Empty by contract when a transcript is present; see MemoryExtractionContext.
      userMessage: '',
      transcript,
    });

    if (facts.length > 0) {
      await storeMemories(db, session.userId, session.characterId, facts, deps.maxStored);
    }

    /**
     * LAST, and its result is checked.
     *
     * Everything above can fail and leave the call eligible; once this lands the
     * work is done. False would mean somebody else completed it while we worked,
     * which the lease is supposed to prevent -- so it is reported rather than
     * ignored, as a fact about the race and not an error for the caller.
     */
    const marked = await markExtracted(db, callSessionId);
    return { status: 'extracted', facts: facts.length, firstToComplete: marked };
  } catch (error) {
    /**
     * Two safe lines and not one word of what was said.
     *
     * A transcript is a private conversation and an extracted fact is private
     * information, so neither is logged -- only the call it belongs to. The error
     * goes through `describeError` because a drizzle message is the failing
     * statement and its bound parameters.
     */
    log?.warn(
      { voiceRelay: { callSessionId } },
      'voice memory: extraction failed; call remains eligible',
    );
    log?.error({ voiceRelay: describeError(error) }, 'voice memory: extraction error');
    /**
     * ONLY IF THIS WORKER ACTUALLY HOLDS IT.
       *
     * The try above opens before the first read and before the claim, so this
     * catch is reachable with no claim at all -- a database blip on the initial
     * select, or on the claim statement itself. Releasing then would have
     * cleared whatever claim was live, which is somebody else's.
     *
     * The timestamp predicate inside `releaseClaim` would already refuse that,
     * and this makes the intent local rather than leaving it to be inferred
     * from a WHERE clause in another function.
     */
    if (heldClaim !== null) {
      // Handed back so a retry need not wait out the lease. The completion
      // marker is untouched, so the call is still owed its extraction.
      await releaseClaim(db, callSessionId, heldClaim);
    }
    deps.onError?.(error);
    return { status: 'failed' };
  }
}

/* ------------------------------------------------------------------ *
 * Recovery: the calls that are still owed an extraction
 * ------------------------------------------------------------------ */

/**
 * How many pending calls one trigger will look at.
 *
 * SMALL ON PURPOSE. This runs when somebody starts a call, so it must stay a
 * rounding error against the work that request is already doing. Three is enough
 * to drain a backlog over a few calls while making it impossible for one request
 * to turn into a batch job.
 */
export const RECOVERY_BATCH_LIMIT = 3;

/**
 * Calls belonging to this person and character that finished but were never
 * turned into memories, newest first.
 *
 * ONLY CALLS THAT GENUINELY COMPLETED. `ended` is a conversation somebody hung
 * up on. `expired` is accepted ONLY with `termination_reason = 'max_duration'`,
 * which is the relay recording that the call reached the provider's ceiling --
 * and that is deliberately not the same thing as `termination_reason = 'expired'`,
 * which is the overdue sweep settling a row after the relay had already vanished.
 * A swept row may hold a transcript whose ending was never flushed, so extracting
 * it would be a weaker claim than this mechanism is allowed to make. `failed` is
 * excluded for the same reason it is excluded everywhere else.
 *
 * SCOPED TO ONE PERSON AND ONE CHARACTER, which is both the tightest bound
 * available and the most useful one: these are exactly the memories the call
 * being started is about to read.
 */
export async function findCallsAwaitingExtraction(
  db: Db,
  userId: string,
  characterId: string,
  limit: number = RECOVERY_BATCH_LIMIT,
): Promise<string[]> {
  const rows = await db
    .select({ id: callSessions.id })
    .from(callSessions)
    .where(
      and(
        eq(callSessions.userId, userId),
        eq(callSessions.characterId, characterId),
        isNull(callSessions.memoriesExtractedAt),
        claimIsFree(),
        or(
          eq(callSessions.status, 'ended'),
          and(
            eq(callSessions.status, 'expired'),
            eq(callSessions.terminationReason, 'max_duration'),
          ),
        ),
      ),
    )
    // Newest first: the most recent conversation is the one worth remembering.
    .orderBy(desc(callSessions.endedAt))
    .limit(limit);
  return rows.map((row) => row.id);
}

/**
 * Retries the extractions this person and character are still owed.
 *
 * FIRE AND FORGET, AND THAT IS THE CONTRACT. The caller is a request that is
 * starting a call; it must not wait for an inference, and it must not fail
 * because one failed. Nothing here throws, and the result is a count for tests
 * and logs rather than something a caller acts on.
 *
 * It cannot collide with the live call's own extraction: the selection only
 * matches settled rows, so the call being started -- which is `pending` -- is not
 * a candidate, and the lease settles any genuine overlap with a teardown that is
 * still finishing an earlier call.
 *
 * Sequential on purpose. Three concurrent inferences from one request is exactly
 * the spike this is meant not to cause.
 */
export async function recoverCallMemories(
  db: Db,
  userId: string,
  characterId: string,
  deps: CallMemoryDeps = DEFAULT_CALL_MEMORY_DEPS,
  log?: { warn: (obj: unknown, msg: string) => void; error: (obj: unknown, msg: string) => void },
): Promise<{ attempted: number; extracted: number }> {
  let attempted = 0;
  let extracted = 0;
  try {
    const pending = await findCallsAwaitingExtraction(db, userId, characterId);
    for (const callSessionId of pending) {
      attempted += 1;
      const outcome = await extractCallMemories(db, callSessionId, deps, log);
      if (outcome.status === 'extracted') extracted += 1;
    }
  } catch (error) {
    // The person is starting a call. A failure to tidy up an old one is not
    // their problem, and never reaches them.
    log?.error({ voiceRelay: describeError(error) }, 'voice memory: recovery sweep failed');
  }
  return { attempted, extracted };
}
