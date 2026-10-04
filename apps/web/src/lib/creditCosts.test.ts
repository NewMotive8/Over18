import { describe, expect, it } from 'vitest';
import type { CustomerActionCost } from '@over18/shared';
import type { CustomerEconomyOverview } from './customerEconomy.models';
import {
  actionCost,
  canIllustrate,
  costOf,
  credits,
  creditsFor,
  howManyFor,
  perUnitLabel,
  TEXT_MESSAGE,
  VOICE_CALL,
} from './creditCosts';

/**
 * WHAT THINGS COST, AS THE INTERFACE SAYS IT.
 *
 * The rule these exist to hold: every number shown is the published ruleset's,
 * and an unpriced action produces NO number rather than a plausible one. A
 * screen that invents a price is wrong the moment somebody changes the real
 * one, and nobody finds out until a customer is charged something else.
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

const PRICED = overview([
  cost(),
  cost({ actionType: VOICE_CALL, unit: 'per_minute' }),
]);

describe('the published cost reaches the screen', () => {
  it('reads the chat cost from the catalogue', () => {
    expect(creditsFor(PRICED, TEXT_MESSAGE)).toBe(1);
    expect(perUnitLabel(PRICED, TEXT_MESSAGE)).toBe('1 Credit / message');
  });

  it('reads the call cost from the catalogue', () => {
    expect(creditsFor(PRICED, VOICE_CALL)).toBe(1);
    expect(perUnitLabel(PRICED, VOICE_CALL)).toBe('1 Credit / minute');
  });

  /**
   * THE POINT OF ALL THIS. Change the ruleset and the interface changes with it,
   * because there is no second copy of the price to forget.
   */
  it('follows the ruleset when the price changes', () => {
    const dearer = overview([
      cost({ creditCost: 2 }),
      cost({ actionType: VOICE_CALL, unit: 'per_minute', creditCost: 3 }),
    ]);
    expect(perUnitLabel(dearer, TEXT_MESSAGE)).toBe('2 Credits / message');
    expect(perUnitLabel(dearer, VOICE_CALL)).toBe('3 Credits / minute');
    expect(costOf(dearer, TEXT_MESSAGE, 10)).toBe(20);
    expect(costOf(dearer, VOICE_CALL, 10)).toBe(30);
  });

  it('never says "1 Credits"', () => {
    expect(credits(1)).toBe('1 Credit');
    expect(credits(2)).toBe('2 Credits');
    expect(credits(0)).toBe('0 Credits');
  });
});

describe('an unpriced action produces no number', () => {
  it('is null when the ruleset prices nothing', () => {
    const none = overview([]);
    expect(creditsFor(none, TEXT_MESSAGE)).toBeNull();
    expect(perUnitLabel(none, TEXT_MESSAGE)).toBeNull();
    expect(costOf(none, TEXT_MESSAGE, 10)).toBeNull();
    expect(howManyFor(none, TEXT_MESSAGE, 100)).toBeNull();
  });

  it('is null for an action this ruleset does not price', () => {
    const chatOnly = overview([cost()]);
    expect(creditsFor(chatOnly, VOICE_CALL)).toBeNull();
    expect(perUnitLabel(chatOnly, VOICE_CALL)).toBeNull();
  });

  it('is null before the economy has answered at all', () => {
    expect(creditsFor(null, TEXT_MESSAGE)).toBeNull();
    expect(creditsFor(undefined, TEXT_MESSAGE)).toBeNull();
    expect(creditsFor(overview(undefined as unknown as CustomerActionCost[]), TEXT_MESSAGE)).toBeNull();
  });

  /** A tier is one price of several and cannot stand for "what it costs". */
  it('ignores a duration-tiered cost rather than quoting one tier', () => {
    const tiered = overview([cost({ actionType: 'video', unit: 'per_action', maxDurationSeconds: 30 })]);
    expect(actionCost(tiered, 'video')).toBeNull();
    expect(canIllustrate(cost({ maxDurationSeconds: 30 }))).toBe(false);
  });

  it('ignores a cost quoted for another quality tier', () => {
    expect(creditsFor(overview([cost({ qualityTier: 'high' })]), TEXT_MESSAGE)).toBeNull();
  });
});

describe('the worked example', () => {
  it('multiplies ten messages by the published cost', () => {
    expect(costOf(PRICED, TEXT_MESSAGE, 10)).toBe(10);
  });

  it('multiplies a ten-minute call by the published cost', () => {
    expect(costOf(PRICED, VOICE_CALL, 10)).toBe(10);
  });

  it('refuses a nonsensical quantity rather than inventing one', () => {
    expect(costOf(PRICED, TEXT_MESSAGE, -1)).toBeNull();
    expect(costOf(PRICED, TEXT_MESSAGE, Number.NaN)).toBeNull();
  });
});

describe('what a balance covers', () => {
  it('counts whole messages and whole minutes only', () => {
    expect(howManyFor(PRICED, TEXT_MESSAGE, 100)).toBe(100);
    expect(howManyFor(PRICED, VOICE_CALL, 100)).toBe(100);
  });

  /** Part of a message buys nothing. */
  it('floors, at a price above one', () => {
    const dearer = overview([cost({ creditCost: 3 })]);
    expect(howManyFor(dearer, TEXT_MESSAGE, 10)).toBe(3);
  });

  it('is zero on an empty wallet, not null', () => {
    expect(howManyFor(PRICED, TEXT_MESSAGE, 0)).toBe(0);
  });

  it('says nothing while the balance is unknown', () => {
    expect(howManyFor(PRICED, TEXT_MESSAGE, null)).toBeNull();
  });

  /** "Unlimited" is a claim this screen must not make for the economy. */
  it('says nothing rather than "unlimited" for a zero price', () => {
    expect(howManyFor(overview([cost({ creditCost: 0 })]), TEXT_MESSAGE, 50)).toBeNull();
  });
});
