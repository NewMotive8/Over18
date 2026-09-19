import type { AccountStatus, AdminAccountStatusChange, AdminAccountStatusChangeRequest, AdminUserAccountRole, AdminUserDetail } from '@over18/shared';
import { ApiRequestError } from '../lib/api';
import { serverMessages } from './economyConfig';

/**
 * Admin -> Users (P2.5.1, P2.5.2), as pure logic. The web suite runs no effects, so
 * what the pages decide lives here and is tested here.
 *
 * THE SERVER DECIDES: it searches, filters, pages and resolves every fact.
 * These helpers keep the filters in the URL, build the query string and put
 * the server's answers into words -- nothing more. Whether an account's status
 * may be changed, and by whom, is the server's decision too.
 */

export type RoleFilter = 'all' | 'customer' | 'staff';
export type StatusFilter = 'all' | AccountStatus;

export interface UserFilters {
  search: string;
  role: RoleFilter;
  status: StatusFilter;
  /** YYYY-MM-DD, or '' for none. */
  createdFrom: string;
  createdTo: string;
}

export const EMPTY_FILTERS: UserFilters = { search: '', role: 'all', status: 'all', createdFrom: '', createdTo: '' };

/** The filters a list URL carries. Unknown values fall back to "no filter"; the server checks the rest. */
export function filtersFromParams(params: URLSearchParams): UserFilters {
  const role = params.get('role');
  const status = params.get('status');
  return {
    search: params.get('search') ?? '',
    role: role === 'customer' || role === 'staff' ? role : 'all',
    status: status === 'active' || status === 'suspended' ? status : 'all',
    createdFrom: params.get('createdFrom') ?? '',
    createdTo: params.get('createdTo') ?? '',
  };
}

/** The filters as URL / query-string parameters; empty filters are left out. */
export function filtersToParams(filters: UserFilters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.search.trim()) params.set('search', filters.search.trim());
  if (filters.role !== 'all') params.set('role', filters.role);
  if (filters.status !== 'all') params.set('status', filters.status);
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

export const STATUS_LABEL: Record<AccountStatus, string> = { active: 'Active', suspended: 'Suspended' };

/* ------------------------------------------------------------------ *
 * Account status (P2.5.2)
 * ------------------------------------------------------------------ */

/** The one change available from a status: they are each other's opposite. */
export const STATUS_ACTION: Record<AccountStatus, { to: AccountStatus; label: string }> = {
  active: { to: 'suspended', label: 'Suspend account' },
  suspended: { to: 'active', label: 'Reactivate account' },
};

/** Why this operator cannot change the status, in words; null when they can. */
export function statusChangeBlocked(change: AdminAccountStatusChange): string | null {
  if (change.allowed) return null;
  switch (change.reason) {
    case 'own_account':
      return 'You cannot change the status of your own account.';
    case 'staff_account':
      return 'Staff accounts cannot be suspended or reactivated here — only customer accounts.';
    case 'permission_required':
      return 'Changing an account status needs the users.status.manage permission (administrators only).';
  }
}

/** The request for the one change available from `current`, or what is missing. */
export function statusChangeRequest(
  current: AccountStatus,
  reason: string,
): { ok: true; value: AdminAccountStatusChangeRequest } | { ok: false; errors: string[] } {
  const trimmed = reason.trim();
  if (!trimmed) return { ok: false, errors: ['A reason is required. It is recorded in the audit log.'] };
  if (trimmed.length > 500) return { ok: false, errors: ['The reason must be at most 500 characters.'] };
  return { ok: true, value: { status: STATUS_ACTION[current].to, expectedStatus: current, reason: trimmed } };
}

/** What the confirmation says the change will and will not do. */
export function statusConfirmation(request: AdminAccountStatusChangeRequest, email: string): { title: string; body: string } {
  if (request.status === 'suspended') {
    return {
      title: `Suspend ${email}?`,
      body:
        'They will be signed out everywhere at once and cannot sign in until the account is reactivated. ' +
        'Their subscription, wallet, entitlements and content are not changed. ' +
        `Reason recorded in the audit log: "${request.reason}"`,
    };
  }
  return {
    title: `Reactivate ${email}?`,
    body:
      'They will be able to sign in again, with a new sign-in: sessions ended by the suspension stay ended. ' +
      'Nothing else about the account changes. ' +
      `Reason recorded in the audit log: "${request.reason}"`,
  };
}

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
