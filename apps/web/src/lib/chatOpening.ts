import type { ChatMessage } from '@over18/shared';

/**
 * Client-side rules for the character's opening message.
 *
 * The GUARANTEE that only one greeting is ever created is the server's, and
 * deliberately so: two tabs, a double tap and a refresh mid-flight are all
 * concurrent requests that no amount of client state can arbitrate between.
 * Everything here is about DISPLAY — when to ask, and where the greeting goes
 * once it arrives.
 */

/**
 * Ask for a greeting only for a conversation with no history.
 *
 * Not "was it just created". A conversation whose greeting failed the first
 * time is still empty, and should get one when he comes back — which is exactly
 * what emptiness expresses and a creation flag does not.
 */
export function shouldRequestOpening(history: ChatMessage[]): boolean {
  return history.length === 0;
}

/**
 * Places an arriving greeting in the list.
 *
 * PREPENDED, NEVER APPENDED. The server creates a greeting only while the
 * conversation is empty, so a greeting that exists is by construction the first
 * message in it. Appending would be right in the common case and visibly wrong
 * in the one that matters: if he types before the greeting lands, appending
 * shows her greeting him AFTER he has already spoken.
 *
 * Idempotent by id, so a re-render, a re-fetch or a second response cannot
 * produce two identical bubbles.
 */
export function mergeOpeningMessage(messages: ChatMessage[], opening: ChatMessage): ChatMessage[] {
  if (messages.some((message) => message.id === opening.id)) return messages;
  return [opening, ...messages];
}
