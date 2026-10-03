import { Link } from 'react-router-dom';
import type { CustomerPaymentView } from '@over18/shared';
import {
  balanceLine,
  credits,
  formatCountdown,
  packCtaLabel,
  type BalanceState,
  type PackView,
  type StoreHeroCopy,
} from '../../lib/creditsStore';
import type { PublicClip } from '../../lib/api';
import RotatingHeaderClip from '../RotatingHeaderClip';
import { ChevronLeftIcon, CrownIcon, LockIcon, PhoneIcon, SparkleIcon } from '../icons';

/**
 * THE CREDITS STORE'S PIECES (Credits Store PR 2).
 *
 * Presentational only: every value arrives as a prop, already decided by
 * `lib/creditsStore.ts` from what the server said. Nothing here prices,
 * compares or chooses -- which is what lets these render in a test without a
 * browser, and what keeps the page from ever showing a number of its own.
 *
 * The look is the app's own: zinc ground, rose for the one action that
 * matters, amber wherever Credits are meant.
 */

/* ------------------------------------------------------------------ *
 * The hero
 * ------------------------------------------------------------------ */

export interface HeroMedia {
  /** A character's image, when the store opens on one. */
  imageUrl: string | null;
  /** Her name, for the image's description. */
  name: string | null;
}

export const DEFAULT_HERO = { video: '/media/store/default-hero.mp4', poster: '/media/store/default-hero-poster.jpg' } as const;

/** Gold coins drifting over the hero -- still, decorative, and never spinning. */
function HeroCoins() {
  const coin = 'absolute rounded-full bg-[radial-gradient(circle_at_34%_30%,#fef3c7_0%,#fbbf24_38%,#d97706_72%,#92400e_100%)]';
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0">
      <span className={`${coin} right-5 top-14 flex h-12 w-12 rotate-12 items-center justify-center shadow-[0_0_28px_rgba(251,191,36,0.55)]`}>
        <SparkleIcon className="h-6 w-6 text-rose-600" />
      </span>
      <span className={`${coin} left-3 top-28 h-8 w-8 -rotate-12 blur-[0.6px] shadow-[0_0_20px_rgba(251,191,36,0.5)]`} />
      <span className={`${coin} right-2 top-44 h-5 w-5 opacity-85 blur-[1.2px]`} />
    </div>
  );
}

/**
 * The hero: the character the store opened on, if any; otherwise the session's
 * six rotating characters (`rotation`); otherwise -- while they load, or if
 * there are none -- OVER18's own default clip.
 */
