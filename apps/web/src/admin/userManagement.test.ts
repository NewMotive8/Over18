import { describe, expect, it } from 'vitest';
import { ApiRequestError } from '../lib/api';
import {
  EMPTY_FILTERS,
  ageText,
  filtersFromParams,
  filtersToParams,
  hasFilters,
  listQuery,
  pageError,
  subscriptionText,
  tierText,
  when,
} from './userManagement';

/** P2.5.1 Admin -> Users, as pure logic: URL filters, the list query, and the server's facts in words. */

describe('the list filters', () => {
  it('round-trip through the URL, leaving empty ones out', () => {
    const filters = { search: ' alice ', role: 'staff' as const, createdFrom: '2026-02-01', createdTo: '' };
    const params = filtersToParams(filters);
    expect(params.toString()).toBe('search=alice&role=staff&createdFrom=2026-02-01');
    expect(filtersFromParams(params)).toEqual({ search: 'alice', role: 'staff', createdFrom: '2026-02-01', createdTo: '' });
    expect(filtersToParams(EMPTY_FILTERS).toString()).toBe('');
    expect(hasFilters(EMPTY_FILTERS)).toBe(false);
    expect(hasFilters(filters)).toBe(true);
  });

  it('treat an unknown type as no filter (the server checks everything else)', () => {
    expect(filtersFromParams(new URLSearchParams('role=owner')).role).toBe('all');
  });

  it('build one page of the list query, with the cursor the server issued', () => {
    expect(listQuery({ ...EMPTY_FILTERS, role: 'customer' }, null)).toBe('role=customer');
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
