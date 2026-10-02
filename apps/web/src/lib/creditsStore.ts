import {
  PURCHASE_ORIGIN_ACTIONS,
  PURCHASE_ORIGINS,
  type CustomerEconomyCatalog,
  type CustomerPackOffer,
  type PurchaseContext,
} from '@over18/shared';
import { formatMoneyMinor } from './customerEconomy.selectors';

/**
 * THE CREDITS STORE, AS RULES (Credits Store PR 2).
 *
 * Everything the `/credits` page decides lives here, as plain functions, so it
 * can be tested without a DOM -- which this repo's web tests do not have.
 *
 * NOTHING HERE PRICES ANYTHING. Every number on the page comes from
 * `GET /api/economy/catalog` and `GET /api/me/commercial-state`; this module
 * only decides which of the server's packs to show, how to word them, and
 * where to send the customer afterwards. The checkout charges the server's
 * price whatever this module shows.
 */

/* ------------------------------------------------------------------ *
 * Which packs
 * ------------------------------------------------------------------ */

/**
 * The packs a customer may buy, in ladder order. The catalog deliberately
 * includes RETIRED versions (`isPurchasable: false`) so a client can recognise
 * them; the store must never offer one.
 */
export function purchasablePacks(catalog: CustomerEconomyCatalog | null | undefined): CustomerPackOffer[] {
  return (catalog?.packs ?? [])
    .filter((pack) => pack.isPurchasable)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.code.localeCompare(b.code));
}

/** The pack the operator marked as the one to recommend (`isBestValue`), if any. */
export function recommendedPack(packs: readonly CustomerPackOffer[]): CustomerPackOffer | null {
  return packs.find((pack) => pack.isBestValue) ?? null;
}

/* ------------------------------------------------------------------ *
 * The balance
 * ------------------------------------------------------------------ */

/**
 * At or below this many Credits the store's balance card is worded "N Credits
 * remaining" instead of the plain number (the brief's "low" state). A LABEL,
 * not an affordability rule: it blocks nothing, warns nowhere, and decides
 * nothing -- the server alone decides whether anything can be paid for.
 */
export const LOW_BALANCE = 10;

export type BalanceState = { kind: 'unknown' } | { kind: 'zero' } | { kind: 'low'; credits: number } | { kind: 'normal'; credits: number };

export function balanceState(spendable: number | null): BalanceState {
  if (spendable === null) return { kind: 'unknown' };
  if (spendable <= 0) return { kind: 'zero' };
  if (spendable <= LOW_BALANCE) return { kind: 'low', credits: spendable };
  return { kind: 'normal', credits: spendable };
}

export const credits = (n: number): string => `${n.toLocaleString('en-US')} ${n === 1 ? 'Credit' : 'Credits'}`;

/* ------------------------------------------------------------------ *
 * One pack, as shown
 * ------------------------------------------------------------------ */

export interface PackView {
  code: string;
  name: string;
  credits: number;
  bonusCredits: number;
  totalCredits: number;
  /** What it costs NOW, formatted. */
  price: string;
  /** The regular price to strike through -- only while a promotion is in effect. */
  wasPrice: string | null;
  /** Milliseconds until the promotion ends, while it is running and has an end. */
  endsInMs: number | null;
  badge: string | null;
  recommended: boolean;
  /** Says exactly what the customer receives. */
  cta: string;
}

/**
 * A pack at instant `now`. The catalog's promotion was in effect when the
 * server answered; if its end passes while the page is open, the promotion is
 * over HERE TOO: the regular price becomes the price and the countdown goes --
 * which is also what the server charges from that moment.
 */
export function packView(pack: CustomerPackOffer, now: number, recommended: CustomerPackOffer | null = null): PackView {
  const endsAt = pack.promotionEndsAt === null ? null : Date.parse(pack.promotionEndsAt);
  const promoting = pack.wasPriceMinor !== null && (endsAt === null || endsAt > now);
  const priceMinor = pack.wasPriceMinor !== null && !promoting ? pack.wasPriceMinor : pack.priceMinor;
  return {
    code: pack.code,
    name: pack.displayName,
    credits: pack.credits,
    bonusCredits: pack.bonusCredits,
    totalCredits: pack.totalCredits,
    price: formatMoneyMinor(priceMinor, pack.currency),
    wasPrice: promoting ? formatMoneyMinor(pack.wasPriceMinor!, pack.currency) : null,
    endsInMs: promoting && endsAt !== null ? endsAt - now : null,
    badge: pack.badge,
    recommended: recommended?.code === pack.code,
    cta: `Get ${credits(pack.totalCredits)}`,
  };
}

