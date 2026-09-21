import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { CustomerCommercialState, CustomerEconomyCatalog, CustomerPlanOffer } from '@over18/shared';
import * as components from '../components/CustomerEconomy';
import { CreditBalance, LockedPremiumCard, PaidActionButton, PlanCatalog, PlanSummary } from '../components/CustomerEconomy';
import { ApiRequestError, CUSTOMER_ECONOMY_ENDPOINTS } from './api';
import * as publicModule from './customerEconomy';
import {
  ECONOMY_MESSAGES,
  EconomyBackendUnavailableError,
  commercialTier,
  createHttpCustomerEconomyClient,
  customerEconomyClient,
  economyStateFromError,
  economyStateFromOverview,
  formatPlanPrice,
  getAction,
  getCurrentPlan,
  getPlan,
  initialEconomyState,
  offeredPlans,
  pendingCustomerEconomyClient,
  spendableCredits,
  type CustomerAction,
  type CustomerEconomyOverview,
} from './customerEconomy';
import { customerEconomyFixture, fixtureCustomerEconomyClient } from './customerEconomy.fixture';

/* ------------------------------------------------------------------ *
 * Server-shaped test data (the wire types from @over18/shared)
 * ------------------------------------------------------------------ */

/** Exactly what GET /api/me/commercial-state answers today. */
const TODAY: CustomerCommercialState = {
  viewer: { userId: 'u1' },
  economyEnabled: true,
  tier: { available: false, reason: 'subscriptions_not_supported' },
  subscription: { available: false, reason: 'subscriptions_not_supported' },
  wallet: { available: false, reason: 'wallet_not_supported' },
  age: { available: false, reason: 'age_verification_not_supported' },
};

const plan = (code: string, over: Partial<CustomerPlanOffer> = {}): CustomerPlanOffer => ({
  code,
  version: 1,
  versionId: `${code}-v1`,
  displayName: `Plan ${code}`,
  billingPeriodMonths: 1,
  priceMinor: 1299,
  currency: 'USD',
  monthlyIncludedCredits: 300,
  isPurchasable: true,
  effectiveFrom: '2026-09-01T00:00:00.000000Z',
  ...over,
});
const catalogOf = (...plans: CustomerPlanOffer[]): CustomerEconomyCatalog => ({ asOf: '2026-09-19T00:00:00.000000Z', plans, packs: [] });
const overviewOf = (over: Partial<CustomerEconomyOverview> = {}): CustomerEconomyOverview => ({
  commercial: TODAY,
  catalog: catalogOf(),
  actions: [],
  ...over,
});
const subscribedTo = (planCode: string | null): CustomerCommercialState => ({
  ...TODAY,
  subscription: {
    available: true,
    value: planCode === null ? null : { status: 'active', planCode, currentPeriodEnd: '2026-10-19T00:00:00.000Z', cancelAtPeriodEnd: false },
  },
});
const voiceQuote: CustomerAction = {
  slot: 'voice_call',
  title: 'Start a voice call',
  description: 'A live voice experience.',
  quote: { availability: 'available', creditCost: 5, unit: 'per_minute', unavailableReason: null, quoteId: 'q1', expiresAt: null },
};

const render = (node: ReactNode) => renderToStaticMarkup(<MemoryRouter>{node}</MemoryRouter>);

/** Every non-test source file under src/, relative to src/. */
function applicationSources(): string[] {
  const src = fileURLToPath(new URL('..', import.meta.url));
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return walk(path);
      return /\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) ? [path] : [];
    });
  return walk(src).map((path) => relative(src, path).split('\\').join('/'));
}
const sourceOf = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');

/* ================================================================== *
 * 1. Plans are identified by code
 * ================================================================== */

