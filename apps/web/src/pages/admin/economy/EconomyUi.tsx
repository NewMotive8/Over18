import type { ReactNode } from 'react';
import type { EconomyVersionState } from '@over18/shared';
import { STATE_LABEL } from '../../../admin/economyConfig';

/**
 * Small presentational pieces shared by the economy editors. No fetching, no
 * state, no economy logic -- they render what they are given.
 */

export const inputClass = 'mt-1 w-full rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-100';
export const buttonClass = 'rounded-md bg-rose-600 px-4 py-2 text-sm font-semibold text-white hover:bg-rose-500 disabled:opacity-50';
export const secondaryButtonClass = 'rounded-md border border-zinc-700 px-4 py-2 text-sm text-zinc-200 hover:bg-zinc-800 disabled:opacity-50';

/** Server or form messages. `alert` for errors (announced); `status` for warnings and notes. */
export function MessageList({ messages, tone = 'error' }: { messages: readonly string[]; tone?: 'error' | 'warning' | 'success' }) {
  if (messages.length === 0) return null;
  const styles = {
    error: 'border-red-900 bg-red-950/40 text-red-200',
    warning: 'border-amber-500/30 bg-amber-500/10 text-amber-200',
    success: 'border-emerald-800 bg-emerald-950/40 text-emerald-200',
  }[tone];
  return (
    <ul role={tone === 'error' ? 'alert' : 'status'} className={`list-disc rounded-lg border py-3 pl-8 pr-4 text-sm ${styles}`}>
      {messages.map((m) => (
        <li key={m}>{m}</li>
      ))}
    </ul>
  );
}

export function StateBadge({ state }: { state: EconomyVersionState }) {
  const styles: Record<EconomyVersionState, string> = {
    draft: 'border-sky-800 text-sky-300',
    scheduled: 'border-amber-700 text-amber-300',
    active: 'border-emerald-800 text-emerald-300',
    superseded: 'border-zinc-700 text-zinc-500',
    cancelled: 'border-zinc-700 text-zinc-500 line-through',
  };
  return <span className={`rounded border px-1.5 py-0.5 text-[11px] uppercase tracking-wide ${styles[state]}`}>{STATE_LABEL[state]}</span>;
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block text-sm text-zinc-300">
      {label}
      {children}
      {hint && <span className="mt-1 block text-xs text-zinc-500">{hint}</span>}
    </label>
  );
}

export function Section({ title, children, actions }: { title: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">{title}</h3>
        {actions}
      </div>
      {children}
    </section>
  );
}

/** A version history table: the columns are given, the state and timestamps are standard. */
export function VersionHistory<V extends { id: string; version: number; state: EconomyVersionState; effectiveFrom: string | null; publishReason: string | null }>({
  versions,
  columns,
}: {
  versions: readonly V[];
  columns: Array<{ label: string; value: (v: V) => ReactNode }>;
}) {
  if (versions.length === 0) return <p className="text-sm text-zinc-500">No version yet.</p>;
  const newestFirst = [...versions].sort((a, b) => b.version - a.version);
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[40rem] text-left text-sm">
        <thead className="text-xs text-zinc-500">
          <tr>
            <th className="py-1">Version</th>
            <th>State</th>
            <th>Takes effect</th>
            {columns.map((c) => (
              <th key={c.label}>{c.label}</th>
            ))}
            <th>Reason</th>
          </tr>
        </thead>
        <tbody className="align-top text-zinc-300">
          {newestFirst.map((v) => (
            <tr key={v.id} data-testid="version-row">
              <td className="py-1">v{v.version}</td>
              <td>
                <StateBadge state={v.state} />
              </td>
              <td className="text-xs text-zinc-400">{v.effectiveFrom ?? '—'}</td>
              {columns.map((c) => (
                <td key={c.label}>{c.value(v)}</td>
              ))}
              <td className="text-xs text-zinc-400">{v.publishReason ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
