import { useCallback, useEffect, useState } from 'react';
import type { AdminAccessView, AuditEntryView } from '@over18/shared';
import { adminAccessApi, ApiRequestError, type AuditFilters } from '../../lib/api';

/**
 * Admin -> Audit (PRD v1.2 §34.2). READ-ONLY.
 *
 * Who changed what, from what to what, when, and why. There is no edit or
 * delete control anywhere on this screen because none exists anywhere else
 * either: the log is append-only in the database itself.
 */

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function formatWhen(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

/**
 * The table, as a pure component: no fetching, no state. `before` and `after`
 * are shown only when the writer knew them -- the generic admin-write hook
 * never does, and an em dash says so rather than implying "empty".
 */
export function AuditTable({ entries }: { entries: readonly AuditEntryView[] }) {
  if (entries.length === 0) {
    return (
      <p className="rounded-lg border border-neutral-800 px-4 py-6 text-sm text-neutral-400">
        No audit entries yet.
      </p>
    );
  }
  return (
    <div className="overflow-x-auto rounded-lg border border-neutral-800">
      <table className="w-full min-w-[56rem] text-left text-sm">
        <thead className="bg-neutral-900 text-xs uppercase tracking-wide text-neutral-500">
          <tr>
            <th className="px-3 py-2 font-medium">When</th>
            <th className="px-3 py-2 font-medium">Who</th>
            <th className="px-3 py-2 font-medium">Action</th>
            <th className="px-3 py-2 font-medium">Object</th>
            <th className="px-3 py-2 font-medium">Before → After</th>
            <th className="px-3 py-2 font-medium">Reason</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-neutral-800">
          {entries.map((entry) => (
            <tr key={entry.id} data-testid="audit-row" className="align-top text-neutral-300">
              <td className="whitespace-nowrap px-3 py-2 text-neutral-400">
                {formatWhen(entry.occurredAt)}
              </td>
              <td className="px-3 py-2">{entry.actorEmail ?? entry.actorUserId ?? 'system'}</td>
              <td className="px-3 py-2 font-mono text-xs">{entry.action}</td>
              <td className="px-3 py-2">
                <span className="text-neutral-400">{entry.objectType}</span>
                {entry.objectId && (
                  <span className="block break-all font-mono text-xs text-neutral-500">
                    {entry.objectId}
                  </span>
                )}
              </td>
              <td className="px-3 py-2 font-mono text-xs">
                <span className="block break-all">{formatValue(entry.before)}</span>
                <span className="block break-all text-neutral-100">{formatValue(entry.after)}</span>
              </td>
              <td className="px-3 py-2">{entry.reason ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function AdminAuditPage() {
  const [access, setAccess] = useState<AdminAccessView | null>(null);
  const [entries, setEntries] = useState<AuditEntryView[] | null>(null);
  const [nextCursor, setNextCursor] = useState<number | null>(null);
  const [filters, setFilters] = useState<AuditFilters>({});
  const [objectTypeDraft, setObjectTypeDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const load = useCallback(async (active: AuditFilters) => {
    setError(null);
    setEntries(null);
    try {
      const page = await adminAccessApi.audit(active);
      setEntries(page.entries);
      setNextCursor(page.nextCursor);
    } catch (err) {
      setError(
        err instanceof ApiRequestError && err.status === 403
          ? 'Your role does not include reading the audit log.'
          : 'The audit log could not be loaded.',
      );
    }
  }, []);

  useEffect(() => {
    void load(filters);
  }, [filters, load]);

  useEffect(() => {
    adminAccessApi.me().then(setAccess, () => setAccess(null));
  }, []);

  const loadMore = async () => {
    if (nextCursor === null) return;
    setLoadingMore(true);
    try {
      const page = await adminAccessApi.audit({ ...filters, before: nextCursor });
      setEntries((current) => [...(current ?? []), ...page.entries]);
      setNextCursor(page.nextCursor);
    } catch {
      setError('More entries could not be loaded.');
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-6xl px-4 pb-24 pt-6 sm:px-6">
      <header className="mb-4">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-neutral-500">Audit</p>
        <h1 className="mt-1 text-2xl font-semibold text-neutral-100 sm:text-3xl">Audit log</h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-neutral-400">
          Every attributed admin change, newest first. Entries cannot be edited or deleted — by
          anyone, including from this screen.
        </p>
      </header>

      {access && !access.features.auditLog && (
        <div
          role="status"
          className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200"
        >
          General admin-write recording is switched off. Only changes that record themselves —
          role grants and revocations — appear here until it is switched on.
        </div>
      )}

      <form
        className="mb-4 flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          setFilters({ objectType: objectTypeDraft.trim() || undefined });
        }}
      >
        <label className="flex flex-col gap-1 text-xs text-neutral-400">
          Object type
          <input
            value={objectTypeDraft}
            onChange={(event) => setObjectTypeDraft(event.target.value)}
            placeholder="e.g. admin_role_grant"
            className="w-56 rounded-md border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-sm text-neutral-100"
          />
        </label>
        <button
          type="submit"
          className="rounded-md bg-neutral-800 px-3 py-1.5 text-sm text-neutral-100 hover:bg-neutral-700"
        >
          Filter
        </button>
        <a
          href={adminAccessApi.exportUrl(filters)}
          className="ml-auto rounded-md border border-neutral-700 px-3 py-1.5 text-sm text-neutral-200 hover:bg-neutral-900"
        >
          Export CSV
        </a>
      </form>

      {error && (
        <p role="alert" className="mb-4 text-sm text-rose-400">
          {error}
        </p>
      )}

      {entries === null && !error && <p className="text-sm text-neutral-500">Loading…</p>}
      {entries && <AuditTable entries={entries} />}

      {nextCursor !== null && (
        <button
          type="button"
          onClick={() => void loadMore()}
          disabled={loadingMore}
          className="mt-4 rounded-md bg-neutral-800 px-4 py-2 text-sm text-neutral-100 hover:bg-neutral-700 disabled:opacity-50"
        >
          {loadingMore ? 'Loading…' : 'Load older entries'}
        </button>
      )}
    </div>
  );
}
