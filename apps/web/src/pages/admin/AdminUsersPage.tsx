import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { AdminUserList, AdminUserListItem } from '@over18/shared';
import {
  EMPTY_FILTERS,
  ROLE_LABEL,
  filtersFromParams,
  filtersToParams,
  hasFilters,
  listQuery,
  pageError,
  when,
  type RoleFilter,
  type UserFilters,
} from '../../admin/userManagement';
import { adminUsersApi } from '../../lib/api';
import { Field, MessageList, buttonClass, inputClass, secondaryButtonClass } from './economy/EconomyUi';

/**
 * Admin -> Users (P2.5.1): search, filter and page through users, newest
 * first, and open one. Read-only. The server searches, filters, pages and
 * enforces the permission; the filters live in the URL so a view can be shared.
 */

export function UsersTable({ users }: { users: readonly AdminUserListItem[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[48rem] text-left text-sm">
        <thead className="text-xs text-zinc-500">
          <tr>
            <th className="py-1">Email</th>
            <th>Type</th>
            <th>Staff roles</th>
            <th>Created</th>
            <th>Last sign-in</th>
          </tr>
        </thead>
        <tbody className="text-zinc-300">
          {users.map((u) => (
            <tr key={u.id} data-testid="user-row">
              <td className="py-1">
                <Link to={`/admin/users/${u.id}`} className="text-rose-400 hover:text-rose-300">
                  {u.email}
                </Link>
              </td>
              <td>{ROLE_LABEL[u.role]}</td>
              <td className="text-xs text-zinc-400">{u.staffRoles.length > 0 ? u.staffRoles.join(', ') : '—'}</td>
              <td className="text-xs text-zinc-400">{when(u.createdAt)}</td>
              <td className="text-xs text-zinc-400">{when(u.lastSignInAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The search and filters, edited as a draft and applied together. */
export function UserFiltersForm({ value, onApply }: { value: UserFilters; onApply: (filters: UserFilters) => void }) {
  const [draft, setDraft] = useState<UserFilters>(value);
  return (
    <form
      className="grid gap-3 rounded-lg border border-zinc-800 bg-zinc-900/40 p-4 sm:grid-cols-[2fr_1fr_1fr_1fr_auto]"
      onSubmit={(event) => {
        event.preventDefault();
        onApply(draft);
      }}
    >
      <Field label="Search" hint="Part of an email, or a whole User ID">
        <input value={draft.search} onChange={(e) => setDraft({ ...draft, search: e.target.value })} className={inputClass} />
      </Field>
      <Field label="Type">
        <select value={draft.role} onChange={(e) => setDraft({ ...draft, role: e.target.value as RoleFilter })} className={inputClass}>
          <option value="all">All</option>
          <option value="customer">Customers</option>
          <option value="staff">Staff</option>
        </select>
      </Field>
      <Field label="Created from">
        <input type="date" value={draft.createdFrom} onChange={(e) => setDraft({ ...draft, createdFrom: e.target.value })} className={inputClass} />
      </Field>
      <Field label="Created to">
        <input type="date" value={draft.createdTo} onChange={(e) => setDraft({ ...draft, createdTo: e.target.value })} className={inputClass} />
      </Field>
      <div className="flex items-end gap-2">
        <button type="submit" className={buttonClass}>
          Apply
        </button>
        <button
          type="button"
          onClick={() => {
            setDraft(EMPTY_FILTERS);
            onApply(EMPTY_FILTERS);
          }}
          className={secondaryButtonClass}
        >
          Clear
        </button>
      </div>
    </form>
  );
}

type Loaded =
  | { status: 'loading' }
  | { status: 'failed'; kind: 'unauthorized' | 'forbidden' | 'error'; messages: string[] }
  | { status: 'ready'; page: AdminUserList };

/** What the list area shows for each state. Pure: the page decides the state. */
export function UsersListBody({ state, filtered }: { state: Loaded; filtered: boolean }) {
  if (state.status === 'loading') return <p className="text-sm text-zinc-400">Loading users…</p>;
  if (state.status === 'failed') return <MessageList messages={state.messages} />;
  if (state.page.users.length === 0) {
    return <p className="text-sm text-zinc-500">{filtered ? 'No user matches these filters.' : 'There are no users yet.'}</p>;
  }
  return <UsersTable users={state.page.users} />;
}

export default function AdminUsersPage() {
  const [params, setParams] = useSearchParams();
  const filters = filtersFromParams(params);
  const filterKey = filtersToParams(filters).toString();
  // The cursors of the pages visited: the last is the current page's; none is the first page.
  const [cursors, setCursors] = useState<string[]>([]);
  const cursor = cursors.at(-1) ?? null;
  const [state, setState] = useState<Loaded>({ status: 'loading' });

  useEffect(() => {
    let current = true;
    setState({ status: 'loading' });
    adminUsersApi
      .list(listQuery(filtersFromParams(new URLSearchParams(filterKey)), cursor))
      .then((page) => current && setState({ status: 'ready', page }))
      .catch((error: unknown) => current && setState({ status: 'failed', ...pageError(error) }));
    return () => {
      current = false;
    };
  }, [filterKey, cursor]);

  const apply = (next: UserFilters) => {
    setCursors([]);
    setParams(filtersToParams(next));
  };

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold text-white">Users</h1>
        <p className="mt-1 text-sm text-zinc-400">Find a user by email or permanent User ID, then open their account, commercial state, wallet and activity.</p>
      </div>
      <UserFiltersForm key={filterKey} value={filters} onApply={apply} />
      <UsersListBody state={state} filtered={hasFilters(filters)} />
      {state.status === 'ready' && (cursors.length > 0 || state.page.nextCursor) ? (
        <div className="flex gap-2">
          <button type="button" disabled={cursors.length === 0} onClick={() => setCursors([])} className={secondaryButtonClass}>
            First page
          </button>
          <button type="button" disabled={cursors.length === 0} onClick={() => setCursors(cursors.slice(0, -1))} className={secondaryButtonClass}>
            Previous
          </button>
          <button
            type="button"
            disabled={!state.page.nextCursor}
            onClick={() => state.page.nextCursor && setCursors([...cursors, state.page.nextCursor])}
            className={secondaryButtonClass}
          >
            Next
          </button>
        </div>
      ) : null}
    </div>
  );
}
