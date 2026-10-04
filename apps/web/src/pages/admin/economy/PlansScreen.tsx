import type { AdminPlanVersion, EconomyConfigurationView } from '@over18/shared';
import {
  BILLING_PERIODS,
  RETIRED_HELP,
  availabilityLabel,
  billingPeriodLabel,
  emptyPlanForm,
  featureLabel,
  planDraftFromForm,
  planFormFrom,
  suggestedCurrency,
  type Catalogue,
  type PlanForm,
} from '../../../admin/economyConfig';
import { adminEconomyApi } from '../../../lib/api';
import { Field, MoneyField, formatMinor, inputClass } from './EconomyUi';
import VersionedItemScreen from './VersionedItemScreen';

/**
 * A plan draft, in the words of the person setting it up.
 *
 * A price is typed as money, a billing period is chosen by name, and the
 * included features are named -- one checkbox per feature in the server's
 * catalogue. What is sent is the same request as before: `planDraftFromForm`
 * turns the price into minor units and the chosen term into months.
 */
export function PlanDraftFields({ form, catalogue, onChange }: { form: PlanForm; catalogue: Catalogue; onChange: (form: PlanForm) => void }) {
  const set = (patch: Partial<PlanForm>) => onChange({ ...form, ...patch });
  // A plan saved with any other term keeps it: it is offered as its own option rather than silently changed.
  const months = form.billingPeriodMonths.trim();
  const otherTerm = months !== '' && !BILLING_PERIODS.some((period) => String(period.months) === months);
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label="Name" hint="What customers see, for example on the Premium page and at checkout.">
        <input value={form.displayName} onChange={(e) => set({ displayName: e.target.value })} className={inputClass} />
      </Field>
      <Field label="Billing period" hint="How often the customer is charged the price below.">
        <select value={months} onChange={(e) => set({ billingPeriodMonths: e.target.value })} className={inputClass}>
          <option value="">Choose…</option>
          {BILLING_PERIODS.map((period) => (
            <option key={period.months} value={String(period.months)}>
              {period.label} — {period.every.toLowerCase()}
            </option>
          ))}
          {otherTerm && <option value={months}>{billingPeriodLabel(Number(months))} (current)</option>}
        </select>
      </Field>
      <MoneyField
        label="Price"
        hint="The full amount charged each billing period."
        value={form.price}
        currency={form.currency}
        onChange={(price) => set({ price })}
      />
      <Field label="Currency" hint="3-letter code. The price above is in this currency.">
        <input value={form.currency} maxLength={3} onChange={(e) => set({ currency: e.target.value.toUpperCase() })} className={inputClass} />
      </Field>
      <Field label="Credits included per billing cycle" hint="Added to the customer's balance with each payment. Enter 0 for none.">
        <input inputMode="numeric" value={form.includedCredits} onChange={(e) => set({ includedCredits: e.target.value })} className={inputClass} />
      </Field>
      <fieldset className="text-sm text-zinc-300 sm:col-span-2">
        <legend>Included features</legend>
        <p className="mt-0.5 text-xs text-zinc-500">Tick what this plan includes.</p>
        <div className="mt-2 flex flex-col gap-1.5 sm:flex-row sm:flex-wrap sm:gap-x-6">
          {catalogue.planFeatures.map((key) => (
            <label key={key} className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={form.features[key] === true}
                onChange={(e) => set({ features: { ...form.features, [key]: e.target.checked } })}
              />
              <span>{featureLabel(key)}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset className="text-sm text-zinc-300 sm:col-span-2">
        <legend>Availability</legend>
        <div className="mt-2 flex flex-col gap-1.5">
          <label className="flex items-center gap-2">
            <input type="radio" name="plan-availability" checked={form.isPurchasable} onChange={() => set({ isPurchasable: true })} />
            <span>
              On sale <span className="text-xs text-zinc-500">— customers can buy this plan once it is published.</span>
            </span>
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" name="plan-availability" checked={!form.isPurchasable} onChange={() => set({ isPurchasable: false })} />
            <span>
              Retired <span className="text-xs text-zinc-500">— {RETIRED_HELP.replace(/^Retired: /, '')}</span>
            </span>
          </label>
        </div>
      </fieldset>
    </div>
  );
}

export const planColumns: Array<{ label: string; value: (v: AdminPlanVersion) => string }> = [
  { label: 'Name', value: (v) => v.displayName },
  // Money as money, and the term by name: what an admin set, not what the database holds.
  { label: 'Price', value: (v) => formatMinor(v.priceMinor, v.currency) },
  { label: 'Billing period', value: (v) => billingPeriodLabel(v.billingPeriodMonths) },
  { label: 'Credits per billing cycle', value: (v) => String(v.monthlyIncludedCredits) },
  {
    label: 'Included features',
    value: (v) =>
      Object.entries(v.features)
        .filter(([, on]) => on === true)
        .map(([key]) => featureLabel(key))
        .join(', ') || '—',
  },
  { label: 'Availability', value: (v) => availabilityLabel(v.isPurchasable) },
];

export default function PlansScreen({ config, reload }: { config: EconomyConfigurationView; reload: () => Promise<void> }) {
  return (
    <VersionedItemScreen
      noun="plan"
      items={config.plans}
      emptyForm={() => emptyPlanForm(config.catalogue, suggestedCurrency(config))}
      formFrom={(v: AdminPlanVersion) => planFormFrom(v, config.catalogue)}
      nameOf={(form) => form.displayName}
      toDraft={planDraftFromForm}
      save={adminEconomyApi.savePlanDraft}
      discard={adminEconomyApi.discardPlanDraft}
      reload={reload}
      columns={planColumns}
      renderForm={(form, onChange) => <PlanDraftFields form={form} catalogue={config.catalogue} onChange={onChange} />}
    />
  );
}
