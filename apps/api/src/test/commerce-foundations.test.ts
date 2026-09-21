import { afterEach, describe, expect, it, vi } from 'vitest';
import { ANALYTICS_EVENT_NAMES, type AnalyticsEventName } from '@over18/shared';
import {
  FAKE_SIGNATURE_HEADER,
  createFakeAgeVerificationProvider,
  createFakePaymentProvider,
  signFakePayload,
} from '../commerce/fake-providers.js';
import { fakeProvidersAllowed } from '../commerce/fake-provider-policy.js';
import {
  FakeProviderInProductionError,
  selectAgeVerificationProvider,
  selectPaymentProvider,
} from '../commerce/select-providers.js';
import { loadEnv } from '../env.js';
import { createAnalytics, createMemoryAnalyticsSink } from '../services/analytics-service.js';
import { resolveEntitlement } from '../services/entitlement-service.js';
import type { TestContext } from './helpers.js';

/**
 * PRD v1.2 build step 0b -- the foundations every later economy phase stands on.
 * None of it touches the database, and none of it is reachable by a user yet.
 */

const SECRET = 'fake-provider-test-secret';
const noDb = {} as TestContext['db'];

/* ------------------------------------------------------------------ *
 * Feature flags
 * ------------------------------------------------------------------ */

describe('economy and admin flags', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  const load = (vars: Record<string, string | undefined>) => {
    process.env = { ...saved, DATABASE_URL: 'postgresql://x@127.0.0.1:1/x_test', ...vars };
    for (const key of Object.keys(vars)) if (vars[key] === undefined) delete process.env[key];
    return loadEnv();
  };

  const UNSET = {
    ADMIN_AUDIT_ENABLED: undefined,
    ADMIN_PERMISSIONS_ENFORCED: undefined,
    ECONOMY_ENABLED: undefined,
    PAYMENT_PROVIDER: undefined,
    AGE_VERIFICATION_PROVIDER: undefined,
    ANALYTICS_ENABLED: undefined,
    RAILWAY_ENVIRONMENT: undefined,
    RAILWAY_ENVIRONMENT_ID: undefined,
    RAILWAY_ENVIRONMENT_NAME: undefined,
    RAILWAY_PROJECT_ID: undefined,
    RAILWAY_SERVICE_ID: undefined,
    ALLOW_SIMULATED_PAYMENTS: undefined,
  };

  it('defaults every switch OFF', () => {
    const env = load(UNSET);
    expect(env.admin).toEqual({ auditEnabled: false, permissionsEnforced: false });
    expect(env.commerce).toEqual({
      enabled: false,
      paymentProvider: 'none',
      ageVerificationProvider: 'none',
      analyticsEnabled: false,
    });
  });

  it('turns a switch on only for exactly "true"', () => {
    expect(load({ ...UNSET, ADMIN_AUDIT_ENABLED: ' TRUE ' }).admin.auditEnabled).toBe(true);
    expect(load({ ...UNSET, ADMIN_AUDIT_ENABLED: '1' }).admin.auditEnabled).toBe(false);
    expect(load({ ...UNSET, ECONOMY_ENABLED: 'yes' }).commerce.enabled).toBe(false);
  });

  it('selects a fake provider only outside production', () => {
    const dev = load({ ...UNSET, NODE_ENV: 'development', PAYMENT_PROVIDER: 'fake', AGE_VERIFICATION_PROVIDER: 'FAKE' });
    expect(dev.commerce.paymentProvider).toBe('fake');
    expect(dev.commerce.ageVerificationProvider).toBe('fake');

    const prod = load({ ...UNSET, NODE_ENV: 'production', PAYMENT_PROVIDER: 'fake', AGE_VERIFICATION_PROVIDER: 'fake' });
    expect(prod.commerce.paymentProvider).toBe('none');
    expect(prod.commerce.ageVerificationProvider).toBe('none');
  });

  it('fails closed: an unset or unrecognised NODE_ENV counts as production', () => {
    for (const NODE_ENV of [undefined, '', 'staging', 'prod', 'Development', 'PRODUCTION']) {
      const env = load({ ...UNSET, NODE_ENV, PAYMENT_PROVIDER: 'fake', AGE_VERIFICATION_PROVIDER: 'fake' });
      expect(env.commerce.paymentProvider, `NODE_ENV=${String(NODE_ENV)}`).toBe('none');
      expect(env.commerce.ageVerificationProvider, `NODE_ENV=${String(NODE_ENV)}`).toBe('none');
    }
  });

  it('refuses a fake on Railway even when NODE_ENV claims development', () => {
    const env = load({
      ...UNSET,
      NODE_ENV: 'development',
      RAILWAY_ENVIRONMENT_ID: 'any-railway-environment',
      PAYMENT_PROVIDER: 'fake',
      AGE_VERIFICATION_PROVIDER: 'fake',
    });
    expect(env.commerce.paymentProvider).toBe('none');
    expect(env.commerce.ageVerificationProvider).toBe('none');
  });

  it('selects a fake on staging when the opt-in is set -- the first of three locks', () => {
    const staging = load({
      ...UNSET,
      // Staging is built from the same image as production, so it reports
      // NODE_ENV=production. The environment NAME is what distinguishes it.
      NODE_ENV: 'production',
      RAILWAY_ENVIRONMENT_NAME: 'staging',
      RAILWAY_PROJECT_ID: 'a-railway-project',
      ALLOW_SIMULATED_PAYMENTS: 'true',
      PAYMENT_PROVIDER: 'fake',
    });
    expect(staging.commerce.paymentProvider).toBe('fake');
  });

  it('refuses a fake on staging when the opt-in is absent', () => {
    const staging = load({
      ...UNSET,
      NODE_ENV: 'production',
      RAILWAY_ENVIRONMENT_NAME: 'staging',
      RAILWAY_PROJECT_ID: 'a-railway-project',
      PAYMENT_PROVIDER: 'fake',
    });
    expect(staging.commerce.paymentProvider).toBe('none');
  });

  it('does not change isProduction, which still means NODE_ENV === "production"', () => {
    expect(load({ ...UNSET, NODE_ENV: undefined }).isProduction).toBe(false);
    expect(load({ ...UNSET, NODE_ENV: 'production' }).isProduction).toBe(true);
  });

  it('treats an unknown provider name as none, never as a guess', () => {
    expect(load({ ...UNSET, PAYMENT_PROVIDER: 'stripe' }).commerce.paymentProvider).toBe('none');
  });
});

