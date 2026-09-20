import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import type { CommerceEnv } from '../env.js';
import { paidActions, type PaidActionRow } from '../db/schema.js';
import {
  actionCostFor,
  economyNow,
  lockEconomyRefForRecording,
  loadRuleset,
  resolveRuleset,
  type EconomyInstant,
  type EconomyRef,
  type RulesetSnapshot,
} from './economy-resolver.js';
import {
  CREDITS_CURRENCY,
  captureHold,
  holdCredits,
  refundTransaction,
  releaseHold,
  type WalletOperationResult,
} from './wallet-service.js';

/**
 * THE PAID-ACTION FRAMEWORK (P7.1, PRD §19.2).
 *
 * Hold -> work -> capture, and release or refund when the work does not come
 * off. Every paid action in the product runs through here; none is implemented
 * here.
 *
 * ── WHAT THIS MODULE IS FOR ──────────────────────────────────────────────────
 *
 * A charge is three things that must not drift apart: the PRICE (which economy
 * version said so), the MONEY (Credits reserved before the work, consumed only
 * if it succeeds) and the IDENTITY (one request, one charge, however many times
 * it is retried). Done per action type, each of those is a place to get it
 * wrong differently. Done once, here, every action inherits the same answer.
 *
 * ── FOUR RULES EVERY CALLER INHERITS ─────────────────────────────────────────
 *
 * 1. THE SERVER PRICES IT, AND A CALLER NEVER STATES A PRICE. Ordinarily a
 *    caller says WHAT is being done -- the ruleset's action type, quality tier
 *    and, where it is priced by length, the duration -- and the price comes
 *    from the P1.2 resolver. Some things are priced by a different server
 *    authority: locked photos and videos carry their price on the content
 *    offer, per asset, not in the economy configuration's action costs. Such a
 *    caller passes a RESOLVER, not a number, and this module runs it inside the
 *    charging transaction and pins what it used -- so the guarantee is the same
 *    either way. There is no default, no fallback and no zero: an authority
 *    that does not price something stops it.
 *
 * 2. THE VERSION IS PINNED, NOT REMEMBERED AS A TIME. The exact ruleset row is
 *    locked with `lockEconomyRefForRecording` in the same transaction that
 *    reserves the Credits, and its id is stored on the row. Re-reading a past
 *    charge loads THAT version (`loadRuleset`); it never re-resolves "what was
 *    live then", which a version published a moment later can change.
 *
 * 3. MONEY MOVES ONLY THROUGH P2. Every Credit movement is a wallet-service
 *    operation writing one P2.1 ledger row: hold, capture, release, refund.
 *    This module adds no balance, no second ledger and no arithmetic on either.
 *    `paid_actions` NAMES those rows; it is a record of an operation, not a
 *    store of value, and its `WalletError`s are deliberately left to propagate
 *    -- "not enough Credits" is the wallet's answer to give, not ours to
 *    restate.
 *
 * 4. EXECUTION IS THE CALLER'S. The work itself is a callback this module
 *    invokes between the hold and the settlement. It knows nothing about chat,
 *    media, providers or content, and nothing here decides WHETHER an action is
 *    allowed -- that is entitlement's job, upstream.
 *
 * ── IDEMPOTENCY, ACROSS THE WHOLE OPERATION ──────────────────────────────────
 *
 * The wallet's key is per ledger row; a paid action is several rows around work
 * the wallet cannot see. So the operation has its OWN key, unique per user, and
 * its own row. A replayed request finds that row and returns it, having written
 * nothing and -- this is the point -- having run no work a second time. The
 * wallet keys for the hold, capture, release and refund are derived from the
 * action's id, so a retry of any single step is idempotent in the wallet too.
 *
 * Starting an action takes a transaction-scoped advisory lock on (user, key)
 * before reading, so two concurrent identical requests cannot both start one;
 * settling one takes `for update` on its row. Concurrent requests therefore
 * cannot spend the same Credits twice, and the unique indexes are the backstop
 * if they somehow did.
 *
 * ── THE ECONOMY GATE ─────────────────────────────────────────────────────────
 *
 * Nothing here charges while the economy is off: starting, capturing, releasing
 * and refunding all refuse before anything is read, locked or written. Reading
 * a price or a past action is available either way, like every other read.
 *
 * NOT HERE, DELIBERATELY: any particular paid action, checkout, payment
 * provider, content unlock, subscription or age check. Nothing in the
 * application calls this module yet -- P7.2 is the first caller.
 */

