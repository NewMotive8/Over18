import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@over18/shared';
import { mergeOpeningMessage, shouldRequestOpening } from './chatOpening';

/**
 * How the client places an arriving greeting.
 *
 * The promise that only one greeting is ever created is the server's. What can
 * go wrong here is ORDER: the greeting is requested when the chat opens and can
 * land after he has already typed something.
 */

const message = (id: string, sender: 'user' | 'character', content: string): ChatMessage => ({
  id,
  sender,
  content,
  createdAt: '2026-09-29T10:00:00.000Z',
});

const GREETING = message('g1', 'character', "You're here. How was your day?");

describe('when to ask for a greeting', () => {
  it('asks for an empty conversation', () => {
    expect(shouldRequestOpening([])).toBe(true);
  });

  it('does not ask when anything has been said', () => {
    expect(shouldRequestOpening([message('m1', 'user', 'hi')])).toBe(false);
    expect(shouldRequestOpening([message('m1', 'character', 'hello you')])).toBe(false);
  });
});

describe('where an arriving greeting goes', () => {
  it('is the only message in a conversation that had none', () => {
    expect(mergeOpeningMessage([], GREETING)).toEqual([GREETING]);
  });

  /**
   * THE CASE THAT DECIDES PREPEND VERSUS APPEND. He typed while the greeting was
   * still being generated, and the server put the greeting first. Appending here
   * would show her greeting him after he had already spoken.
   */
  it('goes before a message he sent while it was being generated', () => {
    const his = message('m1', 'user', 'hey, you there?');
    const hers = message('m2', 'character', 'I am now.');

    expect(mergeOpeningMessage([his, hers], GREETING).map((m) => m.id)).toEqual([
      'g1',
      'm1',
      'm2',
    ]);
  });

  it('cannot produce the same bubble twice', () => {
    const once = mergeOpeningMessage([], GREETING);
    expect(mergeOpeningMessage(once, GREETING)).toEqual(once);
  });

  it('leaves the existing messages untouched', () => {
    const existing = [message('m1', 'user', 'hi')];
    const merged = mergeOpeningMessage(existing, GREETING);

    expect(existing).toHaveLength(1); // no mutation
    expect(merged.slice(1)).toEqual(existing);
  });
});