describe('plans are identified by code, not tier', () => {
  it('finds a plan by its code, and nothing for an unknown or missing code', () => {
    const catalog = catalogOf(plan('premium_monthly'), plan('premium_annual', { billingPeriodMonths: 12 }));
    expect(getPlan(catalog, 'premium_annual')?.billingPeriodMonths).toBe(12);
    expect(getPlan(catalog, 'premium_monthly')?.billingPeriodMonths).toBe(1);
    expect(getPlan(catalog, 'nope')).toBeNull();
    expect(getPlan(catalog, null)).toBeNull();
    expect(getPlan(null, 'premium_monthly')).toBeNull();
    expect(getPlan(undefined, undefined)).toBeNull();
  });

  it('the current plan is null without a known subscription, and never a "Free" plan', () => {
    const catalog = catalogOf(plan('premium_monthly'));
    expect(getCurrentPlan(overviewOf({ catalog }))).toBeNull(); // subscription not available
    expect(getCurrentPlan(overviewOf({ catalog, commercial: subscribedTo(null) }))).toBeNull(); // no subscription
    expect(getCurrentPlan(null)).toBeNull();
  });

  it('an unknown or retired subscription plan is null; an offered one resolves by code', () => {
    const catalog = catalogOf(plan('premium_monthly'), plan('legacy_monthly', { isPurchasable: false }));
    expect(getCurrentPlan(overviewOf({ catalog, commercial: subscribedTo('gone_plan') }))).toBeNull();
    expect(getCurrentPlan(overviewOf({ catalog, commercial: subscribedTo('legacy_monthly') }))).toBeNull();
    expect(getCurrentPlan(overviewOf({ catalog, commercial: subscribedTo('premium_monthly') }))?.code).toBe('premium_monthly');
  });
});

/* ================================================================== *
 * 2. No invented Free plan
 * ================================================================== */

describe('no plan is invented', () => {
  it('the HTTP overview carries exactly the server catalog -- an empty one stays empty', async () => {
    for (const catalog of [catalogOf(), catalogOf(plan('premium_monthly'))]) {
      const client = createHttpCustomerEconomyClient({ catalog: async () => catalog, commercialState: async () => TODAY });
      const overview = await client.getOverview();
      expect(overview.catalog).toBe(catalog);
      expect(overview.catalog.plans.map((p) => p.code)).toEqual(catalog.plans.map((p) => p.code));
    }
  });

  it('the plan list shows offered plans only, by code, with the server price -- and no Free card', () => {
    const overview = overviewOf({ catalog: catalogOf(plan('premium_monthly'), plan('legacy_monthly', { isPurchasable: false })) });
    expect(offeredPlans(overview).map((p) => p.code)).toEqual(['premium_monthly']);
    const html = render(<PlanCatalog overview={overview} />);
    expect(html).toContain('data-testid="plan-premium_monthly"');
    expect(html).toContain('$12.99 / month');
    expect(html).toContain('300 Credits');
    expect(html).not.toContain('data-testid="plan-legacy_monthly"');
    expect(html).not.toMatch(/\bFree\b/);
  });

  it('an empty catalog says so, rather than showing sample plans', () => {
    const html = render(<PlanCatalog overview={overviewOf()} />);
    expect(html).toContain('No plans are offered right now.');
    expect(html).not.toMatch(/\bFree\b|Premium/);
  });

  it('with the tier unavailable, the plan summary claims neither Free nor Premium', () => {
    const html = render(<PlanSummary overview={overviewOf()} />);
    expect(html).toContain('available yet');
    expect(html).not.toMatch(/>Free<|>Premium</);
  });
});

/* ================================================================== *
 * 3. getAction is null-safe
 * ================================================================== */

describe('getAction never throws', () => {
  it('answers null for a missing overview, missing actions or a missing slot', () => {
    expect(getAction(null, 'voice_call')).toBeNull();
    expect(getAction(undefined, 'premium_content')).toBeNull();
    expect(getAction({ ...overviewOf(), actions: undefined } as unknown as CustomerEconomyOverview, 'voice_call')).toBeNull();
    expect(getAction({ ...overviewOf(), actions: 'nope' } as unknown as CustomerEconomyOverview, 'voice_call')).toBeNull();
    expect(getAction(overviewOf(), 'voice_call')).toBeNull();
    expect(getAction(overviewOf({ actions: [voiceQuote] }), null)).toBeNull();
    expect(getAction(overviewOf({ actions: [voiceQuote] }), 'voice_call')).toBe(voiceQuote);
  });

  it('the action components render nothing without a server quote', () => {
    expect(render(<PaidActionButton action={null} />)).toBe('');
    expect(render(<LockedPremiumCard action={null} />)).toBe('');
    expect(render(<PaidActionButton action={voiceQuote} />)).toContain('5 Credits');
  });
});

