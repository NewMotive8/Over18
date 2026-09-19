import { describe, expect, it } from 'vitest';
import { ApiRequestError } from '../lib/api';
import {
  EMPTY_PACK_FORM,
  activeOf,
  changeValue,
  diffTitle,
  draftOf,
  draftsChanged,
  emptyPlanForm,
  emptyRulesetForm,
  hasDurationTiers,
  isCancellable,
  newActionCostRow,
  packDraftFromForm,
  planDraftFromForm,
  planFormFrom,
  publishRequest,
  rulesetDraftFromForm,
  rulesetFormFrom,
  serverMessages,
  unitOf,
  versionRows,
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
});

describe('plan and pack forms', () => {
  it('a new plan form is empty, with one unticked checkbox per catalogue flag -- nothing pre-filled', () => {
    expect(emptyPlanForm(testCatalogue)).toEqual({
      displayName: '',
      billingPeriodMonths: '',
      priceMinor: '',
      currency: '',
      monthlyIncludedCredits: '',
      features: { unlimited_text: false, full_character_access: false, advanced_media_access: false, voice_access: false },
      isPurchasable: true,
    });
    expect(Object.values(EMPTY_PACK_FORM).filter((v) => typeof v === 'string')).toEqual(['', '', '', '', '']);
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

  it('checks only that numbers are whole numbers -- ranges are the server’s', () => {
    const form = { ...emptyPlanForm(testCatalogue), displayName: 'x', currency: 'usd', billingPeriodMonths: '999', priceMinor: '-5', monthlyIncludedCredits: '1.5' };
    expect(planDraftFromForm(form)).toEqual({ ok: false, errors: ['Monthly included Credits must be a whole number.'] });
    // 999 months, a negative price and a lower-case currency pass through, for the server to refuse.
    const passes = planDraftFromForm({ ...form, monthlyIncludedCredits: '0' });
    expect(passes).toMatchObject({ ok: true, body: { billingPeriodMonths: 999, priceMinor: -5, currency: 'usd' } });
    expect(packDraftFromForm(EMPTY_PACK_FORM)).toEqual({
      ok: false,
      errors: ['Credits is required.', 'Price (minor units) is required.', 'Ladder position is required.'],
    });
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
    expect(diffTitle({ kind: 'plan', code: 'p', draftVersion: 2, liveVersion: 1, changes: [] })).toBe('Plan p: v1 → v2');
    expect(diffTitle({ kind: 'pack', code: 'k', draftVersion: 1, liveVersion: null, changes: [] })).toBe('Pack k: new (v1)');
    expect(diffTitle({ kind: 'ruleset', code: null, draftVersion: 3, liveVersion: 2, changes: [] })).toBe('Ruleset: v2 → v3');
    expect([changeValue(null), changeValue(false), changeValue({ a: 1 })]).toEqual(['—', 'false', '{"a":1}']);
  });

  it('requires a reason, and sends a scheduled time as an ISO instant', () => {
    expect(publishRequest({ reason: '  ', when: 'now', scheduledAt: '' }, 't')).toEqual({ ok: false, errors: ['A reason is required to publish.'] });
    expect(publishRequest({ reason: 'Launch', when: 'now', scheduledAt: '' }, 't')).toEqual({ ok: true, body: { reason: 'Launch', effectiveFrom: null, draftSetToken: 't' } });
    const scheduled = publishRequest({ reason: 'Later', when: 'scheduled', scheduledAt: '2030-01-02T03:04' }, 't');
    expect(scheduled.ok && scheduled.body.effectiveFrom).toBe(new Date('2030-01-02T03:04').toISOString());
    expect(publishRequest({ reason: 'Later', when: 'scheduled', scheduledAt: '' }, 't')).toEqual({ ok: false, errors: ['Choose when the drafts take effect.'] });
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
