import type { PackVersionView } from './economy-resolver.js';

/**
 * WHAT A CREDIT PACK COSTS AND GIVES AT ONE INSTANT -- the one rule, used by
 * both the catalog the store shows and the checkout that charges.
 *
 * A pack version stores its price, an optional regular ("was") price and an
 * optional promotion end. Whether the promotion is IN EFFECT is decided here,
 * against the instant the caller resolved on the database clock -- never the
 * browser's:
 *
 *   no was price                    price_minor, no promotion
 *   was price, no end               price_minor, struck-through was price
 *   was price, end in the future    price_minor, was price, countdown to the end
 *   was price, end passed           THE WAS PRICE -- the promotion is over and
 *                                   the regular price is the price
 *
 * So the store and the checkout cannot disagree, and a countdown that has run
 * out cannot keep selling at the promotional price.
 */
export interface EffectivePackTerms {
  priceMinor: number;
  /** The regular price, only while a promotion is in effect. */
  wasPriceMinor: number | null;
  /** The in-effect promotion's end, ISO 8601; null when none or open-ended. */
  promotionEndsAt: string | null;
  credits: number;
  bonusCredits: number;
  totalCredits: number;
}

type PackPricing = Pick<PackVersionView, 'priceMinor' | 'wasPriceMinor' | 'promotionEndsAt' | 'credits' | 'bonusCredits'>;

export function effectivePackTerms(pack: PackPricing, asOfIso: string): EffectivePackTerms {
  const credits = pack.credits;
  const bonusCredits = pack.bonusCredits;
  const base = { credits, bonusCredits, totalCredits: credits + bonusCredits };
  if (pack.wasPriceMinor === null) {
    return { ...base, priceMinor: pack.priceMinor, wasPriceMinor: null, promotionEndsAt: null };
  }
  const ended = pack.promotionEndsAt !== null && Date.parse(pack.promotionEndsAt) <= Date.parse(asOfIso);
  if (ended) {
    return { ...base, priceMinor: pack.wasPriceMinor, wasPriceMinor: null, promotionEndsAt: null };
  }
  return { ...base, priceMinor: pack.priceMinor, wasPriceMinor: pack.wasPriceMinor, promotionEndsAt: pack.promotionEndsAt };
}
