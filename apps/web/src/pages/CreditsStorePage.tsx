import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import type { PaymentMethod } from '@over18/shared';
import PaymentMethodSheet from '../components/PaymentMethodSheet';
import { EconomyStateNotice } from '../components/CustomerEconomy';
import {
  BackLink,
  BalanceCard,
  ContextNotice,
  CreditUses,
  NoPacks,
  PackCard,
  PremiumNote,
  PurchaseResult,
  StoreHero,
  type HeroMedia,
  type PurchaseOutcome,
} from '../components/credits/CreditsStoreParts';
import { charactersApi, paymentsApi } from '../lib/api';
import {
  announceCreditsChanged,
  balanceState,
  credits,
  creditsStoreHref,
  heroCharacterId,
  lastCharacter,
  packView,
  pendingPayment,
  purchasablePacks,
  readStoreContext,
  recommendedPack,
  returnOutcome,
  returnTarget,
  showPremiumNote,
} from '../lib/creditsStore';
import { commercialTier, spendableCredits, useCustomerEconomy } from '../lib/customerEconomy';
import { absoluteMediaUrl } from '../lib/media';
import { track, useTrackView } from '../lib/analytics';
import { usePackCheckout } from '../lib/payments';

/**
 * THE CREDITS STORE (`/credits`, Credits Store PR 2).
 *
 * Answers three things at a glance -- how many Credits you have, what they are
 * for, and what you can buy for how much -- and then gets out of the way.
 *
 * EVERY COMMERCIAL VALUE IS THE SERVER'S. Packs, prices, bonuses, badges and
 * promotions come from `GET /api/economy/catalog`; the balance and Premium from
 * `GET /api/me/commercial-state`. Retired packs, which the catalog includes on
 * purpose, are never offered. Buying starts the existing checkout with the
 * pack's CODE -- never a price -- and the server charges what it charges.
 *
 * ONLY THE PROVIDER CONFIRMS A PURCHASE. Coming back from the checkout, the
 * page reads the payment from the server and shows what it says; the Credits
 * appear because the server granted them, and the balance is read again.
 *
 * BACK TO WHERE THEY WERE. The purchase context (where the customer came from,
 * what they were doing) travels with the payment, and the way back is built
 * from its ids into a path of this app -- never a URL from anywhere.
 */