/* ------------------------------------------------------------------ *
 * The entitlement resolver
 * ------------------------------------------------------------------ */

describe('the entitlement resolver, phase zero', () => {
  const FREE = {
    tier: 'free',
    subscription: null,
    wallet: { included: 0, earned: 0, purchased: 0, held: 0, spendable: 0 },
    age: { verified: false, expiresAt: null },
  };

  it('answers FREE, empty and unverified for an anonymous visitor', async () => {
    expect(await resolveEntitlement(noDb, null, { enabled: false })).toEqual({
      viewer: 'anonymous',
      ...FREE,
      economyEnabled: false,
    });
  });

  it('answers the same for a signed-in user', async () => {
    const user = { id: 'u1', email: 'u@example.com', role: 'user' as const };
    expect(await resolveEntitlement(noDb, user, { enabled: true })).toEqual({
      viewer: 'user',
      ...FREE,
      economyEnabled: true,
    });
  });

  it('does NOT treat an administrator as Premium -- staff access is not a commercial tier', async () => {
    const admin = { id: 'a1', email: 'a@example.com', role: 'admin' as const };
    const state = await resolveEntitlement(noDb, admin, { enabled: true });
    expect(state.tier).toBe('free');
    expect(state.wallet.spendable).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * Analytics
 * ------------------------------------------------------------------ */

describe('the analytics pipeline', () => {
  it('carries exactly the PRD §23 event catalogue', () => {
    expect([...ANALYTICS_EVENT_NAMES]).toEqual([
      'paywall_viewed',
      'subscription_cta_clicked',
      'subscription_started',
      'free_limit_reached',
      'credit_balance_viewed',
      'credit_purchase_viewed',
      'credit_purchase_started',
      'credit_purchase_completed',
      'credit_spend',
      'locked_content_viewed',
      'locked_content_unlocked',
      'reward_earned',
      'paywall_dismissed',
      'grant_exhausted',
      'spend_refunded',
      'age_verification_started',
      'age_verification_completed',
    ]);
  });

  it('sends nothing while switched off', async () => {
    const sink = createMemoryAnalyticsSink();
    const analytics = createAnalytics({ enabled: false, sink });
    expect(await analytics.emit('paywall_viewed', { userId: null })).toBe(false);
    expect(sink.events).toEqual([]);
  });

  it('delivers a timestamped event, snapshotting its properties', async () => {
    const sink = createMemoryAnalyticsSink();
    const at = new Date('2026-09-17T10:00:00Z');
    const analytics = createAnalytics({ enabled: true, sink, now: () => at });
    const properties: Record<string, string | number> = { actionType: 'image', credits: 10 };
    expect(await analytics.emit('credit_spend', { userId: 'u1', properties })).toBe(true);
    properties.credits = 999;
    expect(sink.events).toEqual([
      { name: 'credit_spend', userId: 'u1', occurredAt: at, properties: { actionType: 'image', credits: 10 } },
    ]);
  });

  it('refuses a name outside the catalogue, even one that slips past the type system', async () => {
    const sink = createMemoryAnalyticsSink();
    const analytics = createAnalytics({ enabled: true, sink });
    expect(await analytics.emit('made_up_event' as AnalyticsEventName, { userId: null })).toBe(false);
    expect(sink.events).toEqual([]);
  });

  it('never throws when the sink fails -- it reports, and the action carries on', async () => {
    const onError = vi.fn();
    const analytics = createAnalytics({
      enabled: true,
      sink: { write: async () => Promise.reject(new Error('sink down')) },
      onError,
    });
    await expect(analytics.emit('spend_refunded', { userId: 'u1' })).resolves.toBe(false);
    expect(onError).toHaveBeenCalledWith(expect.any(Error), 'spend_refunded');
  });
});

/* ------------------------------------------------------------------ *
 * Providers
 * ------------------------------------------------------------------ */

const signed = (body: unknown, secret = SECRET) => {
  const rawBody = Buffer.from(JSON.stringify(body));
  return { headers: { [FAKE_SIGNATURE_HEADER]: signFakePayload(secret, rawBody) }, rawBody };
};

describe('the fake-provider policy', () => {
  it('allows a fake only for an explicit development or test NODE_ENV off Railway', () => {
    expect(fakeProvidersAllowed({ NODE_ENV: 'development' })).toBe(true);
    expect(fakeProvidersAllowed({ NODE_ENV: ' test ' })).toBe(true);
  });

  it('fails closed for production, unset, empty and unrecognised values', () => {
    for (const NODE_ENV of ['production', undefined, '', '  ', 'staging', 'Development', 'dev']) {
      expect(fakeProvidersAllowed({ NODE_ENV }), `NODE_ENV=${String(NODE_ENV)}`).toBe(false);
    }
  });

  it('fails closed whenever any Railway identity variable is present', () => {
    for (const name of [
      'RAILWAY_ENVIRONMENT',
      'RAILWAY_ENVIRONMENT_ID',
      'RAILWAY_ENVIRONMENT_NAME',
      'RAILWAY_PROJECT_ID',
      'RAILWAY_SERVICE_ID',
    ]) {
      expect(fakeProvidersAllowed({ NODE_ENV: 'development', [name]: 'x' }), name).toBe(false);
    }
    // A blank value is not a Railway identity.
    expect(fakeProvidersAllowed({ NODE_ENV: 'test', RAILWAY_PROJECT_ID: ' ' })).toBe(true);
  });

  /**
   * DOOR 2: the staging deployment, the only way a fake reaches a Railway
   * process. It exists so the simulated purchase flow can be reviewed on a real
   * URL. BOTH halves are required, and production has neither.
   */
  const STAGING = {
    NODE_ENV: 'production',
    RAILWAY_ENVIRONMENT_NAME: 'staging',
    ALLOW_SIMULATED_PAYMENTS: 'true',
  };

  it('allows a fake on staging when the opt-in is deliberately set', () => {
    expect(fakeProvidersAllowed(STAGING)).toBe(true);
    // Both halves are read the way every other flag in this codebase is read.
    expect(fakeProvidersAllowed({ ...STAGING, RAILWAY_ENVIRONMENT_NAME: ' Staging ' })).toBe(true);
    expect(fakeProvidersAllowed({ ...STAGING, ALLOW_SIMULATED_PAYMENTS: ' TRUE ' })).toBe(true);
  });

  it('refuses staging without the opt-in -- half a door is a shut door', () => {
    for (const ALLOW_SIMULATED_PAYMENTS of [undefined, '', ' ', 'false', '1', 'yes', 'on', 'truthy']) {
      expect(
        fakeProvidersAllowed({ ...STAGING, ALLOW_SIMULATED_PAYMENTS }),
        `ALLOW_SIMULATED_PAYMENTS=${String(ALLOW_SIMULATED_PAYMENTS)}`,
      ).toBe(false);
    }
  });

  it('refuses the opt-in anywhere but staging, however nearly it is spelled', () => {
    for (const name of [undefined, '', ' ', 'production', 'staging-2', 'stage', 'preview', 'pr-14']) {
      expect(
        fakeProvidersAllowed({ ...STAGING, RAILWAY_ENVIRONMENT_NAME: name }),
        `RAILWAY_ENVIRONMENT_NAME=${String(name)}`,
      ).toBe(false);
    }
  });

  it('refuses production as production actually looks -- opt-in and all', () => {
    // The real shape of the production API process, plus the opt-in variable
    // that someone could one day paste onto the wrong service. Still refused:
    // the environment name comes from Railway and a deployment cannot forge it.
    expect(
      fakeProvidersAllowed({
        NODE_ENV: 'production',
        RAILWAY_ENVIRONMENT: 'production',
        RAILWAY_ENVIRONMENT_ID: 'production-environment-id',
        RAILWAY_ENVIRONMENT_NAME: 'production',
        RAILWAY_PROJECT_ID: 'the-project-id',
        RAILWAY_SERVICE_ID: 'the-api-service-id',
        PAYMENT_PROVIDER: 'fake',
        ALLOW_SIMULATED_PAYMENTS: 'true',
      }),
    ).toBe(false);
  });

  it('does not let the opt-in alone rescue an unnamed process off Railway', () => {
    // No Railway identity at all, NODE_ENV not development/test: neither door.
    expect(fakeProvidersAllowed({ ALLOW_SIMULATED_PAYMENTS: 'true' })).toBe(false);
    expect(fakeProvidersAllowed({ NODE_ENV: 'production', ALLOW_SIMULATED_PAYMENTS: 'true' })).toBe(false);
  });
});

describe('provider selection', () => {
  const opts = (environ: NodeJS.ProcessEnv) => ({ environ, secret: SECRET, baseUrl: 'http://localhost:5173' });
  const DEV = { NODE_ENV: 'development' };

  it('returns null for none -- a missing provider means switched off', () => {
    expect(selectPaymentProvider('none', opts({ NODE_ENV: 'production' }))).toBeNull();
    expect(selectAgeVerificationProvider('none', opts({}))).toBeNull();
  });

  it('refuses a fake in production, independently of loadEnv', () => {
    expect(() => selectPaymentProvider('fake', opts({ NODE_ENV: 'production' }))).toThrow(FakeProviderInProductionError);
    expect(() => selectAgeVerificationProvider('fake', opts({ NODE_ENV: 'production' }))).toThrow(
      FakeProviderInProductionError,
    );
  });

  it('refuses a fake when NODE_ENV is unset -- the case that used to fail open', () => {
    expect(() => selectPaymentProvider('fake', opts({}))).toThrow(FakeProviderInProductionError);
    expect(() => selectAgeVerificationProvider('fake', opts({}))).toThrow(FakeProviderInProductionError);
  });

  it('refuses a fake on Railway even with NODE_ENV=development', () => {
    const railway = { ...DEV, RAILWAY_ENVIRONMENT_ID: 'x' };
    expect(() => selectPaymentProvider('fake', opts(railway))).toThrow(FakeProviderInProductionError);
    expect(() => selectAgeVerificationProvider('fake', opts(railway))).toThrow(FakeProviderInProductionError);
  });

  it('returns a fake in an explicit development environment', () => {
    expect(selectPaymentProvider('fake', opts(DEV))?.name).toBe('fake');
    expect(selectAgeVerificationProvider('fake', opts(DEV))?.name).toBe('fake');
  });

  it('builds a fake on staging with the opt-in -- the second lock agrees with the first', () => {
    const staging = { NODE_ENV: 'production', RAILWAY_ENVIRONMENT_NAME: 'staging', ALLOW_SIMULATED_PAYMENTS: 'true' };
    expect(selectPaymentProvider('fake', opts(staging))?.name).toBe('fake');
  });

  it('still refuses a fake on staging without the opt-in', () => {
    const staging = { NODE_ENV: 'production', RAILWAY_ENVIRONMENT_NAME: 'staging' };
    expect(() => selectPaymentProvider('fake', opts(staging))).toThrow(FakeProviderInProductionError);
  });

  it('judges process.env itself when no environment is passed', () => {
    const saved = { ...process.env };
    try {
      process.env = { ...saved, NODE_ENV: undefined };
      delete process.env.NODE_ENV;
      expect(() => selectPaymentProvider('fake', { secret: SECRET, baseUrl: 'http://x' })).toThrow(
        FakeProviderInProductionError,
      );
    } finally {
      process.env = saved;
    }
  });
});

describe('the fake payment provider', () => {
  const provider = () => createFakePaymentProvider({ secret: SECRET, checkoutBaseUrl: 'http://localhost:5173' });
  const checkout = {
    kind: 'credit_pack' as const,
    productRef: 'pack-v1',
    amountMinor: 999,
    currency: 'USD',
    customerRef: 'user-1',
    returnUrl: 'http://localhost:5173/wallet',
    idempotencyKey: 'key-1',
  };

  it('returns the SAME checkout for the same idempotency key, and a new one otherwise', async () => {
    const p = provider();
    const a = await p.createCheckout(checkout);
    const b = await p.createCheckout(checkout);
    const c = await p.createCheckout({ ...checkout, idempotencyKey: 'key-2' });
    expect(b).toEqual(a);
    expect(c.checkoutRef).not.toBe(a.checkoutRef);
    expect(new URL(a.redirectUrl).searchParams.get('return')).toBe(checkout.returnUrl);
  });

  it('refuses non-integer money and malformed currency', async () => {
    const p = provider();
    await expect(p.createCheckout({ ...checkout, amountMinor: 9.99 })).rejects.toThrow(/minor units/);
    await expect(p.createCheckout({ ...checkout, amountMinor: 0 })).rejects.toThrow(/minor units/);
    await expect(p.createCheckout({ ...checkout, currency: 'usd' })).rejects.toThrow(/ISO 4217/);
  });

  it('accepts a correctly signed webhook and parses it', async () => {
    const parsed = await provider().parseWebhook(
      signed({
        id: 'evt_1',
        occurredAt: '2026-09-17T10:00:00Z',
        type: 'payment_succeeded',
        data: { checkoutRef: 'chk_1', transactionRef: 'txn_1', amountMinor: 999, currency: 'USD' },
      }),
    );
    expect(parsed).toEqual({
      signatureValid: true,
      eventRef: 'evt_1',
      occurredAt: new Date('2026-09-17T10:00:00Z'),
      event: { type: 'payment_succeeded', checkoutRef: 'chk_1', transactionRef: 'txn_1', amountMinor: 999, currency: 'USD' },
    });
  });

  it('marks a tampered, wrongly signed or unsigned webhook invalid', async () => {
    const p = provider();
    const good = signed({ id: 'evt_1', type: 'subscription_expired', data: { subscriptionRef: 's1' } });

    const tampered = { ...good, rawBody: Buffer.from(good.rawBody.toString().replace('s1', 's2')) };
    expect((await p.parseWebhook(tampered)).signatureValid).toBe(false);

    const wrongKey = signed({ id: 'evt_1', type: 'subscription_expired', data: { subscriptionRef: 's1' } }, 'other');
    expect((await p.parseWebhook(wrongKey)).signatureValid).toBe(false);

    expect((await p.parseWebhook({ headers: {}, rawBody: good.rawBody })).signatureValid).toBe(false);
    expect(
      (await p.parseWebhook({ headers: { [FAKE_SIGNATURE_HEADER]: 'abc' }, rawBody: good.rawBody })).signatureValid,
    ).toBe(false);
  });

  it('never coerces a malformed or unknown event into a real one', async () => {
    const p = provider();
    expect((await p.parseWebhook({ headers: {}, rawBody: Buffer.from('not json') })).event).toEqual({ type: 'unrecognised' });
    const missingAmount = signed({ id: 'e', type: 'payment_succeeded', data: { checkoutRef: 'c', transactionRef: 't', currency: 'USD' } });
    expect((await p.parseWebhook(missingAmount)).event).toEqual({ type: 'unrecognised' });
    const floatAmount = signed({ id: 'e', type: 'refunded', data: { transactionRef: 't', amountMinor: 9.99, currency: 'USD' } });
    expect((await p.parseWebhook(floatAmount)).event).toEqual({ type: 'unrecognised' });
    expect((await p.parseWebhook(signed({ id: 'e', type: 'mystery', data: {} }))).event).toEqual({ type: 'unrecognised' });
  });

  it('parses every lifecycle event type', async () => {
    const p = provider();
    const cases: Array<[string, Record<string, unknown>]> = [
      ['payment_failed', { checkoutRef: 'c', reason: 'declined' }],
      ['subscription_renewed', { subscriptionRef: 's', transactionRef: 't', amountMinor: 1999, currency: 'USD' }],
      ['subscription_renewal_failed', { subscriptionRef: 's' }],
      ['subscription_cancelled', { subscriptionRef: 's', effectiveAt: '2026-10-01T00:00:00Z' }],
      ['subscription_expired', { subscriptionRef: 's' }],
      ['refunded', { transactionRef: 't', amountMinor: 999, currency: 'USD' }],
      ['chargeback', { transactionRef: 't', amountMinor: 999, currency: 'USD' }],
    ];
    for (const [type, data] of cases) {
      expect((await p.parseWebhook(signed({ id: 'e', type, data }))).event.type).toBe(type);
    }
  });

  it('records cancellations', async () => {
    const p = provider();
    await p.cancelSubscription('sub_1');
    expect(p.cancelled).toEqual(['sub_1']);
  });
});

describe('the fake age-verification provider', () => {
  const provider = () => createFakeAgeVerificationProvider({ secret: SECRET, verifyBaseUrl: 'http://localhost:5173' });

  it('starts a deterministic session', async () => {
    const input = { customerRef: 'u1', returnUrl: 'http://localhost:5173/x', idempotencyKey: 'k' };
    expect(await provider().startVerification(input)).toEqual(await provider().startVerification(input));
  });

  /**
   * §7.2 data minimisation: a callback that carries identity data yields a
   * result with nowhere to put it.
   */
  it('copies out only the permitted fields, never identity data', async () => {
    const parsed = await provider().parseCallback(
      signed({
        sessionRef: 'avs_1',
        outcome: 'verified',
        verifiedAt: '2026-09-17T10:00:00Z',
        expiresAt: '2027-09-17T10:00:00Z',
        method: 'id_document',
        fullName: 'Jane Doe',
        dateOfBirth: '1990-01-01',
        documentImage: 'base64...',
      }),
    );
    expect(parsed).toEqual({
      signatureValid: true,
      sessionRef: 'avs_1',
      outcome: 'verified',
      verifiedAt: new Date('2026-09-17T10:00:00Z'),
      expiresAt: new Date('2027-09-17T10:00:00Z'),
      method: 'id_document',
    });
    expect(JSON.stringify(parsed)).not.toMatch(/Jane|1990|base64/);
  });

  it('treats anything but a known outcome as failed, and a failure carries no dates', async () => {
    const odd = await provider().parseCallback(signed({ sessionRef: 's', outcome: 'maybe', verifiedAt: '2026-09-17T10:00:00Z' }));
    expect(odd).toMatchObject({ outcome: 'failed', verifiedAt: null, expiresAt: null });
    const unsigned = await provider().parseCallback({ headers: {}, rawBody: Buffer.from('{}') });
    expect(unsigned.signatureValid).toBe(false);
  });
});
