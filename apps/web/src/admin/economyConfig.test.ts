import { describe, expect, it } from 'vitest';
import { ApiRequestError } from '../lib/api';
import {
  BILLING_PERIODS,
  EMPTY_PACK_FORM,
  RETIRED_HELP,
  STATE_HELP,
  STATE_LABEL,
  activeOf,
  adminWording,
  availabilityLabel,
  billingPeriodLabel,
  changeValue,
  codeFromName,
  currencySymbol,
  describeChange,
  diffCurrencies,
  diffTitle,
  draftOf,
  draftsChanged,
  emptyPackForm,
  emptyPlanForm,
  emptyRulesetForm,
  featureLabel,
  hasDurationTiers,
  isCancellable,
  itemName,
  moneyText,
  nameByCode,
  newActionCostRow,
  localDateTime,
  packDraftFromForm,
  packFormFrom,
  planDraftFromForm,
  planFormFrom,
  publishRequest,
  rulesetDraftFromForm,
  rulesetFormFrom,
  serverMessages,
  suggestedCurrency,
  unitOf,
  versionRows,
  whatLabel,
  type PlanForm,
} from './economyConfig';
import { configurationView, testCatalogue } from './economyTestData';

/**
 * P1.4 editors, as pure logic. The vocabulary is the server's catalogue (here
 * as the server sends it); every value is test data.
 */

describe('versions', () => {
  it('finds the draft and the active version, and flattens every version newest first', () => {
    const config = configurationView();
    expect(draftOf(config.plans[0]!.versions)?.version).toBe(2);
    expect(activeOf(config.packs[0]!.versions)?.version).toBe(2);
    expect(versionRows(config).map((r) => [r.kind, r.code, r.version, r.state])).toEqual([
      ['plan', 'test_monthly', 2, 'draft'],
      ['plan', 'test_monthly', 1, 'active'],
      ['pack', 'test_small', 3, 'scheduled'],
      ['pack', 'test_small', 2, 'active'],
      ['pack', 'test_small', 1, 'superseded'],
      ['ruleset', null, 1, 'active'],
    ]);
  });

  it('offers cancellation only for a version the server reports as scheduled', () => {
    expect(versionRows(configurationView()).filter(isCancellable).map((r) => r.id)).toEqual(['pack-v3']);
  });

  it('calls plans and packs by name, falling back to the internal ID', () => {
    const config = configurationView();
    expect(itemName(config.plans[0]!)).toBe('Test plan');
    expect(itemName({ code: 'bare', versions: [] })).toBe('bare');
    expect(nameByCode(config, 'pack', 'test_small')).toBe('Test pack');
    expect(nameByCode(config, 'plan', 'gone')).toBe('gone');
    expect(nameByCode(config, 'ruleset', null)).toBeNull();
    expect([whatLabel('plan', 'Premium'), whatLabel('ruleset', null)]).toEqual(['Plan “Premium”', 'Ruleset']);
    expect(versionRows(config)[0]).toMatchObject({ kind: 'plan', code: 'test_monthly', name: 'Test plan' });
    expect(versionRows(config).at(-1)).toMatchObject({ kind: 'ruleset', name: null });
  });

  it('explains every state, and retired, in business words', () => {
    expect(STATE_LABEL).toEqual({ draft: 'Draft', scheduled: 'Scheduled', active: 'Published', superseded: 'Replaced', cancelled: 'Cancelled' });
    for (const help of Object.values(STATE_HELP)) expect(help.length).toBeGreaterThan(20);
    expect([availabilityLabel(true), availabilityLabel(false)]).toEqual(['On sale', 'Retired']);
    expect(RETIRED_HELP).toContain('no longer offered');
  });
});

