import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import type { PaymentMethod } from '@over18/shared';
import PaymentMethodSheet from '../PaymentMethodSheet';
import { EconomyStateNotice, premiumBenefitFacts } from '../CustomerEconomy';
import { DEFAULT_HERO } from '../credits/CreditsStoreParts';
import RotatingHeaderClip from '../RotatingHeaderClip';
import type { PublicClip } from '../../lib/api';
import { useHeaderRotation } from '../../lib/headerRotation';
import { CrownIcon, PhoneIcon, SparkleIcon } from '../icons';
import { track } from '../../lib/analytics';
import {
  bestValuePlan,
  commercialTier,
  formatMoneyMinor,
  formatPlanPrice,
  monthlyEquivalentMinor,
  offeredPlans,
  savingsPercent,
  useCustomerEconomy,
  type CustomerEconomyOverview,
} from '../../lib/customerEconomy';
import type { CustomerPlanOffer } from '@over18/shared';
import { useCheckout } from '../../lib/payments';
import { FREE_CHARACTER_LIMIT, type GateSurface } from '../../lib/premiumGate';

/**
 * THE PREMIUM FEED FUNNEL -- two steps, one place.
 *
 *   Step 1  "This feed is for Premium eyes only": a deliberate, inviting moment
 *           over the (blurred, inert) feed, with one primary action.
 *   Step 2  The Premium OFFER, right here: a visual header, the real benefits,
 *           the catalog's plans as offer cards with the best value chosen,
 *           and one CTA -- then the SAME payment-method sheet and the SAME
 *           `useCheckout` the Premium page uses. No `/subscription` detour, and no
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
      <span className="inline-flex items-center gap-1.5 rounded-full bg-rose-600 px-3 py-1 text-xs font-bold uppercase tracking-wider text-white shadow-lg shadow-rose-950/50">
        <CrownIcon aria-hidden className="h-3.5 w-3.5" /> Premium only
      </span>
      <h2 id="premium-funnel-title" className="text-[2rem] font-black uppercase leading-[1.02] tracking-tight text-white drop-shadow">
        This feed is for{' '}
        <span className="text-rose-500">Premium</span> eyes only
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
        className="mt-1 flex min-h-14 w-full max-w-xs items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-rose-600 to-pink-600 px-6 text-base font-bold uppercase tracking-wide text-white shadow-[0_6px_20px_rgba(225,29,72,0.4)] transition-transform active:scale-[0.98]"
      >
        <CrownIcon aria-hidden className="h-4 w-4" /> Unlock Premium Now
      </button>
      <button type="button" onClick={onClose} className="min-h-11 px-4 text-sm font-medium text-zinc-400 hover:text-white">
        Not now
      </button>
    </div>
  );
}

/** "1 month", "3 months", "12 months" -- how long a plan runs, said plainly. */
function periodLabel(months: number): string {
  return `${months} ${months === 1 ? 'month' : 'months'}`;
}

/** One plan as an offer card: the price per month big, what is billed small. */
function OfferCard({
  plan,
  selected,
  best,
  saving,
  onSelect,
}: {
  plan: CustomerPlanOffer;
  selected: boolean;
  best: boolean;
  saving: number | null;
  onSelect: () => void;
}) {
  const perMonthMinor = monthlyEquivalentMinor(plan);
  const perMonth = perMonthMinor === null ? null : formatMoneyMinor(perMonthMinor, plan.currency);
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      data-testid={`offer-${plan.code}`}
      data-best={best || undefined}
      aria-label={`${periodLabel(plan.billingPeriodMonths)}, ${formatPlanPrice(plan)}${best ? ', best value' : ''}`}
      className={`relative flex flex-col items-center rounded-2xl p-[1.5px] text-center transition-transform active:scale-[0.98] ${
        selected
          ? 'bg-gradient-to-br from-rose-400 via-amber-400 to-pink-600 shadow-[0_6px_20px_rgba(225,29,72,0.4)]'
          : 'bg-zinc-800'
      } ${best ? 'mt-0' : 'mt-3'}`}
    >
      {best && (
        <span data-testid="offer-best" className="absolute -top-3 left-1/2 z-10 -translate-x-1/2 whitespace-nowrap rounded-full bg-gradient-to-r from-amber-300 to-amber-500 px-2.5 py-0.5 text-[10px] font-black uppercase tracking-wider text-zinc-950 shadow">
          Best value
        </span>
      )}
      <span className={`flex h-full w-full flex-col items-center gap-1 rounded-[calc(1rem-1.5px)] px-2 pb-3 ${best ? 'pt-5' : 'pt-3'} ${selected ? 'bg-zinc-950/85' : 'bg-zinc-900'}`}>
        <span className="text-xs font-semibold text-zinc-300">{periodLabel(plan.billingPeriodMonths)}</span>
        {perMonth && (
          <span className="flex flex-col items-center leading-none">
            <span className="text-xl font-black tracking-tight text-white tabular-nums">{perMonth}</span>
            <span className="mt-0.5 text-[11px] text-zinc-400">per month</span>
          </span>
        )}
        <span className={`mt-1 min-h-[1.25rem] rounded-full px-2 py-0.5 text-[11px] font-bold ${saving !== null ? 'bg-emerald-400/15 text-emerald-300' : 'invisible'}`}>
          Save {saving ?? 0}%
        </span>
        <span className="text-[10px] leading-tight text-zinc-500">{formatPlanPrice(plan)}</span>
      </span>
    </button>
  );
}

