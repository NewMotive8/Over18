import { afterEach, describe, expect, it, vi } from 'vitest';
import { ANALYTICS_EVENT_NAMES, type AnalyticsEventName } from '@over18/shared';
import {
  FAKE_SIGNATURE_HEADER,
  createFakeAgeVerificationProvider,
  createFakePaymentProvider,
  signFakePayload,
} from '../commerce/fake-providers.js';
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

describe('provider selection', () => {
  const opts = (isProduction: boolean) => ({ isProduction, secret: SECRET, baseUrl: 'http://localhost:5173' });

  it('returns null for none -- a missing provider means switched off', () => {
    expect(selectPaymentProvider('none', opts(true))).toBeNull();
    expect(selectAgeVerificationProvider('none', opts(false))).toBeNull();
  });

  it('refuses a fake in production, independently of loadEnv', () => {
    expect(() => selectPaymentProvider('fake', opts(true))).toThrow(FakeProviderInProductionError);
    expect(() => selectAgeVerificationProvider('fake', opts(true))).toThrow(FakeProviderInProductionError);
  });

  it('returns a fake outside production', () => {
    expect(selectPaymentProvider('fake', opts(false))?.name).toBe('fake');
    expect(selectAgeVerificationProvider('fake', opts(false))?.name).toBe('fake');
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
