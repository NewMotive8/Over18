import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import type { PaymentMethod } from '@over18/shared';
import PageContainer from '../components/PageContainer';
import PageHeader from '../components/PageHeader';
import PaymentMethodSheet from '../components/PaymentMethodSheet';
import { CurrentPlanCard, EconomyStateNotice, PlanCatalog, PremiumBenefits } from '../components/CustomerEconomy';
import { formatPlanPrice, offeredPlans, useCustomerEconomy } from '../lib/customerEconomy';
import { useCheckout } from '../lib/payments';

/**
 * Premium (US-18, P9.1) -- what Premium is, what the customer has now, and
 * choosing a billing period.
 *
 * WHAT THE SERVER SAYS, AND ONLY THAT. The plan, the balance and the
 * subscription period are read from the customer's commercial state; nothing on
 * this page decides any of them. Buying starts a checkout and sends the
 * customer to the provider -- while the processor is undecided (P9.D1) that is
 * a clearly marked TEST screen -- and the result is whatever the server reports
 * afterwards, never what this page hoped for.
 *
 * THE ORDER IS THE ARGUMENT: what Premium is, what you have, what it costs.
 * The balance appears once here, because the brand bar already carries the
 * Credits pill on every screen; a second large balance card read as a second
 * balance. Each plan is a row rather than a card, because they are one product
 * at three billing periods, not three offers -- which is also what keeps the
 * CTA above the fold on a phone.
 */
export default function SubscriptionPage() {
  const [state, retry] = useCustomerEconomy();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const checkout = useCheckout();
  const [chosen, setChosen] = useState<string | null>(null);

  const overview = state.status === 'ready' ? state.overview : null;
  const plan = overview ? offeredPlans(overview).find((p) => p.code === chosen) ?? null : null;
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
      <PageHeader
        eyebrow="Plans & Premium"
        title="Premium"
        subtitle="Unlimited text chat, Premium content, and Credits every billing cycle."
      />
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
                <p className="text-sm font-semibold text-emerald-100">Premium is active.</p>
              ) : (
                <p className="text-sm text-zinc-300">No payment was completed, so nothing changed. You can try again whenever you like.</p>
              )}
            </div>
          )}

          <CurrentPlanCard overview={overview} />
          <PremiumBenefits overview={overview} />
          <PlanCatalog overview={overview} onBuy={(code) => setChosen(code)} />

          {/*
            The disclosure is part of the offer, not a footnote: someone about
            to press a payment button should read it without hunting for it.
          */}
          <p
            data-testid="payment-note"
            className="rounded-xl border border-amber-500/20 bg-amber-500/5 px-4 py-3 text-center text-xs text-amber-200/90"
          >
            Payments are simulated in Staging. No card is collected and no real money moves.
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
    </PageContainer>
  );
}
