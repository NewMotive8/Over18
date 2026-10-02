/**
 * The age-entry gate.
 *
 * ── WHAT THIS IS, STATED PLAINLY ─────────────────────────────────────────────
 *
 * A SELF-DECLARED ENTRY GATE. It asks a visitor to confirm they are 18 or over
 * and remembers the answer in their browser. It is not age verification, it is
 * not age assurance, and it proves nothing: anyone can click the button. The
 * repository already carries the interface for real verification
 * (`commerce/age-verification-provider.ts`) with no vendor chosen, and nothing
 * here substitutes for it.
 *
 * It is worth having anyway, for the reason a door sign is worth having: it
 * states what is inside before someone walks in, and it is the thing a visitor
 * who did not mean to arrive here needs.
 *
 * ── WHAT IT CANNOT DO ────────────────────────────────────────────────────────
 *
 * IT PROTECTS THE BROWSER, NOT THE API. `/api/characters`, the public visual
 * identity read and `/api/characters/:id/clips` are public by design (US-02),
 * and the last of those returns a character's explicit clips with a playable
 * url. A gate in the client cannot change that, and pretending otherwise would
 * be worse than having no gate: it would make an unprotected surface look
 * protected. Blocking the API is a server change, listed in the report and
 * deliberately not attempted here.
 *
 * ── NOT COOKIE CONSENT ───────────────────────────────────────────────────────
 *
 * Deliberately `localStorage` and deliberately not a cookie, so that confirming
 * your age cannot be mistaken for -- or quietly recorded as -- consent to
 * anything else. It stores one timestamp, it is strictly functional, and
 * clicking the button enables no tracking.
 */

/** The age this gate asks about. */
export const MINIMUM_AGE = 18;

/** One key, namespaced like every other browser value this app keeps. */
export const AGE_CONFIRMED_KEY = 'over18.ageConfirmedAt';

/**
 * How long a confirmation lasts before it is asked again.
 *
 * Bounded rather than forever, because a shared or borrowed device should not
 * carry one person's answer indefinitely. Thirty days is a judgement, not a
 * legal requirement, and the report says so.
 */
export const CONFIRMATION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type GateStatus =
  /** Nothing has been answered yet, or the last answer has expired. */
  | 'asking'
  /** They said they are under 18. Nothing is shown and nothing is stored. */
  | 'declined'
  /** They confirmed. The application may render. */
  | 'confirmed';

/**
 * Whether a stored value still counts as a confirmation.
 *
 * PURE, so the rules can be asserted without a DOM -- which this test
 * environment does not have.
 *
 * A FUTURE TIMESTAMP IS NOT TRUSTED. It cannot have been written by a clock
 * agreeing with this one, so it is either a wrong clock or a hand-edited value,
 * and in both cases asking again is the cheap, safe answer. Anything that is
 * not a finite number is treated the same way.
 */
export function isConfirmationFresh(raw: string | null, now: number): boolean {
  if (raw === null || raw.trim().length === 0) return false;
  const at = Number(raw);
  if (!Number.isFinite(at) || at <= 0) return false;
  if (at > now) return false;
  return now - at < CONFIRMATION_TTL_MS;
}

/* ------------------------------------------------------------------ *
 * The browser's copy
 *
 * Wrapped exactly as `creditsStore` wraps its own: storage throws in private
 * mode and when site data is blocked, and a gate that crashes the application
 * would be a worse outcome than a gate that asks twice.
 * ------------------------------------------------------------------ */

function store(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** The answer this browser holds, or none. */
export function readConfirmation(now: number = Date.now()): boolean {
  try {
    return isConfirmationFresh(store()?.getItem(AGE_CONFIRMED_KEY) ?? null, now);
  } catch {
    return false;
  }
}

/** Records a confirmation. Failing to record it means they are asked again. */
export function writeConfirmation(now: number = Date.now()): void {
  try {
    store()?.setItem(AGE_CONFIRMED_KEY, String(now));
  } catch {
    /* storage refused; the gate simply asks again next time */
  }
}

/** Forgets the answer. Exported for the account screen and for tests. */
export function clearConfirmation(): void {
  try {
    store()?.removeItem(AGE_CONFIRMED_KEY);
  } catch {
    /* nothing to undo */
  }
}

/**
 * The status to open with.
 *
 * `declined` is never restored from storage: refusing is not a preference worth
 * keeping, and a person who arrives again gets asked again rather than being
 * met with a wall they cannot explain.
 */
export function initialStatus(now: number = Date.now()): GateStatus {
  return readConfirmation(now) ? 'confirmed' : 'asking';
}
