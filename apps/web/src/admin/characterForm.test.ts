import { describe, expect, it } from 'vitest';
import {
  blockingError,
  canSubmit,
  NAME_TOO_SHORT,
  quickCreatePayload,
  slugify,
  visibleError,
  type CharacterDraft,
  type FormFeedback,
} from './characterForm';

/**
 * Character creation form — the stale-validation regression.
 *
 * THE REPORTED BUG. The Name field showed a valid name such as "Nova" while the
 * form still displayed "Enter a name with at least two letters or numbers."
 *
 * THE CAUSE. The error was STORED on a failed submit and cleared only inside
 * the submit handler, after both guards had already passed — that is, only on a
 * submit that was about to succeed. Nothing cleared it when the operator fixed
 * the field, so the message outlived the problem it described.
 *
 * These tests walk the reported sequence step by step. The critical one is
 * `step 2`: under the old implementation the message survived the correction,
 * which is precisely what an operator saw.
 */

const draft = (displayName: string, hasImage = true): CharacterDraft => ({
  displayName,
  hasImage,
});

const shown = (feedback: Partial<FormFeedback> & { draft: CharacterDraft }): string | null =>
  visibleError({ submitAttempted: true, serverError: null, ...feedback });

/* ------------------------------------------------------------------ *
 * The reported failure, start to finish
 * ------------------------------------------------------------------ */

describe('correcting an invalid name clears its error', () => {
  it('step 1 — an invalid name blocks submit and states why', () => {
    const invalid = draft('!');
    expect(canSubmit(invalid)).toBe(false);
    expect(blockingError(invalid)).toBe(NAME_TOO_SHORT);
    expect(shown({ draft: invalid })).toBe(NAME_TOO_SHORT);
  });

  it('step 2 — typing "Nova" removes the error immediately (THE REGRESSION)', () => {
    // Same form, same past submit attempt, name corrected. Before the fix the
    // stored message survived this transition and the operator saw "Nova"
    // sitting under "Enter a name with at least two letters or numbers."
    const corrected = draft('Nova');
    expect(shown({ draft: corrected })).toBeNull();
  });

  it('step 3 — no error remains for any valid name', () => {
    for (const name of ['Nova', '  Luna Rae  ', "Zoë's Alt #2", 'A1']) {
      expect(shown({ draft: draft(name) })).toBeNull();
    }
  });

  it('step 4 — the corrected name submits, with the right payload', () => {
    const corrected = draft('Nova');
    expect(canSubmit(corrected)).toBe(true);
    expect(quickCreatePayload(corrected)).toEqual({ name: 'nova', displayName: 'Nova' });
  });

  it('the whole sequence, as one transition', () => {
    // invalid → error shown → corrected → error gone → submittable
    let current = draft('!');
    expect(shown({ draft: current })).toBe(NAME_TOO_SHORT);
    current = draft('Nova');
    expect(shown({ draft: current })).toBeNull();
    expect(canSubmit(current)).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * The rule itself is unchanged
 * ------------------------------------------------------------------ */

describe('the name rule is exactly what it was', () => {
  it('still refuses a name that produces fewer than two slug characters', () => {
    for (const name of ['', ' ', '!', '!!!', 'a', ' b ', '#', '-']) {
      expect(blockingError(draft(name))).toBe(NAME_TOO_SHORT);
      expect(canSubmit(draft(name))).toBe(false);
    }
  });

  it('still accepts a name that produces two or more', () => {
    for (const name of ['Nova', 'ab', 'A1', 'Luna Rae', 'zo-e']) {
      expect(blockingError(draft(name))).toBeNull();
    }
  });

  it('NO LONGER requires an image — a name is enough to create a character', () => {
    // The old rule made a character impossible to create until its media
    // existed, which is the wrong way round: an operator builds the roster
    // first and uploads over the following days.
    expect(blockingError(draft('Nova', false))).toBeNull();
    expect(canSubmit(draft('Nova', false))).toBe(true);
    expect(shown({ draft: draft('Nova', false) })).toBeNull();
  });

  it('still refuses a bad NAME whether or not an image is present', () => {
    expect(blockingError(draft('!', false))).toBe(NAME_TOO_SHORT);
    expect(blockingError(draft('!', true))).toBe(NAME_TOO_SHORT);
  });

  it('an image is accepted but never demanded', () => {
    expect(blockingError(draft('Nova', true))).toBeNull();
    expect(blockingError(draft('Nova', false))).toBeNull();
  });

  it('derives the slug exactly as before', () => {
    expect(slugify('Nova')).toBe('nova');
    expect(slugify('  Luna Rae  ')).toBe('luna-rae');
    expect(slugify("Zoë's Alt #2")).toBe('zo-s-alt-2');
    expect(slugify('!!!')).toBe('');
    expect(slugify('a'.repeat(80)).length).toBe(50);
  });
});

/* ------------------------------------------------------------------ *
 * When a message may and may not appear
 * ------------------------------------------------------------------ */

describe('a message appears only when it should', () => {
  it('says nothing before the operator has pressed Create', () => {
    // An empty form must not scold someone who has typed nothing yet.
    expect(
      visibleError({ submitAttempted: false, serverError: null, draft: draft('', false) }),
    ).toBeNull();
  });

  it('shows a server error even when the draft itself is fine', () => {
    // The regression fix must not swallow "that name is already taken", which
    // the operator cannot see by looking at their own inputs.
    expect(
      visibleError({
        submitAttempted: true,
        serverError: 'That name is already taken.',
        draft: draft('Nova'),
      }),
    ).toBe('That name is already taken.');
  });

  it('prefers the server error over a local one', () => {
    expect(
      visibleError({
        submitAttempted: true,
        serverError: 'Upload failed.',
        draft: draft('!', false),
      }),
    ).toBe('Upload failed.');
  });

  it('a cleared server error falls back to the live verdict', () => {
    // The page clears serverError on any edit; what remains is the truth about
    // the current draft, which is null once the draft is valid.
    expect(
      visibleError({ submitAttempted: true, serverError: null, draft: draft('Nova') }),
    ).toBeNull();
  });
});
