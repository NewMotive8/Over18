import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { CustomerActionCost } from '@over18/shared';
import type { CustomerEconomyOverview } from '../../lib/customerEconomy';
import HowCreditsWork from './HowCreditsWork';
import { TEXT_MESSAGE, VOICE_CALL } from '../../lib/creditCosts';

/**
 * The Credits Store's explanation of what Credits buy.
 *
 * What these pin: every figure on it is the published ruleset's, the worked
 * example and the capacity line are CALCULATED rather than written, and an
 * economy that prices nothing produces no section at all.
 */

const cost = (over: Partial<CustomerActionCost> = {}): CustomerActionCost => ({
  actionType: TEXT_MESSAGE,
  qualityTier: 'standard',
  unit: 'per_action',
  creditCost: 1,
  maxDurationSeconds: null,
  ...over,
});

const overview = (actionCosts: CustomerActionCost[]): CustomerEconomyOverview =>
  ({ catalog: { asOf: '', plans: [], packs: [], actionCosts } }) as unknown as CustomerEconomyOverview;

const BOTH = [cost(), cost({ actionType: VOICE_CALL, unit: 'per_minute' })];

const render = (actionCosts: CustomerActionCost[], balance: number | null = 100) =>
  renderToStaticMarkup(<HowCreditsWork overview={overview(actionCosts)} balance={balance} />);

describe('it states what each activity costs', () => {
  const html = render(BOTH);

  it('shows the chat and voice prices from the ruleset', () => {
    expect(html).toContain('How Credits work');
    expect(html).toContain('1 Credit / message');
    expect(html).toContain('1 Credit / minute');
  });

  it('works the example out rather than stating it', () => {
    expect(html).toContain('10 messages = 10 Credits');
    expect(html).toContain('a 10-minute call = 10 Credits');
  });

  /**
   * THE WHOLE REASON THIS IS COMPUTED. Change the published price and the page
   * changes with it — no second copy of the number to forget.
   */
  it('recalculates everything when the ruleset price changes', () => {
    const dearer = render([
      cost({ creditCost: 2 }),
      cost({ actionType: VOICE_CALL, unit: 'per_minute', creditCost: 3 }),
    ]);
    expect(dearer).toContain('2 Credits / message');
    expect(dearer).toContain('3 Credits / minute');
    expect(dearer).toContain('10 messages = 20 Credits');
    expect(dearer).toContain('a 10-minute call = 30 Credits');
    // And the old figures are gone, not merely joined.
    expect(dearer).not.toContain('10 messages = 10 Credits');
  });
});

describe('it says what the balance covers', () => {
  it('counts the balance in messages and minutes', () => {
    const html = render(BOTH, 100);
    expect(html).toContain('Your 100 Credits covers');
    expect(html).toContain('100 messages');
    expect(html).toContain('100 minutes of voice');
  });

  /** One pool, not two allowances: a hundred Credits is not a hundred of each. */
  it('says the two are alternatives, not an allowance of each', () => {
    expect(render(BOTH, 100)).toContain('or any combination');
  });

  it('uses the configured price, not the balance, to divide', () => {
    const html = render([cost({ creditCost: 4 }), cost({ actionType: VOICE_CALL, unit: 'per_minute', creditCost: 5 })], 100);
    expect(html).toContain('25 messages');
    expect(html).toContain('20 minutes of voice');
  });

  it('says nothing about capacity while the balance is unknown', () => {
    expect(render(BOTH, null)).not.toContain('covers');
  });
});

describe('an unpriced economy produces no invented price', () => {
  it('renders nothing at all when the ruleset prices neither action', () => {
    expect(render([])).toBe('');
  });

  it('shows only the action that is priced', () => {
    const html = render([cost()]);
    expect(html).toContain('1 Credit / message');
    expect(html).not.toContain('/ minute');
    expect(html).not.toContain('minute call');
  });

  it('never shows a zero or a placeholder price', () => {
    const html = render([cost()]);
    expect(html).not.toContain('0 Credits /');
    expect(html).not.toMatch(/unavailable|unknown|—\s*Credit/i);
  });
});

/**
 * Premium is ACCESS; Credits are CONSUMPTION. A Premium member spends exactly
 * these amounts, so nothing here may hint that the activity is free for them.
 */
describe('it never suggests Premium makes these free', () => {
  it('says nothing about Premium at all', () => {
    const html = render(BOTH);
    expect(html).not.toMatch(/premium/i);
    expect(html).not.toMatch(/free/i);
    expect(html).not.toMatch(/unlimited/i);
  });
});
