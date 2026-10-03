import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AGE_CONFIRMED_KEY,
  CONFIRMATION_TTL_MS,
  MINIMUM_AGE,
  clearConfirmation,
  initialStatus,
  isConfirmationFresh,
  readConfirmation,
  writeConfirmation,
} from './ageGate';

/**
 * The age gate's rules.
 *
 * The freshness decision is pure and gets the bulk of the assertions; the
 * storage wrapper is exercised against a stand-in `localStorage`, including the
 * ones that throw, because private mode and blocked site data are the states
 * where a gate must degrade rather than break.
 */

const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);

function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: () => null,
    length: 0,
    read: (k: string) => map.get(k) ?? null,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('what counts as a confirmation', () => {
  it('accepts one made just now', () => {
    expect(isConfirmationFresh(String(NOW), NOW)).toBe(true);
  });

  it('accepts one inside the window', () => {
    expect(isConfirmationFresh(String(NOW - CONFIRMATION_TTL_MS + 1_000), NOW)).toBe(true);
  });

  /** Bounded on purpose: a borrowed device should not carry an answer forever. */
  it('expires one at the window', () => {
    expect(isConfirmationFresh(String(NOW - CONFIRMATION_TTL_MS), NOW)).toBe(false);
    expect(isConfirmationFresh(String(NOW - CONFIRMATION_TTL_MS - 1), NOW)).toBe(false);
  });

  /**
   * A TIMESTAMP FROM THE FUTURE IS NOT TRUSTED. It cannot have been written by
   * a clock that agrees with this one, so it is a wrong clock or a hand-edited
   * value -- and asking again costs one tap, where believing it could keep the
   * gate open indefinitely.
   */
  it('refuses one from the future', () => {
    expect(isConfirmationFresh(String(NOW + 1), NOW)).toBe(false);
    expect(isConfirmationFresh(String(NOW + CONFIRMATION_TTL_MS * 100), NOW)).toBe(false);
  });

  it.each([
    ['nothing stored', null],
    ['an empty string', ''],
    ['whitespace', '   '],
    ['text', 'yes'],
    ['a boolean', 'true'],
    ['zero', '0'],
    ['a negative number', '-1'],
    ['not a number', 'NaN'],
    ['infinity', 'Infinity'],
  ])('refuses %s', (_label, raw) => {
    expect(isConfirmationFresh(raw, NOW)).toBe(false);
  });
});

describe('the browser copy', () => {
  it('round-trips a confirmation', () => {
    const storage = fakeStorage();
    vi.stubGlobal('localStorage', storage);

    expect(readConfirmation(NOW)).toBe(false);
    writeConfirmation(NOW);
    expect(storage.read(AGE_CONFIRMED_KEY)).toBe(String(NOW));
    expect(readConfirmation(NOW)).toBe(true);

    clearConfirmation();
    expect(readConfirmation(NOW)).toBe(false);
  });

  it('opens on the question when nothing is stored, and on the app when it is', () => {
    vi.stubGlobal('localStorage', fakeStorage());
    expect(initialStatus(NOW)).toBe('asking');

    writeConfirmation(NOW);
    expect(initialStatus(NOW)).toBe('confirmed');
  });

  /**
   * ASKS AGAIN RATHER THAN CRASHING. `localStorage` throws outright in some
   * privacy modes, and the failure a visitor should get is one extra tap.
   */
  it('survives storage that throws on every call', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
      removeItem: () => {
        throw new Error('denied');
      },
    });

    expect(() => writeConfirmation(NOW)).not.toThrow();
    expect(() => clearConfirmation()).not.toThrow();
    expect(readConfirmation(NOW)).toBe(false);
    expect(initialStatus(NOW)).toBe('asking');
  });

  it('survives there being no storage at all', () => {
    vi.stubGlobal('localStorage', undefined);
    expect(readConfirmation(NOW)).toBe(false);
    expect(() => writeConfirmation(NOW)).not.toThrow();
  });
});

describe('what the gate is', () => {
  it('asks about eighteen', () => {
    expect(MINIMUM_AGE).toBe(18);
  });

  /**
   * NOT A COOKIE, AND THAT IS THE POINT. Confirming an age must not be
   * recordable as consent to anything else, so it never touches `document.cookie`
   * and the value it keeps is one timestamp.
   */
  it('keeps its answer out of cookies', () => {
    const storage = fakeStorage();
    vi.stubGlobal('localStorage', storage);
    const cookie = { value: '' };
    vi.stubGlobal('document', {
      get cookie() {
        return cookie.value;
      },
      set cookie(next: string) {
        cookie.value = next;
      },
    });

    writeConfirmation(NOW);

    expect(cookie.value).toBe('');
    expect(storage.read(AGE_CONFIRMED_KEY)).toBe(String(NOW));
  });
});
