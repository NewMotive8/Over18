/**
 * Character creation form logic — React-free, so it can actually be tested.
 *
 * WHY THIS MODULE EXISTS. The create form's validation lived inline in
 * `AdminCharactersPage.handleCreate`, where this repo's node test environment
 * (no DOM, no events — see apps/web/vitest.config.ts) could never reach it. Its
 * own test file said so out loud: "What they cannot do: exercise ... the create
 * form submit". A stale-error bug shipped in exactly that blind spot. Moving the
 * rule out here makes the failure reproducible in a test, which is the only
 * durable fix.
 *
 * THE BUG. `saveError` recorded the verdict of ONE past submit and was cleared
 * only inside `handleCreate`, after both guards had already passed — i.e. only
 * on a submit that was about to succeed. Nothing cleared it when the operator
 * corrected the field. Typing a valid name over an invalid one therefore left
 * the Name field reading "Nova" underneath "Enter a name with at least two
 * letters or numbers."
 *
 * THE FIX. A validation error is no longer stored at all. It is DERIVED from
 * the draft on every render, and shown only once the operator has actually
 * tried to submit. An error cannot go stale because there is no stored error to
 * go stale — the moment the draft stops being invalid, the message stops being
 * produced.
 *
 * THE RULE IS UNCHANGED. Still: an image is required, and the slug derived from
 * the typed name must be at least two characters. Same checks, same order, same
 * wording.
 */

/** Derives a valid slug from what the operator typed, so they never meet the regex. */
export function slugify(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

export const NAME_TOO_SHORT = 'Enter a name with at least two letters or numbers.';

/** The minimum slug length a character name must produce. Unchanged. */
export const MIN_NAME_LENGTH = 2;

/**
 * What the operator has entered. `hasImage` rather than a File so this stays
 * testable in node, where `File` does not exist.
 *
 * AN IMAGE IS OPTIONAL. It used to be required, which meant a character could
 * not exist until its media did — the wrong way round for an operator who
 * creates the roster first and uploads over the following days. A name is
 * enough; a photo supplied here is still filed as the primary reference
 * exactly as before.
 */
export interface CharacterDraft {
  displayName: string;
  hasImage: boolean;
}

/**
 * Why this draft cannot be submitted, or null when it can.
 *
 * The name is the only requirement. It must still produce a usable slug,
 * because the slug is the character's stable id everywhere else.
 */
export function blockingError(draft: CharacterDraft): string | null {
  if (slugify(draft.displayName).length < MIN_NAME_LENGTH) return NAME_TOO_SHORT;
  return null;
}

export function canSubmit(draft: CharacterDraft): boolean {
  return blockingError(draft) === null;
}

export interface FormFeedback {
  /** True once the operator has pressed Create at least once. */
  submitAttempted: boolean;
  /** An error the SERVER returned for a previous attempt, if any. */
  serverError: string | null;
  draft: CharacterDraft;
}

/**
 * The single message the form should display right now, or null.
 *
 * A server error wins, because it describes something the operator cannot see
 * by looking at their own inputs. Otherwise the live verdict on the current
 * draft is shown — but only after a submit attempt, so the form does not start
 * out scolding someone who has typed nothing yet.
 *
 * Note what is absent: any remembered validation string. That absence is the
 * fix. There is nothing here that can survive the draft becoming valid.
 */
export function visibleError(feedback: FormFeedback): string | null {
  if (feedback.serverError !== null) return feedback.serverError;
  if (!feedback.submitAttempted) return null;
  return blockingError(feedback.draft);
}

/** The payload the API client is called with for a valid draft. */
export function quickCreatePayload(draft: CharacterDraft): {
  name: string;
  displayName: string;
} {
  return { name: slugify(draft.displayName), displayName: draft.displayName.trim() };
}
