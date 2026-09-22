import type { EconomyConfigurationView, EconomyPublishReview } from '@over18/shared';
import type { EconomyPreviewResponse } from '../lib/api';

/**
 * TEST DATA ONLY: a server-shaped P1.3 preview response, as the admin screens
 * receive it. Its figures are arithmetic fixtures chosen by the tests, not
 * business values, and nothing in the application imports this file.
 */
export function previewResponse(over: Partial<EconomyPreviewResponse> = {}): EconomyPreviewResponse {
  const usd = (amount: string) => ({ amount, currency: 'USD' });
  return {
    asOf: '2026-09-19T12:00:00.000000Z',
    mode: 'drafted',
    configuration: {
      plans: [{ code: 'test_monthly', version: 2, source: 'draft', isPurchasable: true }],
      packs: [
        { code: 'test_small', version: 1, source: 'live', isPurchasable: true },
        { code: 'test_large', version: 1, source: 'live', isPurchasable: true },
      ],
      ruleset: { version: 3, source: 'draft' },
    },
    ladders: [
      {
        currency: 'USD',
        rungs: [
          { code: 'test_small', credits: 100, price: usd('10.00'), perCredit: usd('0.100'), isBestValue: false },
          { code: 'test_large', credits: 250, price: usd('20.00'), perCredit: usd('0.080'), isBestValue: true },
        ],
        spreadPercent: '20',
        issues: [],
      },
    ],
    grants: [
      {
        plan: 'test_monthly',
        version: 2,
        source: 'draft',
        monthlyCredits: 100,
        buys: [
          { action: 'image/standard/any', unit: 'per_action', creditCost: 10, quantity: 10 },
          { action: 'voice_call/standard/any', unit: 'per_minute', creditCost: 5, quantity: 20 },
        ],
        worstCaseAiProviderCost: { status: 'incomplete', knownWorst: null, missingCosts: ['image/standard/any', 'voice_call/standard/any'] },
      },
    ],
    actions: [
      {
        action: 'image/standard/any',
        actionType: 'image',
        qualityTier: 'standard',
        maxDurationSeconds: null,
        unit: 'per_action',
        creditCost: 10,
        runtime: 'priced',
        cashPrice: [{ pack: 'test_small', price: usd('1.00') }],
        aiProviderCost: { status: 'incomplete', gaps: [{ reason: 'usage_not_supplied', ref: 'image/standard/any' }] },
        aiProviderCostPerCredit: null,
        grossMargins: [],
        otherCosts: { lines: [], infrastructure: 'not_supplied' },
        net: { status: 'incomplete', gaps: [{ reason: 'sales_channel_not_supplied', ref: 'sales_channels' }] },
        guard: 'not_evaluated',
        netGuard: 'not_evaluated',
      },
    ],
    subscriptions: [
      {
        plan: 'test_monthly',
        version: 2,
        source: 'draft',
        pricePerMonth: usd('12.00'),
        includedUsage: { status: 'incomplete', gaps: [{ reason: 'usage_not_supplied', ref: 'plan:test_monthly' }] },
        grantWorstCase: { status: 'incomplete', gaps: [{ reason: 'grant_cost_incomplete', ref: 'image/standard/any' }] },
        otherCosts: { lines: [], infrastructure: 'not_supplied' },
        net: { status: 'incomplete', gaps: [{ reason: 'infrastructure_not_supplied', ref: 'plan:test_monthly' }] },
      },
    ],
    disabledActions: [],
    configurationIssues: [],
    inputs: {
      missingAiProviderCosts: ['image/standard/any'],
      unmatched: [],
      unusedRates: [],
      unitMismatches: [],
      currencyMismatches: [],
      undated: [],
      stale: [],
      futureDated: [],
    },
    marginGuard: {
      status: 'not_configured',
      minGrossMarginPercent: null,
      maxCostAgeDays: null,
      warnings: [],
      notEvaluated: [],
      net: { status: 'not_configured', minNetMarginPercent: null, warnings: [], notEvaluated: [] },
    },
    parity: null,
    caveats: ['Test caveat from the server.'],
    precision: { price: 2, perCredit: 3, actionCost: 4, meterLine: 6, perSubscriberMonth: 2, percent: 0, costMultiple: 1 },
    ...over,
  };
}

/* ------------------------------------------------------------------ *
 * The P1 configuration and review, server-shaped -- test data only
 * ------------------------------------------------------------------ */