/**
 * Step 2: the Premium OFFER -- a continuation of Step 1, not a settings page.
 *
 * Presentation made for the funnel; the facts are the existing ones: plans and
 * prices from the catalog (`offeredPlans`), the recommendation from
 * `bestValuePlan`, savings from `savingsPercent`, per-month prices from
 * `monthlyEquivalentMinor`, and the benefits from `premiumBenefitFacts` -- the
 * same selectors the Premium page's `PlanCatalog` uses. Choosing continues into
 * the existing payment-method sheet and checkout (see `PremiumFunnel`).
 */
export function FunnelPlans({
  state,
  onBack,
  onClose,
  onChoose,
  rotation = [],
}: {
  state: ReturnType<typeof useCustomerEconomy>[0];
  /** The session's six rotating characters; the poster stands in until they arrive. */
  rotation?: readonly PublicClip[];
  onBack: () => void;
  onClose: () => void;
  onChoose: (planCode: string) => void;
}) {
  const overview = state.status === 'ready' ? state.overview : null;
  const plans = overview ? [...offeredPlans(overview)].sort((a, b) => a.billingPeriodMonths - b.billingPeriodMonths) : [];
  const best = bestValuePlan(plans);
  const [picked, setPicked] = useState<string | null>(null);
  const selected = plans.find((p) => p.code === picked) ?? best ?? plans[0] ?? null;
  const facts = overview ? premiumBenefitFacts(overview) : null;
  const premium = overview ? commercialTier(overview) === 'premium' : false;

  return (
    <div
      data-testid="premium-funnel-plans"
      className="flex max-h-[94dvh] w-full max-w-lg flex-col overflow-hidden rounded-t-3xl border border-rose-500/20 bg-zinc-950 shadow-2xl sm:rounded-3xl"
    >
      <div className="overflow-y-auto">
        {/* The visual: OVER18's own non-nude hero, in Premium colours. */}
        <div className="relative h-64 overflow-hidden sm:h-72">
          <RotatingHeaderClip
            clips={rotation}
            className="absolute inset-0 h-full w-full object-cover object-top"
            fallback={<img src={DEFAULT_HERO.poster} alt="" aria-hidden className="absolute inset-0 h-full w-full object-cover object-top" />}
          />
          <div aria-hidden className="absolute inset-0 bg-gradient-to-b from-zinc-950/40 via-transparent via-40% to-zinc-950" />
          <div className="absolute inset-x-0 top-0 flex items-center justify-between p-3">
            <button
              type="button"
              onClick={onBack}
              data-testid="premium-funnel-back"
              aria-label="Back"
              className="flex h-9 w-9 items-center justify-center rounded-full bg-black/45 text-xl text-white backdrop-blur hover:bg-black/60"
            >
              ‹
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="flex h-9 w-9 items-center justify-center rounded-full bg-black/45 text-lg text-white backdrop-blur hover:bg-black/60"
            >
              ×
            </button>
          </div>
          <div className="absolute inset-x-0 bottom-0 px-5 pb-3">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-rose-600 px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wider text-white shadow-lg shadow-rose-950/50">
              <CrownIcon aria-hidden className="h-3 w-3" /> Premium
            </span>
            <h2 id="premium-funnel-title" className="mt-1.5 text-[1.75rem] font-black uppercase leading-[1.02] tracking-tight text-white drop-shadow">
              Unlock{' '}
              <span className="text-rose-500">everything</span>
            </h2>
          </div>
        </div>

        <div className="flex flex-col gap-4 px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-2">
          {state.status !== 'ready' ? (
            <EconomyStateNotice state={state} />
          ) : (
            <>
              <p className="text-sm leading-relaxed text-zinc-300">Every companion, every Premium post and conversations without limits.</p>

              {facts && (
                <ul data-testid="premium-offer-benefits" className="flex flex-col gap-2">
                  {facts.map((fact) => (
                    <li key={fact.key} className="flex items-center gap-2.5 text-sm font-medium text-white">
                      <span aria-hidden className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-400/20 text-xs font-black text-emerald-300">
                        ✓
                      </span>
                      {fact.text}
                    </li>
                  ))}
                </ul>
              )}

              {plans.length === 0 ? (
                <p className="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-4 text-center text-sm text-zinc-400">No plans are offered right now.</p>
              ) : premium ? (
                <p data-testid="already-premium" className="rounded-xl border border-emerald-500/20 bg-emerald-500/10 px-4 py-3 text-center text-sm text-emerald-100">
                  You&rsquo;re on Premium &mdash; there&rsquo;s nothing to buy here.
                </p>
              ) : (
                <>
                  <div
                    role="radiogroup"
                    aria-label="Choose a plan"
                    className="grid items-end gap-2 pt-1"
                    // One column per plan (up to three), so one or two plans never sit in an empty row.
                    style={{ gridTemplateColumns: `repeat(${Math.min(plans.length, 3)}, minmax(0, 1fr))` }}
                  >
                    {plans.map((plan) => (
                      <OfferCard
                        key={plan.code}
                        plan={plan}
                        selected={plan.code === selected?.code}
                        best={plan.code === best?.code && plans.length > 1}
                        saving={savingsPercent(plans, plan)}
                        onSelect={() => setPicked(plan.code)}
                      />
                    ))}
                  </div>
                  {selected && (
                    <button
                      type="button"
                      onClick={() => onChoose(selected.code)}
                      data-testid="premium-offer-continue"
                      className="flex min-h-14 w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-rose-600 to-pink-600 px-5 text-base font-bold text-white shadow-[0_6px_20px_rgba(225,29,72,0.4)] transition-transform active:scale-[0.98]"
                    >
                      <CrownIcon aria-hidden className="h-4 w-4" />
                      Continue · {periodLabel(selected.billingPeriodMonths)} for {formatPlanPrice(selected).split(' / ')[0]}
                    </button>
                  )}
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Where the funnel was opened from, for analytics. The feed gates use their own
 * surface; a character's profile reports as "premium_gate", the name that
 * button's events have always carried (it used to open the old placeholder
 * sheet), so its history stays one series.
 */
export type FunnelSurface = GateSurface | 'premium_gate';

export default function PremiumFunnel({
  open,
  surface,
  onClose,
  startAt = 'intro',
}: {
  open: boolean;
  surface: FunnelSurface;
  onClose: () => void;
  /**
   * "plans" opens straight on the offer (Step 2) and Back then closes: Step 1
   * speaks to the feed allowance ("you've met your free companions"), which is
   * only true where the feed gate opened it.
   */
  startAt?: 'intro' | 'plans';
}) {
  const [step, setStep] = useState<'intro' | 'plans'>(startAt);
  const [chosen, setChosen] = useState<string | null>(null);
  const [economy] = useCustomerEconomy();
  const checkout = useCheckout();
  const navigate = useNavigate();
  // Fetched on first opening only, then kept for the session.
  const rotation = useHeaderRotation(open);
  const overview = economy.status === 'ready' ? economy.overview : null;
  const plan = overview && chosen ? offeredPlans(overview).find((p) => p.code === chosen) ?? null : null;

  // Every opening starts at its first step, and is reported once.
  useEffect(() => {
    if (!open) return;
    setStep(startAt);
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
      if (step === 'plans' && startAt === 'intro') setStep('intro');
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
          rotation={rotation}
          onBack={() => (startAt === 'plans' ? close() : setStep('intro'))}
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
