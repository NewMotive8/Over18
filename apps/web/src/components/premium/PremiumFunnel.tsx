import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import type { PaymentMethod } from '@over18/shared';
import PaymentMethodSheet from '../PaymentMethodSheet';
import { EconomyStateNotice, PlanCatalog, premiumBenefitFacts } from '../CustomerEconomy';
import { CrownIcon, PhoneIcon, SparkleIcon } from '../icons';
import { track } from '../../lib/analytics';
import { formatPlanPrice, offeredPlans, useCustomerEconomy, type CustomerEconomyOverview } from '../../lib/customerEconomy';
import { useCheckout } from '../../lib/payments';
import { FREE_CHARACTER_LIMIT, type GateSurface } from '../../lib/premiumGate';

/**
 * THE PREMIUM FEED FUNNEL -- two steps, one place.
 *
 *   Step 1  "This feed is for Premium eyes only": a deliberate, inviting moment
 *           over the (blurred, inert) feed, with one primary action.
 *   Step 2  The plans, right here -- the SAME `PlanCatalog` the Premium page
 *           renders -- then the SAME payment-method sheet and the SAME
 *           `useCheckout` that page uses. No `/subscription` detour, and no
 *           second checkout: this is one more entry point into the existing one.
 *
 * Back from Step 2 returns to Step 1; closing returns to the feed exactly as it
 * was. Prices, plans and "best value" are the catalog's; nothing is invented --
 * no countdowns, no "people watching", no discount that is not the server's.
 */

const ICON = {
  chat: <PhoneIcon className="h-4 w-4" />,
  content: <CrownIcon className="h-4 w-4" />,
  credits: <SparkleIcon className="h-4 w-4" />,
  spend: <SparkleIcon className="h-4 w-4" />,
} as const;

/** Step 1, as a pure piece (rendered statically in tests). */
export function FunnelIntro({
  overview,
  onUnlock,
  onClose,
}: {
  overview: CustomerEconomyOverview | null;
  onUnlock: () => void;
  onClose: () => void;
}) {
  const unlockRef = useRef<HTMLButtonElement>(null);
  useEffect(() => unlockRef.current?.focus(), []);
  const facts = overview ? premiumBenefitFacts(overview) : null;
  return (
    <div data-testid="premium-funnel-intro" className="flex w-full max-w-md flex-col items-center gap-5 px-6 text-center">
      <span className="inline-flex items-center gap-1.5 rounded-full bg-gradient-to-r from-rose-500 to-fuchsia-600 px-3 py-1 text-xs font-bold uppercase tracking-wider text-white shadow-lg shadow-rose-950/50">
        <CrownIcon aria-hidden className="h-3.5 w-3.5" /> Premium only
      </span>
      <h2 id="premium-funnel-title" className="text-[2rem] font-black uppercase leading-[1.02] tracking-tight text-white drop-shadow">
        This feed is for{' '}
        <span className="bg-gradient-to-r from-rose-400 via-pink-400 to-fuchsia-400 bg-clip-text text-transparent">Premium</span> eyes only
      </h2>
      <p className="max-w-xs text-sm leading-relaxed text-zinc-200">
        You&rsquo;ve met your {FREE_CHARACTER_LIMIT} free companions. Go Premium to keep discovering &mdash; and keep every
        conversation going.
      </p>
      {facts && (
        <ul data-testid="premium-funnel-benefits" className="flex w-full max-w-xs flex-col gap-2.5 text-left">
          {facts.map((fact) => (
            <li key={fact.key} className="flex items-center gap-3 text-sm font-medium text-white">
              <span aria-hidden className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-rose-500/20 text-rose-200">
                {ICON[fact.key]}
              </span>
              {fact.text}
            </li>
          ))}
        </ul>
      )}
      <button
        ref={unlockRef}
        type="button"
        onClick={onUnlock}
        data-testid="premium-funnel-unlock"
        className="mt-1 flex min-h-14 w-full max-w-xs items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-rose-500 to-fuchsia-600 px-6 text-base font-bold uppercase tracking-wide text-white shadow-[0_10px_30px_rgba(225,29,72,0.45)] transition-transform active:scale-[0.98]"
      >
        <CrownIcon aria-hidden className="h-4 w-4" /> Unlock Premium Now
      </button>
      <button type="button" onClick={onClose} className="min-h-11 px-4 text-sm font-medium text-zinc-400 hover:text-white">
        Not now
      </button>
    </div>
  );
}