describe('plan and pack forms', () => {
  it('a new plan form is empty, with one unticked checkbox per catalogue flag -- nothing pre-filled', () => {
    expect(emptyPlanForm(testCatalogue)).toEqual({
      displayName: '',
      billingPeriodMonths: '',
      price: '',
      currency: '',
      includedCredits: '',
      features: { unlimited_text: false, full_character_access: false, advanced_media_access: false, voice_access: false },
      isPurchasable: true,
    });
    expect(Object.values(EMPTY_PACK_FORM).filter((v) => typeof v === 'string')).toEqual(['', '', '', '', '', '', '', '', '']);
  });

  it('round-trips a version through the form into the request the server expects', () => {
    const draft = draftOf(configurationView().plans[0]!.versions)!;
    const built = planDraftFromForm(planFormFrom(draft, testCatalogue));
    expect(built).toEqual({
      ok: true,
      body: {
        displayName: draft.displayName,
        billingPeriodMonths: draft.billingPeriodMonths,
        priceMinor: draft.priceMinor,
        currency: draft.currency,
        monthlyIncludedCredits: draft.monthlyIncludedCredits,
        features: draft.features,
        isPurchasable: draft.isPurchasable,
      },
    });
  });

  it('round-trips every pack version: opening and saving a pack unchanged sends its stored values', () => {
    for (const version of configurationView().packs[0]!.versions) {
      expect(packDraftFromForm(packFormFrom(version))).toEqual({
        ok: true,
        body: {
          displayName: version.displayName,
          credits: version.credits,
          priceMinor: version.priceMinor,
          currency: version.currency,
          sortOrder: version.sortOrder,
          isBestValue: version.isBestValue,
          isPurchasable: version.isPurchasable,
          badge: version.badge ?? null,
          bonusCredits: version.bonusCredits ?? 0,
          wasPriceMinor: version.wasPriceMinor ?? null,
          promotionEndsAt: null,
        },
      });
    }
  });

  it('says what is missing in the words of the form, not the database', () => {
    expect(planDraftFromForm(emptyPlanForm(testCatalogue))).toEqual({
      ok: false,
      errors: [
        'Name: enter the name customers will see.',
        'Billing period: choose Monthly, Quarterly or Annual.',
        'Currency: enter a 3-letter currency code.',
        'Price: enter an amount.',
        'Credits included per billing cycle: enter a number (0 for none).',
      ],
    });
    expect(planDraftFromForm({ ...emptyPlanForm(testCatalogue), displayName: 'P', billingPeriodMonths: '1', price: '5', includedCredits: '0' })).toEqual({
      ok: false,
      errors: ['Currency: enter a 3-letter currency code.', 'Price: choose the currency first, so the amount can be read correctly.'],
    });
    const plan = { ...emptyPlanForm(testCatalogue, 'USD'), displayName: 'Premium', billingPeriodMonths: '1', price: '12.99', includedCredits: '200' };
    expect(planDraftFromForm({ ...plan, price: '' })).toEqual({ ok: false, errors: ['Price: enter an amount.'] });
    expect(planDraftFromForm({ ...plan, price: '12.999' })).toEqual({ ok: false, errors: ['Price: use at most 2 decimal places.'] });
    expect(planDraftFromForm({ ...plan, price: 'twelve' })).toMatchObject({ ok: false, errors: [expect.stringMatching(/^Price: enter a money amount/)] });
    expect(planDraftFromForm({ ...plan, price: '0' })).toEqual({ ok: false, errors: ['Price must be more than zero.'] });
    expect(planDraftFromForm({ ...plan, includedCredits: '1.5' })).toEqual({
      ok: false,
      errors: ['Credits included per billing cycle: enter a whole number, using digits only.'],
    });
    expect(packDraftFromForm(emptyPackForm('USD'))).toEqual({
      ok: false,
      errors: [
        'Name: enter the name customers will see.',
        'Price: enter an amount.',
        'Credits: enter a number.',
        'Position in the store: enter a number (0 for none).',
      ],
    });
    // No message names a stored field or its unit.
    const all = [planDraftFromForm(emptyPlanForm(testCatalogue)), packDraftFromForm(EMPTY_PACK_FORM)].flatMap((r) => (r.ok ? [] : r.errors)).join(' ');
    expect(all).not.toMatch(/minor|\(months\)|priceMinor|billingPeriodMonths/);
  });

  it('a pack draft carries badge, bonus and promotion -- and an empty one carries none', () => {
    const base = { ...emptyPackForm('USD'), displayName: 'Plus', credits: '750', price: '49.99', sortOrder: '2' };
    expect(packDraftFromForm(base)).toMatchObject({ ok: true, body: { priceMinor: 4999, badge: null, bonusCredits: 0, wasPriceMinor: null, promotionEndsAt: null } });

    const ends = new Date(2030, 0, 1, 10, 30);
    const promo = packDraftFromForm({ ...base, badge: ' Best value ', bonusCredits: '100', regularPrice: '$79.99', promotionEndsAt: localDateTime(ends.toISOString()) });
    expect(promo).toEqual({
      ok: true,
      body: expect.objectContaining({ badge: 'Best value', bonusCredits: 100, wasPriceMinor: 7999, promotionEndsAt: ends.toISOString() }),
    });
    expect(packDraftFromForm({ ...base, bonusCredits: 'lots' })).toEqual({ ok: false, errors: ['Bonus Credits: enter a whole number, using digits only.'] });
    expect(packDraftFromForm({ ...base, regularPrice: '39.99' })).toMatchObject({ ok: false, errors: [expect.stringMatching(/^Regular price must be higher than the price/)] });
    expect(packDraftFromForm({ ...base, promotionEndsAt: localDateTime(ends.toISOString()) })).toMatchObject({
      ok: false,
      errors: [expect.stringMatching(/^Promotion ends: a promotion needs a regular price/)],
    });
  });
});

