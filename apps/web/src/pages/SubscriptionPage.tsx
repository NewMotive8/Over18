import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import type { PaymentMethod } from '@over18/shared';
import PageContainer from '../components/PageContainer';
import PageHeader from '../components/PageHeader';
import PaymentMethodSheet from '../components/PaymentMethodSheet';
import { CreditBalance, EconomyStateNotice, LockedPremiumCard, PlanCatalog, PlanSummary } from '../components/CustomerEconomy';
import { formatPlanPrice, getAction, getCurrentPlan, offeredPlans, spendableCredits, useCustomerEconomy } from '../lib/customerEconomy';
import { useCheckout } from '../lib/payments';

/**
 * Subscription (US-18, P9.1) -- plans, access, and buying Premium.
 *
 * WHAT THE SERVER SAYS, AND ONLY THAT. The plan, the balance and the
 * subscription period are read from the customer's commercial state; nothing on
 * this page decides any of them. Buying starts a checkout and sends the
 * customer to the provider -- while the processor is undecided (P9.D1) that is
 * a clearly marked TEST screen -- and the result is whatever the server reports
 * afterwards, never what this page hoped for.
 */
export default function SubscriptionPage() {
  const [state, retry] = useCustomerEconomy();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const checkout = useCheckout();
  const [chosen, setChosen] = useState<string | null>(null);

  const overview = state.status === 'ready' ? state.overview : null;
  const plan = overview ? offeredPlans(overview).find((p) => p.code === chosen) ?? null : null;
  const current = overview ? getCurrentPlan(overview) : null;
  const subscription = overview?.commercial?.subscription;
  const premium = overview?.commercial?.tier?.available && overview.commercial.tier.value === 'premium';
  /** Set when the customer has just come back from a checkout. */
  const returned = params.get('from') === 'checkout';

  const buy = async (method: PaymentMethod) => {
    if (!plan) return;
    const started = await checkout.start(plan.code, method);
    if (!started?.redirectUrl) return;
    setChosen(null);
    // The provider decides where to send them. Same origin while it is the
    // simulated one, so this stays an in-app navigation.
    const url = new URL(started.redirectUrl);
    navigate(`${url.pathname}${url.search}`);
  };

  return (
    <PageContainer>
      <PageHeader eyebrow="Plans & access" title="Choose your experience" subtitle="Compare your current plan, Credits, and Premium access." />
      <EconomyStateNotice state={state} retry={retry} />

      {overview && (
        <>
          {returned && (
            <div
              role="status"
              data-testid="checkout-result"
              className={`rounded-2xl border px-4 py-3 ${premium ? 'border-emerald-500/30 bg-emerald-500/10' : 'border-zinc-700 bg-zinc-900/60'}`}
            >
              {premium ? (
                <>
                  <p className="text-sm font-semibold text-emerald-100">Premium is active.</p>
                  <p className="mt-1 text-xs text-emerald-100/80">
                    {current ? `${current.displayName} · ` : ''}
                    {subscription?.available && subscription.value
                      ? `renews ${new Date(subscription.value.currentPeriodEnd).toLocaleDateString()}`
                      : 'Your period is shown below.'}
                  </p>
                </>
              ) : (
                <p className="text-sm text-zinc-300">
                  No payment was completed, so nothing changed. You can try again whenever you like.
                </p>
              )}
            </div>
          )}

          {spendableCredits(overview) !== null && (
            <div className="flex items-center justify-between rounded-2xl border border-zinc-800 bg-zinc-900/50 px-4 py-3">
              <div>
                <p className="text-sm font-semibold text-white">Your available balance</p>
                <p className="text-xs text-zinc-500">Always shown before a paid action.</p>
              </div>
              <CreditBalance overview={overview} compact />
            </div>
          )}

          <PlanSummary overview={overview} />

          {/* Premium status and period, as the server states them. */}
          {premium && subscription?.available && subscription.value && (
            <div data-testid="premium-status" className="rounded-2xl border border-zinc-800 bg-zinc-900/50 px-4 py-3 text-sm">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-zinc-400">Status</span>
                <span className="font-semibold text-emerald-200">{subscription.value.status}</span>
              </div>
              <div className="mt-1 flex items-baseline justify-between gap-3">
                <span className="text-zinc-400">Current period ends</span>
                <span className="font-semibold text-zinc-100">{new Date(subscription.value.currentPeriodEnd).toLocaleDateString()}</span>
              </div>
            </div>
          )}

          <PlanCatalog overview={overview} onBuy={premium ? undefined : (code) => setChosen(code)} />
          <LockedPremiumCard action={getAction(overview, 'premium_content')} />

          <p className="text-center text-[11px] text-zinc-600">
            Payments are simulated while the provider is being selected. No card is collected and no money moves.
          </p>
        </>
      )}

      {plan && (
        <PaymentMethodSheet
          planName={plan.displayName}
          price={formatPlanPrice(plan)}
          busy={checkout.state.status === 'starting'}
          error={checkout.state.status === 'failed' ? checkout.state.message : null}
          onChoose={(method) => void buy(method)}
          onCancel={() => {
            setChosen(null);
            checkout.reset();
          }}
        />
      )}

      <Link to="/characters" className="text-center text-sm text-zinc-400 transition-colors hover:text-zinc-200">
        ← Back to Discover
      </Link>
    </PageContainer>
  );
}
