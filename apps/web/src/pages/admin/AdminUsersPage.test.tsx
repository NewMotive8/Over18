import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { AdminUserDetail, AdminUserListItem } from '@over18/shared';
import { EMPTY_FILTERS } from '../../admin/userManagement';
import AdminUserDetailPage, { UserDetailView } from './AdminUserDetailPage';
import AdminUsersPage, { UserFiltersForm, UsersListBody, UsersTable } from './AdminUsersPage';

/**
 * P2.5.1 -- the admin Users list and detail, rendered statically (the suite
 * runs no effects). Everything shown is server-shaped test data passed in.
 */

const render = (node: ReactNode) => renderToStaticMarkup(<MemoryRouter>{node}</MemoryRouter>);
const ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

const row = (over: Partial<AdminUserListItem> = {}): AdminUserListItem => ({
  id: ID,
  email: 'customer@example.com',
  role: 'user',
  staffRoles: [],
  createdAt: '2026-09-01T08:00:00.000000Z',
  lastSignInAt: '2026-09-19T10:15:00.000000Z',
  ...over,
});

const detail = (over: Partial<AdminUserDetail> = {}): AdminUserDetail => ({
  identity: { id: ID, email: 'customer@example.com' },
  account: { role: 'user', staffRoles: [], createdAt: '2026-09-01T08:00:00.000000Z', updatedAt: '2026-09-02T08:00:00.000000Z' },
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
  it('shows each user: email linking to their detail, type, staff roles, created and last sign-in', () => {
    const html = render(<UsersTable users={[row(), row({ id: 'staff-1', email: 'op@example.com', role: 'admin', staffRoles: ['support', 'analyst'], lastSignInAt: null })]} />);
    expect(html.match(/data-testid="user-row"/g)).toHaveLength(2);
    expect(html).toContain(`href="/admin/users/${ID}"`);
    expect(html).toContain('Customer');
    expect(html).toContain('Staff');
    expect(html).toContain('support, analyst');
    expect(html).toContain('2026-09-19 10:15 UTC');
  });

  it('has a search, a type filter and a created-date range', () => {
    const html = render(<UserFiltersForm value={{ ...EMPTY_FILTERS, search: 'alice', role: 'staff' }} onApply={() => {}} />);
    expect(html).toContain('value="alice"');
    expect(html).toContain('<option value="staff" selected="">Staff</option>');
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
  it('shows identity, account, commercial state, wallet, activity and audit -- read-only', () => {
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
    expect(html).toContain('Not tracked yet — account status arrives with P2.5.2');
    expect(html).not.toMatch(/<form|<input|<button[^>]*type="submit"/);
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
