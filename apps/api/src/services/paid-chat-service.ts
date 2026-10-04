import { randomUUID } from 'node:crypto';
import type { SendMessageResult } from '@over18/shared';
import type { Db } from '../db/client.js';
import type { CommerceEnv } from '../env.js';
import { getConversationForUser } from './conversation-service.js';
import { PaidActionError, runPaidAction } from './paid-action-service.js';
import { WalletError } from './wallet-service.js';

/**
 * CHARGING FOR A CHAT EXCHANGE (`text_message`).
 *
 * This module decides WHEN Credits are charged for chat and WHAT a refusal
 * means. It decides no price: the amount comes from the published ruleset
 * through the paid-action framework, exactly as every other paid action's does.
 * It knows nothing about the model, the prompt or media either -- the exchange
 * itself is handed in as `send`, so the charging and the chatting stay separable.
 *
 * THE CREDITS ARE RESERVED BEFORE THE MODEL IS CALLED and consumed only after
 * the exchange comes off. `runPaidAction` releases the reservation if `send`
 * throws, so a failed generation leaves the balance exactly as it was -- which
 * is the one thing a customer would notice immediately if it were wrong.
 *
 * PREMIUM DOES NOT MAKE CHAT FREE. Nothing here reads the subscription: Premium
 * is access, Credits are consumption (the Credits Store's own rule), so a
 * Premium customer with no Credits is refused exactly like anyone else. That is
 * a deliberate commercial decision, not an oversight.
 *
 * FAIL CLOSED. While the economy is ON, an exchange that cannot be priced is
 * refused rather than given away: no published ruleset, or a ruleset with no
 * enabled `text_message` cost, both mean no chat. Missing configuration is never
 * read as "free". While the economy is OFF, chat is not a paid action at all and
 * runs untouched -- the same convention every other money surface follows.
 *
 * AN OPENING GREETING IS NOT CHARGED, and cannot be: it is produced by
 * `conversation-opening-service` on its own path, which never comes through
 * here. The visitor did not ask for it.
 */

export const TEXT_MESSAGE_ACTION = 'text_message';

export type ChatCreditErrorCode =
  /** The wallet cannot cover the exchange -- including having no wallet at all. */
  | 'insufficient_credits'
  /** The economy is on but nothing prices a chat exchange. */
  | 'not_priced';

export class ChatCreditError extends Error {
  constructor(
    public readonly code: ChatCreditErrorCode,
    message: string,
    /** The underlying resolver or wallet reason, for logs — never shown to a customer. */
    public readonly reason?: string,
  ) {
    super(message);
    this.name = 'ChatCreditError';
  }
}

/**
 * Thrown by the work when the conversation turned out not to be the caller's
 * after all, so the reservation is released rather than captured. It never
 * leaves this module: the caller gets `null`, exactly as an unpaid send would
 * have given them.
 */
class ConversationGone extends Error {}

/**
 * A chat exchange, charged.
 *
 * Ownership is checked BEFORE any Credits move, so probing someone else's
 * conversation costs nothing and leaves no reservation behind.
 *
 * Each send is its own action with its own key: the HTTP API has no idempotency
 * key for messages, and inventing a stable one would make a genuine second
 * message silently free. A client that retries a timed-out send charges twice
 * and gets two exchanges — which is what it does today, unpaid.
 */
export async function sendChargedMessage(
  db: Db,
  commerce: Pick<CommerceEnv, 'enabled'>,
  input: { userId: string; conversationId: string; requestId?: string | null },
  send: () => Promise<SendMessageResult | null>,
): Promise<SendMessageResult | null> {
  // Not a paid action while the economy is off: chat behaves as it always has.
  if (!commerce.enabled) return send();

  const conversation = await getConversationForUser(db, input.userId, input.conversationId);
  if (!conversation) return null;

  try {
    const run = await runPaidAction(
      db,
      commerce,
      {
        userId: input.userId,
        actionType: TEXT_MESSAGE_ACTION,
        idempotencyKey: `chat:${input.conversationId}:${randomUUID()}`,
        requestId: input.requestId ?? null,
        metadata: { conversationId: input.conversationId },
      },
      async () => {
        const result = await send();
        if (result === null) throw new ConversationGone();
        return result;
      },
    );
    // A fresh key is never a replay, so the result is always the work's.
    return run.replayed ? null : run.result;
  } catch (error) {
    if (error instanceof ConversationGone) return null;
    throw asChatCreditError(error);
  }
}

/**
 * The two refusals a customer can do something about, told apart from genuine
 * faults. Everything else propagates unchanged -- a database failure must not
 * be reported to someone as "you need more Credits".
 */
function asChatCreditError(error: unknown): unknown {
  if (error instanceof WalletError) {
    // No wallet row at all is the same situation as an empty one: a customer who
    // has never held a Credit cannot pay for an exchange.
    if (error.code === 'insufficient_credits' || error.code === 'wallet_not_found') {
      return new ChatCreditError('insufficient_credits', 'Not enough Credits for this message.', error.code);
    }
    return error;
  }
  if (error instanceof PaidActionError && (error.code === 'not_priced' || error.code === 'configuration_changed')) {
    return new ChatCreditError(
      'not_priced',
      'Chat is not available right now.',
      error.reason ?? error.code,
    );
  }
  return error;
}
