import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { CustomerAction, CustomerEconomyOverview, CustomerEconomyState } from '../lib/customerEconomy';
import {
  bestValuePlan,
  billingPeriodLabel,
  commercialTier,
  formatMonthlyEquivalent,
  formatPlanPrice,
  getCurrentPlan,
  offeredPlans,
  savingsPercent,
  spendableCredits,
} from '../lib/customerEconomy';
import { CrownIcon, LockIcon, PhoneIcon, SparkleIcon } from './icons';

/**
 * Customer economy presentation. Every value shown here comes from the server
 * through the overview; a fact the server has not supplied renders as "not
 * available", never as a default (no 0 Credits, no "Free", no invented plan).
 */

/** The server's spendable balance. Renders nothing while it is not available. */
export function CreditBalance({ overview, compact = false }: { overview: CustomerEconomyOverview; compact?: boolean }) {
  const credits = spendableCredits(overview);
  if (credits === null) return null;
  return (
    <Link
      to="/credits"
      aria-label={`${credits} Credits available. View your Credits.`}
      className={`inline-flex items-center gap-2 rounded-xl border border-amber-500/20 bg-amber-500/10 font-medium text-amber-100 transition-colors hover:bg-amber-500/20 ${compact ? 'px-2.5 py-1 text-xs' : 'px-3 py-2 text-sm'}`}
    >
      <span aria-hidden className="flex h-5 w-5 items-center justify-center rounded-full bg-amber-400/20 text-amber-300">✦</span>
      <span>{credits} Credits</span>
    </Link>
  );
}

export function EconomyStateNotice({ state, retry }: { state: CustomerEconomyState; retry?: () => void }) {
  if (state.status === 'loading') {
    return <div aria-busy className="h-24 animate-pulse rounded-2xl border border-zinc-800 bg-zinc-900/60" />;
  }
  if (state.status === 'unavailable' || state.status === 'disabled') {
    return (
      <div role="status" className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5 text-center">
        <p className="text-sm font-semibold text-zinc-100">{state.status === 'unavailable' ? 'Backend support pending' : 'Not available yet'}</p>
        <p className="mt-1 text-sm text-zinc-400">{state.message}</p>
      </div>
    );
  }
  if (state.status === 'signed-out') {
    return (
      <div role="status" className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5 text-center">
        <p className="text-sm text-zinc-400">{state.message}</p>
        <Link to="/login" className="mt-3 inline-block text-sm font-semibold text-rose-400 hover:text-rose-300">Sign in →</Link>
      </div>
    );
  }
  if (state.status === 'error') {
    return (
      <div role="alert" className="rounded-2xl border border-red-900 bg-red-950/40 p-5 text-center">
        <p className="text-sm text-red-200">{state.message}</p>
        {retry && <button type="button" onClick={retry} className="mt-3 text-sm font-semibold text-red-100 underline">Try again</button>}
      </div>
    );
  }
  return null;
}

/** The customer's tier and plan, as the server states them -- or that they are not known yet. */
export function PlanSummary({ overview }: { overview: CustomerEconomyOverview }) {
  const tier = commercialTier(overview);
  const plan = getCurrentPlan(overview);
  return (
    <div className="rounded-3xl border border-zinc-800 bg-gradient-to-b from-zinc-900 to-zinc-950 p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-rose-400">Your plan</p>
          {tier === null ? (
            <p className="mt-1 text-sm text-zinc-400">Your plan details aren't available yet.</p>
          ) : (
            <>
              <h3 className="mt-1 text-xl font-semibold text-white">{tier === 'premium' ? 'Premium' : 'Free'}</h3>
              {plan && <p className="mt-1 text-sm text-zinc-400">{plan.displayName}</p>}
            </>
          )}
        </div>
        {tier === 'premium' ? <CrownIcon className="h-6 w-6 text-amber-300" /> : <SparkleIcon className="h-6 w-6 text-rose-400" />}
      </div>
      <Link to="/subscription" className="mt-4 inline-flex rounded-xl border border-zinc-700 px-4 py-2 text-sm font-semibold text-zinc-100 hover:bg-zinc-800">View plans</Link>
    </div>
  );
}

