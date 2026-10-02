import { useCallback, useEffect, useState } from 'react';
import type { AnalyticsFunnel, AnalyticsFunnelsView } from '@over18/shared';
import { adminAnalyticsApi, ApiRequestError, type AnalyticsWindow } from '../../lib/api';

/**
 * Admin -> Analytics (Credits Store PR 3). READ-ONLY.
 *
 * The four commercial funnels as tables, for a date range, and a bounded CSV
 * of the events behind them. How many -- never who: no step lists a customer.
 * Deliberately not a dashboard: no charts, no trends, nothing to configure.
 */

/** "12.5%" of the step before; the first step has no conversion of its own. */
export function stepConversion(steps: AnalyticsFunnel['steps'], index: number): string {
  if (index === 0) return '—';
  const before = steps[index - 1]!.users;
  if (before === 0) return '—';
  const pct = (steps[index]!.users / before) * 100;
  return `${pct >= 10 || pct === 0 ? pct.toFixed(0) : pct.toFixed(1)}%`;
}

export function FunnelTable({ funnel }: { funnel: AnalyticsFunnel }) {
  return (
    <section aria-label={funnel.title} data-testid={`funnel-${funnel.key}`} className="rounded-lg border border-neutral-800">
      <h2 className="border-b border-neutral-800 px-4 py-2 text-sm font-semibold text-neutral-100">{funnel.title}</h2>
      <table className="w-full text-left text-sm">
        <thead className="text-xs uppercase tracking-wide text-neutral-500">
          <tr>
            <th className="px-4 py-2 font-medium">Step</th>
            <th className="px-4 py-2 text-right font-medium">People</th>
            <th className="px-4 py-2 text-right font-medium">From previous</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-neutral-800">
          {funnel.steps.map((step, index) => (
            <tr key={step.label} className="text-neutral-300">
              <td className="px-4 py-2">
                <span className="mr-2 text-neutral-500">{index + 1}.</span>
                {step.label}
              </td>
              <td className="px-4 py-2 text-right tabular-nums">{step.users.toLocaleString('en-US')}</td>
              <td className="px-4 py-2 text-right tabular-nums text-neutral-400">{stepConversion(funnel.steps, index)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

export function AnalyticsReport({ view }: { view: AnalyticsFunnelsView }) {
  const counts = Object.entries(view.eventCounts);
  return (
    <div className="flex flex-col gap-4">
      {!view.recording && (
        <div role="status" className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
          Analytics recording is switched off. Nothing new is being recorded; these tables show only what was recorded
          while it was on.
        </div>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        {view.funnels.map((funnel) => (
          <FunnelTable key={funnel.key} funnel={funnel} />
        ))}
      </div>
      <section aria-label="Events" className="rounded-lg border border-neutral-800">
        <h2 className="border-b border-neutral-800 px-4 py-2 text-sm font-semibold text-neutral-100">
          Events in this range
          <span className="ml-2 font-normal text-neutral-500">
            · failed or cancelled Credit purchases: {view.failedCreditPurchases.toLocaleString('en-US')}
          </span>
        </h2>
        {counts.length === 0 ? (
          <p className="px-4 py-4 text-sm text-neutral-400">No events in this range.</p>
        ) : (
          <table className="w-full text-left text-sm">
            <tbody className="divide-y divide-neutral-800">
              {counts.map(([name, n]) => (
                <tr key={name} className="text-neutral-300">
                  <td className="px-4 py-1.5 font-mono text-xs">{name}</td>
                  <td className="px-4 py-1.5 text-right tabular-nums">{n.toLocaleString('en-US')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

export default function AdminAnalyticsPage() {
  const [range, setRange] = useState<AnalyticsWindow>({});
  const [draft, setDraft] = useState<AnalyticsWindow>({});
  const [view, setView] = useState<AnalyticsFunnelsView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (active: AnalyticsWindow) => {
    setError(null);
    setView(null);
    try {
      const result = await adminAnalyticsApi.funnels(active);
      setView(result);
      setDraft({ from: result.from, to: result.to });
    } catch (err) {
      setError(
        err instanceof ApiRequestError && err.status === 403
          ? 'Your role does not include reading analytics.'
          : err instanceof ApiRequestError && err.status === 400
            ? err.message
            : 'The funnels could not be loaded.',
      );
    }
  }, []);

  useEffect(() => {
    void load(range);
  }, [range, load]);

  return (
    <div className="mx-auto w-full max-w-6xl px-4 pb-24 pt-6 sm:px-6">
      <header className="mb-4">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-neutral-500">Analytics</p>
        <h1 className="mt-1 text-2xl font-semibold text-neutral-100 sm:text-3xl">Commercial funnels</h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-neutral-400">
          People who reached each step, in order, within the range (UTC days, both ends included). Purchases, spends and
          unlocks are counted only once the server has confirmed them.
        </p>
      </header>

      <form
        className="mb-4 flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          setRange({ from: draft.from || undefined, to: draft.to || undefined });
        }}
      >
        {(['from', 'to'] as const).map((key) => (
          <label key={key} className="flex flex-col gap-1 text-xs capitalize text-neutral-400">
            {key}
            <input
              type="date"
              value={draft[key] ?? ''}
              onChange={(event) => setDraft((d) => ({ ...d, [key]: event.target.value }))}
              className="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-sm text-neutral-100"
            />
          </label>
        ))}
        <button type="submit" className="rounded-md bg-neutral-800 px-3 py-1.5 text-sm text-neutral-100 hover:bg-neutral-700">
          Show
        </button>
        <a
          href={adminAnalyticsApi.exportUrl(view ? { from: view.from, to: view.to } : range)}
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
      {view === null && !error && <p className="text-sm text-neutral-500">Loading…</p>}
      {view && <AnalyticsReport view={view} />}
    </div>
  );
}