export function StoreHero({
  media,
  copy,
  wide = false,
  rotation = [],
}: {
  media: HeroMedia;
  copy: StoreHeroCopy;
  wide?: boolean;
  rotation?: readonly PublicClip[];
}) {
  const defaultVideo = (
    <video
      data-testid="store-hero-video"
      src={DEFAULT_HERO.video}
      poster={DEFAULT_HERO.poster}
      autoPlay
      muted
      loop
      playsInline
      aria-hidden
      className="absolute inset-0 h-full w-full object-cover object-[center_20%]"
    />
  );
  return (
    <section
      data-testid="store-hero"
      className={`relative overflow-hidden bg-zinc-900 ${wide ? 'h-full min-h-[34rem] rounded-3xl border border-zinc-800' : 'h-[18.75rem] sm:h-[22rem] lg:h-[40rem] lg:rounded-3xl lg:border lg:border-zinc-800'}`}
    >
      {media.imageUrl ? (
        <img
          src={media.imageUrl}
          alt={media.name ?? ''}
          data-testid="store-hero-image"
          className="absolute inset-0 h-full w-full object-cover object-[center_15%]"
        />
      ) : (
        <RotatingHeaderClip
          clips={rotation}
          fallback={defaultVideo}
          className="absolute inset-0 h-full w-full object-cover object-[center_20%]"
        />
      )}
      <div aria-hidden className="absolute inset-0 bg-gradient-to-b from-zinc-950/40 via-transparent via-40% to-zinc-950" />
      <HeroCoins />
      <div className="absolute inset-x-0 bottom-0 flex flex-col gap-1.5 p-5 sm:p-7">
        <p className="text-xs font-semibold uppercase tracking-widest text-rose-300">{copy.eyebrow}</p>
        <h1 data-testid="store-hero-title" className="text-[1.75rem] font-extrabold uppercase leading-[1.05] tracking-tight text-white drop-shadow sm:text-4xl">
          {copy.title}
        </h1>
        <p data-testid="store-hero-subtitle" className="max-w-sm text-sm leading-relaxed text-zinc-200">
          {copy.subtitle}
        </p>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * The balance -- one line, so the packs come first
 * ------------------------------------------------------------------ */

export function BalanceLine({ balance, premium }: { balance: BalanceState; premium: boolean }) {
  const line = balanceLine(balance);
  if (line === null && !premium) return null;
  return (
    <section
      aria-label="Your Credits"
      data-testid="store-balance"
      data-balance={balance.kind}
      className="flex items-center justify-between gap-3 rounded-2xl border border-zinc-800 bg-zinc-900 px-4 py-2.5"
    >
      <p className="flex items-center gap-2 text-sm text-zinc-300">
        <SparkleIcon aria-hidden className="h-4 w-4 shrink-0 text-amber-300" />
        <span>{line ?? "Your Credit balance isn't available right now."}</span>
      </p>
      {premium && (
        <span className="inline-flex shrink-0 items-center gap-1 text-xs font-semibold text-amber-200">
          <CrownIcon className="h-3 w-3" />
          Premium
        </span>
      )}
    </section>
  );
}

/**
 * Premium as a value anchor -- one line under the packs, for a customer known
 * not to have it. The numbers are the catalog's monthly plan. Secondary: it
 * links away, it never replaces buying Credits.
 */
export function PremiumAnchor({ anchor }: { anchor: { credits: number; price: string } | null }) {
  if (!anchor) return null;
  return (
    <Link
      to="/subscription"
      data-testid="store-premium-anchor"
      className="flex items-center gap-2 rounded-2xl border border-amber-500/20 bg-amber-500/5 px-4 py-3 text-sm text-amber-100 transition-colors hover:bg-amber-500/10"
    >
      <CrownIcon aria-hidden className="h-4 w-4 shrink-0 text-amber-300" />
      <span>
        <strong className="font-semibold">Better value:</strong> Premium gives you {anchor.credits.toLocaleString('en-US')} Credits every
        month + unlimited chat, {anchor.price}/mo
      </span>
      <span aria-hidden className="ml-auto text-amber-300">
        ›
      </span>
    </Link>
  );
}

/* ------------------------------------------------------------------ *
 * The packs -- choose one, then one button buys it
 * ------------------------------------------------------------------ */

function Coin({ size = 'md' }: { size?: 'sm' | 'md' }) {
  return (
    <span
      aria-hidden
      className={`flex items-center justify-center rounded-full bg-[radial-gradient(circle_at_34%_30%,#fef3c7_0%,#fbbf24_38%,#d97706_72%,#92400e_100%)] shadow-[0_0_14px_rgba(251,191,36,0.4)] ${size === 'sm' ? 'h-6 w-6' : 'h-9 w-9'}`}
    >
      <SparkleIcon className={`text-rose-600 ${size === 'sm' ? 'h-3 w-3' : 'h-4 w-4'}`} />
    </span>
  );
}

/**
 * One pack, as a choice. Tapping it SELECTS it; the store's one purchase button
 * (inline on desktop, the sticky bar on a phone) buys whichever is selected.
 */
export function PackCard({
  view,
  selected,
  onSelect,
  savingPercent = null,
  unlocksThis = false,
  disabled,
}: {
  view: PackView;
  selected: boolean;
  onSelect: () => void;
  savingPercent?: number | null;
  unlocksThis?: boolean;
  disabled?: boolean;
}) {
  const featured = view.recommended;
  const label = view.badge ?? (featured ? 'Recommended' : null);
  const saving = savingPercent !== null && savingPercent > 0 ? savingPercent : null;
  const hasChips = label !== null || view.bonusCredits > 0 || saving !== null || view.endsInMs !== null;
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      aria-pressed={selected}
      data-testid={`pack-${view.code}`}
      data-recommended={featured || undefined}
      data-selected={selected || undefined}
      aria-label={`${packCtaLabel(view)}${saving ? `, save ${saving}%` : ''}${unlocksThis ? ', unlocks this' : ''}`}
      className={`relative w-full text-left transition-transform active:scale-[0.99] disabled:opacity-60 ${
        featured ? 'col-span-2 rounded-3xl p-[1.5px] shadow-[0_10px_40px_rgba(225,29,72,0.25)]' : 'rounded-2xl p-[1.5px]'
      } ${
        selected
          ? 'bg-gradient-to-br from-rose-400 via-amber-400 to-pink-600'
          : featured
            ? 'bg-gradient-to-br from-rose-400/50 via-amber-400/40 to-pink-600/50'
            : 'bg-zinc-800'
      }`}
    >
      <span
        className={`flex h-full flex-col gap-2.5 p-4 ${
          featured
            ? 'rounded-[calc(1.5rem-1.5px)] bg-[radial-gradient(120%_90%_at_0%_0%,rgba(225,29,72,0.2)_0%,#18181b_60%)]'
            : 'rounded-[calc(1rem-1.5px)] bg-gradient-to-b from-zinc-900 to-zinc-950'
        }`}
      >
        <span className={`flex-wrap items-center gap-1.5 pr-6 ${hasChips ? 'flex' : 'hidden'}`}>
          {label && (
            <span data-testid="pack-badge" className="rounded-full bg-rose-600 px-2.5 py-0.5 text-[11px] font-extrabold uppercase tracking-wider text-white">
              {label}
            </span>
          )}
          {view.bonusCredits > 0 && (
            <span data-testid="pack-bonus" className="rounded-full bg-amber-500/15 px-2.5 py-0.5 text-xs font-bold text-amber-200">
              +{view.bonusCredits.toLocaleString('en-US')} free
            </span>
          )}
          {saving !== null && (
            <span data-testid="pack-saving" className="rounded-full bg-emerald-500/15 px-2.5 py-0.5 text-xs font-bold text-emerald-300">
              Save {saving}%
            </span>
          )}
          {view.endsInMs !== null && (
            <span data-testid="pack-countdown" className="rounded-full border border-zinc-700 bg-zinc-950/70 px-2.5 py-0.5 text-xs font-semibold tabular-nums text-zinc-100">
              Offer ends in {formatCountdown(view.endsInMs)}
            </span>
          )}
        </span>

        <span className="flex items-center gap-3">
          <Coin size={featured ? 'md' : 'sm'} />
          <span className="min-w-0">
            <span className="flex items-baseline gap-1.5">
              <span className={`font-extrabold tracking-tight text-white tabular-nums ${featured ? 'text-3xl' : 'text-2xl'}`}>
                {view.totalCredits.toLocaleString('en-US')}
              </span>
              <span className="text-sm font-semibold text-amber-200">Credits</span>
            </span>
            {view.bonusCredits > 0 && (
              <span className="block text-xs text-zinc-400">
                {view.credits.toLocaleString('en-US')} + {view.bonusCredits.toLocaleString('en-US')} free
              </span>
            )}
          </span>
        </span>

        <span className="mt-auto flex items-baseline gap-2">
          {view.wasPrice && (
            <s data-testid="pack-was-price" className="text-sm text-zinc-500">
              {view.wasPrice}
            </s>
          )}
          <span data-testid="pack-price" className={`font-bold text-white ${featured ? 'text-xl' : 'text-lg'}`}>
            {view.price}
          </span>
        </span>

        {unlocksThis && (
          <span data-testid="pack-unlocks-this" className="text-xs font-semibold text-emerald-300">
            Unlocks this ✓
          </span>
        )}
      </span>
      {selected && (
        <span aria-hidden className="absolute right-3 top-3 flex h-5 w-5 items-center justify-center rounded-full bg-rose-500 text-[11px] font-bold text-white">
          ✓
        </span>
      )}
    </button>
  );
}

/** The desktop purchase button: the selected pack's own terms, from the catalog. */
export function PurchaseCta({ view, onBuy, busy }: { view: PackView | null; onBuy: () => void; busy?: boolean }) {
  if (!view) return null;
  return (
    <button
      type="button"
      onClick={onBuy}
      disabled={busy}
      data-testid="store-cta"
      className="hidden min-h-14 w-full items-center justify-center rounded-2xl bg-gradient-to-r from-rose-600 to-pink-600 px-4 text-base font-bold text-white shadow-[0_6px_20px_rgba(225,29,72,0.4)] transition-colors hover:from-rose-500 hover:to-pink-500 disabled:opacity-60 lg:flex"
    >
      {packCtaLabel(view)}
    </button>
  );
}

/**
 * The phone's sticky purchase bar: the selected pack, its price, Continue.
 * Fixed to the bottom with the safe area respected; the page reserves room for
 * it, and it steps aside while the payment sheet is open.
 */
export function StickyPurchaseBar({ view, onBuy, busy }: { view: PackView | null; onBuy: () => void; busy?: boolean }) {
  if (!view) return null;
  return (
    <div
      data-testid="store-sticky-bar"
      className="fixed inset-x-0 bottom-0 z-20 border-t border-zinc-800 bg-zinc-950/95 px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur lg:hidden"
    >
      <div className="mx-auto flex max-w-lg items-center gap-3">
        <p className="min-w-0 flex-1">
          <span className="block truncate text-sm font-bold text-white">{credits(view.totalCredits)}</span>
          <span className="block text-sm text-zinc-300">{view.price}</span>
        </p>
        <button
          type="button"
          onClick={onBuy}
          disabled={busy}
          aria-label={packCtaLabel(view)}
          className="min-h-12 shrink-0 rounded-xl bg-gradient-to-r from-rose-600 to-pink-600 px-6 text-base font-bold text-white shadow-[0_6px_20px_rgba(225,29,72,0.4)] disabled:opacity-60"
        >
          Continue
        </button>
      </div>
    </div>
  );
}

/**
 * Reassurance under the packs -- ONLY what the payment architecture supports:
 * Credits land the moment the provider confirms, and the checkout is the
 * provider's own, so no card is ever entered here. ("Discreet billing" waits
 * for a chosen processor whose statement descriptor can be confirmed.)
 */
export function TrustRow() {
  return (
    <p data-testid="store-trust" className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-xs text-zinc-400">
      <span>⚡ Added instantly</span>
      <span>🔒 Secure checkout</span>
    </p>
  );
}

/* ------------------------------------------------------------------ *
 * What Credits are for, and the small print
 * ------------------------------------------------------------------ */

export function CreditUses() {
  const uses: Array<[string, JSX.Element]> = [
    ['Photos', <SparkleIcon key="p" className="h-5 w-5" />],
    ['Videos', <SparkleIcon key="v" className="h-5 w-5" />],
    ['Voice', <PhoneIcon key="c" className="h-5 w-5" />],
    ['Premium content', <LockIcon key="l" className="h-5 w-5" />],
  ];
  return (
    <section aria-labelledby="credit-uses" className="flex flex-col gap-3">
      <h2 id="credit-uses" className="text-sm font-semibold text-white">
        What can I use Credits for?
      </h2>
      <ul className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {uses.map(([label, icon]) => (
          <li key={label} className="flex items-center gap-2 rounded-xl border border-zinc-800 bg-zinc-900/60 px-3 py-2.5 text-sm text-zinc-300">
            <span aria-hidden className="text-rose-300">
              {icon}
            </span>
            {label}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function NoPacks() {
  return (
    <div role="status" data-testid="store-no-packs" className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5 text-center">
      <p className="text-sm font-semibold text-zinc-100">No Credit packs are on sale right now</p>
      <p className="mt-1 text-sm text-zinc-400">Please check back soon.</p>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * After a payment
 * ------------------------------------------------------------------ */

export type PurchaseOutcome =
  | { kind: 'checking' }
  | { kind: 'added'; payment: CustomerPaymentView; balance: number | null }
  /** The same succeeded payment, seen again (a refresh or a later visit): nothing new was added. */
  | { kind: 'already_added'; payment: CustomerPaymentView }
  | { kind: 'not_completed'; payment: CustomerPaymentView | null }
  | { kind: 'pending'; payment: CustomerPaymentView };

export function PurchaseResult({
  outcome,
  continueTo,
  continueLabel,
  onDismiss,
}: {
  outcome: PurchaseOutcome;
  /** An in-app path to go back to, or null to stay in the store. */
  continueTo: string | null;
  continueLabel: string;
  onDismiss: () => void;
}) {
  if (outcome.kind === 'checking') {
    return (
      <section role="status" aria-busy data-testid="purchase-result" data-outcome="checking" className="rounded-3xl border border-zinc-800 bg-zinc-900/60 p-6 text-center">
        <p className="text-sm text-zinc-400">Checking your payment…</p>
      </section>
    );
  }
  if (outcome.kind === 'added') {
    const added = outcome.payment.pack?.totalCredits ?? null;
    return (
      <section role="status" data-testid="purchase-result" data-outcome="added" className="flex flex-col items-center gap-4 rounded-3xl border border-amber-500/25 bg-gradient-to-b from-amber-500/10 to-zinc-950 p-6 text-center">
        <Coin />
        <div>
          <h2 className="text-2xl font-bold text-white">Credits added!</h2>
          {added !== null && <p className="mt-1 text-3xl font-extrabold text-amber-300">+{added.toLocaleString('en-US')}</p>}
          {outcome.balance !== null && (
            <p data-testid="purchase-new-balance" className="mt-1 text-sm text-zinc-300">
              New balance: <strong className="text-white">{credits(outcome.balance)}</strong>
            </p>
          )}
        </div>
        {continueTo ? (
          <Link to={continueTo} data-testid="purchase-continue" className="flex min-h-12 w-full items-center justify-center rounded-xl bg-rose-600 px-3 text-sm font-bold text-white hover:bg-rose-500">
            {continueLabel}
          </Link>
        ) : (
          <button type="button" onClick={onDismiss} data-testid="purchase-continue" className="min-h-12 w-full rounded-xl bg-rose-600 px-3 text-sm font-bold text-white hover:bg-rose-500">
            Continue
          </button>
        )}
      </section>
    );
  }
  if (outcome.kind === 'already_added') {
    // Not news: the Credits arrived when this purchase completed. Said as a
    // fact about that purchase -- never as Credits being added now.
    const total = outcome.payment.pack?.totalCredits ?? null;
    return (
      <section role="status" data-testid="purchase-result" data-outcome="already_added" className="flex flex-col items-center gap-3 rounded-3xl border border-zinc-800 bg-zinc-900/60 p-6 text-center">
        <h2 className="text-lg font-bold text-white">Purchase complete</h2>
        <p className="text-sm text-zinc-400">
          {total !== null ? `The ${credits(total)} from this purchase are already in your balance.` : 'The Credits from this purchase are already in your balance.'}
        </p>
        {continueTo ? (
          <Link to={continueTo} data-testid="purchase-continue" className="flex min-h-12 w-full items-center justify-center rounded-xl bg-zinc-800 px-3 text-sm font-bold text-white hover:bg-zinc-700">
            {continueLabel}
          </Link>
        ) : (
          <button type="button" onClick={onDismiss} data-testid="purchase-continue" className="min-h-12 w-full rounded-xl bg-zinc-800 px-3 text-sm font-bold text-white hover:bg-zinc-700">
            Back to the store
          </button>
        )}
      </section>
    );
  }
  if (outcome.kind === 'pending') {
    return (
      <section role="status" data-testid="purchase-result" data-outcome="pending" className="rounded-3xl border border-zinc-800 bg-zinc-900/60 p-6 text-center">
        <p className="text-sm font-semibold text-zinc-100">Your payment is still being confirmed</p>
        <p className="mt-1 text-sm text-zinc-400">Your Credits appear as soon as it is. Nothing is lost if you leave this page.</p>
      </section>
    );
  }
  return (
    <section role="status" data-testid="purchase-result" data-outcome="not_completed" className="rounded-3xl border border-zinc-800 bg-zinc-900/60 p-5 text-center">
      <p className="text-sm text-zinc-300">No payment was completed, so no Credits were added. You can try again whenever you like.</p>
      <button type="button" onClick={onDismiss} className="mt-3 text-sm font-semibold text-zinc-400 underline hover:text-zinc-200">
        Back to the store
      </button>
    </section>
  );
}

/** Back to where they were -- an in-app path only. */
export function BackLink({ to, label }: { to: string; label: string }) {
  return (
    <Link to={to} className="inline-flex min-h-9 items-center gap-1 text-sm text-zinc-400 hover:text-zinc-200">
      <ChevronLeftIcon className="h-4 w-4" />
      {label}
    </Link>
  );
}
