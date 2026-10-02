import { Link } from 'react-router-dom';
import type { CustomerPaymentView, PurchaseContext } from '@over18/shared';
import { credits, formatCountdown, type BalanceState, type PackView } from '../../lib/creditsStore';
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

export function StoreHero({ media, wide = false }: { media: HeroMedia; wide?: boolean }) {
  return (
    <section
      data-testid="store-hero"
      className={`relative overflow-hidden bg-zinc-900 ${wide ? 'h-full min-h-[34rem] rounded-3xl border border-zinc-800' : 'h-[24rem] sm:h-[28rem] lg:h-[40rem] lg:rounded-3xl lg:border lg:border-zinc-800'}`}
    >
      {media.imageUrl ? (
        <img
          src={media.imageUrl}
          alt={media.name ?? ''}
          data-testid="store-hero-image"
          className="absolute inset-0 h-full w-full object-cover object-[center_15%]"
        />
      ) : (
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
      )}
      <div aria-hidden className="absolute inset-0 bg-gradient-to-b from-zinc-950/40 via-transparent via-45% to-zinc-950" />
      <div className="absolute inset-x-0 bottom-0 flex flex-col gap-2 p-5 sm:p-7">
        <p className="text-xs font-semibold uppercase tracking-widest text-rose-300">Credits Store</p>
        <h1 className="text-3xl font-extrabold uppercase leading-[1.05] tracking-tight text-white drop-shadow sm:text-4xl">
          Keep the experience going
        </h1>
        <p className="max-w-sm text-sm leading-relaxed text-zinc-200">Get Credits for photos, videos, voice and premium content.</p>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * The balance
 * ------------------------------------------------------------------ */

export function BalanceCard({ balance, premium }: { balance: BalanceState; premium: boolean }) {
  return (
    <section
      aria-label="Your Credits"
      data-testid="store-balance"
      data-balance={balance.kind}
      className="flex items-center gap-4 rounded-3xl border border-zinc-800 bg-gradient-to-b from-zinc-900 to-zinc-950 p-5"
    >
      <span aria-hidden className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full border border-amber-500/25 bg-amber-400/15 text-amber-300">
        <SparkleIcon className="h-6 w-6" />
      </span>
      <div className="min-w-0 flex-1">
        {balance.kind === 'zero' && (
          <>
            <p className="text-lg font-bold text-white">You're out of Credits</p>
            <p className="text-sm text-zinc-400">Get Credits to continue with photos, videos, voice and premium content.</p>
          </>
        )}
        {balance.kind === 'low' && (
          <>
            <p className="text-lg font-bold text-white">{credits(balance.credits)} remaining</p>
            <p className="text-sm text-zinc-400">Top up whenever you like.</p>
          </>
        )}
        {balance.kind === 'normal' && (
          <>
            <p className="flex items-baseline gap-2">
              <span className="text-3xl font-bold tracking-tight text-white tabular-nums">{balance.credits.toLocaleString('en-US')}</span>
              <span className="text-sm font-medium text-amber-200">Credits</span>
            </p>
            <p className="text-sm text-zinc-400">Available to use now</p>
          </>
        )}
        {balance.kind === 'unknown' && <p className="text-sm text-zinc-400">Your Credit balance isn't available right now.</p>}
      </div>
      {premium && (
        <span className="inline-flex shrink-0 items-center gap-1 self-start rounded-full border border-amber-500/25 bg-amber-500/10 px-2.5 py-1 text-xs font-semibold text-amber-200">
          <CrownIcon className="h-3 w-3" />
          Premium
        </span>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * Why they are here
 * ------------------------------------------------------------------ */

/** Said only when the customer arrived because something needed Credits. */
export function ContextNotice({ context }: { context: PurchaseContext | null }) {
  if (context?.originAction !== 'content_unlock') return null;
  return (
    <div role="status" data-testid="store-context" className="flex items-start gap-3 rounded-2xl border border-zinc-800 bg-zinc-900/70 p-4">
      <span aria-hidden className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-zinc-800 text-rose-300">
        <LockIcon className="h-4 w-4" />
      </span>
      <div>
        <p className="text-sm font-semibold text-white">You need a few more Credits</p>
        <p className="mt-0.5 text-sm text-zinc-400">Pick a pack and we'll take you straight back to unlock it.</p>
      </div>
    </div>
  );
}

/**
 * Premium, as a secondary note for someone who does not have it. A subscriber
 * never sees it: this page sells Credits, and they already have Premium.
 */
export function PremiumNote() {
  return (
    <section data-testid="store-premium-note" className="rounded-2xl border border-amber-500/20 bg-amber-500/5 p-4">
      <p className="text-sm font-semibold text-amber-100">Want unlimited conversations?</p>
      <p className="mt-0.5 text-sm text-zinc-400">Premium includes unlimited messaging plus recurring Credits.</p>
      <Link to="/subscription" className="mt-2 inline-flex min-h-8 items-center text-sm font-semibold text-amber-300 hover:text-amber-200">
        View Premium →
      </Link>
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * One pack
 * ------------------------------------------------------------------ */

function Coin({ size = 'md' }: { size?: 'sm' | 'md' }) {
  return (
    <span
      aria-hidden
      className={`flex items-center justify-center rounded-full bg-[radial-gradient(circle_at_34%_30%,#fef3c7_0%,#fbbf24_38%,#d97706_72%,#92400e_100%)] shadow-[0_0_14px_rgba(251,191,36,0.4)] ${size === 'sm' ? 'h-6 w-6' : 'h-9 w-9'}`}
    >
      <SparkleIcon className={`text-white/90 ${size === 'sm' ? 'h-3 w-3' : 'h-4 w-4'}`} />
    </span>
  );
}

export function PackCard({ view, onSelect, disabled }: { view: PackView; onSelect: () => void; disabled?: boolean }) {
  const featured = view.recommended;
  return (
    <article
      data-testid={`pack-${view.code}`}
      data-recommended={featured || undefined}
      aria-label={`${view.cta} for ${view.price}`}
      className={
        featured
          ? 'relative rounded-3xl bg-gradient-to-br from-rose-400 via-amber-400 to-pink-600 p-[1.5px] shadow-[0_10px_40px_rgba(225,29,72,0.25)] col-span-2'
          : 'relative rounded-2xl border border-zinc-800 bg-gradient-to-b from-zinc-900 to-zinc-950'
      }
    >
      <div className={`flex h-full flex-col gap-3 p-4 ${featured ? 'rounded-[calc(1.5rem-1.5px)] bg-[radial-gradient(120%_90%_at_0%_0%,rgba(225,29,72,0.2)_0%,#18181b_60%)]' : ''}`}>
        <div className="flex min-h-6 flex-wrap items-center gap-1.5">
          {view.badge && (
            <span data-testid="pack-badge" className="rounded-full bg-rose-600 px-2.5 py-0.5 text-[11px] font-extrabold uppercase tracking-wider text-white">
              {view.badge}
            </span>
          )}
          {view.bonusCredits > 0 && (
            <span data-testid="pack-bonus" className="rounded-full bg-amber-500/15 px-2.5 py-0.5 text-xs font-bold text-amber-200">
              +{view.bonusCredits.toLocaleString('en-US')} bonus
            </span>
          )}
          {view.endsInMs !== null && (
            <span data-testid="pack-countdown" className="rounded-full border border-zinc-700 bg-zinc-950/70 px-2.5 py-0.5 text-xs font-semibold tabular-nums text-zinc-100">
              Offer ends in {formatCountdown(view.endsInMs)}
            </span>
          )}
        </div>

        <div className="flex items-center gap-3">
          <Coin size={featured ? 'md' : 'sm'} />
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">{view.name}</p>
            <p className="flex items-baseline gap-1.5">
              <span className={`font-extrabold tracking-tight text-white tabular-nums ${featured ? 'text-3xl' : 'text-2xl'}`}>
                {view.totalCredits.toLocaleString('en-US')}
              </span>
              <span className="text-sm font-semibold text-amber-200">Credits</span>
            </p>
            {view.bonusCredits > 0 && (
              <p className="text-xs text-zinc-400">
                {view.credits.toLocaleString('en-US')} + {view.bonusCredits.toLocaleString('en-US')} bonus
              </p>
            )}
          </div>
        </div>

        <p className="mt-auto flex items-baseline gap-2">
          {view.wasPrice && (
            <s data-testid="pack-was-price" className="text-sm text-zinc-500">
              {view.wasPrice}
            </s>
          )}
          <span data-testid="pack-price" className={`font-bold text-white ${featured ? 'text-xl' : 'text-lg'}`}>
            {view.price}
          </span>
        </p>

        <button
          type="button"
          onClick={onSelect}
          disabled={disabled}
          data-testid={`buy-${view.code}`}
          className={`min-h-12 w-full rounded-xl px-3 text-sm font-bold text-white transition-colors disabled:opacity-60 ${
            featured
              ? 'bg-gradient-to-r from-rose-600 to-pink-600 shadow-[0_6px_20px_rgba(225,29,72,0.35)] hover:from-rose-500 hover:to-pink-500'
              : 'border border-zinc-700 bg-zinc-800 hover:bg-zinc-700'
          }`}
        >
          {view.cta}
        </button>
      </div>
    </article>
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