/**
 * THE CONTRACT. What the friendly form sends is exactly what the server was
 * always sent: the same fields, the price in minor units, the term in months.
 */
describe('friendly values become the exact stored values', () => {
  const plan = (over: Partial<PlanForm>) =>
    planDraftFromForm({ ...emptyPlanForm(testCatalogue, 'USD'), displayName: 'Premium', includedCredits: '200', ...over });

  it.each([
    ['Monthly', '$12.99', 1, 1299],
    ['Quarterly', '29.99', 3, 2999],
    ['Annual', '$89.99', 12, 8999],
  ])('%s at %s -> %i months, %i minor units', (label, price, months, priceMinor) => {
    const period = BILLING_PERIODS.find((p) => p.label === label)!;
    expect(period.months).toBe(months);
    expect(plan({ billingPeriodMonths: String(period.months), price })).toEqual({
      ok: true,
      body: {
        displayName: 'Premium',
        billingPeriodMonths: months,
        priceMinor,
        currency: 'USD',
        monthlyIncludedCredits: 200,
        features: { unlimited_text: false, full_character_access: false, advanced_media_access: false, voice_access: false },
        isPurchasable: true,
      },
    });
  });

  it('reads a price however it is typed, to the exact cent -- by digits, never by floating point', () => {
    const minor = (price: string, currency = 'USD') => {
      const built = plan({ billingPeriodMonths: '1', price, currency });
      return built.ok ? built.body.priceMinor : built.errors;
    };
    expect(['12.99', '$12.99', ' 12.99 ', '12.9', '12', '12.', '1,299.00', 'USD 12.99', '0.07', '19.99', '4.35', '1.15'].map((p) => minor(p))).toEqual([
      1299, 1299, 1299, 1290, 1200, 1200, 129900, 1299, 7, 1999, 435, 115,
    ]);
    // A currency without decimals stores the amount as typed, and refuses decimals.
    expect(minor('1500', 'JPY')).toBe(1500);
    expect(minor('15.5', 'JPY')).toEqual(['Price: this currency has no decimal places. Enter a whole amount.']);
    expect(minor('12.99', 'usd')).toBe(1299);
  });

  it('shows a stored amount as the money it is, and types back to the same integer', () => {
    expect([moneyText(1299, 'USD'), moneyText(7, 'USD'), moneyText(129900, 'USD'), moneyText(1500, 'JPY'), moneyText(null, 'USD')]).toEqual([
      '12.99',
      '0.07',
      '1299.00',
      '1500',
      '',
    ]);
    for (const stored of [1, 99, 100, 1299, 2999, 8999, 123456789]) {
      const built = plan({ billingPeriodMonths: '1', price: moneyText(stored, 'USD') });
      expect(built.ok && built.body.priceMinor).toBe(stored);
    }
    expect(currencySymbol('USD')).toBe('$');
    expect(currencySymbol('nope')).toBe('');
  });

  it('names billing periods, and keeps an existing term that is none of the three', () => {
    expect([1, 3, 12, 6].map(billingPeriodLabel)).toEqual(['Monthly', 'Quarterly', 'Annual', 'Every 6 months']);
    expect(plan({ billingPeriodMonths: '6', price: '10' })).toMatchObject({ ok: true, body: { billingPeriodMonths: 6 } });
  });

  it('names features from the catalogue keys, without a list of its own', () => {
    expect(testCatalogue.planFeatures.map(featureLabel)).toEqual(['Unlimited text', 'Full character access', 'Advanced media access', 'Voice access']);
    expect(featureLabel('something_new')).toBe('Something new');
  });

  it('makes the permanent internal ID from the name: valid, unique, never typed', () => {
    const valid = /^[a-z][a-z0-9_]{1,63}$/; // the server's rule
    expect(codeFromName('Premium Monthly', 'plan', [])).toBe('premium_monthly');
    expect(codeFromName('Premium Monthly', 'plan', ['premium_monthly'])).toBe('premium_monthly_2');
    expect(codeFromName('Premium Monthly', 'plan', ['premium_monthly', 'premium_monthly_2'])).toBe('premium_monthly_3');
    expect(codeFromName('100 Credits', 'pack', [])).toBe('pack_100_credits');
    expect(codeFromName('  Best — Value!  ', 'pack', [])).toBe('best_value');
    expect(codeFromName('X', 'plan', [])).toBe('plan_x');
    expect(codeFromName('!!!', 'plan', [])).toBeNull();
    const long = codeFromName('a'.repeat(200), 'plan', ['a'.repeat(64)])!;
    expect(long).toHaveLength(64);
    expect(long).toMatch(valid);
    for (const name of ['Premium Monthly', '100 Credits', 'X', 'Ünïcode Plán', 'a'.repeat(200)]) expect(codeFromName(name, 'pack', [])).toMatch(valid);
  });

  it('suggests the currency the existing products use, only when they agree', () => {
    const config = configurationView();
    expect(suggestedCurrency(config)).toBe('USD');
    config.packs[0]!.versions = config.packs[0]!.versions.map((v) => ({ ...v, currency: 'EUR' }));
    expect(suggestedCurrency(config)).toBe('');
  });
});

