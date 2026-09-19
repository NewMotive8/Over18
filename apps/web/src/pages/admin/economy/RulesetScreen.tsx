import { useState } from 'react';
import type { AdminRulesetVersion, EconomyConfigurationView } from '@over18/shared';
import ConfirmDialog from '../../../admin/ConfirmDialog';
import {
  NEW_REWARD_ROW,
  activeOf,
  draftOf,
  emptyRulesetForm,
  hasDurationTiers,
  newActionCostRow,
  rulesetDraftFromForm,
  rulesetFormFrom,
  serverMessages,
  unitOf,
  type ActionCostRow,
  type Catalogue,
  type RewardRow,
  type RulesetForm,
} from '../../../admin/economyConfig';
import { adminEconomyApi } from '../../../lib/api';
import { Field, MessageList, Section, VersionHistory, buttonClass, inputClass, secondaryButtonClass } from './EconomyUi';

/**
 * Action costs, allowances and rewards: three screens over ONE ruleset draft,
 * which the server saves whole. Whichever screen saves, all three are saved.
 * Actions, tiers, units, duration tiers and allowance keys come from the
 * server's catalogue.
 */

export type RulesetPart = 'action-costs' | 'allowances' | 'rewards';

const cell = 'w-full rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1 text-sm text-zinc-100';

export function ActionCostsEditor({ rows, catalogue, onChange }: { rows: ActionCostRow[]; catalogue: Catalogue; onChange: (rows: ActionCostRow[]) => void }) {
  const update = (i: number, patch: Partial<ActionCostRow>) => onChange(rows.map((row, j) => (j === i ? { ...row, ...patch } : row)));
  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[44rem] text-left text-sm">
          <thead className="text-xs text-zinc-500">
            <tr>
              <th className="py-1">Action</th>
              <th>Quality tier</th>
              <th>Unit</th>
              <th>Max duration (s)</th>
              <th>Credit cost</th>
              <th>Enabled</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i} data-testid="action-cost-row">
                <td className="py-1 pr-2">
                  <select
                    aria-label={`Action ${i + 1}`}
                    value={row.actionType}
                    onChange={(e) =>
                      update(i, { actionType: e.target.value, maxDurationSeconds: hasDurationTiers(catalogue, e.target.value) ? row.maxDurationSeconds : '' })
                    }
                    className={cell}
                  >
                    {Object.keys(catalogue.actions).map((action) => (
                      <option key={action} value={action}>
                        {action}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="pr-2">
                  <select aria-label={`Quality tier ${i + 1}`} value={row.qualityTier} onChange={(e) => update(i, { qualityTier: e.target.value })} className={cell}>
                    {catalogue.qualityTiers.map((tier) => (
                      <option key={tier} value={tier}>
                        {tier}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="pr-2 text-xs text-zinc-400">{unitOf(catalogue, row.actionType) ?? '—'}</td>
                <td className="pr-2">
                  {hasDurationTiers(catalogue, row.actionType) ? (
                    <input aria-label={`Max duration ${i + 1}`} inputMode="numeric" value={row.maxDurationSeconds} onChange={(e) => update(i, { maxDurationSeconds: e.target.value })} className={cell} />
                  ) : (
                    <span className="text-xs text-zinc-600">no duration tiers</span>
                  )}
                </td>
                <td className="pr-2">
                  <input aria-label={`Credit cost ${i + 1}`} inputMode="numeric" value={row.creditCost} onChange={(e) => update(i, { creditCost: e.target.value })} className={cell} />
                </td>
                <td className="pr-2">
                  <input aria-label={`Enabled ${i + 1}`} type="checkbox" checked={row.enabled} onChange={(e) => update(i, { enabled: e.target.checked })} />
                </td>
                <td>
                  <button type="button" onClick={() => onChange(rows.filter((_, j) => j !== i))} className="text-xs text-zinc-400 hover:text-red-300">
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length === 0 && <p className="text-sm text-zinc-500">No action cost yet.</p>}
      <button type="button" onClick={() => onChange([...rows, newActionCostRow(catalogue)])} className={`${secondaryButtonClass} self-start`}>
        Add action cost
      </button>
      <p className="text-xs text-zinc-500">A free action is disabled, never priced at 0 -- the server refuses a zero cost.</p>
    </div>
  );
}

export function AllowancesEditor({ allowances, onChange }: { allowances: Record<string, string>; onChange: (allowances: Record<string, string>) => void }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {Object.entries(allowances).map(([key, value]) => (
        <Field key={key} label={key} hint="Blank means not set. Publishing needs every catalogue allowance.">
          <input inputMode="numeric" value={value} onChange={(e) => onChange({ ...allowances, [key]: e.target.value })} className={`${inputClass} font-mono`} />
        </Field>
      ))}
    </div>
  );
}

export function RewardsEditor({ rows, onChange }: { rows: RewardRow[]; onChange: (rows: RewardRow[]) => void }) {
  const update = (i: number, patch: Partial<RewardRow>) => onChange(rows.map((row, j) => (j === i ? { ...row, ...patch } : row)));
  return (
    <div className="flex flex-col gap-3">
      <table className="w-full text-left text-sm">
        <thead className="text-xs text-zinc-500">
          <tr>
            <th className="py-1">Reward key</th>
            <th>Credits</th>
            <th>Per-user cap</th>
            <th>Enabled</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} data-testid="reward-row">
              <td className="py-1 pr-2">
                <input aria-label={`Reward key ${i + 1}`} value={row.rewardKey} onChange={(e) => update(i, { rewardKey: e.target.value })} className={`${cell} font-mono`} />
              </td>
              <td className="pr-2">
                <input aria-label={`Reward Credits ${i + 1}`} inputMode="numeric" value={row.credits} onChange={(e) => update(i, { credits: e.target.value })} className={cell} />
              </td>
              <td className="pr-2">
                <input aria-label={`Per-user cap ${i + 1}`} inputMode="numeric" placeholder="once" value={row.perUserCap} onChange={(e) => update(i, { perUserCap: e.target.value })} className={cell} />
              </td>
              <td className="pr-2">
                <input aria-label={`Reward enabled ${i + 1}`} type="checkbox" checked={row.enabled} onChange={(e) => update(i, { enabled: e.target.checked })} />
              </td>
              <td>
                <button type="button" onClick={() => onChange(rows.filter((_, j) => j !== i))} className="text-xs text-zinc-400 hover:text-red-300">
                  Remove
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && <p className="text-sm text-zinc-500">No reward yet.</p>}
      <button type="button" onClick={() => onChange([...rows, { ...NEW_REWARD_ROW }])} className={`${secondaryButtonClass} self-start`}>
        Add reward
      </button>
      <p className="text-xs text-zinc-500">A blank per-user cap means once per user.</p>
    </div>
  );
}

