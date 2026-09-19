import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { CustomerAction, CustomerEconomyOverview, CustomerEconomyState } from '../lib/customerEconomy';
import { commercialTier, formatPlanPrice, getCurrentPlan, offeredPlans, spendableCredits } from '../lib/customerEconomy';
import { CrownIcon, LockIcon, PhoneIcon, SparkleIcon } from './icons';

/**
 * Customer economy presentation. Every value shown here comes from the server
 * through the overview; a fact the server has not supplied renders as "not
 * available", never as a default (no 0 Credits, no "Free", no invented plan).
 */

/** The server's spendable balance. Renders nothing while the wallet is not available. */
export function CreditBalance({ overview, compact = false }: { overview: CustomerEconomyOverview; compact?: boolean }) {
  const credits = spendableCredits(overview);
  if (credits === null) return null;
  return (
    <Link
      to="/credits"
      aria-label={`${credits} Credits available. View wallet.`}
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
 * The plans offered now, from the server catalog: purchasable plans only, by
 * code. No plan is added here -- in particular there is no "Free" plan card.
 * Raw plan `features` are not rendered (their customer wording is undecided).
 */
export function PlanCatalog({ overview }: { overview: CustomerEconomyOverview }) {
  const plans = offeredPlans(overview);
  if (plans.length === 0) {
    return <div className="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-5 text-center text-sm text-zinc-400">No plans are offered right now.</div>;
  }
  return (
    <section className="flex flex-col gap-3">
      {plans.map((plan) => (
        <article key={plan.code} className="rounded-3xl border border-rose-500/30 bg-gradient-to-b from-rose-500/10 to-zinc-950 p-5">
          <div className="flex items-baseline justify-between gap-3">
            <h3 className="text-lg font-semibold text-white">{plan.displayName}</h3>
            <span className="text-xs text-zinc-400">{formatPlanPrice(plan)}</span>
          </div>
          <p className="mt-2 text-sm text-zinc-400">{plan.monthlyIncludedCredits} Credits included each month</p>
          <button type="button" disabled aria-disabled className="mt-5 w-full cursor-not-allowed rounded-xl bg-rose-600/50 py-3 text-sm font-semibold text-white/80">Subscribing isn't available yet</button>
        </article>
      ))}
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
