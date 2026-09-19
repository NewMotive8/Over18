import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { AdminUserDetail, AdminUserListItem } from '@over18/shared';
import { EMPTY_FILTERS } from '../../admin/userManagement';
import AdminUserDetailPage, { AccountStatusPanel, UserDetailView } from './AdminUserDetailPage';
import AdminUsersPage, { UserFiltersForm, UsersListBody, UsersTable } from './AdminUsersPage';

/**
 * P2.5.1 / P2.5.2 -- the admin Users list and detail, rendered statically (the
 * suite runs no effects). Everything shown is server-shaped test data passed in.
 */

const render = (node: ReactNode) => renderToStaticMarkup(<MemoryRouter>{node}</MemoryRouter>);
const ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

const row = (over: Partial<AdminUserListItem> = {}): AdminUserListItem => ({
  id: ID,
  email: 'customer@example.com',
  role: 'user',
  status: 'active',
  staffRoles: [],
  createdAt: '2026-09-01T08:00:00.000000Z',
  lastSignInAt: '2026-09-19T10:15:00.000000Z',
  ...over,
});

const detail = (over: Partial<AdminUserDetail> = {}): AdminUserDetail => ({
  identity: { id: ID, email: 'customer@example.com' },
  account: {
    role: 'user',
    staffRoles: [],
    createdAt: '2026-09-01T08:00:00.000000Z',
    updatedAt: '2026-09-02T08:00:00.000000Z',
    status: 'active',
    statusChange: { allowed: true },
  },
  activity: { lastSignInAt: '2026-09-19T10:15:00.000000Z', activeSessions: 2, conversations: 3, lastConversationAt: '2026-09-18T20:00:00.000000Z' },
  commercial: {
    economyEnabled: false,
    tier: { available: true, value: 'premium' },
    subscription: { available: true, value: { status: 'active', planCode: 'test_plan', currentPeriodEnd: '2026-10-01T00:00:00.000Z', cancelAtPeriodEnd: false } },
    age: { available: false, reason: 'age_verification_not_supported' },
  },
  wallets: [{ currency: 'credits', exists: true, included: 11, earned: 22, purchased: 33, held: 4, spendable: 66, transactions: 7 }],
  audit: {
    available: true,
    entries: [
      {
        id: 9,
        occurredAt: '2026-09-19T11:00:00.000Z',
        actorUserId: 'op-1',
        actorEmail: 'operator@example.com',
        action: 'wallet.adjust.credit',
        objectType: 'wallet',
        objectId: `${ID}:credits`,
        before: null,
        after: null,
        reason: 'Goodwill',
        requestId: null,
        metadata: {},
      },
    ],
  },
  ...over,
});

describe('the Users list', () => {
  it('shows each user: email linking to their detail, type, status, staff roles, created and last sign-in', () => {
    const html = render(
      <UsersTable
        users={[row({ status: 'suspended' }), row({ id: 'staff-1', email: 'op@example.com', role: 'admin', staffRoles: ['support', 'analyst'], lastSignInAt: null })]}
      />,
    );
    expect(html.match(/data-testid="user-row"/g)).toHaveLength(2);
    expect(html).toContain(`href="/admin/users/${ID}"`);
    expect(html).toContain('Customer');
    expect(html).toContain('Staff');
    expect(html).toContain('>Suspended</td>');
    expect(html).toContain('>Active</td>');
    expect(html).toContain('support, analyst');
    expect(html).toContain('2026-09-19 10:15 UTC');
  });

  it('has a search, a type filter, a status filter and a created-date range', () => {
    const html = render(<UserFiltersForm value={{ ...EMPTY_FILTERS, search: 'alice', role: 'staff', status: 'suspended' }} onApply={() => {}} />);
    expect(html).toContain('value="alice"');
    expect(html).toContain('<option value="staff" selected="">Staff</option>');
    expect(html).toContain('<option value="suspended" selected="">Suspended</option>');
    expect(html.match(/type="date"/g)).toHaveLength(2);
    expect(html).toContain('Part of an email, or a whole User ID');
  });

  it('says what is happening in every state: loading, empty, filtered-empty, refused, failed', () => {
    expect(render(<UsersListBody state={{ status: 'loading' }} filtered={false} />)).toContain('Loading users');
    const empty = { status: 'ready' as const, page: { users: [], nextCursor: null } };
    expect(render(<UsersListBody state={empty} filtered={false} />)).toContain('There are no users yet.');
    expect(render(<UsersListBody state={empty} filtered />)).toContain('No user matches these filters.');
    const refused = render(<UsersListBody state={{ status: 'failed', kind: 'forbidden', messages: ['Your role does not permit viewing users (it needs users.commercial.read).'] }} filtered={false} />);
    expect(refused).toContain('role="alert"');
    expect(refused).toContain('users.commercial.read');
  });

  it('asks the server for the list rather than assuming one', () => {
    expect(render(<AdminUsersPage />)).toContain('Loading users');
  });
});