/* ================================================================== *
 * 4. Ordinary text chat costs nothing
 * ================================================================== */

describe('text chat is not a paid action', () => {
  it('"message" is not an action slot', () => {
    // @ts-expect-error -- 'message' is deliberately not a CustomerActionSlot.
    expect(getAction(customerEconomyFixture, 'message')).toBeNull();
    expect(customerEconomyFixture.actions.map((a) => a.slot)).not.toContain('message');
  });

  it('the chat screen asks for no message quote and shows no message cost', () => {
    const chat = sourceOf('pages/ChatPage.tsx');
    expect(chat).not.toMatch(/getAction\([^)]*'message'/);
    expect(chat).not.toMatch(/Message cost/i);
  });
});

/* ================================================================== *
 * 5. No client-side affordability rule
 * ================================================================== */

describe('the client decides nothing about affordability', () => {
  it('exports no low-balance heuristic', () => {
    expect(publicModule).not.toHaveProperty('isLowCreditBalance');
    expect(components).not.toHaveProperty('LowCreditNotice');
  });

  it('no application source contains one', () => {
    for (const rel of applicationSources()) {
      expect(sourceOf(rel), rel).not.toMatch(/isLowCreditBalance|LowCreditNotice|running low/i);
    }
  });

  it('an unavailable balance is null -- never 0 -- and renders nothing', () => {
    expect(spendableCredits(overviewOf())).toBeNull();
    expect(commercialTier(overviewOf())).toBeNull();
    expect(render(<CreditBalance overview={overviewOf()} />)).toBe('');
    const known = overviewOf({ commercial: { ...TODAY, wallet: { available: true, value: { included: 0, earned: 0, purchased: 0, held: 0, spendable: 42 } } } });
    expect(render(<CreditBalance overview={known} />)).toContain('42 Credits');
  });
});

/* ================================================================== *
 * 6. The fixture never reaches production code
 * ================================================================== */