/** A database or a transaction. Settlement nests in the caller's unit of work. */
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Reader = Pick<Db, 'select' | 'selectDistinctOn' | 'execute'>;
export type PaidActionDb = Pick<Db, 'transaction' | 'select' | 'selectDistinctOn' | 'execute'>;

/** How a paid action is recorded on its ledger rows (P2.1 `source_type`). */
export const PAID_ACTION_SOURCE = 'paid_action';

/** The ruleset's own shape for an action type and a quality tier. */
const CODE = /^[a-z][a-z0-9_]{1,63}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY_MAX = 200;
const REASON_MAX = 500;
/** The ledger's integer columns. */
const AMOUNT_MAX = 2 ** 31 - 1;
const SECONDS_PER_MINUTE = 60;

/** The tier assumed when a caller does not name one, as in the resolver. */
export const DEFAULT_QUALITY_TIER = 'standard';

/** The ordinary price authority: the P1 ruleset's action costs. */
export const RULESET_SOURCE = 'ruleset';

export type PaidActionErrorCode =
  | 'invalid_request'
  | 'economy_disabled'
  /** Nothing prices this action: from `actionCostFor`, no ruleset at all, or the caller's own authority. */
  | 'not_priced'
  /** The pinned version was cancelled or is not yet in effect: nothing is charged against it. */
  | 'configuration_changed'
  | 'action_not_found'
  | 'idempotency_conflict'
  /** The action is not in a state this step can apply to (capturing a released one, say). */
  | 'invalid_state';

export class PaidActionError extends Error {
  constructor(
    public readonly code: PaidActionErrorCode,
    message: string,
    /** The resolver's own reason, where one caused this. */
    public readonly reason?: string,
  ) {
    super(message);
    this.name = 'PaidActionError';
  }
}

function invalid(message: string): never {
  throw new PaidActionError('invalid_request', message);
}

/**
 * THE GATE. No paid action may be started or settled while the economy is off,
 * so nothing can be charged before the phase that owns charging is switched on.
 */
export function assertPaidActionsEnabled(commerce: Pick<CommerceEnv, 'enabled'>): void {
  if (!commerce.enabled) {
    throw new PaidActionError('economy_disabled', 'The economy is switched off: no Credits can be charged.');
  }
}

/* ------------------------------------------------------------------ *
 * What a caller asks for, and what they get back
 * ------------------------------------------------------------------ */

/**
 * A price from somewhere other than the P1 ruleset.
 *
 * `resolve` is run INSIDE the charging transaction, so the price is read at the
 * moment the Credits move, not earlier by a caller who might have gone stale.
 * It returns the price and `refId`, the id of the row that decided it, which is
 * pinned on the paid action exactly as a ruleset version would be. A caller
 * that simply returned a constant would be stating a price, which is the one
 * thing this interface exists to prevent -- so what it returns is checked, and
 * what priced it is always recorded.
 */
export interface ExternalPricing {
  /** The authority, as it is recorded: lower-case, e.g. `content_offer`. */
  source: string;
  resolve: (db: Reader) => Promise<{ amount: number; refId: string }>;
}

