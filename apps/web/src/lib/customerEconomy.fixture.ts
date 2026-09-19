import type { CustomerEconomyClient } from './customerEconomy.adapter';
import type { CustomerEconomyOverview } from './customerEconomy.models';

/**
 * TEST / DEVELOPMENT DATA ONLY -- not a commercial offer, and never a default.
 *
 * No application module imports this file and the public `customerEconomy`
 * module does not re-export it: a test or a development harness must import
 * it by path and inject `fixtureCustomerEconomyClient` explicitly. The marker
 * below lets the production build be checked for it.
 */
export const CUSTOMER_ECONOMY_FIXTURE_MARKER = '__customer_economy_fixture__';

export const customerEconomyFixture: CustomerEconomyOverview = {
  commercial: {
    viewer: { userId: `${CUSTOMER_ECONOMY_FIXTURE_MARKER}user` },
    economyEnabled: true,
    tier: { available: true, value: 'premium' },
    subscription: {
      available: true,
      value: { status: 'active', planCode: 'fixture_monthly', currentPeriodEnd: '2030-01-01T00:00:00.000Z', cancelAtPeriodEnd: false },
    },
    wallet: { available: true, value: { included: 1, earned: 0, purchased: 0, held: 0, spendable: 1 } },
    age: { available: false, reason: 'age_verification_not_supported' },
  },
  catalog: {
    asOf: '2030-01-01T00:00:00.000000Z',
    plans: [
      {
        code: 'fixture_monthly',
        version: 1,
        versionId: `${CUSTOMER_ECONOMY_FIXTURE_MARKER}plan`,
        displayName: `Fixture plan ${CUSTOMER_ECONOMY_FIXTURE_MARKER}`,
        billingPeriodMonths: 1,
        priceMinor: 1,
        currency: 'USD',
        monthlyIncludedCredits: 1,
        features: {},
        isPurchasable: true,
        effectiveFrom: '2030-01-01T00:00:00.000000Z',
      },
    ],
    packs: [],
  },
  actions: [
    {
      slot: 'voice_call',
      title: 'Start a voice call',
      description: 'A live voice experience with your character.',
      quote: { availability: 'unavailable', creditCost: 1, unit: 'per_minute', unavailableReason: 'Fixture reason', quoteId: null, expiresAt: null },
    },
  ],
};

export const fixtureCustomerEconomyClient: CustomerEconomyClient = {
  kind: 'fixture',
  getOverview: async () => customerEconomyFixture,
};
