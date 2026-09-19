import type { AdminUserAccountRole, AdminUserDetail } from '@over18/shared';
import { ApiRequestError } from '../lib/api';
import { serverMessages } from './economyConfig';

/**
 * Admin -> Users (P2.5.1), as pure logic. The web suite runs no effects, so
 * what the pages decide lives here and is tested here.
 *
 * THE SERVER DECIDES: it searches, filters, pages and resolves every fact.
 * These helpers keep the filters in the URL, build the query string and put
 * the server's answers into words -- nothing more.
 */

export type RoleFilter = 'all' | 'customer' | 'staff';

export interface UserFilters {
  search: string;
  role: RoleFilter;
  /** YYYY-MM-DD, or '' for none. */
  createdFrom: string;
  createdTo: string;
}

export const EMPTY_FILTERS: UserFilters = { search: '', role: 'all', createdFrom: '', createdTo: '' };

/** The filters a list URL carries. Unknown values fall back to "no filter"; the server checks the rest. */
export function filtersFromParams(params: URLSearchParams): UserFilters {
  const role = params.get('role');
  return {
    search: params.get('search') ?? '',
    role: role === 'customer' || role === 'staff' ? role : 'all',
    createdFrom: params.get('createdFrom') ?? '',
    createdTo: params.get('createdTo') ?? '',
  };
}

/** The filters as URL / query-string parameters; empty filters are left out. */
export function filtersToParams(filters: UserFilters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.search.trim()) params.set('search', filters.search.trim());
  if (filters.role !== 'all') params.set('role', filters.role);
  if (filters.createdFrom) params.set('createdFrom', filters.createdFrom);
  if (filters.createdTo) params.set('createdTo', filters.createdTo);
  return params;
}

/** The list request's query string for one page. */
export function listQuery(filters: UserFilters, cursor: string | null): string {
  const params = filtersToParams(filters);
  if (cursor) params.set('cursor', cursor);
  return params.toString();
}

export const hasFilters = (filters: UserFilters): boolean => filtersToParams(filters).toString() !== '';

export const ROLE_LABEL: Record<AdminUserAccountRole, string> = { user: 'Customer', admin: 'Staff' };

/** An ISO instant as "YYYY-MM-DD HH:MM UTC"; a missing one as a dash. */
export function when(iso: string | null): string {
  if (!iso) return '—';
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

const UNAVAILABLE: Record<string, string> = {
  subscription_unresolvable: 'Cannot be resolved: the subscription names a plan version that is not published.',
  wallet_unresolvable: 'Cannot be resolved: the Credit classes do not reconcile.',
  age_verification_not_supported: 'Not tracked yet.',
  subscriptions_not_supported: 'Not tracked yet.',
  wallet_not_supported: 'Not tracked yet.',
};

const unavailableText = (reason: string) => UNAVAILABLE[reason] ?? `Unavailable (${reason}).`;

type Commercial = AdminUserDetail['commercial'];

export function tierText(tier: Commercial['tier']): string {
  if (!tier.available) return unavailableText(tier.reason);
  return tier.value === 'premium' ? 'Premium' : 'Free';
}

export function subscriptionText(subscription: Commercial['subscription']): string {
  if (!subscription.available) return unavailableText(subscription.reason);
  const s = subscription.value;
  if (!s) return 'No paid subscription';
  const end = s.cancelAtPeriodEnd ? `ends ${when(s.currentPeriodEnd)}` : `period ends ${when(s.currentPeriodEnd)}`;
  return `${s.planCode} — ${s.status.replace('_', ' ')}, ${end}`;
}

export function ageText(age: Commercial['age']): string {
  if (!age.available) return unavailableText(age.reason);
  return age.value.verified ? `Verified${age.value.expiresAt ? ` until ${when(age.value.expiresAt)}` : ''}` : 'Not verified';
}

/**
 * What a failed request means to the operator: an ended session, a role that
 * may not see users, or the server's own words.
 */
export function pageError(error: unknown): { kind: 'unauthorized' | 'forbidden' | 'error'; messages: string[] } {
  if (error instanceof ApiRequestError && error.status === 401) return { kind: 'unauthorized', messages: ['Your session has ended. Sign in again.'] };
  if (error instanceof ApiRequestError && error.status === 403) {
    return { kind: 'forbidden', messages: ['Your role does not permit viewing users (it needs users.commercial.read).'] };
  }
  return { kind: 'error', messages: serverMessages(error) };
}
