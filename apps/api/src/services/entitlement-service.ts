import type { CommercialState } from '@over18/shared';
import type { Db } from '../db/client.js';
import type { CommerceEnv } from '../env.js';
import type { SafeUser } from './auth-service.js';

/**
 * THE entitlement resolver (PRD v1.2 §18, build step 0b).
 *
 * One function returns a viewer's complete commercial state -- plan, status,
 * balance, age verification, whether the economy is on. Every gated route will
 * consult it, and no route may re-derive entitlement for itself: the moment two
 * routes answer "is this user Premium?" differently, one of them is a paywall
 * bypass.
 *
 * PHASE ZERO: EVERYONE IS FREE, AND NOTHING READS THIS YET. There are no
 * subscription, wallet or age-verification tables, so the only true answer is
 * the empty one. It is still the right shape, taking the database, so P2 and
 * P3 fill it in without changing a single caller.
 *
 * `role` IS NOT A COMMERCIAL TIER. An administrator is not Premium: staff
 * access is authorization, and conflating the two would let an operator's
 * account quietly bypass paywalls during verification and hide real defects.
 */
export async function resolveEntitlement(
  _db: Db,
  viewer: SafeUser | null,
  commerce: Pick<CommerceEnv, 'enabled'>,
): Promise<CommercialState> {
  return {
    viewer: viewer ? 'user' : 'anonymous',
    tier: 'free',
    subscription: null,
    wallet: { included: 0, earned: 0, purchased: 0, held: 0, spendable: 0 },
    age: { verified: false, expiresAt: null },
    economyEnabled: commerce.enabled,
  };
}