describe('the fixture is explicit-only', () => {
  it('the public module does not export it', () => {
    for (const name of ['customerEconomyFixture', 'fixtureCustomerEconomyClient', 'CUSTOMER_ECONOMY_FIXTURE_MARKER']) {
      expect(publicModule, name).not.toHaveProperty(name);
    }
  });

  it('no application module imports it', () => {
    // Static and dynamic imports; doc comments may still name the file.
    const importsFixture = /(?:from|import)\s*\(?\s*['"][^'"]*customerEconomy\.fixture['"]/;
    const importers = applicationSources()
      .filter((rel) => rel !== 'lib/customerEconomy.fixture.ts')
      .filter((rel) => importsFixture.test(sourceOf(rel)));
    expect(importers).toEqual([]);
    // The detector itself works: this test file does import the fixture.
    expect(importsFixture.test(readFileSync(fileURLToPath(import.meta.url), 'utf8'))).toBe(true);
  });

  it('it is a fixture client, told apart by kind', async () => {
    expect(fixtureCustomerEconomyClient.kind).toBe('fixture');
    await expect(fixtureCustomerEconomyClient.getOverview()).resolves.toBe(customerEconomyFixture);
  });
});

/* ================================================================== *
 * 7. Production fails closed
 * ================================================================== */

describe('production fails closed', () => {
  /**
   * P9 moved the default from the pending client to the real one. The property
   * that mattered is unchanged and is asserted here directly: production shows
   * no commercial data, because the SERVER answers 503 while ECONOMY_ENABLED is
   * off and that maps to `disabled` carrying no overview. The pending client
   * remains for tests and for any surface that must never call.
   */
  it('the default client calls the server, and a switched-off economy yields no data', async () => {
    expect(customerEconomyClient.kind).toBe('http');
    // Nothing commercial is shown before the server has answered.
    expect(initialEconomyState(customerEconomyClient).status).toBe('loading');
    const off = economyStateFromError(new ApiRequestError(503, 'economy_unavailable', 'The economy is not available yet.'));
    expect(off.status).toBe('disabled');
    expect(off).not.toHaveProperty('overview');
  });

  it('the pending client is still available, and still yields nothing', async () => {
    expect(pendingCustomerEconomyClient.kind).toBe('pending');
    expect(initialEconomyState(pendingCustomerEconomyClient)).toEqual({ status: 'unavailable', message: ECONOMY_MESSAGES.pending });
    await expect(pendingCustomerEconomyClient.getOverview()).rejects.toBeInstanceOf(EconomyBackendUnavailableError);
  });

  it('only a ready state carries an overview, and every failure maps to one without', () => {
    const cases: Array<[unknown, string]> = [
      [new EconomyBackendUnavailableError(), 'unavailable'],
      [new ApiRequestError(401, 'unauthorized', 'Authentication required.'), 'signed-out'],
      [new ApiRequestError(503, 'economy_unavailable', 'The economy is not available yet.'), 'disabled'],
      [new ApiRequestError(503, 'request_failed', 'Request failed (503).'), 'error'], // an outage, not "switched off"
      [new ApiRequestError(404, 'not_found', 'Not found'), 'error'],
      [new Error('network'), 'error'],
    ];
    for (const [error, status] of cases) {
      const state = economyStateFromError(error);
      expect(state.status).toBe(status);
      expect(state).not.toHaveProperty('overview');
    }
    expect(economyStateFromOverview(overviewOf())).toEqual({ status: 'ready', overview: overviewOf() });
    expect(initialEconomyState(createHttpCustomerEconomyClient())).toEqual({ status: 'loading' });
  });
});

/* ================================================================== *
 * 8. The HTTP adapter: two endpoints, availability passed through
 * ================================================================== */

describe('the HTTP adapter', () => {
  it('declares the two existing read endpoints and nothing else', () => {
    expect(CUSTOMER_ECONOMY_ENDPOINTS).toEqual({ catalog: '/api/economy/catalog', commercialState: '/api/me/commercial-state' });
  });

  it('calls each once, passes the commercial state through untouched, and invents no quote', async () => {
    const calls: string[] = [];
    const catalog = catalogOf(plan('premium_monthly'));
    const client = createHttpCustomerEconomyClient({
      catalog: async () => (calls.push('catalog'), catalog),
      commercialState: async () => (calls.push('commercialState'), TODAY),
    });
    expect(client.kind).toBe('http');
    const overview = await client.getOverview();
    expect(calls.sort()).toEqual(['catalog', 'commercialState']);
    expect(overview.commercial).toBe(TODAY);
    expect(overview.actions).toEqual([]);
  });

  it('a switched-off economy surfaces as the disabled state', async () => {
    const off = new ApiRequestError(503, 'economy_unavailable', 'The economy is not available yet.');
    const client = createHttpCustomerEconomyClient({
      catalog: () => Promise.reject(off),
      commercialState: () => Promise.reject(off),
    });
    const state = await client.getOverview().then(economyStateFromOverview, economyStateFromError);
    expect(state).toEqual({ status: 'disabled', message: ECONOMY_MESSAGES.disabled });
  });
});

/* ================================================================== *
 * Presentation of server prices
 * ================================================================== */

describe('formatPlanPrice', () => {
  it("shows the server's minor units in the currency's own decimals, per billing period", () => {
    expect(formatPlanPrice({ priceMinor: 1299, currency: 'USD', billingPeriodMonths: 1 })).toBe('$12.99 / month');
    expect(formatPlanPrice({ priceMinor: 9999, currency: 'USD', billingPeriodMonths: 12 })).toBe('$99.99 / year');
    expect(formatPlanPrice({ priceMinor: 2999, currency: 'USD', billingPeriodMonths: 3 })).toBe('$29.99 / 3 months');
    expect(formatPlanPrice({ priceMinor: 1200, currency: 'JPY', billingPeriodMonths: 1 })).toBe('¥1,200 / month');
  });
});