/**
 * WHAT PREMIUM IS, in the customer's words.
 *
 * Four facts, and only facts the product already states. The Credits figure is
 * the server's `monthlyIncludedCredits`, never a constant, so changing the plan
 * in the economy configuration changes this line too. With no plan to read it
 * from this renders nothing rather than guessing a number.
 */
export function PremiumBenefits({ overview }: { overview: CustomerEconomyOverview }) {
  const plans = offeredPlans(overview);
  const credits = plans.length > 0 ? plans[0]!.monthlyIncludedCredits : null;
  if (credits === null) return null;
  const benefits = [
    { key: 'chat', icon: <PhoneIcon className="h-4 w-4" />, text: 'Unlimited text chat' },
    { key: 'content', icon: <CrownIcon className="h-4 w-4" />, text: 'Premium content included while your plan is active' },
    { key: 'credits', icon: <SparkleIcon className="h-4 w-4" />, text: `${credits} Credits every billing cycle` },
    { key: 'spend', icon: <SparkleIcon className="h-4 w-4" />, text: 'Spend Credits on anything priced in Credits' },
  ];
  return (
    <section aria-label="What Premium includes" data-testid="premium-benefits" className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-4">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-rose-400">What Premium includes</h3>
      <ul className="mt-3 flex flex-col gap-2.5">
        {benefits.map((benefit) => (
          <li key={benefit.key} className="flex items-start gap-3 text-sm text-zinc-200">
            <span aria-hidden className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-rose-500/15 text-rose-300">
              {benefit.icon}
            </span>
            <span>{benefit.text}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * The customer's plan right now, compactly: tier, plan, renewal, and the
 * balance ONCE.
 *
 * The brand bar already carries the Credits pill on every screen, so this
 * states the balance as one small figure rather than a second large balance
 * card -- the same number twice, in two different shapes, reads as two
 * balances.
 */
export function CurrentPlanCard({ overview }: { overview: CustomerEconomyOverview }) {
  const tier = commercialTier(overview);
  const plan = getCurrentPlan(overview);
  const credits = spendableCredits(overview);
  const subscription = overview.commercial?.subscription;
  const period = subscription?.available && subscription.value ? subscription.value : null;
  const premium = tier === 'premium';

  return (
    <section
      aria-label="Your current plan"
      data-testid="current-plan"
      data-tier={tier ?? 'unknown'}
      className="rounded-2xl border border-zinc-800 bg-zinc-900/40 px-4 py-3"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">Your plan</p>
          {tier === null ? (
            <p className="mt-0.5 text-sm text-zinc-400">Not available yet</p>
          ) : (
            <p className="mt-0.5 flex items-center gap-1.5 text-base font-semibold text-white">
              {premium && <CrownIcon aria-hidden className="h-4 w-4 shrink-0 text-amber-300" />}
              <span className="truncate">{premium ? plan?.displayName ?? 'Premium' : 'Free'}</span>
            </p>
          )}
        </div>
        {credits !== null && (
          <p className="shrink-0 text-right">
            <span className="block text-[11px] font-semibold uppercase tracking-wide text-zinc-500">Credits</span>
            <span className="text-base font-semibold text-amber-200">{credits}</span>
          </p>
        )}
      </div>
      {premium && period && (
        <p className="mt-2 border-t border-zinc-800 pt-2 text-xs text-zinc-400">
          {period.status === 'cancelled' ? 'Premium until' : 'Renews'} {new Date(period.currentPeriodEnd).toLocaleDateString()}
          <span className="ml-1 text-zinc-500">&middot; {period.status}</span>
        </p>
      )}
    </section>
  );
}

/**
 * THE PLAN SELECTOR: one decision, three billing periods.
 *
 * Every plan is the same product, so this is a choice of billing period rather
 * than three competing offers -- one row each, one of them selected, and one
 * primary CTA underneath carrying the price. The monthly equivalent and any
 * saving are DERIVED from the server's own prices (see the selectors); nothing
 * here invents a discount, and a saving that cannot be computed is not shown.
 *
 * The included Credits are stated once when every plan includes the same
 * number, and per row only when they differ -- the same fact three times is
 * noise, and on a phone it is noise that pushes the CTA off the screen.
 *
 * A PREMIUM CUSTOMER IS NOT SOLD PREMIUM. Their plan is marked and no purchase
 * CTA is drawn: the server refuses a second subscription, so an offer it would
 * refuse should never be on screen.
 */
export function PlanCatalog({ overview, onBuy }: { overview: CustomerEconomyOverview; onBuy?: (planCode: string) => void }) {
  // Shortest commitment first, so the ladder reads Monthly, Quarterly, Annual
  // whatever order the catalogue happens to return. Presentation only: which
  // plans exist, and their prices, are still entirely the server's.
  const plans = [...offeredPlans(overview)].sort((a, b) => a.billingPeriodMonths - b.billingPeriodMonths);
  const current = getCurrentPlan(overview);
  const premium = commercialTier(overview) === 'premium';
  const featured = bestValuePlan(plans);
  const [picked, setPicked] = useState<string | null>(null);

  if (plans.length === 0) {
    return <div className="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-5 text-center text-sm text-zinc-400">No plans are offered right now.</div>;
  }

  const selectedCode = picked ?? current?.code ?? featured?.code ?? plans[0]!.code;
  const selected = plans.find((plan) => plan.code === selectedCode) ?? plans[0]!;
  const credits = plans[0]!.monthlyIncludedCredits;
  const sameCreditsEverywhere = plans.every((plan) => plan.monthlyIncludedCredits === credits);

  return (
    <section className="flex flex-col gap-3">
      <div role="radiogroup" aria-label="Billing period" className="flex flex-col gap-2">
        {plans.map((plan) => {
          const chosen = plan.code === selected.code;
          const mine = current?.code === plan.code;
          const save = savingsPercent(plans, plan);
          const permonth = formatMonthlyEquivalent(plan);
          return (
            <label
              key={plan.code}
              data-testid={`plan-${plan.code}`}
              data-selected={chosen ? 'true' : 'false'}
              className={`flex min-h-[3.5rem] cursor-pointer items-center gap-3 rounded-2xl border px-4 py-3 transition-colors ${
                chosen ? 'border-rose-500 bg-rose-500/10' : 'border-zinc-800 bg-zinc-900/40 hover:border-zinc-700'
              }`}
            >
              <input
                type="radio"
                name="billing-period"
                value={plan.code}
                checked={chosen}
                onChange={() => setPicked(plan.code)}
                className="sr-only"
              />
              <span
                aria-hidden
                className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 ${chosen ? 'border-rose-500' : 'border-zinc-600'}`}
              >
                {chosen && <span className="h-2.5 w-2.5 rounded-full bg-rose-500" />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="text-sm font-semibold text-white">{billingPeriodLabel(plan)}</span>
                  {plan.code === featured?.code && plans.length > 1 && (
                    <span className="rounded-full bg-amber-400/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-300">Best value</span>
                  )}
                  {mine && (
                    <span className="rounded-full bg-emerald-400/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-300">Your plan</span>
                  )}
                </span>
                {permonth && <span className="mt-0.5 block text-xs text-zinc-400">{permonth}</span>}
                {!sameCreditsEverywhere && (
                  <span className="mt-0.5 block text-xs text-amber-200/80">{plan.monthlyIncludedCredits} Credits each cycle</span>
                )}
              </span>
              <span className="shrink-0 text-right">
                <span className="block text-sm font-semibold text-white">{formatPlanPrice(plan)}</span>
                {save !== null && <span className="block text-[11px] font-medium text-emerald-300">Save {save}%</span>}
              </span>
            </label>
          );
        })}
      </div>

      {sameCreditsEverywhere && (
        <p className="text-center text-xs text-zinc-400">
          Every plan includes <span className="font-semibold text-amber-200">{credits} Credits</span> each billing cycle.
        </p>
      )}

      {premium ? (
        <p data-testid="already-premium" className="rounded-xl border border-emerald-500/20 bg-emerald-500/10 px-4 py-3 text-center text-sm text-emerald-100">
          You&rsquo;re on Premium &mdash; there&rsquo;s nothing to buy here.
        </p>
      ) : onBuy ? (
        <button
          type="button"
          data-testid={`buy-${selected.code}`}
          onClick={() => onBuy(selected.code)}
          className="min-h-[3rem] w-full rounded-xl bg-rose-600 px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-rose-500"
        >
          Choose {billingPeriodLabel(selected)} &middot; {formatPlanPrice(selected)}
        </button>
      ) : (
        <button
          type="button"
          disabled
          aria-disabled
          className="min-h-[3rem] w-full cursor-not-allowed rounded-xl bg-rose-600/40 px-4 py-3 text-sm font-semibold text-white/70"
        >
          Subscribing isn&rsquo;t available yet
        </button>
      )}
    </section>
  );
}

function ConfirmationDialog({ action, onClose }: { action: CustomerAction; onClose: () => void }) {
  const { creditCost } = action.quote;
  return (
    <div role="dialog" aria-modal="true" aria-label={`Confirm ${action.title}`} className="fixed inset-0 z-50 flex items-end justify-center bg-black/80 p-0 backdrop-blur-sm sm:items-center sm:p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-t-3xl border border-zinc-800 bg-zinc-950 p-6 sm:rounded-3xl" onClick={(event) => event.stopPropagation()}>
        <p className="text-xs font-semibold uppercase tracking-wide text-amber-300">Preview confirmation</p>
        <h3 className="mt-2 text-xl font-semibold text-white">{action.title}</h3>
        <p className="mt-2 text-sm text-zinc-400">
          This action is shown with the cost the server quoted. This preview will not spend Credits or change your account.
        </p>
        <div className="mt-4 rounded-2xl border border-zinc-800 bg-zinc-900 px-4 py-3 text-sm text-zinc-200">
          {creditCost === null ? 'Cost will be shown before you continue.' : `${creditCost} Credits`}
        </div>
        <button type="button" onClick={onClose} className="mt-5 w-full rounded-xl bg-rose-600 py-3 text-sm font-semibold text-white hover:bg-rose-500">Got it</button>
      </div>
    </div>
  );
}

/** A paid action, exactly as the server quoted it. Renders nothing without a quote. */
export function PaidActionButton({ action, className = '' }: { action: CustomerAction | null; className?: string }) {
  const [confirming, setConfirming] = useState(false);
  if (!action) return null;
  const { quote } = action;
  if (quote.availability !== 'available') {
    return (
      <div className={`rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4 ${className}`}>
        <div className="flex gap-3">
          {action.slot === 'voice_call' ? <PhoneIcon className="mt-0.5 h-5 w-5 shrink-0 text-zinc-400" /> : <LockIcon className="mt-0.5 h-5 w-5 shrink-0 text-zinc-400" />}
          <div>
            <p className="text-sm font-semibold text-zinc-100">{action.title}</p>
            <p className="mt-1 text-sm text-zinc-400">{quote.unavailableReason ?? 'This action is not available yet.'}</p>
            {quote.creditCost !== null && <p className="mt-2 text-xs font-medium text-amber-200">Cost when available: {quote.creditCost} Credits</p>}
            <Link to="/subscription" className="mt-3 inline-block text-sm font-semibold text-rose-400 hover:text-rose-300">See options →</Link>
          </div>
        </div>
      </div>
    );
  }
  return (
    <>
      <button type="button" onClick={() => setConfirming(true)} className={`rounded-xl bg-rose-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-rose-500 ${className}`}>
        {action.title} {quote.creditCost === null ? '' : `· ${quote.creditCost} Credits`}
      </button>
      {confirming && <ConfirmationDialog action={action} onClose={() => setConfirming(false)} />}
    </>
  );
}

/** Locked premium content, with the server's reason. Renders nothing without a quote. */
export function LockedPremiumCard({ action }: { action: CustomerAction | null }) {
  if (!action) return null;
  return (
    <div className="rounded-3xl border border-zinc-800 bg-gradient-to-b from-zinc-900 to-zinc-950 p-5">
      <div className="flex gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-zinc-800 text-rose-400"><LockIcon className="h-5 w-5" /></span>
        <div>
          <p className="text-sm font-semibold text-white">Premium content</p>
          <p className="mt-1 text-sm text-zinc-400">{action.quote.unavailableReason ?? 'This content is locked.'}</p>
          <p className="mt-3 text-xs text-zinc-500">Cost and eligibility are always shown before an unlock is confirmed.</p>
        </div>
      </div>
      <Link to="/subscription" className="mt-4 inline-flex rounded-xl border border-zinc-700 px-4 py-2 text-sm font-semibold text-zinc-100 hover:bg-zinc-800">View plans</Link>
    </div>
  );
}