const rulesetColumns: Array<{ label: string; value: (v: AdminRulesetVersion) => string }> = [
  { label: 'Action costs', value: (v) => String(v.actionCosts.length) },
  { label: 'Allowances', value: (v) => String(Object.keys(v.allowances).length) },
  { label: 'Rewards', value: (v) => String(v.rewards.length) },
];

/**
 * The ruleset workspace. Rendered with a key naming the server's draft, so a
 * save, discard or publish that changes the draft starts it afresh -- while
 * moving between the three parts keeps unsaved edits.
 */
export default function RulesetScreen({
  config,
  part,
  reload,
  onNotice,
}: {
  config: EconomyConfigurationView;
  part: RulesetPart;
  reload: () => Promise<void>;
  /** Kept by the parent: a save remounts this screen, and the notice must outlive it. */
  onNotice: (messages: string[]) => void;
}) {
  const draft = draftOf(config.rulesets);
  const active = activeOf(config.rulesets);
  const [form, setForm] = useState<RulesetForm | null>(() => (draft ? rulesetFormFrom(draft, config.catalogue) : null));
  const [dirty, setDirty] = useState(false);
  const [note, setNote] = useState('');
  const [messages, setMessages] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const edit = (next: RulesetForm) => {
    setForm(next);
    setDirty(true);
  };

  const save = async () => {
    if (!form) return;
    const parsed = rulesetDraftFromForm(form, config.catalogue);
    if (!parsed.ok) return setMessages(parsed.errors);
    setBusy(true);
    setMessages([]);
    try {
      await adminEconomyApi.saveRulesetDraft({ ...parsed.body, reason: note.trim() || null });
      onNotice(['Ruleset draft saved -- action costs, allowances and rewards together. It goes live only when published.']);
      await reload();
    } catch (error) {
      setMessages(serverMessages(error));
    } finally {
      setBusy(false);
    }
  };

  const discard = async () => {
    setBusy(true);
    try {
      await adminEconomyApi.discardRulesetDraft();
      setConfirming(false);
      onNotice(['Ruleset draft discarded.']);
      await reload();
    } catch (error) {
      setConfirming(false);
      setMessages(serverMessages(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <Section title="Ruleset versions">
        <VersionHistory versions={config.rulesets} columns={rulesetColumns} />
      </Section>

      {!form ? (
        <Section title="Draft">
          <p className="text-sm text-zinc-400">No open ruleset draft. Action costs, allowances and rewards change together, in one draft.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {active && (
              <button type="button" onClick={() => setForm(rulesetFormFrom(active, config.catalogue))} className={secondaryButtonClass}>
                Start a draft from v{active.version}
              </button>
            )}
            <button type="button" onClick={() => setForm(emptyRulesetForm(config.catalogue))} className={secondaryButtonClass}>
              Start an empty draft
            </button>
          </div>
        </Section>
      ) : (
        <Section title={draft ? `Ruleset draft v${draft.version}` : 'New ruleset draft'}>
          <div className="flex flex-col gap-4">
            {part === 'action-costs' && <ActionCostsEditor rows={form.actionCosts} catalogue={config.catalogue} onChange={(actionCosts) => edit({ ...form, actionCosts })} />}
            {part === 'allowances' && <AllowancesEditor allowances={form.allowances} onChange={(allowances) => edit({ ...form, allowances })} />}
            {part === 'rewards' && <RewardsEditor rows={form.rewards} onChange={(rewards) => edit({ ...form, rewards })} />}
            <Field label="Note for the audit log (optional)">
              <input value={note} onChange={(e) => setNote(e.target.value)} className={inputClass} />
            </Field>
            <MessageList messages={messages} />
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" disabled={busy} onClick={() => void save()} className={buttonClass}>
                {busy ? 'Saving…' : 'Save ruleset draft'}
              </button>
              {draft && (
                <button type="button" disabled={busy} onClick={() => setConfirming(true)} className={secondaryButtonClass}>
                  Discard draft
                </button>
              )}
              <span className="text-xs text-zinc-500">
                Saves action costs, allowances and rewards together{dirty ? ' -- you have unsaved changes' : ''}.
              </span>
            </div>
          </div>
        </Section>
      )}
      <ConfirmDialog
        open={confirming}
        title="Discard the ruleset draft?"
        body="Its action costs, allowances and rewards are deleted together. Nothing that is live or scheduled changes."
        confirmLabel="Discard draft"
        cancelLabel="Keep draft"
        onConfirm={() => void discard()}
        onCancel={() => setConfirming(false)}
        busy={busy}
        tone="danger"
      />
    </div>
  );
}