export default function CreditsStorePage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const [economy, refreshEconomy] = useCustomerEconomy();
  const checkout = usePackCheckout();
  const [chosen, setChosen] = useState<string | null>(null);

  const context = useMemo(() => readStoreContext(params), [params]);
  const returningFromCheckout = params.get('from') === 'checkout';
  const overview = economy.status === 'ready' ? economy.overview : null;
  const premium = commercialTier(overview) === 'premium';
  const now = useNow(overview);

  const packs = useMemo(() => {
    const purchasable = purchasablePacks(overview?.catalog);
    const recommended = recommendedPack(purchasable);
    const views = purchasable.map((pack) => packView(pack, now, recommended));
    return { featured: views.find((v) => v.recommended) ?? null, rest: views.filter((v) => !v.recommended) };
  }, [overview, now]);
  const all = packs.featured ? [packs.featured, ...packs.rest] : packs.rest;
  const selected = all.find((p) => p.code === chosen) ?? null;

  const hero = useHero(context);
  const outcome = usePurchaseOutcome(returningFromCheckout ? params.get('payment') : null, returningFromCheckout, refreshEconomy);
  // The balance shown after a purchase is the one the server reports now.
  const balanceNow = spendableCredits(overview);

  // Funnel B/C (PR 3): the store seen once its packs are known -- not on the
  // return from a checkout, which is the end of a visit rather than a new one.
  // Starting and completing a purchase are the server's to record, and the
  // tier and balance state are stated by the server, not sent from here.
  useTrackView(
    'credit_purchase_viewed',
    { ...(context ?? {}), packCount: all.length },
    overview !== null && !returningFromCheckout,
  );

  const buy = async (method: PaymentMethod) => {
    if (!selected) return;
    const started = await checkout.start(selected.code, method, context);
    if (!started?.redirectUrl) return;
    pendingPayment.set(started.payment.id);
    setChosen(null);
    // The provider decides where to pay. The simulated one is this app; a real
    // one is another site, reached by a full navigation.
    const url = new URL(started.redirectUrl, window.location.origin);
    if (url.origin === window.location.origin) navigate(`${url.pathname}${url.search}`);
    else window.location.assign(url.toString());
  };

  const dismissResult = useCallback(() => {
    pendingPayment.clear();
    setParams({}, { replace: true });
  }, [setParams]);

  const settled = outcome.kind === 'added' || outcome.kind === 'already_added';
  const resultContext = settled || outcome.kind === 'not_completed' ? outcome.payment?.context ?? null : null;
  const continueTo = settled ? returnTarget(outcome.payment.context) : null;
  const continueLabel = settled && outcome.payment.context?.originAction === 'content_unlock' ? 'Continue to unlock' : 'Continue';
  const backTo = returnTarget(context);

  const content = (
    <div className="flex flex-col gap-5">
      {returningFromCheckout ? (
        <PurchaseResult
          outcome={outcome.kind === 'added' ? { ...outcome, balance: balanceNow ?? outcome.balance } : outcome}
          continueTo={continueTo}
          continueLabel={continueLabel}
          onDismiss={() => {
            dismissResult();
            // Back into the store with the same reason for being here, if there was one.
            if (resultContext) navigate(creditsStoreHref(resultContext), { replace: true });
          }}
        />
      ) : (
        <>
          {backTo && <BackLink to={backTo} label="Back" />}
          <ContextNotice context={context} />
        </>
      )}

      <EconomyStateNotice state={economy} retry={refreshEconomy} />
      {overview && (
        <>
          <BalanceCard balance={balanceState(balanceNow)} premium={premium} />
          {!returningFromCheckout && (
            <section aria-labelledby="store-packs" className="flex flex-col gap-3">
              <div className="flex items-baseline justify-between">
                <h2 id="store-packs" className="text-base font-semibold text-white">
                  Choose your Credits
                </h2>
                <span className="text-xs text-zinc-500">One-time · no renewal</span>
              </div>
              {all.length === 0 ? (
                <NoPacks />
              ) : (
                <div data-testid="store-packs" className="grid grid-cols-2 gap-3">
                  {all.map((view) => (
                    <PackCard
                      key={view.code}
                      view={view}
                      disabled={checkout.state.status === 'starting'}
                      onSelect={() => {
                        checkout.reset();
                        setChosen(view.code);
                      }}
                    />
                  ))}
                </div>
              )}
            </section>
          )}
          {/* Premium is mentioned to someone without it, as a footnote. A subscriber never sees it. */}
          {showPremiumNote(commercialTier(overview)) && <PremiumNote />}
          <CreditUses />
          <p className="text-center text-xs text-zinc-500">One-time purchase. Credits are added as soon as your payment is confirmed.</p>
          <p
            data-testid="payment-note"
            className="rounded-xl border border-amber-500/20 bg-amber-500/5 px-4 py-3 text-center text-xs text-amber-200/90"
          >
            Payments are simulated in Staging. No card is collected and no real money moves.
          </p>
        </>
      )}
    </div>
  );

  return (
    <div data-testid="credits-store" className="-mx-4 -mt-6 lg:mx-0 lg:mt-0">
      {/* Phone: the hero opens the page, full width. Desktop: hero left, store right. */}
      <div className="lg:grid lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] lg:gap-8">
        <div className="lg:sticky lg:top-20 lg:self-start">
          <StoreHero media={hero} />
        </div>
        <div className="px-4 pt-4 lg:px-0 lg:pt-0">{content}</div>
      </div>

      {selected && (
        <PaymentMethodSheet
          planName={credits(selected.totalCredits)}
          price={`${selected.price} · one-time${selected.bonusCredits > 0 ? ` · includes ${credits(selected.bonusCredits)} bonus` : ''}`}
          busy={checkout.state.status === 'starting'}
          error={checkout.state.status === 'failed' ? checkout.state.message : null}
          onChoose={(method) => void buy(method)}
          onCancel={() => {
            track('paywall_dismissed', { surface: 'credits_store', packCode: selected.code });
            setChosen(null);
            checkout.reset();
          }}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Hooks local to the page
 * ------------------------------------------------------------------ */

/** "Now", ticking once a second only while some offer is counting down. */
function useNow(overview: { catalog: { packs: { promotionEndsAt: string | null; isPurchasable: boolean }[] } } | null): number {
  const [now, setNow] = useState(() => Date.now());
  const counting = (overview?.catalog.packs ?? []).some((p) => p.isPurchasable && p.promotionEndsAt !== null);
  useEffect(() => {
    if (!counting) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [counting]);
  return now;
}

/** The character the store opens on: where they came from, else who they last chatted with, else the default. */
function useHero(context: ReturnType<typeof readStoreContext>): HeroMedia {
  const [hero, setHero] = useState<HeroMedia>({ imageUrl: null, name: null });
  const id = heroCharacterId(context, lastCharacter.get());
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    charactersApi
      .get(id)
      .then((character) => {
        if (!cancelled) setHero({ imageUrl: absoluteMediaUrl(character.profileImage) ?? null, name: character.displayName });
      })
      // Unknown, hidden or unreachable: the default hero, never an error.
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [id]);
  return hero;
}

/**
 * What became of the pack checkout the customer is returning from -- as the
 * SERVER reports it. A payment still pending is asked about again a few times.
 *
 * "Credits added" is said only on the FIRST return from a checkout this tab
 * started (`returnOutcome`); a refresh or a later visit to the same succeeded
 * payment is told the purchase is complete, and nothing is announced as new.
 */
function usePurchaseOutcome(paymentParam: string | null, active: boolean, refreshEconomy: () => void): PurchaseOutcome {
  const [outcome, setOutcome] = useState<PurchaseOutcome>({ kind: 'checking' });
  // Which checkout this tab started -- read ONCE, before anything clears it.
  const [startedHere] = useState(() => pendingPayment.get());
  useEffect(() => {
    if (!active) return;
    const paymentId = paymentParam ?? startedHere;
    if (!paymentId) {
      setOutcome({ kind: 'not_completed', payment: null });
      return;
    }
    let cancelled = false;
    let attempts = 0;
    const look = () => {
      paymentsApi
        .read(paymentId)
        .then((payment) => {
          if (cancelled) return;
          const kind = returnOutcome(payment.status, payment.id, startedHere);
          if (kind === 'added') {
            pendingPayment.clear();
            setOutcome({ kind: 'added', payment, balance: null });
            refreshEconomy();
            announceCreditsChanged();
          } else if (kind === 'already_added') {
            setOutcome({ kind: 'already_added', payment });
          } else if (kind === 'pending' && attempts++ < 5) {
            setOutcome({ kind: 'pending', payment });
            setTimeout(look, 2000);
          } else if (kind === 'pending') {
            setOutcome({ kind: 'pending', payment });
          } else {
            if (startedHere === payment.id) pendingPayment.clear();
            setOutcome({ kind: 'not_completed', payment });
          }
        })
        .catch(() => {
          if (!cancelled) setOutcome({ kind: 'not_completed', payment: null });
        });
    };
    look();
    return () => {
      cancelled = true;
    };
  }, [paymentParam, active, refreshEconomy, startedHere]);
  return outcome;
}