const meta = (id: string, version: number, state: 'draft' | 'scheduled' | 'active' | 'superseded' | 'cancelled', effectiveFrom: string | null) => ({
  id,
  version,
  state,
  effectiveFrom,
  createdAt: '2026-09-01T00:00:00.000000Z',
  updatedAt: `2026-09-0${version}T00:00:00.000000Z`,
  createdBy: 'test-admin',
  publishedAt: state === 'draft' ? null : '2026-09-01T00:00:00.000000Z',
  publishedBy: state === 'draft' ? null : 'test-admin',
  publishReason: state === 'draft' ? null : `test reason v${version}`,
  cancelledAt: state === 'cancelled' ? '2026-09-02T00:00:00.000000Z' : null,
  cancelledBy: state === 'cancelled' ? 'test-admin' : null,
  cancelReason: state === 'cancelled' ? 'test cancel' : null,
});

/** The catalogue as the server sends it. */
export const testCatalogue: EconomyConfigurationView['catalogue'] = {
  planFeatures: ['unlimited_text', 'full_character_access', 'advanced_media_access', 'voice_access'],
  qualityTiers: ['standard', 'high'],
  actions: {
    image: { unit: 'per_action', durationTiers: 'forbidden' },
    voice_message: { unit: 'per_action', durationTiers: 'forbidden' },
    voice_call: { unit: 'per_minute', durationTiers: 'forbidden' },
    video: { unit: 'per_action', durationTiers: 'required' },
  },
  allowances: ['free_first_conversation_messages', 'free_daily_messages', 'signup_grant_credits', 'grace_period_days', 'reward_monthly_cap_credits'],
};

const testFeatures = { unlimited_text: true, full_character_access: true, advanced_media_access: false, voice_access: false };

export function configurationView(over: Partial<EconomyConfigurationView> = {}): EconomyConfigurationView {
  return {
    asOf: '2026-09-19T12:00:00.000000Z',
    plans: [
      {
        code: 'test_monthly',
        versions: [
          { ...meta('plan-v1', 1, 'active', '2026-09-01T00:00:00.000000Z'), displayName: 'Test plan', billingPeriodMonths: 1, priceMinor: 111, currency: 'USD', monthlyIncludedCredits: 11, features: testFeatures, isPurchasable: true },
          { ...meta('plan-v2', 2, 'draft', null), displayName: 'Test plan', billingPeriodMonths: 1, priceMinor: 222, currency: 'USD', monthlyIncludedCredits: 11, features: { ...testFeatures, voice_access: true }, isPurchasable: true },
        ],
      },
    ],
    packs: [
      {
        code: 'test_small',
        versions: [
          { ...meta('pack-v1', 1, 'superseded', '2026-09-01T00:00:00.000000Z'), displayName: 'Test pack', credits: 10, priceMinor: 33, currency: 'USD', sortOrder: 0, isBestValue: false, isPurchasable: true },
          { ...meta('pack-v2', 2, 'active', '2026-09-02T00:00:00.000000Z'), displayName: 'Test pack', credits: 12, priceMinor: 33, currency: 'USD', sortOrder: 0, isBestValue: false, isPurchasable: true },
          { ...meta('pack-v3', 3, 'scheduled', '2030-01-01T00:00:00.000000Z'), displayName: 'Test pack', credits: 14, priceMinor: 33, currency: 'USD', sortOrder: 0, isBestValue: true, isPurchasable: true },
        ],
      },
    ],
    rulesets: [
      {
        ...meta('ruleset-v1', 1, 'active', '2026-09-01T00:00:00.000000Z'),
        actionCosts: [
          { actionType: 'image', qualityTier: 'standard', maxDurationSeconds: null, unit: 'per_action', creditCost: 7, enabled: true },
          { actionType: 'video', qualityTier: 'standard', maxDurationSeconds: 5, unit: 'per_action', creditCost: 21, enabled: true },
        ],
        allowances: { free_daily_messages: 4 },
        rewards: [{ rewardKey: 'test_referral', credits: 3, perUserCap: null, enabled: true }],
      },
    ],
    catalogue: testCatalogue,
    ...over,
  };
}

export function publishReview(over: Partial<EconomyPublishReview> = {}): EconomyPublishReview {
  return {
    asOf: '2026-09-19T12:00:00.000000Z',
    draftSetToken: 'a'.repeat(64),
    diff: [
      {
        kind: 'plan',
        code: 'test_monthly',
        draftVersion: 2,
        liveVersion: 1,
        changes: [
          { field: 'priceMinor', before: 111, after: 222 },
          { field: 'features.voice_access', before: false, after: true },
        ],
      },
    ],
    errors: [],
    warnings: [],
    ...over,
  };
}