describe('the User detail', () => {
  it('shows identity, account (with its status), commercial state, wallet, activity and audit', () => {
    const html = render(<UserDetailView detail={detail()} />);
    for (const section of ['Identity', 'Account', 'Commercial / subscription', 'Wallet', 'Activity', 'Audit']) expect(html).toContain(section);
    expect(html).toContain(ID);
    expect(html).toContain('Premium');
    expect(html).toContain('test_plan — active, period ends 2026-10-01 00:00 UTC');
    expect(html).toContain('Switched off');
    expect(html).toContain('<td>11</td><td>22</td><td>33</td><td>4</td>');
    expect(html).toContain('66');
    expect(html).toContain('wallet.adjust.credit');
    expect(html).toContain('operator@example.com');
    expect(html).toContain('Account status');
    expect(html).toContain('>Active</dd>');
    expect(html).not.toContain('Not tracked yet — account status');
    // The view alone changes nothing: the status control is the page's, passed in.
    expect(html).not.toMatch(/<form|<input|<textarea|<button[^>]*type="submit"/);
    expect(render(<UserDetailView detail={detail({ account: { ...detail().account, status: 'suspended' } })} />)).toContain('>Suspended</dd>');
  });

  it('links to the existing wallet support screen', () => {
    expect(render(<UserDetailView detail={detail()} />)).toContain(`href="/admin/wallets/${ID}"`);
  });

  it('says so when there is no wallet, or when audit entries need audit.read', () => {
    const html = render(
      <UserDetailView
        detail={detail({
          wallets: [{ currency: 'credits', exists: false, included: 0, earned: 0, purchased: 0, held: 0, spendable: 0, transactions: 0 }],
          audit: { available: false, reason: 'audit_read_required' },
        })}
      />,
    );
    expect(html).toContain('(no wallet yet)');
    expect(html).toContain('Audit entries need the audit.read permission.');
  });

  it('places the status control inside the Account section', () => {
    const html = render(<UserDetailView detail={detail()} statusControl={<p data-testid="probe">control</p>} />);
    const account = html.slice(html.indexOf('Account'), html.indexOf('Commercial / subscription'));
    expect(account).toContain('data-testid="probe"');
  });

  it('loads the user from the server by permanent User ID', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={[`/admin/users/${ID}`]}>
        <Routes>
          <Route path="/admin/users/:userId" element={<AdminUserDetailPage />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(html).toContain('Loading the user');
    expect(html).toContain('href="/admin/users"');
  });
});

describe('the account status control (P2.5.2)', () => {
  const panel = (over: Partial<Parameters<typeof AccountStatusPanel>[0]> = {}) =>
    render(
      <AccountStatusPanel status="active" change={{ allowed: true }} reason="" onReason={() => {}} onReview={() => {}} busy={false} messages={[]} {...over} />,
    );

  it('offers Suspend on an active customer, with a required reason, and says what it leaves alone', () => {
    const html = panel();
    expect(html).toContain('data-testid="status-change-form"');
    expect(html).toContain('Reason (required)');
    expect(html).toContain('<textarea');
    expect(html).toContain('Suspend account…');
    expect(html).not.toContain('Reactivate');
    expect(html).toContain('Subscription, wallet, entitlements and content are not changed.');
    // No reason yet: nothing to review.
    expect(html).toMatch(/<button type="submit" disabled=""/);
  });

  it('offers Reactivate on a suspended customer, enabled once a reason is given', () => {
    const html = panel({ status: 'suspended', reason: 'Resolved with the customer' });
    expect(html).toContain('Reactivate account…');
    expect(html).not.toContain('Suspend account');
    expect(html).not.toMatch(/<button type="submit" disabled=""/);
  });

  it("offers nothing to submit when the server says no -- and says why", () => {
    for (const [reason, words] of [
      ['own_account', 'your own account'],
      ['staff_account', 'Staff accounts cannot be suspended'],
      ['permission_required', 'users.status.manage'],
    ] as const) {
      const html = panel({ change: { allowed: false, reason } });
      expect(html).toContain('data-testid="status-change-blocked"');
      expect(html).toContain(words);
      expect(html).not.toMatch(/<form|<textarea|<button/);
    }
  });

  it("shows the server's refusal, e.g. a conflict", () => {
    const html = panel({ reason: 'x', messages: ['This account is suspended now, not active: it changed since you loaded it. Nothing was changed.'] });
    expect(html).toContain('role="alert"');
    expect(html).toContain('it changed since you loaded it');
  });
});