/** Step 2: the existing plan selector, in a sheet, with a way back to Step 1. */
export function FunnelPlans({
  state,
  onBack,
  onClose,
  onChoose,
}: {
  state: ReturnType<typeof useCustomerEconomy>[0];
  onBack: () => void;
  onClose: () => void;
  onChoose: (planCode: string) => void;
}) {
  return (
    <div
      data-testid="premium-funnel-plans"
      className="flex max-h-[92dvh] w-full max-w-lg flex-col gap-4 overflow-y-auto rounded-t-3xl border border-zinc-800 bg-zinc-950 p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] shadow-2xl sm:rounded-3xl"
    >
      <div className="flex items-center justify-between gap-3">
        <button type="button" onClick={onBack} data-testid="premium-funnel-back" className="flex min-h-11 items-center gap-1 pr-3 text-sm font-medium text-zinc-300 hover:text-white">
          <span aria-hidden>‹</span> Back
        </button>
        <button type="button" onClick={onClose} aria-label="Close" className="flex h-9 w-9 items-center justify-center rounded-full bg-zinc-900 text-lg text-zinc-300 hover:text-white">
          ×
        </button>
      </div>
      <div>
        <p className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-rose-400">
          <CrownIcon aria-hidden className="h-3.5 w-3.5" /> Premium
        </p>
        <h2 id="premium-funnel-title" className="mt-1 text-2xl font-bold tracking-tight text-white">
          Choose your plan
        </h2>
      </div>
      {state.status === 'ready' ? <PlanCatalog overview={state.overview} onBuy={onChoose} /> : <EconomyStateNotice state={state} />}
    </div>
  );
}

export default function PremiumFunnel({ open, surface, onClose }: { open: boolean; surface: GateSurface; onClose: () => void }) {
  const [step, setStep] = useState<'intro' | 'plans'>('intro');
  const [chosen, setChosen] = useState<string | null>(null);
  const [economy] = useCustomerEconomy();
  const checkout = useCheckout();
  const navigate = useNavigate();
  const overview = economy.status === 'ready' ? economy.overview : null;
  const plan = overview && chosen ? offeredPlans(overview).find((p) => p.code === chosen) ?? null : null;

  // Every opening starts at Step 1, and is reported once.
  useEffect(() => {
    if (!open) return;
    setStep('intro');
    setChosen(null);
    checkout.reset();
    track('paywall_viewed', { surface });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, surface]);

  const close = () => {
    track('paywall_dismissed', { surface });
    onClose();
  };

  // Escape steps back, then closes -- unless the payment sheet is handling it.
  useEffect(() => {
    if (!open || chosen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (step === 'plans') setStep('intro');
      else close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const buy = async (method: PaymentMethod) => {
    if (!plan) return;
    const started = await checkout.start(plan.code, method);
    if (!started?.redirectUrl) return;
    // The provider decides where to pay, exactly as on the Premium page.
    const url = new URL(started.redirectUrl, window.location.origin);
    if (url.origin === window.location.origin) navigate(`${url.pathname}${url.search}`);
    else window.location.assign(url.toString());
  };

  if (!open || typeof document === 'undefined') return null;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="premium-funnel-title"
      data-testid="premium-funnel"
      data-step={step}
      className={`fixed inset-0 z-40 flex justify-center overscroll-contain bg-zinc-950/70 backdrop-blur-xl ${step === 'intro' ? 'items-center' : 'items-end sm:items-center sm:p-4'}`}
    >
      {step === 'intro' ? (
        <FunnelIntro overview={overview} onUnlock={() => setStep('plans')} onClose={close} />
      ) : (
        <FunnelPlans
          state={economy}
          onBack={() => setStep('intro')}
          onClose={close}
          onChoose={(code) => {
            track('subscription_cta_clicked', { surface, planCode: code });
            checkout.reset();
            setChosen(code);
          }}
        />
      )}

      {plan && (
        <PaymentMethodSheet
          planName={plan.displayName}
          price={formatPlanPrice(plan)}
          busy={checkout.state.status === 'starting'}
          error={checkout.state.status === 'failed' ? checkout.state.message : null}
          onChoose={(method) => void buy(method)}
          onCancel={() => {
            track('paywall_dismissed', { surface, planCode: plan.code });
            setChosen(null);
            checkout.reset();
          }}
        />
      )}
    </div>,
    document.body,
  );
}