export interface PaidActionRequest {
  /** Whose Credits. Whether they MAY act is entitlement's question, decided before this. */
  userId: string;
  /** A ruleset action type, or -- with `pricedBy` -- the name this action is recorded under. */
  actionType: string;
  qualityTier?: string;
  /** Whole seconds, where the action is priced by length. */
  durationSeconds?: number;
  /** One key, one paid action, per user. */
  idempotencyKey: string;
  /** Correlation, carried onto every ledger row of this operation. */
  requestId?: string | null;
  /** Defaults to Credits. */
  currency?: string;
  /** Context for audit. Never a credential or payment instrument. */
  metadata?: Record<string, unknown>;
  /** Priced by another server authority instead of the ruleset (P8.2). */
  pricedBy?: ExternalPricing;
}

/** What an action costs on a resolved configuration -- read-only, nothing reserved. */
export interface PaidActionQuote {
  amount: number;
  currency: string;
  actionType: string;
  qualityTier: string;
  durationSeconds: number | null;
  /** Which authority priced it: `ruleset`, or the caller's own. */
  priceSource: string;
  /** The exact configuration version this price came from -- only when the ruleset priced it. */
  ruleset: Extract<EconomyRef, { kind: 'ruleset' }> | null;
  /** The row that priced it -- for every other authority. */
  priceRefId: string | null;
  /** The instant it was resolved at. A quote is not a reservation: it can go stale. */
  asOf: EconomyInstant;
}

export type PaidActionStatus = PaidActionRow['status'];

/** One paid action, end to end. Every amount here is the wallet's, not a second tally. */
export interface PaidActionRecord {
  id: string;
  userId: string;
  actionType: string;
  qualityTier: string;
  durationSeconds: number | null;
  currency: string;
  amount: number;
  priceSource: string;
  ruleset: Extract<EconomyRef, { kind: 'ruleset' }> | null;
  priceRefId: string | null;
  status: PaidActionStatus;
  holdTransactionId: string;
  /** The capture or release that ended the hold; null while held. */
  settlementTransactionId: string | null;
  refundTransactionId: string | null;
  idempotencyKey: string;
  requestId: string | null;
  failureReason: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  settledAt: string | null;
}

export interface PaidActionResult {
  action: PaidActionRecord;
  /** True when this step had already been applied: nothing was written. */
  replayed: boolean;
}

function toRecord(row: PaidActionRow): PaidActionRecord {
  return {
    id: row.id,
    userId: row.userId,
    actionType: row.actionType,
    qualityTier: row.qualityTier,
    durationSeconds: row.durationSeconds,
    currency: row.currency,
    amount: row.amount,
    priceSource: row.priceSource,
    ruleset: row.rulesetId === null || row.rulesetVersion === null ? null : { kind: 'ruleset', id: row.rulesetId, version: row.rulesetVersion },
    priceRefId: row.priceRefId,
    status: row.status,
    holdTransactionId: row.holdTransactionId,
    settlementTransactionId: row.settlementTransactionId,
    refundTransactionId: row.refundTransactionId,
    idempotencyKey: row.idempotencyKey,
    requestId: row.requestId,
    failureReason: row.failureReason,
    metadata: row.metadata,
    createdAt: row.createdAt.toISOString(),
    settledAt: row.settledAt?.toISOString() ?? null,
  };
}

/* ------------------------------------------------------------------ *
 * Validation -- the request's shape. Balances are the wallet's to judge.
 * ------------------------------------------------------------------ */

interface ParsedRequest {
  userId: string;
  actionType: string;
  qualityTier: string;
  durationSeconds: number | null;
  idempotencyKey: string;
  requestId: string | null;
  currency: string;
  metadata: Record<string, unknown>;
  pricedBy: ExternalPricing | null;
}

