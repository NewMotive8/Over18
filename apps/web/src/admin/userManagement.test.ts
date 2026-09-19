import { describe, expect, it } from 'vitest';
import { ApiRequestError } from '../lib/api';
import {
  EMPTY_FILTERS,
  ageText,
  filtersFromParams,
  filtersToParams,
  hasFilters,
  listQuery,
  STATUS_ACTION,
  pageError,
  statusChangeBlocked,
  statusChangeRequest,
  statusConfirmation,
  subscriptionText,
  tierText,
  when,
} from './userManagement';

/** P2.5.1 / P2.5.2 Admin -> Users, as pure logic: URL filters, the list query, the server's facts in words, the status change. */

describe('the list filters', () => {
  it('round-trip through the URL, leaving empty ones out', () => {
    const filters = { search: ' alice ', role: 'staff' as const, status: 'suspended' as const, createdFrom: '2026-02-01', createdTo: '' };
    const params = filtersToParams(filters);
    expect(params.toString()).toBe('search=alice&role=staff&status=suspended&createdFrom=2026-02-01');
    expect(filtersFromParams(params)).toEqual({ search: 'alice', role: 'staff', status: 'suspended', createdFrom: '2026-02-01', createdTo: '' });
    expect(filtersToParams(EMPTY_FILTERS).toString()).toBe('');
    expect(hasFilters(EMPTY_FILTERS)).toBe(false);
    expect(hasFilters(filters)).toBe(true);
  });

  it('treat an unknown type or status as no filter (the server checks everything else)', () => {
    expect(filtersFromParams(new URLSearchParams('role=owner')).role).toBe('all');
    expect(filtersFromParams(new URLSearchParams('status=closed')).status).toBe('all');
  });

  it('build one page of the list query, with the cursor the server issued', () => {
    expect(listQuery({ ...EMPTY_FILTERS, role: 'customer' }, null)).toBe('role=customer');
    expect(listQuery({ ...EMPTY_FILTERS, status: 'active' }, null)).toBe('status=active');
    expect(listQuery({ ...EMPTY_FILTERS, search: 'a@b.c' }, 'CURSOR')).toBe('search=a%40b.c&cursor=CURSOR');
  });
});

describe("the server's facts, in words", () => {
  it('shows instants to the minute in UTC, and a missing one as a dash', () => {
    expect(when('2026-09-19T12:34:56.123456Z')).toBe('2026-09-19 12:34 UTC');
    expect(when(null)).toBe('—');
  });

  it('tier, subscription and age -- including what cannot be resolved', () => {
    expect(tierText({ available: true, value: 'premium' })).toBe('Premium');
    expect(tierText({ available: false, reason: 'subscription_unresolvable' })).toMatch(/Cannot be resolved/);
    expect(subscriptionText({ available: true, value: null })).toBe('No paid subscription');
    expect(
      subscriptionText({ available: true, value: { status: 'past_due', planCode: 'test_plan', currentPeriodEnd: '2026-10-01T00:00:00.000Z', cancelAtPeriodEnd: false } }),
    ).toBe('test_plan — past due, period ends 2026-10-01 00:00 UTC');
    expect(
      subscriptionText({ available: true, value: { status: 'cancelled', planCode: 'test_plan', currentPeriodEnd: '2026-10-01T00:00:00.000Z', cancelAtPeriodEnd: true } }),
    ).toBe('test_plan — cancelled, ends 2026-10-01 00:00 UTC');
    expect(ageText({ available: false, reason: 'age_verification_not_supported' })).toBe('Not tracked yet.');
  });
});

describe('the account status change (P2.5.2)', () => {
  it('offers exactly one change from each status: its opposite', () => {
    expect(STATUS_ACTION.active).toEqual({ to: 'suspended', label: 'Suspend account' });
    expect(STATUS_ACTION.suspended).toEqual({ to: 'active', label: 'Reactivate account' });
  });

  it("puts the server's refusal into words, and nothing when it allows", () => {
    expect(statusChangeBlocked({ allowed: true })).toBeNull();
    expect(statusChangeBlocked({ allowed: false, reason: 'own_account' })).toMatch(/your own account/);
    expect(statusChangeBlocked({ allowed: false, reason: 'staff_account' })).toMatch(/Staff accounts/);
    expect(statusChangeBlocked({ allowed: false, reason: 'permission_required' })).toMatch(/users\.status\.manage/);
  });

  it('builds a compare-and-set request from the status shown, and requires a reason', () => {
    expect(statusChangeRequest('active', '  Chargeback fraud  ')).toEqual({
      ok: true,
      value: { status: 'suspended', expectedStatus: 'active', reason: 'Chargeback fraud' },
    });
    expect(statusChangeRequest('suspended', 'Resolved')).toEqual({ ok: true, value: { status: 'active', expectedStatus: 'suspended', reason: 'Resolved' } });
    expect(statusChangeRequest('active', '   ')).toMatchObject({ ok: false, errors: [expect.stringMatching(/reason is required/)] });
    expect(statusChangeRequest('active', 'x'.repeat(501))).toMatchObject({ ok: false });
  });

  it('confirms what the change does -- and what it leaves alone', () => {
    const suspend = statusConfirmation({ status: 'suspended', expectedStatus: 'active', reason: 'Abuse' }, 'c@example.com');
    expect(suspend.title).toBe('Suspend c@example.com?');
    expect(suspend.body).toMatch(/signed out everywhere/);
    expect(suspend.body).toMatch(/subscription, wallet, entitlements and content are not changed/);
    expect(suspend.body).toContain('"Abuse"');
    const reactivate = statusConfirmation({ status: 'active', expectedStatus: 'suspended', reason: 'Resolved' }, 'c@example.com');
    expect(reactivate.title).toBe('Reactivate c@example.com?');
    expect(reactivate.body).toMatch(/new sign-in/);
  });
});

describe('failures', () => {
  it('tells an ended session and a refused role apart from other errors', () => {
    expect(pageError(new ApiRequestError(401, 'unauthorized', 'Authentication required.'))).toMatchObject({ kind: 'unauthorized' });
    expect(pageError(new ApiRequestError(403, 'forbidden', 'Your role does not permit this action.'))).toMatchObject({
      kind: 'forbidden',
      messages: [expect.stringContaining('users.commercial.read')],
    });
    expect(pageError(new ApiRequestError(400, 'invalid_request', 'createdFrom must be a date, YYYY-MM-DD.'))).toEqual({
      kind: 'error',
      messages: ['createdFrom must be a date, YYYY-MM-DD.'],
    });
  });
});
