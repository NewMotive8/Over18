import type { AdminPackVersion, EconomyConfigurationView } from '@over18/shared';
import {
  RETIRED_HELP,
  availabilityLabel,
  emptyPackForm,
  packDraftFromForm,
  packFormFrom,
  suggestedCurrency,
  type PackForm,
} from '../../../admin/economyConfig';
import { adminEconomyApi } from '../../../lib/api';
import { Field, MoneyField, formatMinor, inputClass } from './EconomyUi';
import VersionedItemScreen from './VersionedItemScreen';

/**
 * A Credit pack draft, in the words of the person setting it up: prices are
 * typed as money (`packDraftFromForm` stores them as minor units), and nothing
 * asks for a database field by name. The request sent is unchanged.
 */
export function PackDraftFields({ form, onChange }: { form: PackForm; onChange: (form: PackForm) => void }) {
  const set = (patch: Partial<PackForm>) => onChange({ ...form, ...patch });
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label="Name" hint="What customers see in the Credits Store.">
        <input value={form.displayName} onChange={(e) => set({ displayName: e.target.value })} className={inputClass} />
      </Field>
      <Field label="Credits" hint="How many Credits the customer buys.">
        <input inputMode="numeric" value={form.credits} onChange={(e) => set({ credits: e.target.value })} className={inputClass} />
      </Field>
      <MoneyField label="Price" hint="What the customer pays for this pack." value={form.price} currency={form.currency} onChange={(price) => set({ price })} />
      <Field label="Currency" hint="3-letter code. The prices here are in this currency.">
        <input value={form.currency} maxLength={3} onChange={(e) => set({ currency: e.target.value.toUpperCase() })} className={inputClass} />
      </Field>
      <Field label="Bonus Credits" hint="Extra Credits given on top, free. Leave empty for none.">
        <input inputMode="numeric" value={form.bonusCredits} onChange={(e) => set({ bonusCredits: e.target.value })} className={inputClass} />
      </Field>
      <Field label="Position in the store" hint="Packs are listed lowest number first.">
        <input inputMode="numeric" value={form.sortOrder} onChange={(e) => set({ sortOrder: e.target.value })} className={inputClass} />
      </Field>
      <Field label="Badge" hint={'A short label shown on the pack, such as "Best value". Up to 40 characters; leave empty for none.'}>
        <input maxLength={40} value={form.badge} onChange={(e) => set({ badge: e.target.value })} className={inputClass} />
      </Field>
      <label className="flex items-center gap-2 self-end text-sm text-zinc-300">
        <input type="checkbox" checked={form.isBestValue} onChange={(e) => set({ isBestValue: e.target.checked })} />
        Highlight as the best-value pack
      </label>
      <fieldset className="grid gap-3 rounded-md border border-zinc-800 p-3 text-sm text-zinc-300 sm:col-span-2 sm:grid-cols-2">
        <legend className="px-1 text-zinc-400">Promotion (optional)</legend>
        <MoneyField
          label="Regular price"
          hint="The usual price, higher than the price above. The store shows it struck through. Leave empty for no promotion."
          value={form.regularPrice}
          currency={form.currency}
          onChange={(regularPrice) => set({ regularPrice })}
        />
        <Field label="Promotion ends" hint="The store counts down to this; afterwards the regular price is charged. Needs a regular price. Leave empty for no end.">
          <input type="datetime-local" value={form.promotionEndsAt} onChange={(e) => set({ promotionEndsAt: e.target.value })} className={inputClass} />
        </Field>
      </fieldset>
      <fieldset className="text-sm text-zinc-300 sm:col-span-2">
        <legend>Availability</legend>
        <div className="mt-2 flex flex-col gap-1.5">
          <label className="flex items-center gap-2">
            <input type="radio" name="pack-availability" checked={form.isPurchasable} onChange={() => set({ isPurchasable: true })} />
            <span>
              On sale <span className="text-xs text-zinc-500">— customers can buy this pack once it is published.</span>
            </span>
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" name="pack-availability" checked={!form.isPurchasable} onChange={() => set({ isPurchasable: false })} />
            <span>
              Retired <span className="text-xs text-zinc-500">— {RETIRED_HELP.replace(/^Retired: /, '')}</span>
            </span>
          </label>
        </div>
      </fieldset>
    </div>
  );
}

export const packColumns: Array<{ label: string; value: (v: AdminPackVersion) => string }> = [
  { label: 'Name', value: (v) => v.displayName },
  { label: 'Credits', value: (v) => String(v.credits) },
  // Money as money, the way the customer's store shows it.
  { label: 'Price', value: (v) => formatMinor(v.priceMinor, v.currency) },
  { label: 'Bonus', value: (v) => (v.bonusCredits ? `+${v.bonusCredits}` : '') },
  {
    label: 'Promotion',
    value: (v) =>
      v.wasPriceMinor
        ? `regular ${formatMinor(v.wasPriceMinor, v.currency)}${v.promotionEndsAt ? `, ends ${new Date(v.promotionEndsAt).toLocaleString()}` : ''}`
        : '',
  },
  { label: 'Badge', value: (v) => v.badge ?? '' },
  { label: 'Position', value: (v) => String(v.sortOrder) },
  { label: 'Best value', value: (v) => (v.isBestValue ? 'Yes' : '') },
  { label: 'Availability', value: (v) => availabilityLabel(v.isPurchasable) },
];

/** A pack the way a customer would describe it. */
export const packSummary = (v: AdminPackVersion): string[] => [
  `${v.credits} Credits${v.bonusCredits ? ` + ${v.bonusCredits} bonus` : ''}`,
  `${formatMinor(v.priceMinor, v.currency)}${v.wasPriceMinor ? ` (regular price ${formatMinor(v.wasPriceMinor, v.currency)})` : ''}`,
  ...(v.isBestValue ? ['Highlighted as best value'] : []),
];

export default function PacksScreen({ config, reload }: { config: EconomyConfigurationView; reload: () => Promise<void> }) {
  return (
    <VersionedItemScreen
      noun="pack"
      where="the Credits Store"
      about="Credit packs are one-off purchases: a customer pays once and gets Credits. They are listed in the Credits Store in the order you set."
      items={config.packs}
      summary={packSummary}
      order={(v) => v.sortOrder}
      emptyForm={() => emptyPackForm(suggestedCurrency(config))}
      formFrom={packFormFrom}
      nameOf={(form) => form.displayName}
      toDraft={packDraftFromForm}
      save={adminEconomyApi.savePackDraft}
      discard={adminEconomyApi.discardPackDraft}
      reload={reload}
      columns={packColumns}
      renderForm={(form, onChange) => <PackDraftFields form={form} onChange={onChange} />}
    />
  );
}