function parse(request: PaidActionRequest): ParsedRequest {
  if (!request || typeof request !== 'object') invalid('A paid action must be described by an object.');
  if (typeof request.userId !== 'string' || !UUID.test(request.userId)) invalid('userId must be a user id.');
  if (typeof request.actionType !== 'string' || !CODE.test(request.actionType)) invalid('actionType must be a lower-case action name.');
  const pricedBy = request.pricedBy ?? null;
  if (pricedBy !== null) {
    if (typeof pricedBy.source !== 'string' || !CODE.test(pricedBy.source) || pricedBy.source === RULESET_SOURCE) {
      invalid('pricedBy.source must name a price authority other than the ruleset.');
    }
    if (typeof pricedBy.resolve !== 'function') invalid('pricedBy.resolve must be a function.');
  }
  const qualityTier = request.qualityTier ?? DEFAULT_QUALITY_TIER;
  if (typeof qualityTier !== 'string' || !CODE.test(qualityTier)) invalid('qualityTier must be a ruleset quality tier.');
  let durationSeconds: number | null = null;
  if (request.durationSeconds !== undefined && request.durationSeconds !== null) {
    // Stricter than the resolver's lookup, which allows a fractional duration:
    // a recorded action stores whole seconds.
    if (!Number.isSafeInteger(request.durationSeconds) || request.durationSeconds < 1) {
      invalid('durationSeconds must be a whole number of seconds, 1 or more.');
    }
    durationSeconds = request.durationSeconds;
  }
  const key = request.idempotencyKey;
  if (typeof key !== 'string' || key.trim() === '' || key.length > KEY_MAX) {
    invalid(`idempotencyKey must be non-blank text of at most ${KEY_MAX} characters.`);
  }
  const currency = request.currency ?? CREDITS_CURRENCY;
  if (typeof currency !== 'string' || !CODE.test(currency)) invalid('currency must be a wallet currency code.');
  if (request.requestId != null && typeof request.requestId !== 'string') invalid('requestId must be text.');
  if (
    request.metadata !== undefined &&
    (typeof request.metadata !== 'object' || request.metadata === null || Array.isArray(request.metadata))
  ) {
    invalid('metadata must be an object.');
  }
  return {
    userId: request.userId,
    actionType: request.actionType,
    qualityTier,
    durationSeconds,
    idempotencyKey: key,
    requestId: request.requestId ?? null,
    currency,
    metadata: request.metadata ?? {},
    pricedBy,
  };
}

/* ------------------------------------------------------------------ *
 * Pricing -- configuration only. Nothing here reserves or writes.
 * ------------------------------------------------------------------ */

/**
 * What this action costs on a given ruleset, in whole Credits.
 *
 * `per_action` is the row's cost outright. `per_minute` is that cost for every
 * STARTED minute -- a 70-second clip is two minutes, never one and a bit --
 * because a partial Credit cannot be held or captured, and rounding down would
 * mean giving part of the work away. An action priced by the minute must say
 * how long it is.
 *
 * Pure: a lookup on a snapshot the caller already resolved, so the same
 * question can be asked of a live ruleset or a drafted one.
 */
export function priceOn(
  ruleset: Pick<RulesetSnapshot, 'ref' | 'actionCosts'>,
  request: { actionType: string; qualityTier: string; durationSeconds: number | null },
): { ok: true; amount: number } | { ok: false; reason: string } {
  const lookup = actionCostFor(ruleset, request.actionType, {
    qualityTier: request.qualityTier,
    durationSeconds: request.durationSeconds ?? undefined,
  });
  if (!lookup.ok) return { ok: false, reason: lookup.reason };

  const { unit, creditCost } = lookup.cost;
  if (unit === 'per_minute' && request.durationSeconds === null) return { ok: false, reason: 'duration_required' };
  const minutes = request.durationSeconds === null ? 1 : Math.ceil(request.durationSeconds / SECONDS_PER_MINUTE);
  const amount = unit === 'per_minute' ? creditCost * minutes : creditCost;
  // The schema keeps every configured cost above zero; this catches the
  // arithmetic, not the configuration.
  if (!Number.isSafeInteger(amount) || amount < 1 || amount > AMOUNT_MAX) return { ok: false, reason: 'price_out_of_range' };
  return { ok: true, amount };
}

