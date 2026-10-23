import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import AgeConfirmationPanel, {
  ageBoxValue,
  pendingForAgeReview,
  readyConfirmations,
  rowIsReady,
  tickedWithoutAge,
} from './AgeConfirmationPanel';
import type { AdminCharacterListItem } from '../../lib/api';

/**
 * THE AGE REVIEW SCREEN.
 *
 * Two properties carry the weight. Every character without a confirmed age is
 * editable here, including the ones no model has guessed at -- an earlier
 * version listed those as a read-only footnote, which made the characters
 * needing the most attention the only ones that could not be dealt with. And
 * nothing is submitted that an operator did not tick AND fill, because this is
 * precisely where "confirmed by a person" would otherwise erode into "accepted
 * in bulk".
 *
 * The suite renders to static markup in a node environment, so the rules live
 * in exported pure functions and are tested directly rather than through
 * clicks.
 */

const character = (over: Partial<AdminCharacterListItem>): AdminCharacterListItem =>
  ({
    id: over.id ?? `id-${over.name}`,
    name: over.name ?? 'anon',
    displayName: over.displayName ?? over.name ?? 'Anon',
    profileImage: null,
    shortBio: '',
    personality: '',
    interests: [],
    conversationStyle: '',
    systemPrompt: '',
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    profileComplete: true,
    missingProfileFields: [],
    liveCallVoice: null,
    age: null,
    suggestedAge: null,
    countryCode: null,
    region: null,
    city: null,
    timezone: null,
    activeIdentityVersion: 1,
    identityVersionCount: 1,
    primaryReferenceCount: 1,
    profileDivergence: 'consistent',
    ...over,
  }) as AdminCharacterListItem;

const AMANDA = character({ name: 'amanda', displayName: 'Amanda', suggestedAge: 29 });
const CAMILA = character({ name: 'camila', displayName: 'Camila', suggestedAge: null });
const OLGA = character({ name: 'olga', displayName: 'Olga', age: 41, suggestedAge: 41 });

const markup = (characters: AdminCharacterListItem[]) =>
  renderToStaticMarkup(<AgeConfirmationPanel characters={characters} onConfirmed={() => {}} />);

/* ------------------------------------------------------------------ *
 * Which characters appear
 * ------------------------------------------------------------------ */

