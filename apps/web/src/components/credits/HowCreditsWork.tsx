import type { CustomerEconomyOverview } from '../../lib/customerEconomy';
import { costOf, credits, howManyFor, perUnitLabel, TEXT_MESSAGE, VOICE_CALL } from '../../lib/creditCosts';

/**
 * HOW CREDITS WORK — the one place that answers "what does this cost me?".
 *
 * EVERY NUMBER IS THE PUBLISHED RULESET'S. Nothing here is written down: the
 * per-unit prices, the worked example and the capacity line are all computed
 * from the costs the catalogue serves. Change chat to 2 Credits in the Economy
 * admin and this section says two, and says a ten-message example costs twenty,
 * without anybody editing it.
 *
 * AN UNPRICED ACTION IS SIMPLY ABSENT. No "unavailable", no zero, no guess --
 * the row does not render. If neither action is priced the whole section stays
 * away rather than appearing empty, because a heading over nothing is worse
 * than no heading.
 *
 * ILLUSTRATIVE, NOT A RESERVATION. The capacity line says "or any combination"
 * because Credits are one pool: a hundred Credits is a hundred messages OR a
 * hundred minutes, never both, and a screen that implied otherwise would be
 * promising twice what it has.
 *
 * PREMIUM IS NOT MENTIONED, deliberately. Premium is access and Credits are
 * consumption; a Premium member spends exactly these amounts, and any line
 * hinting at "free with Premium" here would contradict the economy.
 */

/** Ten of something: enough to make the multiplication obvious, small enough to be real. */
const EXAMPLE_QUANTITY = 10;

export default function HowCreditsWork({
  overview,
  balance,
}: {
  overview: CustomerEconomyOverview | null;
  /** Spendable Credits, or null while the server has not said. */
  balance: number | null;
}) {
  const perMessage = perUnitLabel(overview, TEXT_MESSAGE);
  const perMinute = perUnitLabel(overview, VOICE_CALL);
  if (!perMessage && !perMinute) return null;

  const messagesExample = costOf(overview, TEXT_MESSAGE, EXAMPLE_QUANTITY);
  const minutesExample = costOf(overview, VOICE_CALL, EXAMPLE_QUANTITY);
  const messagesAffordable = howManyFor(overview, TEXT_MESSAGE, balance);
  const minutesAffordable = howManyFor(overview, VOICE_CALL, balance);
  const showCapacity = balance !== null && (messagesAffordable !== null || minutesAffordable !== null);

  return (
    <section
      aria-labelledby="how-credits-work"
      data-testid="how-credits-work"
      className="flex flex-col gap-3 rounded-2xl border border-zinc-800 bg-zinc-900/40 px-4 py-3.5"
    >
      <h2 id="how-credits-work" className="text-sm font-semibold text-white">
        How Credits work
      </h2>

      <dl className="flex flex-col gap-1.5 text-sm">
        {perMessage && (
          <div data-testid="cost-chat" className="flex items-baseline justify-between gap-3">
            <dt className="text-zinc-400">💬 Chat</dt>
            <dd className="font-medium text-zinc-100">{perMessage}</dd>
          </div>
        )}
        {perMinute && (
          <div data-testid="cost-voice" className="flex items-baseline justify-between gap-3">
            <dt className="text-zinc-400">📞 Voice</dt>
            <dd className="font-medium text-zinc-100">{perMinute}</dd>
          </div>
        )}
      </dl>

      {(messagesExample !== null || minutesExample !== null) && (
        <p data-testid="credits-example" className="text-xs leading-relaxed text-zinc-400">
          For example:{' '}
          {messagesExample !== null && (
            <span className="whitespace-nowrap">
              {EXAMPLE_QUANTITY} messages = {credits(messagesExample)}
            </span>
          )}
          {messagesExample !== null && minutesExample !== null && ' · '}
          {minutesExample !== null && (
            <span className="whitespace-nowrap">
              a {EXAMPLE_QUANTITY}-minute call = {credits(minutesExample)}
            </span>
          )}
        </p>
      )}

      {showCapacity && (
        <p data-testid="credits-capacity" className="border-t border-zinc-800 pt-2.5 text-xs leading-relaxed text-zinc-400">
          Your {credits(balance)} covers{' '}
          {messagesAffordable !== null && <span className="text-zinc-200">{messagesAffordable} messages</span>}
          {messagesAffordable !== null && minutesAffordable !== null && <span> or </span>}
          {minutesAffordable !== null && <span className="text-zinc-200">{minutesAffordable} minutes of voice</span>}
          {/* One pool, not two allowances. */}
          {messagesAffordable !== null && minutesAffordable !== null && ' — or any combination.'}
        </p>
      )}
    </section>
  );
}