const notPriced = (reason: string, actionType: string): PaidActionError =>
  new PaidActionError('not_priced', `The economy configuration does not price "${actionType}" (${reason}).`, reason);

/** The price, from whichever authority applies, at one database instant. */
async function quoteOn(db: Reader, request: ParsedRequest): Promise<{ quote: PaidActionQuote; ruleset: RulesetSnapshot | null }> {
  const asOf = await economyNow(db);
  const common = {
    currency: request.currency,
    actionType: request.actionType,
    qualityTier: request.qualityTier,
    durationSeconds: request.durationSeconds,
    asOf,
  };

  if (request.pricedBy) {
    const answer = await request.pricedBy.resolve(db);
    // A caller's authority is still held to the framework's arithmetic: a price
    // outside the ledger's range, or one that names nothing, prices nothing.
    if (!answer || !Number.isSafeInteger(answer.amount) || answer.amount < 1 || answer.amount > AMOUNT_MAX) {
      throw notPriced('price_out_of_range', request.actionType);
    }
    if (typeof answer.refId !== 'string' || answer.refId.trim() === '') throw notPriced('price_ref_missing', request.actionType);
    return {
      ruleset: null,
      quote: { ...common, amount: answer.amount, priceSource: request.pricedBy.source, ruleset: null, priceRefId: answer.refId },
    };
  }

  const resolved = await resolveRuleset(db, asOf);
  if (!resolved.ok) throw notPriced(resolved.reason, request.actionType);
  const priced = priceOn(resolved.value, request);
  if (!priced.ok) throw notPriced(priced.reason, request.actionType);
  return {
    ruleset: resolved.value,
    quote: { ...common, amount: priced.amount, priceSource: RULESET_SOURCE, ruleset: resolved.value.ref, priceRefId: null },
  };
}

/**
 * What an action WOULD cost now. READ-ONLY: it reserves nothing, writes
 * nothing and pins nothing, so the price it returns can be superseded before
 * the action starts. A charge always prices itself again under its own lock.
 */
export async function quotePaidAction(db: Reader, request: PaidActionRequest): Promise<PaidActionQuote> {
  return (await quoteOn(db, parse(request))).quote;
}

/* ------------------------------------------------------------------ *
 * Reading
 * ------------------------------------------------------------------ */

async function byKey(db: Reader | Tx, userId: string, idempotencyKey: string): Promise<PaidActionRow | null> {
  const [row] = await db
    .select()
    .from(paidActions)
    .where(and(eq(paidActions.userId, userId), eq(paidActions.idempotencyKey, idempotencyKey)));
  return row ?? null;
}

/** One paid action of this user's, by the key that started it. */
export async function readPaidAction(db: Reader, userId: string, idempotencyKey: string): Promise<PaidActionRecord | null> {
  const row = await byKey(db, userId, idempotencyKey);
  return row ? toRecord(row) : null;
}

/**
 * The configuration a past action was priced on -- THAT version, loaded by the
 * id it pinned, never re-resolved by its timestamp. A cancelled version still
 * loads: it is what the charge was made against.
 */
export async function readPaidActionRuleset(db: Reader, action: PaidActionRecord): Promise<RulesetSnapshot | null> {
  if (action.ruleset === null) return null;
  const loaded = await loadRuleset(db, action.ruleset.id);
  return loaded.ok ? loaded.value : null;
}

/* ------------------------------------------------------------------ *
 * Starting: resolve, pin, and hold -- one transaction
 * ------------------------------------------------------------------ */

/** The wallet key for one step of one action: derived, so each step replays on its own. */
const stepKey = (actionId: string, step: 'hold' | 'capture' | 'release' | 'refund') => `${PAID_ACTION_SOURCE}:${actionId}:${step}`;