describe('the ruleset form', () => {
  it('reads units and duration tiers from the server catalogue', () => {
    expect(unitOf(testCatalogue, 'voice_call')).toBe('per_minute');
    expect(unitOf(testCatalogue, 'teleport')).toBeNull();
    expect(hasDurationTiers(testCatalogue, 'video')).toBe(true);
    expect(hasDurationTiers(testCatalogue, 'image')).toBe(false);
    expect(newActionCostRow(testCatalogue)).toEqual({ actionType: 'image', qualityTier: 'standard', maxDurationSeconds: '', creditCost: '', enabled: true });
  });

  it('an empty ruleset form has a blank field for every catalogue allowance', () => {
    expect(emptyRulesetForm(testCatalogue)).toEqual({
      actionCosts: [],
      allowances: Object.fromEntries(testCatalogue.allowances.map((k) => [k, ''])),
      rewards: [],
    });
  });

  it('round-trips a ruleset: blank allowances are left out, a blank cap means once per user', () => {
    const active = activeOf(configurationView().rulesets)!;
    const form = rulesetFormFrom(active, testCatalogue);
    expect(form.allowances.free_daily_messages).toBe('4');
    expect(form.allowances.grace_period_days).toBe('');
    expect(rulesetDraftFromForm(form, testCatalogue)).toEqual({
      ok: true,
      body: { actionCosts: active.actionCosts, allowances: { free_daily_messages: 4 }, rewards: active.rewards },
    });
  });

  it('names each row that is not a whole number', () => {
    const form = { ...emptyRulesetForm(testCatalogue), actionCosts: [{ ...newActionCostRow(testCatalogue), creditCost: 'lots' }] };
    expect(rulesetDraftFromForm(form, testCatalogue)).toEqual({ ok: false, errors: ['Action cost 1: Credit cost must be a whole number.'] });
  });
});