describe('pendingForAgeReview', () => {
  it('includes a character with no suggestion, which is the whole change', () => {
    const pending = pendingForAgeReview([AMANDA, CAMILA]);
    expect(pending.map((c) => c.name)).toContain('camila');
    expect(pending).toHaveLength(2);
  });

  it('excludes anyone who already has a confirmed age', () => {
    expect(pendingForAgeReview([AMANDA, OLGA]).map((c) => c.name)).toEqual(['amanda']);
  });

  it('puts the suggested ones first, then orders by name', () => {
    const zoe = character({ name: 'zoe', displayName: 'Zoe', suggestedAge: 28 });
    const ana = character({ name: 'ana', displayName: 'Ana', suggestedAge: null });
    const order = pendingForAgeReview([ana, CAMILA, zoe, AMANDA]).map((c) => c.name);
    // Quick decisions first; clearing them shortens the list that needs thought.
    expect(order).toEqual(['amanda', 'zoe', 'ana', 'camila']);
  });

  it('is empty when the whole roster is confirmed', () => {
    expect(pendingForAgeReview([OLGA])).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * Prefilling
 * ------------------------------------------------------------------ */

describe('ageBoxValue', () => {
  it('prefills a suggestion', () => {
    expect(ageBoxValue(AMANDA, {})).toBe('29');
  });

  it('leaves a box blank when nothing has guessed her age', () => {
    expect(ageBoxValue(CAMILA, {})).toBe('');
  });

  it('prefers an edit over the suggestion, including clearing it', () => {
    expect(ageBoxValue(AMANDA, { [AMANDA.id]: '31' })).toBe('31');
    // An operator deleting a prefilled number must not have it reappear.
    expect(ageBoxValue(AMANDA, { [AMANDA.id]: '' })).toBe('');
  });
});

/* ------------------------------------------------------------------ *
 * Nothing is confirmed that was not chosen
 * ------------------------------------------------------------------ */

describe('what may be submitted', () => {
  it('sends nothing until a row is ticked, however it is prefilled', () => {
    expect(readyConfirmations([AMANDA], {}, {})).toEqual([]);
    expect(rowIsReady(AMANDA, {}, {})).toBe(false);
  });

  it('sends a ticked prefill as-is', () => {
    expect(readyConfirmations([AMANDA], { [AMANDA.id]: true }, {})).toEqual([
      { characterId: AMANDA.id, age: 29 },
    ]);
  });

  it('sends the edited number rather than the suggestion', () => {
    expect(
      readyConfirmations([AMANDA], { [AMANDA.id]: true }, { [AMANDA.id]: '31' }),
    ).toEqual([{ characterId: AMANDA.id, age: 31 }]);
  });

  it('sends an age for a character who never had a suggestion', () => {
    expect(
      readyConfirmations([CAMILA], { [CAMILA.id]: true }, { [CAMILA.id]: '27' }),
    ).toEqual([{ characterId: CAMILA.id, age: 27 }]);
  });

  it('refuses a ticked row with an empty box', () => {
    /**
     * The trap for every character with no prefill: ticked, blank, and silently
     * sending nothing while the screen reports success.
     */
    expect(rowIsReady(CAMILA, { [CAMILA.id]: true }, {})).toBe(false);
    expect(readyConfirmations([CAMILA], { [CAMILA.id]: true }, {})).toEqual([]);
  });

  it('refuses a fractional or non-numeric age', () => {
    for (const bad of ['27.5', 'twenty', '-', ' ']) {
      expect(rowIsReady(CAMILA, { [CAMILA.id]: true }, { [CAMILA.id]: bad }), bad).toBe(false);
    }
  });

  it('sends only the ticked rows out of several', () => {
    const payload = readyConfirmations(
      [AMANDA, CAMILA],
      { [CAMILA.id]: true },
      { [CAMILA.id]: '27' },
    );
    expect(payload).toEqual([{ characterId: CAMILA.id, age: 27 }]);
  });

  it('names the ticked rows that still need a number', () => {
    const incomplete = tickedWithoutAge(
      [AMANDA, CAMILA],
      { [AMANDA.id]: true, [CAMILA.id]: true },
      {},
    );
    expect(incomplete.map((c) => c.displayName)).toEqual(['Camila']);
  });
});

/* ------------------------------------------------------------------ *
 * What the screen shows
 * ------------------------------------------------------------------ */

describe('the rendered panel', () => {
  it('gives every pending character a checkbox and an age box', () => {
    const html = markup([AMANDA, CAMILA]);
    for (const name of ['amanda', 'camila']) {
      expect(html).toContain(`age-check-${name}`);
      expect(html).toContain(`age-input-${name}`);
    }
  });

  it('labels whether a row has a suggestion at all', () => {
    const html = markup([AMANDA, CAMILA]);
    expect(html).toContain('suggested 29');
    expect(html).toContain('no suggestion');
  });

  it('prefills the suggestion into the box and leaves the other empty', () => {
    const html = markup([AMANDA, CAMILA]);
    expect(html).toMatch(/data-testid="age-input-amanda"[^>]*value="29"/);
    expect(html).toMatch(/value=""[^>]*data-testid="age-input-camila"|data-testid="age-input-camila"[^>]*value=""/);
  });

  it('shows her portrait, resolved to an absolute URL', () => {
    const mika = character({
      name: 'mika',
      displayName: 'Mika',
      profileImage: '/api/media/mika.jpg',
    });
    const html = markup([mika]);
    expect(html).toContain('age-thumb-mika');
    expect(html).toContain('/api/media/mika.jpg');
    expect(html).toContain('alt="Mika"');
  });

  it('says "no photo" rather than rendering a blank box', () => {
    // Having no portrait is itself why her age cannot be judged from here.
    const html = markup([CAMILA]);
    expect(html).toContain('age-thumb-missing-camila');
    expect(html).not.toContain('age-thumb-camila"');
  });

  it('offers a bulk select only for the suggested rows', () => {
    expect(markup([AMANDA, CAMILA])).toContain('age-select-suggested');
    // With nothing suggested there is no "accept the suggestions" shortcut.
    expect(markup([CAMILA])).not.toContain('age-select-suggested');
  });

  it('starts with the confirm button disabled, because nothing is ticked', () => {
    const html = markup([AMANDA]);
    expect(html).toMatch(/data-testid="age-confirm"[^>]*disabled|disabled[^>]*data-testid="age-confirm"/);
  });

  it('reports a clean roster and offers no list', () => {
    const html = markup([OLGA]);
    expect(html).toContain('Every character has a confirmed age');
    expect(html).not.toContain('age-list');
  });

  it('counts the backlog and how much of it is suggested', () => {
    const html = markup([AMANDA, CAMILA]);
    expect(html).toContain('2 without one');
    expect(html).toContain('1 with a suggestion');
  });
});