/** The same request, or a different one wearing the same key? */
function assertSameRequest(existing: PaidActionRow, request: ParsedRequest): void {
  const differences: string[] = [];
  if (existing.actionType !== request.actionType) differences.push(`action ${existing.actionType}, not ${request.actionType}`);
  if (existing.qualityTier !== request.qualityTier) differences.push(`quality ${existing.qualityTier}, not ${request.qualityTier}`);
  if (existing.durationSeconds !== request.durationSeconds) differences.push('a different duration');
  if (existing.currency !== request.currency) differences.push(`currency ${existing.currency}, not ${request.currency}`);
  const source = request.pricedBy?.source ?? RULESET_SOURCE;
  if (existing.priceSource !== source) differences.push(`priced by ${existing.priceSource}, not ${source}`);
  if (differences.length > 0) {
    throw new PaidActionError(
      'idempotency_conflict',
      `Idempotency key "${existing.idempotencyKey}" already names a different paid action (${differences.join('; ')}).`,
    );
  }
}

/**
 * Prices the action on the live configuration, PINS that version and holds the
 * Credits -- all in one transaction, so the price a customer is reserved
 * against is the price that was live when the Credits moved. If anything is
 * refused, nothing is written: no row, no hold, no partial state.
 *
 * A replayed key returns the action already started, with `replayed: true`,
 * whatever has happened to it since -- including one already captured. It never
 * starts a second one and never holds a second time.
 *
 * The Credits are reserved BEFORE any external work: that is the whole point of
 * the hold. Refusals from the wallet -- not enough Credits, no wallet, an
 * inconsistent ledger -- are `WalletError`s and propagate unchanged.
 */
export async function beginPaidAction(
  db: PaidActionDb,
  commerce: Pick<CommerceEnv, 'enabled'>,
  request: PaidActionRequest,
): Promise<PaidActionResult> {
  assertPaidActionsEnabled(commerce);
  const parsed = parse(request);

  return db.transaction(async (tx) => {
    // Serialise this (user, key) before reading, so two identical requests at
    // once cannot both find nothing and both start an action. Taken first, and
    // by nothing else, so it cannot deadlock with the wallet's locks.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`paid-action:${parsed.userId}:${parsed.idempotencyKey}`}, 0))`);
    const existing = await byKey(tx, parsed.userId, parsed.idempotencyKey);
    if (existing) {
      assertSameRequest(existing, parsed);
      return { action: toRecord(existing), replayed: true };
    }

    const { quote, ruleset } = await quoteOn(tx, parsed);
    // Rule 2: hold the exact version still while the reservation is written.
    // Only a ruleset has one to hold -- another authority pins its own row, and
    // resolving it inside this transaction is what keeps it still.
    if (ruleset) {
      const pinned = await lockEconomyRefForRecording(tx, ruleset.ref);
      if (!pinned.ok) {
        throw new PaidActionError(
          'configuration_changed',
          `The economy configuration changed while pricing this action (${pinned.reason}); nothing was charged.`,
          pinned.reason,
        );
      }
    }

    const id = randomUUID();
    const hold = await holdCredits(tx, {
      userId: parsed.userId,
      currency: parsed.currency,
      amount: quote.amount,
      idempotencyKey: stepKey(id, 'hold'),
      source: { type: PAID_ACTION_SOURCE, id },
      requestId: parsed.requestId,
      metadata: parsed.metadata,
    });

    const [row] = await tx
      .insert(paidActions)
      .values({
        id,
        userId: parsed.userId,
        actionType: parsed.actionType,
        qualityTier: parsed.qualityTier,
        durationSeconds: parsed.durationSeconds,
        currency: parsed.currency,
        amount: quote.amount,
        priceSource: quote.priceSource,
        rulesetId: ruleset?.ref.id ?? null,
        rulesetVersion: ruleset?.ref.version ?? null,
        priceRefId: quote.priceRefId,
        status: 'held',
        holdTransactionId: hold.transaction.id,
        idempotencyKey: parsed.idempotencyKey,
        requestId: parsed.requestId,
        metadata: parsed.metadata,
      })
      .returning();
    return { action: toRecord(row!), replayed: false };
  });
}

