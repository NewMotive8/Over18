import type { AdminPlanVersion, EconomyConfigurationView } from '@over18/shared';
import { emptyPlanForm, planDraftFromForm, planFormFrom, type Catalogue, type PlanForm } from '../../../admin/economyConfig';
import { adminEconomyApi } from '../../../lib/api';
import { Field, inputClass } from './EconomyUi';
import VersionedItemScreen from './VersionedItemScreen';

/** A plan draft's fields. The feature flags are the server's catalogue, one checkbox each. */
export function PlanDraftFields({ form, catalogue, onChange }: { form: PlanForm; catalogue: Catalogue; onChange: (form: PlanForm) => void }) {
  const set = (patch: Partial<PlanForm>) => onChange({ ...form, ...patch });
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label="Display name">
        <input value={form.displayName} onChange={(e) => set({ displayName: e.target.value })} className={inputClass} />
      </Field>
      <Field label="Billing period (months)">
        <input inputMode="numeric" value={form.billingPeriodMonths} onChange={(e) => set({ billingPeriodMonths: e.target.value })} className={inputClass} />
      </Field>
      <Field label="Price (minor units)" hint="In the currency's smallest unit, e.g. cents.">
        <input inputMode="numeric" value={form.priceMinor} onChange={(e) => set({ priceMinor: e.target.value })} className={inputClass} />
      </Field>
      <Field label="Currency" hint="3-letter code.">
        <input value={form.currency} onChange={(e) => set({ currency: e.target.value })} className={inputClass} />
      </Field>
      <Field label="Monthly included Credits">
        <input inputMode="numeric" value={form.monthlyIncludedCredits} onChange={(e) => set({ monthlyIncludedCredits: e.target.value })} className={inputClass} />
      </Field>
      <fieldset className="text-sm text-zinc-300 sm:col-span-2">
        <legend>Feature flags</legend>
        <div className="mt-1 flex flex-wrap gap-4">
          {catalogue.planFeatures.map((key) => (
            <label key={key} className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={form.features[key] === true}
                onChange={(e) => set({ features: { ...form.features, [key]: e.target.checked } })}
              />
              <span className="font-mono text-xs">{key}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <label className="flex items-center gap-2 text-sm text-zinc-300 sm:col-span-2">
        <input type="checkbox" checked={form.isPurchasable} onChange={(e) => set({ isPurchasable: e.target.checked })} />
        Offered for purchase
        <span className="text-xs text-zinc-500">Untick to retire: the plan stays in effect for existing subscribers, but is no longer offered.</span>
      </label>
    </div>
  );
}

export const planColumns: Array<{ label: string; value: (v: AdminPlanVersion) => string }> = [
  { label: 'Name', value: (v) => v.displayName },
  { label: 'Price', value: (v) => `${v.priceMinor} (${v.currency} minor units)` },
  { label: 'Term', value: (v) => `${v.billingPeriodMonths} mo` },
  { label: 'Credits / month', value: (v) => String(v.monthlyIncludedCredits) },
  { label: 'Flags on', value: (v) => Object.entries(v.features).filter(([, on]) => on === true).map(([key]) => key).join(', ') || '—' },
  { label: 'Offered', value: (v) => (v.isPurchasable ? 'yes' : 'retired') },
];

export default function PlansScreen({ config, reload }: { config: EconomyConfigurationView; reload: () => Promise<void> }) {
  return (
    <VersionedItemScreen
      noun="plan"
      items={config.plans}
      emptyForm={() => emptyPlanForm(config.catalogue)}
      formFrom={(v: AdminPlanVersion) => planFormFrom(v, config.catalogue)}
      toDraft={planDraftFromForm}
      save={adminEconomyApi.savePlanDraft}
      discard={adminEconomyApi.discardPlanDraft}
      reload={reload}
      columns={planColumns}
      renderForm={(form, onChange) => <PlanDraftFields form={form} catalogue={config.catalogue} onChange={onChange} />}
    />
  );
}