/** `02:14:37`, or `3d 02:14:37` beyond a day. */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(total / 86_400);
  const pad = (n: number) => String(n).padStart(2, '0');
  const clock = `${pad(Math.floor((total % 86_400) / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
  return days > 0 ? `${days}d ${clock}` : clock;
}

/* ------------------------------------------------------------------ *
 * Where the customer came from, and where they go back to
 * ------------------------------------------------------------------ */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const EMPTY: PurchaseContext = { origin: null, originAction: null, assetId: null, conversationId: null, characterId: null };

/**
 * The purchase context from `/credits?...`. Read from fixed lists and id
 * shapes only -- anything else is dropped -- so a crafted link cannot smuggle
 * a destination in. The server validates the same fields again at checkout.
 */
export function readStoreContext(params: URLSearchParams): PurchaseContext | null {
  const pick = <T extends string>(key: string, allowed: readonly T[]): T | null => {
    const value = params.get(key);
    return value !== null && (allowed as readonly string[]).includes(value) ? (value as T) : null;
  };
  const id = (key: string): string | null => {
    const value = params.get(key);
    return value !== null && UUID.test(value) ? value.toLowerCase() : null;
  };
  const context: PurchaseContext = {
    origin: pick('origin', PURCHASE_ORIGINS),
    originAction: pick('originAction', PURCHASE_ORIGIN_ACTIONS),
    assetId: id('assetId'),
    conversationId: id('conversationId'),
    characterId: id('characterId'),
  };
  return Object.values(context).some((v) => v !== null) ? context : null;
}

/** `/credits` with a purchase context -- what a "Get Credits" link points at. */
export function creditsStoreHref(context: Partial<PurchaseContext> = {}): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries({ ...EMPTY, ...context })) if (value) params.set(key, value);
  const query = params.toString();
  return query ? `/credits?${query}` : '/credits';
}

/**
 * Where to send the customer once their Credits have arrived -- ALWAYS a path
 * of this app, built from ids, never a URL taken from anywhere. Null when the
 * purchase did not start from somewhere to go back to.
 *
 *   an unlock of a character's post   that character's Posts, which resumes the unlock
 *   a chat                            that conversation
 *   anything else with a character    that character's profile
 */
export function returnTarget(context: PurchaseContext | null | undefined): string | null {
  if (!context) return null;
  const { originAction, assetId, conversationId, characterId } = context;
  const safe = (v: string | null) => (v !== null && UUID.test(v) ? encodeURIComponent(v) : null);
  if (originAction === 'content_unlock' && safe(characterId) && safe(assetId)) {
    return `/characters/${safe(characterId)}?tab=posts&unlock=${safe(assetId)}`;
  }
  if (safe(conversationId)) return `/chat/${safe(conversationId)}`;
  if (safe(characterId)) return `/characters/${safe(characterId)}`;
  return null;
}

/* ------------------------------------------------------------------ *
 * What the browser remembers across the trip to the payment provider
 *
 * Conveniences only, per browser and per tab. Losing them changes nothing the
 * server decides: the purchase context travels WITH THE PAYMENT, and an unlock
 * that cannot be resumed automatically is simply offered again.
 * ------------------------------------------------------------------ */

const PENDING_PAYMENT = 'over18.credits.pendingPayment';
const PENDING_UNLOCK = 'over18.credits.pendingUnlock';
const LAST_CHARACTER = 'over18.lastCharacterId';

function store(kind: 'session' | 'local'): Storage | null {
  try {
    return kind === 'session' ? globalThis.sessionStorage ?? null : globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}
function read(kind: 'session' | 'local', key: string): string | null {
  try {
    return store(kind)?.getItem(key) ?? null;
  } catch {
    return null;
  }
}
function write(kind: 'session' | 'local', key: string, value: string | null): void {
  try {
    const s = store(kind);
    if (!s) return;
    if (value === null) s.removeItem(key);
    else s.setItem(key, value);
  } catch {
    /* storage refused (private mode, quota): nothing depends on it */
  }
}

/** The pack checkout in flight, so the store can show its result on return. */
export const pendingPayment = {
  set: (paymentId: string) => write('session', PENDING_PAYMENT, paymentId),
  get: () => {
    const id = read('session', PENDING_PAYMENT);
    return id && UUID.test(id) ? id : null;
  },
  clear: () => write('session', PENDING_PAYMENT, null),
};

/**
 * The unlock that sent the customer to buy Credits, with the price they were
 * shown. On the way back it is continued automatically ONLY if the server's
 * price is still that price; otherwise it is offered again for them to confirm.
 */
export interface PendingUnlock {
  assetId: string;
  creditPrice: number;
}
export const pendingUnlock = {
  set: (unlock: PendingUnlock) => write('session', PENDING_UNLOCK, JSON.stringify(unlock)),
  get: (): PendingUnlock | null => {
    try {
      const value = JSON.parse(read('session', PENDING_UNLOCK) ?? 'null') as PendingUnlock | null;
      return value && typeof value.assetId === 'string' && UUID.test(value.assetId) && Number.isSafeInteger(value.creditPrice)
        ? value
        : null;
    } catch {
      return null;
    }
  },
  clear: () => write('session', PENDING_UNLOCK, null),
};

/** Whether an unlock being resumed may go through without asking again. */
export function mayAutoUnlock(pending: PendingUnlock | null, assetId: string, serverPrice: number | null): boolean {
  return pending !== null && pending.assetId === assetId && serverPrice !== null && pending.creditPrice === serverPrice;
}

/**
 * Back from the store with an unlock to continue: what the Posts tab does.
 *
 *   auto      still Credit-priced, at the price the customer saw: it goes through
 *   confirm   still Credit-priced, but nothing (or another price) was remembered: ask
 *   none      owned already, no longer for sale, or not on this page: nothing to do
 */
export function resumeUnlockAction(
  access: { decision: string; creditPrice?: number | null } | null,
  onThisPage: boolean,
  pending: PendingUnlock | null,
  assetId: string,
): 'auto' | 'confirm' | 'none' {
  if (!onThisPage || access?.decision !== 'credits_required') return 'none';
  return mayAutoUnlock(pending, assetId, access.creditPrice ?? null) ? 'auto' : 'confirm';
}

/**
 * A locked tile the customer cannot yet afford says "Get Credits". That link
 * must carry what they wanted -- the post and whose it is -- or the store has
 * nowhere to bring them back to and nothing to finish. Every other tile is
 * returned unchanged.
 */
export function withStoreLink<V extends { state: string; cta: { to: string | null } | null }>(
  view: V,
  assetId: string,
  characterId: string | null | undefined,
): V {
  if (view.state !== 'insufficient_credits' || !view.cta) return view;
  const to = creditsStoreHref({ origin: 'profile', originAction: 'content_unlock', assetId, characterId: characterId ?? null });
  return { ...view, cta: { ...view.cta, to } };
}

/** Premium is mentioned -- secondary, below the packs -- only to someone known not to have it. */
export function showPremiumNote(tier: string | null): boolean {
  return tier !== null && tier !== 'premium';
}

/**
 * The checkout request for a pack: its code, the method, a fresh key and where
 * the purchase started. Never a price, Credits or a bonus -- the server reads
 * those from the catalog.
 */
export function packCheckoutRequest(packCode: string, method: string, idempotencyKey: string, context: PurchaseContext | null) {
  return { packCode, method, idempotencyKey, returnUrl: '/credits', context };
}

/** The character last chatted with, for the store's hero. */
export const lastCharacter = {
  set: (characterId: string) => {
    if (UUID.test(characterId)) write('local', LAST_CHARACTER, characterId.toLowerCase());
  },
  get: () => {
    const id = read('local', LAST_CHARACTER);
    return id && UUID.test(id) ? id : null;
  },
};

/**
 * Whose face the store opens on: the character the customer came from, else
 * the one they last chatted with, else none -- and the page shows its default.
 */
export function heroCharacterId(context: PurchaseContext | null | undefined, lastChatted: string | null): string | null {
  return context?.characterId ?? lastChatted ?? null;
}

/** Told when a purchase has landed, so anything showing the balance reads it again. */
export const CREDITS_CHANGED_EVENT = 'over18:credits-changed';
export function announceCreditsChanged(): void {
  try {
    globalThis.dispatchEvent?.(new Event(CREDITS_CHANGED_EVENT));
  } catch {
    /* no window (tests) */
  }
}