/* ------------------------------------------------------------------ *
 * Settling: capture, release, refund
 * ------------------------------------------------------------------ */

/** Which action to settle: the row's id, or the key the caller started it with. */
export type PaidActionSelector = { actionId: string } | { userId: string; idempotencyKey: string };

async function lockAction(tx: Tx, selector: PaidActionSelector): Promise<PaidActionRow> {
  if ('actionId' in selector && (typeof selector.actionId !== 'string' || !UUID.test(selector.actionId))) {
    invalid('actionId must be a paid action id.');
  }
  const where =
    'actionId' in selector
      ? eq(paidActions.id, selector.actionId)
      : and(eq(paidActions.userId, selector.userId), eq(paidActions.idempotencyKey, selector.idempotencyKey));
  const [row] = await tx.select().from(paidActions).where(where).for('update');
  if (!row) throw new PaidActionError('action_not_found', 'No such paid action.');
  return row;
}

function requireReason(reason: unknown, what: string): string | null {
  if (reason == null) return null;
  if (typeof reason !== 'string' || reason.length > REASON_MAX) invalid(`${what} must be text of at most ${REASON_MAX} characters.`);
  return reason.trim() || null;
}

interface SettleOptions {
  /** Why the work did not come off. Recorded, never used to decide anything. */
  reason?: string | null;
  /** Correlation for this step, when it differs from the one that started the action. */
  requestId?: string | null;
}

/**
 * CAPTURE: the work succeeded, so the reserved Credits are consumed -- EXACTLY
 * the amount reserved, which is the amount the pinned version priced. There is
 * no partial capture: a paid action is one price, charged or not.
 */
export async function capturePaidAction(
  db: PaidActionDb,
  commerce: Pick<CommerceEnv, 'enabled'>,
  selector: PaidActionSelector,
  options: SettleOptions = {},
): Promise<PaidActionResult> {
  return settleHold(db, commerce, selector, 'capture', options);
}

/**
 * RELEASE: the work failed or was cancelled before the Credits were consumed,
 * so the whole reservation goes back to spendable. The customer is left exactly
 * as they started.
 */
export async function releasePaidAction(
  db: PaidActionDb,
  commerce: Pick<CommerceEnv, 'enabled'>,
  selector: PaidActionSelector,
  options: SettleOptions = {},
): Promise<PaidActionResult> {
  return settleHold(db, commerce, selector, 'release', options);
}

async function settleHold(
  db: PaidActionDb,
  commerce: Pick<CommerceEnv, 'enabled'>,
  selector: PaidActionSelector,
  step: 'capture' | 'release',
  options: SettleOptions,
): Promise<PaidActionResult> {
  assertPaidActionsEnabled(commerce);
  const reason = requireReason(options.reason, 'reason');
  const settled: PaidActionStatus = step === 'capture' ? 'captured' : 'released';

  return db.transaction(async (tx) => {
    const action = await lockAction(tx, selector);
    if (action.status === settled) return { action: toRecord(action), replayed: true };
    if (action.status !== 'held') {
      throw new PaidActionError('invalid_state', `This paid action is ${action.status}; it cannot be ${settled}.`);
    }

    const operation: WalletOperationResult = await (step === 'capture' ? captureHold : releaseHold)(tx, {
      userId: action.userId,
      holdTransactionId: action.holdTransactionId,
      // Exactly what was reserved: the framework never settles part of a hold.
      amount: action.amount,
      idempotencyKey: stepKey(action.id, step),
      source: { type: PAID_ACTION_SOURCE, id: action.id },
      reason,
      requestId: options.requestId ?? action.requestId,
    });

    const [row] = await tx
      .update(paidActions)
      .set({
        status: settled,
        settlementTransactionId: operation.transaction.id,
        settledAt: sql`now()`,
        failureReason: step === 'release' ? reason : null,
      })
      .where(eq(paidActions.id, action.id))
      .returning();
    return { action: toRecord(row!), replayed: false };
  });
}

