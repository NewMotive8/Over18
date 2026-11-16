import {
  MY_AI_CHOICES,
  MY_AI_INTERESTS,
  MY_AI_MAX_AGE,
  MY_AI_MAX_INTERESTS,
  MY_AI_MIN_AGE,
  MY_AI_NAME_MAX_LENGTH,
  type MyAiDraft,
  type MyAiEthnicity,
} from '@over18/shared';

/**
 * Keeping a half-built companion across the trip to Sign in.
 *
 * THE PROMISE THIS EXISTS TO HONOUR. A signed-out visitor who finishes the
 * five steps and presses Create is told "Sign in to create her — everything
 * you picked is kept", and beside it is a Sign in button. Following that
 * button unmounts the wizard: React state does not survive a route change, so
 * without this module they would come back to an empty first step and the
 * sentence would be a lie. Eleven choices and a name is quite enough work to
 * lose once and never come back.
 *
 * SESSION STORAGE, NOT LOCAL. The draft belongs to this visit in this tab. It
 * is not a saved document and it should not greet someone on a shared machine
 * next week; closing the tab is a perfectly good way to abandon her.
 *
 * EVERYTHING READ BACK IS RE-VALIDATED. What comes out of storage is not what
 * this app put in — it is whatever is under that key now, and the browser's
 * dev tools are one keystroke away. So every choice is checked against the
 * shared vocabulary, the name is length-limited, the age must be a whole
 * number inside the 21+ range, and anything that fails is DROPPED rather than
 * carried: the wizard shows its own default and the user simply picks again.
 * The server validates all of it a second time regardless, which is where the
 * real refusal lives; this is about not showing somebody a companion built out
 * of values the flow could never have produced.
 */

const KEY = 'over18.myAi.draft';

/**
 * A ceiling on the restored step, purely so a tampered value cannot be a huge
 * number. The flow clamps it to its own last step — which step count is the
 * wizard's business, not this module's.
 */
const MAX_STEP = 20;

export interface StashedMyAiDraft {
  /**
   * Only the fields that survived validation; the wizard fills the rest.
   *
   * `ethnicity` is narrowed to the five the flow knows rather than left as the
   * draft's plain `string`, because every tile after step 2 is addressed by it
   * — a restored value outside that set would resolve to photographs that do
   * not exist. `sanitise` has already checked it against the list, so this is
   * the type stating what the function guarantees.
   */
  draft: Partial<Omit<MyAiDraft, 'ethnicity'>> & { ethnicity?: MyAiEthnicity };
  /** Which step to reopen on. */
  step: number;
}

/**
 * What `onSubmit` throws when the create was refused for want of a session.
 *
 * A distinct type, not a string match: the wizard shows a Sign in button for
 * this and only this, and matching on message text would make the button
 * appear or vanish depending on wording nobody thought was load-bearing.
 */
export class MyAiSignInRequired extends Error {
  constructor(message = 'Sign in to create her — everything you picked is kept.') {
    super(message);
    this.name = 'MyAiSignInRequired';
  }
}

/** Storage access itself throws in some privacy modes, so even this is guarded. */
function storage(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

function sanitise(value: unknown): StashedMyAiDraft | null {
  if (typeof value !== 'object' || value === null) return null;
  const { draft, step } = value as { draft?: unknown; step?: unknown };
  if (typeof draft !== 'object' || draft === null) return null;

  const raw = draft as Record<string, unknown>;
  const clean: Record<string, unknown> = {};

  // The eleven choice fields, each against its own list of options.
  for (const [field, options] of Object.entries(MY_AI_CHOICES)) {
    const picked = raw[field];
    const known = options as readonly { id: string }[];
    if (typeof picked === 'string' && known.some((o) => o.id === picked)) clean[field] = picked;
  }

  if (typeof raw.name === 'string') {
    const name = raw.name.trim();
    if (name.length > 0 && name.length <= MY_AI_NAME_MAX_LENGTH) clean.name = name;
  }

  if (
    typeof raw.age === 'number' &&
    Number.isInteger(raw.age) &&
    raw.age >= MY_AI_MIN_AGE &&
    raw.age <= MY_AI_MAX_AGE
  ) {
    clean.age = raw.age;
  }

  if (Array.isArray(raw.interests)) {
    const known = new Set(MY_AI_INTERESTS.map((i) => i.id as string));
    const kept = raw.interests.filter((i): i is string => typeof i === 'string' && known.has(i));
    clean.interests = [...new Set(kept)].slice(0, MY_AI_MAX_INTERESTS);
  }

  const at =
    typeof step === 'number' && Number.isInteger(step) && step > 0 ? Math.min(step, MAX_STEP) : 0;

  return { draft: clean as StashedMyAiDraft['draft'], step: at };
}

export const myAiDraftStash = {
  /**
   * Keep what has been built so far.
   *
   * Takes `unknown` on purpose: the wizard's working draft has empty strings
   * where nothing is chosen yet, which is not a `MyAiDraft`, and insisting on
   * one here would only invite a cast at the call site. Nothing trusts what
   * goes in — `read` validates every field on the way out.
   */
  write(draft: unknown, step: number): void {
    try {
      storage()?.setItem(KEY, JSON.stringify({ draft, step }));
    } catch {
      /* Storage refused (private mode, quota). The draft is simply not kept. */
    }
  },

  /** What was kept, validated — or null if there is nothing usable. */
  read(): StashedMyAiDraft | null {
    const raw = storage()?.getItem(KEY);
    if (!raw) return null;
    try {
      return sanitise(JSON.parse(raw));
    } catch {
      return null;
    }
  },

  /** Called once she has actually been created: the draft is spent. */
  clear(): void {
    try {
      storage()?.removeItem(KEY);
    } catch {
      /* nothing to do */
    }
  },
};
