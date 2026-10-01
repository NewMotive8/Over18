import type { AdminPackVersion, EconomyConfigurationView } from '@over18/shared';
import { EMPTY_PACK_FORM, packDraftFromForm, packFormFrom, type PackForm } from '../../../admin/economyConfig';
import { adminEconomyApi } from '../../../lib/api';
import { Field, inputClass } from './EconomyUi';
import VersionedItemScreen from './VersionedItemScreen';

export function PackDraftFields({ form, onChange }: { form: PackForm; onChange: (form: PackForm) => void }) {
  const set = (patch: Partial<PackForm>) => onChange({ ...form, ...patch });
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label="Display name">
        <input value={form.displayName} onChange={(e) => set({ displayName: e.target.value })} className={inputClass} />
      </Field>
      <Field label="Credits">
        <input inputMode="numeric" value={form.credits} onChange={(e) => set({ credits: e.target.value })} className={inputClass} />
      </Field>
      <Field label="Price (minor units)" hint="In the currency's smallest unit, e.g. cents.">
        <input inputMode="numeric" value={form.priceMinor} onChange={(e) => set({ priceMinor: e.target.value })} className={inputClass} />
      </Field>
      <Field label="Currency" hint="3-letter code.">
        <input value={form.currency} onChange={(e) => set({ currency: e.target.value })} className={inputClass} />
      </Field>
      <Field label="Ladder position" hint="Packs are listed in this order, then by code.">
        <input inputMode="numeric" value={form.sortOrder} onChange={(e) => set({ sortOrder: e.target.value })} className={inputClass} />
      </Field>
      <Field label="Bonus Credits" hint="Given on top, recorded as bonus Credits. Empty for none.">
        <input inputMode="numeric" value={form.bonusCredits} onChange={(e) => set({ bonusCredits: e.target.value })} className={inputClass} />
      </Field>
      <Field label="Badge" hint={'Shown on the pack in the store, e.g. "Best value". Up to 40 characters; empty for none.'}>
        <input maxLength={40} value={form.badge} onChange={(e) => set({ badge: e.target.value })} className={inputClass} />
      </Field>
      <Field
        label="Regular price (minor units)"
        hint="Only for a promotion: the usual price, higher than the price above. The store strikes it through. Empty for no promotion."
      >
        <input inputMode="numeric" value={form.wasPriceMinor} onChange={(e) => set({ wasPriceMinor: e.target.value })} className={inputClass} />
      </Field>
      <Field
        label="Promotion ends"
        hint="Needs a regular price. The store counts down to it; from then on the regular price is charged. Empty for no end."
      >
        <input type="datetime-local" value={form.promotionEndsAt} onChange={(e) => set({ promotionEndsAt: e.target.value })} className={inputClass} />
      </Field>
      <div className="flex flex-col justify-end gap-2 text-sm text-zinc-300">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={form.isBestValue} onChange={(e) => set({ isBestValue: e.target.checked })} />
          Marked as best value
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={form.isPurchasable} onChange={(e) => set({ isPurchasable: e.target.checked })} />
          Offered for purchase <span className="text-xs text-zinc-500">(untick to retire)</span>
        </label>
      </div>
    </div>
  );
}

export const packColumns: Array<{ label: string; value: (v: AdminPackVersion) => string }> = [
  { label: 'Name', value: (v) => v.displayName },
  { label: 'Credits', value: (v) => String(v.credits) },
  { label: 'Price', value: (v) => `${v.priceMinor} (${v.currency} minor units)` },
  { label: 'Bonus', value: (v) => (v.bonusCredits ? `+${v.bonusCredits}` : '') },
  {
    label: 'Promotion',
    value: (v) =>
      v.wasPriceMinor ? `regular ${v.wasPriceMinor}${v.promotionEndsAt ? `, ends ${new Date(v.promotionEndsAt).toLocaleString()}` : ''}` : '',
  },
  { label: 'Badge', value: (v) => v.badge ?? '' },
  { label: 'Position', value: (v) => String(v.sortOrder) },
  { label: 'Best value', value: (v) => (v.isBestValue ? 'yes' : '') },
  { label: 'Offered', value: (v) => (v.isPurchasable ? 'yes' : 'retired') },
];

export default function PacksScreen({ config, reload }: { config: EconomyConfigurationView; reload: () => Promise<void> }) {
  return (
    <VersionedItemScreen
      noun="pack"
      items={config.packs}
      emptyForm={() => ({ ...EMPTY_PACK_FORM })}
      formFrom={packFormFrom}
      toDraft={packDraftFromForm}
      save={adminEconomyApi.savePackDraft}
      discard={adminEconomyApi.discardPackDraft}
      reload={reload}
      columns={packColumns}
      renderForm={(form, onChange) => <PackDraftFields form={form} onChange={onChange} />}
    />
  );
}
