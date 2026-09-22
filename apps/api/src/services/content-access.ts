import { and, inArray, or } from 'drizzle-orm';
import type { CustomerAccessDecision, CustomerContentAccess, CustomerContentAccessResponse } from '@over18/shared';
import type { Db } from '../db/client.js';
import { characterVisualAssets } from '../db/schema.js';
import { characterPostsCondition, publiclyReachableCondition } from './asset-distribution.js';
import type { SafeUser } from './auth-service.js';
import { describeAssetCommercial, type AssetCommercialView } from './commercial-boundary.js';
import { readOwnedAssetIds } from './content-ownership.js';
import { readCustomerCommercialState } from './customer-economy.js';

/**
 * THE CUSTOMER CONTENT ACCESS RESOLVER (P4.2): what this signed-in customer
 * may do with these pieces of content, decided once, on the server.
 *
 * IT OWNS NOTHING. The content's terms -- state, Credit price, age floor --
 * are P4.1's, read through the commercial boundary; the customer's tier and
 * Credits are P3.1's commercial state; what they have bought is P8.2's
 * ownership. There is no second access, entitlement, wallet, subscription or
 * pricing model here, and nothing is charged, reserved or unlocked: this module
 * only answers a question.
 *
 * THE DECISION, IN ORDER. The first that applies wins, which is the precedence
 * the customer UX specification fixes:
 *
 *   unavailable        the content is withdrawn, unknown, or not something
 *                      this customer could reach at all
 *   age_restricted     the content states an age floor (P5 will decide whether
 *                      a customer meets it; until then nobody does)
 *   owned              the customer bought this content and keeps it (P8.2)
 *   open               free content, or Premium content for a Premium customer
 *   premium_required   Premium content, and this customer is not Premium
 *   credits_required   Credit content that can be unlocked at its price
 *   insufficient_credits  Credit content priced above the customer's Credits
 *
 * OWNERSHIP COMES AFTER THE TWO GATES AND BEFORE EVERY COMMERCIAL ONE. Content
 * that is withdrawn stays withdrawn and an age floor still applies -- neither
 * is a commercial condition that buying can settle. But having bought something
 * outranks tier and balance entirely, which is what makes ownership survive a
 * Premium lapse and an empty wallet alike.
 *
 * FAIL CLOSED. An id that names nothing, content a customer could not reach,
 * a subscription that cannot be resolved -- each answers with no access.
 * The only thing an unknown Credit balance costs is certainty about
 * affordability, never access: the price is stated and the unlock (P8) decides.
 *
 * NOTHING OF THE WALLET LEAVES HERE. No balance, no class, no held amount and
 * no ledger fact: only the content's own price. The customer's balance is the
 * commercial state's to report.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** One screen of content at a time; a grid asks about what it shows. */
export const CONTENT_ACCESS_MAX_IDS = 50;

export class ContentAccessError extends Error {
  constructor(
    public readonly code: 'invalid_request',
    message: string,
  ) {
    super(message);
    this.name = 'ContentAccessError';
  }
}

/**
 * The asset ids asked about: a repeated or comma-separated `assetIds`
 * parameter. Duplicates collapse, order is kept, and anything malformed is
 * refused rather than silently dropped.
 */
export function parseAssetIds(raw: unknown): string[] {
  const parts = (Array.isArray(raw) ? raw : [raw])
    .flatMap((value) => (typeof value === 'string' ? value.split(',') : [value]))
    .map((value) => (typeof value === 'string' ? value.trim() : value))
    .filter((value) => value !== '');
  if (parts.length === 0) throw new ContentAccessError('invalid_request', 'assetIds is required: the content you are asking about.');
  for (const part of parts) {
    if (typeof part !== 'string' || !UUID.test(part)) throw new ContentAccessError('invalid_request', 'Every assetIds value must be an asset id.');
  }
  const ids = [...new Set((parts as string[]).map((id) => id.toLowerCase()))];
  if (ids.length > CONTENT_ACCESS_MAX_IDS) {
    throw new ContentAccessError('invalid_request', `Ask about at most ${CONTENT_ACCESS_MAX_IDS} pieces of content at a time.`);
  }
  return ids;
}

/**
 * Which of these assets this customer could meet at all: content released to a
 * character's Posts, or reachable by id through a placement or her gallery.
 * Both predicates are the existing ones -- no visibility rule is restated here,
 * so this can never admit something the media route would refuse.
 */
async function reachable(db: Db, assetIds: string[]): Promise<Set<string>> {
  const rows = await db
    .select({ id: characterVisualAssets.id })
    .from(characterVisualAssets)
    .where(and(inArray(characterVisualAssets.id, assetIds), or(publiclyReachableCondition(), characterPostsCondition())));
  return new Set(rows.map((r) => r.id));
}

function decide(
  terms: AssetCommercialView,
  viewer: { premium: boolean; credits: number | null },
  owned: boolean,
): CustomerAccessDecision {
  if (terms.state === 'unavailable') return 'unavailable';
  // Age comes before access: P5 owns it, and until it exists nobody has met a floor.
  if (terms.ageFloor !== null) return 'age_restricted';
  // Bought and kept (P8.2). Ahead of tier and balance, never ahead of the two gates.
  if (owned) return 'owned';
  if (terms.state === 'free') return 'open';
  if (terms.state === 'premium') return viewer.premium ? 'open' : 'premium_required';
  // Credit content: the price is always stated. An unknown balance is not a
  // refusal -- the unlock (P8) decides -- but it is never treated as enough.
  if (viewer.credits !== null && terms.creditPrice !== null && viewer.credits < terms.creditPrice) return 'insufficient_credits';
  return 'credits_required';
}

const UNAVAILABLE = (assetId: string): CustomerContentAccess => ({
  assetId,
  state: 'unavailable',
  creditPrice: null,
  ageFloor: null,
  decision: 'unavailable',
});

/** The access decision for each asset asked about, in the order asked. */
export async function readContentAccess(db: Db, user: SafeUser, assetIds: string[]): Promise<CustomerContentAccessResponse> {
  if (assetIds.length === 0) return { items: [] };

  const visible = await reachable(db, assetIds);
  const [terms, commercial, owned] = await Promise.all([
    describeAssetCommercial(db, [...visible]),
    readCustomerCommercialState(db, user),
    readOwnedAssetIds(db, user.id, [...visible]),
  ]);

  // A tier that cannot be resolved is not Premium, and an unknown balance is
  // not a number: both fail closed rather than default.
  const viewer = {
    premium: commercial.tier.available && commercial.tier.value === 'premium',
    credits: commercial.wallet.available ? commercial.wallet.value.spendable : null,
  };

  return {
    items: assetIds.map((assetId) => {
      if (!visible.has(assetId)) return UNAVAILABLE(assetId);
      const asset = terms.get(assetId);
      if (!asset) return UNAVAILABLE(assetId);
      return {
        assetId,
        state: asset.state,
        creditPrice: asset.state === 'credit' ? asset.creditPrice : null,
        ageFloor: asset.ageFloor,
        decision: decide(asset, viewer, owned.has(assetId)),
      };
    }),
  };
}