/**
 * REFUND: the Credits were already consumed and are being returned in full,
 * to the class they were charged from (P2). Only a captured action can be
 * refunded -- while it is still held the answer is a release, and the two are
 * not interchangeable in the ledger.
 */
export async function refundPaidAction(
  db: PaidActionDb,
  commerce: Pick<CommerceEnv, 'enabled'>,
  selector: PaidActionSelector,
  options: SettleOptions = {},
): Promise<PaidActionResult> {
  assertPaidActionsEnabled(commerce);
  const reason = requireReason(options.reason, 'reason');

  return db.transaction(async (tx) => {
    const action = await lockAction(tx, selector);
    if (action.status === 'refunded') return { action: toRecord(action), replayed: true };
    if (action.status !== 'captured') {
      throw new PaidActionError(
        'invalid_state',
        `This paid action is ${action.status}; only a captured one can be refunded${action.status === 'held' ? ' -- release it instead' : ''}.`,
      );
    }

    const refunded = await refundTransaction(tx, {
      userId: action.userId,
      transactionId: action.settlementTransactionId!,
      amount: action.amount,
      idempotencyKey: stepKey(action.id, 'refund'),
      source: { type: PAID_ACTION_SOURCE, id: action.id },
      reason,
      requestId: options.requestId ?? action.requestId,
    });

    const [row] = await tx
      .update(paidActions)
      .set({ status: 'refunded', refundTransactionId: refunded.transaction.id, failureReason: reason })
      .where(eq(paidActions.id, action.id))
      .returning();
    return { action: toRecord(row!), replayed: false };
  });
}

/* ------------------------------------------------------------------ *
 * The whole operation, in one call
 * ------------------------------------------------------------------ */

/**
 * The external work. It runs AFTER the Credits are reserved and BEFORE they are
 * consumed, and it is given the action so it can carry the correlation through
 * whatever it calls. Throwing -- for a failure or a cancellation alike --
 * releases the reservation.
 */
export type PaidActionWork<T> = (context: { action: PaidActionRecord }) => Promise<T>;

export type PaidActionRun<T> =
  /** The work ran, and its Credits were captured. */
  | { action: PaidActionRecord; replayed: false; result: T }
  /**
   * This request had already been made: the recorded action is returned and the
   * work did NOT run again. There is no `result`, and this module will not
   * invent one -- only the caller knows how to recover what its work produced.
   */
  | { action: PaidActionRecord; replayed: true; result: null };

/**
 * Hold, work, capture -- or release if the work does not come off.
 *
 * The ordinary way to use this module. `work` is the caller's; everything
 * around it is the framework's, and the framework never looks inside it.
 *
 * IF THE WORK THROWS, the reservation is released and the original error is
 * re-thrown unchanged -- the caller needs to see what actually failed, not a
 * wrapper. If the release ITSELF fails, the original error is still what the
 * caller gets: the action stays `held`, which is visible in the record and
 * recoverable, rather than being hidden behind a second failure.
 */
export async function runPaidAction<T>(
  db: PaidActionDb,
  commerce: Pick<CommerceEnv, 'enabled'>,
  request: PaidActionRequest,
  work: PaidActionWork<T>,
): Promise<PaidActionRun<T>> {
  const started = await beginPaidAction(db, commerce, request);
  if (started.replayed) return { action: started.action, replayed: true, result: null };

  let result: T;
  try {
    result = await work({ action: started.action });
  } catch (error) {
    try {
      await releasePaidAction(db, commerce, { actionId: started.action.id }, { reason: failureText(error) });
    } catch {
      // Deliberately swallowed: the caller is owed the error that actually
      // happened. The action remains held and settleable.
    }
    throw error;
  }
  const captured = await capturePaidAction(db, commerce, { actionId: started.action.id });
  return { action: captured.action, replayed: false, result };
}

/** A short, safe note of why the work failed. Never the whole error. */
function failureText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, REASON_MAX) || 'The action failed.';
}
