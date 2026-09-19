import { useState, type ReactNode } from 'react';
import { Link, NavLink, useParams } from 'react-router-dom';
import {
  ECONOMY_SECTIONS,
  EMPTY_PREVIEW_FORM,
  buildPreviewRequest,
  economySection,
  formatMoney,
  gapText,
  grantSummaries,
  inputProblems,
  ladderIssueText,
  marginWarnings,
  previewErrorMessages,
  sourceLabel,
  type EconomySection,
  type PreviewForm,
} from '../../admin/economy';
import { adminEconomyApi, type EconomyPreviewResponse, type PreviewAiProviderCost } from '../../lib/api';

/**
 * Admin -> Economy (PRD v1.2 §31, P1.4).
 *
 * The preview & margin guard runs against the server's read-only preview
 * (`economy.manage`). The server also supports drafts, review, publishing and
 * cancellation for plans, packs and the ruleset; the screens that will use it
 * are not built yet, so each says so and lists what the server already
 * supports -- no sample data, no dead form, no hard-coded value. All logic
 * lives in `admin/economy.ts`.
 */

export function EconomyTabs({ active }: { active: EconomySection['key'] | null }) {
  return (
    <nav aria-label="Economy sections" className="mb-6 flex flex-wrap gap-1 border-b border-zinc-800 pb-2">
      {ECONOMY_SECTIONS.map((section) => (
        <NavLink
          key={section.key}
          to={section.path}
          end
          aria-current={section.key === active ? 'page' : undefined}
          className={`rounded-md px-3 py-1.5 text-sm ${section.key === active ? 'bg-zinc-900 text-white' : 'text-zinc-400 hover:text-zinc-200'}`}
        >
          {section.label}
          {section.screen === 'pending' && <span className="ml-1.5 text-[10px] uppercase tracking-wide text-zinc-600">soon</span>}
        </NavLink>
      ))}
    </nav>
  );
}

/** A screen not built yet: it says so, lists what the server already supports, and shows nothing else. */
export function ScreenPendingPanel({ section }: { section: EconomySection }) {
  return (
    <div className="rounded-lg border border-dashed border-zinc-800 bg-zinc-900/40 px-6 py-8">
      <h2 className="text-lg font-semibold text-white">{section.label}</h2>
      <p className="mt-1 text-sm text-zinc-400">{section.manages}</p>
      <p className="mt-6 text-sm font-medium text-zinc-200">Screen not built yet</p>
      <p className="mt-2 text-sm text-zinc-500">The server already supports:</p>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-zinc-500">
        {section.server.map((item) => <li key={item}>{item}</li>)}
      </ul>
      <p className="mt-6 text-sm text-zinc-400">
        The live and drafted configuration can be inspected, read-only, in the{' '}
        <Link to="/admin/economy" className="text-rose-400 hover:text-rose-300">preview</Link>.
      </p>
    </div>
  );
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
      <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-400">{title}</h3>
      {children}
    </section>
  );
}

const aiCostText = (cost: PreviewAiProviderCost) =>
  cost.status === 'complete' ? formatMoney(cost.total) : `incomplete: ${cost.gaps.map(gapText).join('; ')}`;

