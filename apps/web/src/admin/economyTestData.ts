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
