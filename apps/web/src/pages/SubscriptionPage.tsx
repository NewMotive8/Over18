import { Link } from 'react-router-dom';
import PageContainer from '../components/PageContainer';
import PageHeader from '../components/PageHeader';
import { CreditBalance, EconomyStateNotice, LockedPremiumCard, PlanCatalog, PlanSummary } from '../components/CustomerEconomy';
import { getAction, spendableCredits, useCustomerEconomy } from '../lib/customerEconomy';

/**
 * Subscription (US-18) -- plans and access, read-only.
 *
 * Shows only what the server supplies: the customer's plan and balance when
 * they are known, and the plans the server catalog offers, by code. Nothing
 * here subscribes, pays, grants or spends; the subscribe control is disabled.
 */
export default function SubscriptionPage() {
  const [state, retry] = useCustomerEconomy();
  return (
    <PageContainer>
      <PageHeader eyebrow="Plans & access" title="Choose your experience" subtitle="Compare your current plan, Credits, and future Premium access." />
      <EconomyStateNotice state={state} retry={retry} />
      {state.status === 'ready' && (
        <>
          {spendableCredits(state.overview) !== null && (
            <div className="flex items-center justify-between rounded-2xl border border-zinc-800 bg-zinc-900/50 px-4 py-3">
              <div><p className="text-sm font-semibold text-white">Your available balance</p><p className="text-xs text-zinc-500">Always shown before a paid action.</p></div>
              <CreditBalance overview={state.overview} compact />
            </div>
          )}
          <PlanSummary overview={state.overview} />
          <PlanCatalog overview={state.overview} />
          <LockedPremiumCard action={getAction(state.overview, 'premium_content')} />
          <p className="text-center text-[11px] text-zinc-600">Preview only — no subscription, payment, entitlement, or Credit spend can be created here.</p>
        </>
      )}

      <Link to="/characters" className="text-center text-sm text-zinc-400 transition-colors hover:text-zinc-200">
        ← Back to Discover
      </Link>
    </PageContainer>
  );
}