/** The server's preview, rendered as given. Pure: no fetching, no state. */
export function PreviewReport({ preview }: { preview: EconomyPreviewResponse }) {
  const { configuration } = preview;
  const warnings = marginWarnings(preview);
  const problems = inputProblems(preview);
  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-zinc-500">
        {preview.mode === 'drafted' ? 'The economy as drafted' : 'The live economy'} · resolved at {preview.asOf}
      </p>

      <Panel title="Configuration">
        <table className="w-full text-left text-sm">
          <thead className="text-xs text-zinc-500"><tr><th className="py-1">Kind</th><th>Code</th><th>Version</th><th>State</th><th>Purchasable</th></tr></thead>
          <tbody className="text-zinc-300">
            {configuration.plans.map((p) => (
              <tr key={`plan-${p.code}`}><td className="py-1">Plan</td><td>{p.code}</td><td>v{p.version}</td><td>{sourceLabel(p.source)}</td><td>{p.isPurchasable ? 'yes' : 'no'}</td></tr>
            ))}
            {configuration.packs.map((p) => (
              <tr key={`pack-${p.code}`}><td className="py-1">Pack</td><td>{p.code}</td><td>v{p.version}</td><td>{sourceLabel(p.source)}</td><td>{p.isPurchasable ? 'yes' : 'no'}</td></tr>
            ))}
            {configuration.ruleset && (
              <tr><td className="py-1">Ruleset</td><td>—</td><td>v{configuration.ruleset.version}</td><td>{sourceLabel(configuration.ruleset.source)}</td><td>—</td></tr>
            )}
          </tbody>
        </table>
        {configuration.plans.length === 0 && configuration.packs.length === 0 && !configuration.ruleset && (
          <p className="text-sm text-zinc-500">Nothing is live or drafted.</p>
        )}
      </Panel>

      <Panel title="What a month's grant buys">
        {grantSummaries(preview).map((grant) => (
          <div key={grant.heading} className="mb-2 text-sm">
            <p className="text-zinc-200">{grant.heading}</p>
            <ul className="list-disc pl-5 text-zinc-400">{grant.items.map((item) => <li key={item}>{item}</li>)}</ul>
          </div>
        ))}
        {preview.grants.length === 0 && <p className="text-sm text-zinc-500">No plan to show.</p>}
      </Panel>

      <Panel title="Margin guard">
        <p className="text-sm text-zinc-400">
          Gross floor: {preview.marginGuard.status === 'evaluated' ? `${preview.marginGuard.minGrossMarginPercent}%` : 'not configured'} · Net floor:{' '}
          {preview.marginGuard.net.status === 'evaluated' ? `${preview.marginGuard.net.minNetMarginPercent}%` : 'not configured'}
        </p>
        {warnings.length > 0 && (
          <ul role="alert" className="mt-2 list-disc pl-5 text-sm text-amber-200">{warnings.map((w) => <li key={w}>{w}</li>)}</ul>
        )}
        {[...preview.marginGuard.notEvaluated, ...preview.marginGuard.net.notEvaluated].length > 0 && (
          <ul className="mt-2 list-disc pl-5 text-sm text-zinc-500">
            {[...preview.marginGuard.notEvaluated, ...preview.marginGuard.net.notEvaluated].map((n, i) => (
              <li key={`${n.action}-${n.reason}-${i}`}>Not evaluated: {n.action} ({n.reason})</li>
            ))}
          </ul>
        )}
        {preview.parity && (
          <p className="mt-2 text-sm text-zinc-400">
            Thinnest action: {preview.parity.thinnestAction} · AI cost per Credit {formatMoney(preview.parity.highestCostPerCredit)} (lowest {formatMoney(preview.parity.lowestCostPerCredit)})
          </p>
        )}
      </Panel>

      <Panel title="Credit pack ladders">
        {preview.ladders.map((ladder) => (
          <div key={ladder.currency} className="mb-3">
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-zinc-500"><tr><th className="py-1">Pack</th><th>Credits</th><th>Price</th><th>Per Credit</th><th>Best value</th></tr></thead>
              <tbody className="text-zinc-300">
                {ladder.rungs.map((rung) => (
                  <tr key={rung.code}><td className="py-1">{rung.code}</td><td>{rung.credits}</td><td>{formatMoney(rung.price)}</td><td>{formatMoney(rung.perCredit)}</td><td>{rung.isBestValue ? 'yes' : ''}</td></tr>
                ))}
              </tbody>
            </table>
            {ladder.spreadPercent !== null && <p className="mt-1 text-xs text-zinc-500">Spread: {ladder.spreadPercent}%</p>}
            {ladder.issues.length > 0 && (
              <ul role="alert" className="mt-1 list-disc pl-5 text-sm text-amber-200">{ladder.issues.map((issue) => <li key={`${issue.kind}-${issue.rung}`}>{ladderIssueText(issue)}</li>)}</ul>
            )}
          </div>
        ))}
        {preview.ladders.length === 0 && <p className="text-sm text-zinc-500">No purchasable pack.</p>}
      </Panel>

      <Panel title="Actions">
        <table className="w-full text-left text-sm">
          <thead className="text-xs text-zinc-500">
            <tr><th className="py-1">Action</th><th>Credits</th><th>Runtime</th><th>AI provider cost</th><th>Gross margin</th><th>Net</th><th>Guard</th></tr>
          </thead>
          <tbody className="align-top text-zinc-300">
            {preview.actions.map((action) => (
              <tr key={action.action}>
                <td className="py-1 font-mono text-xs">{action.action}</td>
                <td>{action.creditCost}{action.unit === 'per_minute' ? ' / min' : ''}</td>
                <td>{action.runtime}</td>
                <td>{aiCostText(action.aiProviderCost)}</td>
                <td>{action.grossMargins.map((m) => `${m.pack} ${m.grossMarginPercent}% (${m.costMultiple}×)`).join(', ') || '—'}</td>
                <td>
                  {action.net.status === 'complete'
                    ? action.net.channels.map((c) => `${c.channel}: ${c.rungs.map((r) => `${r.pack} ${r.netMarginPercent}%`).join(', ')}`).join('; ')
                    : `incomplete: ${action.net.gaps.map(gapText).join('; ')}`}
                </td>
                <td>{action.guard}{action.netGuard !== 'not_evaluated' ? ` / net ${action.netGuard}` : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {preview.actions.length === 0 && <p className="text-sm text-zinc-500">No enabled action.</p>}
        {preview.disabledActions.length > 0 && <p className="mt-2 text-xs text-zinc-500">Disabled: {preview.disabledActions.join(', ')}</p>}
        {preview.configurationIssues.length > 0 && (
          <ul role="alert" className="mt-2 list-disc pl-5 text-sm text-amber-200">
            {preview.configurationIssues.map((issue) => <li key={`${issue.action}-${issue.reason}`}>Runtime would refuse {issue.action}: {issue.reason}</li>)}
          </ul>
        )}
      </Panel>

      <Panel title="Subscriptions, per subscriber-month">
        {preview.subscriptions.map((sub) => (
          <div key={sub.plan} className="mb-2 text-sm text-zinc-300">
            <p className="text-zinc-200">{sub.plan} v{sub.version} ({sourceLabel(sub.source)}) · {formatMoney(sub.pricePerMonth)} a month</p>
            <p className="text-zinc-400">Included usage: {aiCostText(sub.includedUsage)}</p>
            <p className="text-zinc-400">
              Grant worst case: {sub.grantWorstCase.status === 'complete' ? formatMoney(sub.grantWorstCase.cost) : `incomplete: ${sub.grantWorstCase.gaps.map(gapText).join('; ')}`}
            </p>
            <p className="text-zinc-400">
              Net:{' '}
              {sub.net.status === 'complete'
                ? sub.net.channels.map((c) => `${c.channel} ${formatMoney(c.contribution)} (${c.netMarginPercent}%)`).join('; ')
                : `incomplete: ${sub.net.gaps.map(gapText).join('; ')}`}
            </p>
          </div>
        ))}
        {preview.subscriptions.length === 0 && <p className="text-sm text-zinc-500">No plan to show.</p>}
      </Panel>

      {problems.length > 0 && (
        <Panel title="Inputs to check">
          {problems.map((problem) => (
            <div key={problem.label} className="mb-2 text-sm">
              <p className="text-zinc-300">{problem.label}</p>
              <ul className="list-disc pl-5 text-zinc-500">{problem.items.map((item) => <li key={item}>{item}</li>)}</ul>
            </div>
          ))}
        </Panel>
      )}

      <Panel title="Read this before relying on the figures">
        <ul className="list-disc pl-5 text-xs text-zinc-500">{preview.caveats.map((caveat) => <li key={caveat}>{caveat}</li>)}</ul>
      </Panel>
    </div>
  );
}

function PreviewWorkspace() {
  const [form, setForm] = useState<PreviewForm>(EMPTY_PREVIEW_FORM);
  const [running, setRunning] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [preview, setPreview] = useState<EconomyPreviewResponse | null>(null);
  const update = (field: keyof PreviewForm) => (value: string) => setForm((current) => ({ ...current, [field]: value }));

  const run = async () => {
    const built = buildPreviewRequest(form);
    if (!built.ok) {
      setErrors(built.errors);
      return;
    }
    setRunning(true);
    setErrors([]);
    try {
      setPreview(await adminEconomyApi.preview(built.body));
    } catch (error) {
      setPreview(null);
      setErrors(previewErrorMessages(error));
    } finally {
      setRunning(false);
    }
  };

  const field = 'mt-1 w-full rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-100';
  return (
    <div className="flex flex-col gap-4">
      <form
        className="grid gap-3 rounded-lg border border-zinc-800 bg-zinc-900/40 p-4 sm:grid-cols-4"
        onSubmit={(event) => {
          event.preventDefault();
          void run();
        }}
      >
        <label className="text-sm text-zinc-300">
          Economy
          <select value={form.mode} onChange={(e) => update('mode')(e.target.value)} className={field}>
            <option value="drafted">As drafted</option>
            <option value="live">Live</option>
          </select>
        </label>
        <label className="text-sm text-zinc-300">
          Min gross margin %
          <input inputMode="decimal" value={form.minGrossMarginPercent} onChange={(e) => update('minGrossMarginPercent')(e.target.value)} className={field} />
        </label>
        <label className="text-sm text-zinc-300">
          Min net margin %
          <input inputMode="decimal" value={form.minNetMarginPercent} onChange={(e) => update('minNetMarginPercent')(e.target.value)} className={field} />
        </label>
        <label className="text-sm text-zinc-300">
          Max cost age (days)
          <input inputMode="numeric" value={form.maxCostAgeDays} onChange={(e) => update('maxCostAgeDays')(e.target.value)} className={field} />
        </label>
        <label className="text-sm text-zinc-300 sm:col-span-4">
          Cost inputs (JSON: providers, rates, usage, salesChannels, otherCosts)
          <textarea rows={8} spellCheck={false} value={form.costInputs} onChange={(e) => update('costInputs')(e.target.value)} className={`${field} font-mono text-xs`} />
        </label>
        <div className="sm:col-span-4">
          <button type="submit" disabled={running} className="rounded-md bg-rose-600 px-4 py-2 text-sm font-semibold text-white hover:bg-rose-500 disabled:opacity-50">
            {running ? 'Running…' : 'Run preview'}
          </button>
          <span className="ml-3 text-xs text-zinc-500">Read-only: nothing is saved, published or activated.</span>
        </div>
      </form>
      {errors.length > 0 && (
        <ul role="alert" className="list-disc rounded-lg border border-red-900 bg-red-950/40 py-3 pl-8 pr-4 text-sm text-red-200">
          {errors.map((error) => <li key={error}>{error}</li>)}
        </ul>
      )}
      {preview && <PreviewReport preview={preview} />}
    </div>
  );
}

export default function EconomyPage() {
  const { section: param } = useParams();
  const section = economySection(param);
  return (
    <div className="mx-auto w-full max-w-6xl px-4 pb-24 pt-6 sm:px-6">
      <header className="mb-4">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">Economy</p>
        <h1 className="mt-1 text-2xl font-semibold text-zinc-100 sm:text-3xl">{section?.label ?? 'Economy'}</h1>
      </header>
      <EconomyTabs active={section?.key ?? null} />
      {!section ? (
        <p className="text-sm text-zinc-400">
          There is no such economy section. <Link to="/admin/economy" className="text-rose-400">Back to the preview</Link>
        </p>
      ) : section.screen === 'pending' ? (
        <ScreenPendingPanel section={section} />
      ) : (
        <PreviewWorkspace />
      )}
    </div>
  );
}