describe('review and publish', () => {
  it('titles each diff by what it changes, and shows values plainly', () => {
    expect(diffTitle({ kind: 'plan', code: 'p', draftVersion: 2, liveVersion: 1, changes: [] }, 'Premium')).toBe('Plan “Premium”: v1 → v2');
    expect(diffTitle({ kind: 'pack', code: 'k', draftVersion: 1, liveVersion: null, changes: [] })).toBe('Pack “k”: new (v1)');
    expect(diffTitle({ kind: 'ruleset', code: null, draftVersion: 3, liveVersion: 2, changes: [] })).toBe('Ruleset: v2 → v3');
    expect([changeValue(null), changeValue(false), changeValue({ a: 1 })]).toEqual(['—', 'false', '{"a":1}']);
  });

  it('restates a reviewed plan or pack change the way the form asked for it', () => {
    const config = configurationView();
    const diff = {
      kind: 'plan' as const,
      code: 'test_monthly',
      changes: [
        { field: 'priceMinor', before: 1299, after: 1499 },
        { field: 'billingPeriodMonths', before: 1, after: 12 },
        { field: 'monthlyIncludedCredits', before: 200, after: 250 },
        { field: 'isPurchasable', before: true, after: false },
        { field: 'features.voice_access', before: false, after: true },
        { field: 'somethingNew', before: 1, after: 2 },
      ],
    };
    expect(diffCurrencies(config, diff)).toEqual({ before: 'USD', after: 'USD' });
    expect(diff.changes.map((c) => describeChange(diff, c, diffCurrencies(config, diff)))).toEqual([
      { label: 'Price', before: '$12.99', after: '$14.99' },
      { label: 'Billing period', before: 'Monthly', after: 'Annual' },
      { label: 'Credits included per billing cycle', before: '200', after: '250' },
      { label: 'Availability', before: 'On sale', after: 'Retired' },
      { label: 'Feature: Voice access', before: 'Not included', after: 'Included' },
      { label: 'somethingNew', before: '1', after: '2' }, // unknown to the form: shown as the server sent it
    ]);
    // A new item has nothing live: the server reports its currency in the same diff.
    const fresh = {
      kind: 'pack' as const,
      changes: [
        { field: 'priceMinor', before: null, after: 999 },
        { field: 'currency', before: null, after: 'USD' },
      ],
    };
    expect(describeChange(fresh, fresh.changes[0]!)).toEqual({ label: 'Price', before: '—', after: '$9.99' });
    // The ruleset is not a plan or a pack: untouched.
    const rules = { kind: 'ruleset' as const, changes: [{ field: 'allowances.x', before: 1, after: 2 }] };
    expect(describeChange(rules, rules.changes[0]!)).toEqual({ label: 'allowances.x', before: '1', after: '2' });
  });

  it('requires a reason, and sends a scheduled time as an ISO instant', () => {
    expect(publishRequest({ reason: '  ', when: 'now', scheduledAt: '' }, 't')).toEqual({ ok: false, errors: ['A reason is required to publish.'] });
    expect(publishRequest({ reason: 'Launch', when: 'now', scheduledAt: '' }, 't')).toEqual({ ok: true, body: { reason: 'Launch', effectiveFrom: null, draftSetToken: 't' } });
    const scheduled = publishRequest({ reason: 'Later', when: 'scheduled', scheduledAt: '2030-01-02T03:04' }, 't');
    expect(scheduled.ok && scheduled.body.effectiveFrom).toBe(new Date('2030-01-02T03:04').toISOString());
    expect(publishRequest({ reason: 'Later', when: 'scheduled', scheduledAt: '' }, 't')).toEqual({ ok: false, errors: ['Choose when the drafts take effect.'] });
  });

  it("rewrites the server's field-named refusals for the person at the form, and passes on what it does not know", () => {
    expect(
      [
        'priceMinor must be a positive whole number of minor units.',
        'billingPeriodMonths must be a whole number from 1 to 36.',
        'wasPriceMinor must be higher than priceMinor.',
        '"9x" is not a valid code.',
        'Pack b is dearer per Credit than a (USD).',
        'body/billingPeriodMonths must be integer',
        'body/priceMinor must be integer',
      ].map(adminWording),
    ).toEqual([
      'Price must be more than zero.',
      'Billing period: choose Monthly, Quarterly or Annual.',
      'Regular price must be higher than the price: it is the usual price that the promotion is cheaper than.',
      'The internal ID for this item could not be created from its name. Use a name that contains letters.',
      'Pack b is dearer per Credit than a (USD).',
      'Billing period: the value entered is not valid. Check it and try again.',
      'Price: the value entered is not valid. Check it and try again.',
    ]);
    const refused = new ApiRequestError(400, 'invalid_draft', 'Request failed (400).', {
      error: 'invalid_draft',
      messages: ['priceMinor must be a positive whole number of minor units.', 'billingPeriodMonths must be a whole number from 1 to 36.'],
    });
    expect(serverMessages(refused)).toEqual(['Price must be more than zero.', 'Billing period: choose Monthly, Quarterly or Annual.']);
  });

  it("shows the server's own messages, and recognises changed drafts", () => {
    const refused = new ApiRequestError(409, 'not_publishable', 'Plan p: features.voice_access must be stated before publishing.', {
      error: 'not_publishable',
      messages: ['Plan p: features.voice_access must be stated before publishing.', 'Ruleset: allowances.grace_period_days must be set before publishing.'],
    });
    expect(serverMessages(refused)).toHaveLength(2);
    expect(serverMessages(new ApiRequestError(403, 'forbidden', 'This action requires the economy.manage permission.'))).toEqual([
      'This action requires the economy.manage permission.',
    ]);
    expect(draftsChanged(new ApiRequestError(409, 'drafts_changed', 'Changed'))).toBe(true);
    expect(draftsChanged(refused)).toBe(false);
  });
});
