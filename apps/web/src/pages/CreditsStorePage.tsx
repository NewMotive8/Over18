import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { creditsNeededFor, type PaymentMethod } from '@over18/shared';
import PaymentMethodSheet from '../components/PaymentMethodSheet';
import { EconomyStateNotice } from '../components/CustomerEconomy';
import {
  BackLink,
  BalanceLine,
  CreditUses,
  NoPacks,
  PackCard,
  PremiumAnchor,
  PurchaseCta,
  PurchaseResult,
  StickyPurchaseBar,
  StoreHero,
  TrustRow,
  type HeroMedia,
  type PurchaseOutcome,
} from '../components/credits/CreditsStoreParts';
import { charactersApi, paymentsApi } from '../lib/api';
import { accessFor, useContentAccess } from '../lib/contentAccess';
import {
  announceCreditsChanged,
  balanceState,
  credits,
  creditsStoreHref,
  heroCharacterId,
  packSavings,
  packThatUnlocks,
  packView,
  pendingPayment,
  premiumAnchor,
  purchasablePacks,
  readStoreContext,
  recommendedPack,
  returnOutcome,
  returnTarget,
  storeHeroCopy,
} from '../lib/creditsStore';
import { commercialTier, spendableCredits, useCustomerEconomy } from '../lib/customerEconomy';
import { absoluteMediaUrl } from '../lib/media';
import { useHeaderRotation } from '../lib/headerRotation';
import { track, useTrackView } from '../lib/analytics';
import { usePackCheckout } from '../lib/payments';

/**
 * THE CREDITS STORE (`/credits`, Credits Store PR 2 + the store-conversion PR).
 *
 * Built to sell in one glance: who it is for (a character-aware hero, or the
 * exact post being unlocked and how many Credits it still needs), how many
 * Credits you have (one line), one recommended pack already selected, and one
 * button that says what you get and what it costs.
 *
 * EVERY COMMERCIAL VALUE IS THE SERVER'S. Packs, prices, bonuses, badges and
 * promotions come from `GET /api/economy/catalog`; the balance and Premium from
 * `GET /api/me/commercial-state`; an unlock's price from the content-access
 * resolver. The page only CHOOSES and WORDS: which pack to recommend (the
 * shared rule the server also applies), how much cheaper per Credit a bigger
 * pack is, what the hero says. Buying starts the existing checkout with the
 * pack's CODE -- never a price -- and the server charges what it charges.
 *
 * ONLY THE PROVIDER CONFIRMS A PURCHASE. Coming back from the checkout, the
 * page reads the payment from the server and shows what it says.
 *
 * BACK TO WHERE THEY WERE. The purchase context travels with the payment, and
 * the way back -- including the automatic unlock -- is unchanged from PR 2.
 */
export default function CreditsStorePage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const [economy, refreshEconomy] = useCustomerEconomy();
  const checkout = usePackCheckout();
  /** The pack the customer picked; null means the recommended one. */
  const [picked, setPicked] = useState<string | null>(null);
  const [paying, setPaying] = useState(false);

  const context = useMemo(() => readStoreContext(params), [params]);
  const returningFromCheckout = params.get('from') === 'checkout';
  const overview = economy.status === 'ready' ? economy.overview : null;
  const tier = commercialTier(overview);
  const premium = tier === 'premium';
  const now = useNow(overview);
  // The balance shown is the one the server reports now.
  const balanceNow = spendableCredits(overview);

  // Arriving to unlock a post: its price is the content-access resolver's.
  const unlockAssetId = context?.originAction === 'content_unlock' ? context.assetId : null;
  const [access] = useContentAccess(unlockAssetId ? [unlockAssetId] : []);
  const unlockItem = unlockAssetId ? accessFor(access, unlockAssetId) : null;
  const creditsNeeded =
    unlockItem && NEEDS_CREDITS.has(unlockItem.decision) ? creditsNeededFor(unlockItem.creditPrice, balanceNow) : null;

  const hero = useHero(context, unlockAssetId);
  const rotation = useHeaderRotation();
  const heroCopy = storeHeroCopy({
    characterName: hero.name,
    unlock: unlockAssetId ? { mediaType: hero.unlockMediaType, creditsNeeded } : null,
  });

  const ladder = useMemo(() => {
    const purchasable = purchasablePacks(overview?.catalog);
    const recommended = recommendedPack(purchasable, creditsNeeded);
    const views = purchasable.map((pack) => packView(pack, now, recommended));
    // The recommended pack leads; the rest keep the catalog's ladder order.
    const ordered = [...views.filter((v) => v.recommended), ...views.filter((v) => !v.recommended)];
    return { views: ordered, savings: packSavings(views), unlocks: packThatUnlocks(purchasable, creditsNeeded) };
  }, [overview, now, creditsNeeded]);
  const selected = ladder.views.find((v) => v.code === picked) ?? ladder.views[0] ?? null;

  const outcome = usePurchaseOutcome(returningFromCheckout ? params.get('payment') : null, returningFromCheckout, refreshEconomy);

  // Funnel B/C (PR 3): the store seen once its packs are known -- not on the
  // return from a checkout. Tier, balance state and the recommended pack are
  // stated by the server, not sent from here.
  useTrackView(
    'credit_purchase_viewed',
    { ...(context ?? {}), packCount: ladder.views.length },
    overview !== null && !returningFromCheckout,
  );

  const buy = async (method: PaymentMethod) => {
    if (!selected) return;
    const started = await checkout.start(selected.code, method, context);
    if (!started?.redirectUrl) return;
    pendingPayment.set(started.payment.id);
    setPaying(false);
    // The provider decides where to pay. The simulated one is this app; a real
    // one is another site, reached by a full navigation.
    const url = new URL(started.redirectUrl, window.location.origin);
    if (url.origin === window.location.origin) navigate(`${url.pathname}${url.search}`);
    else window.location.assign(url.toString());
  };
  const openSheet = () => {
    if (!selected) return;
    checkout.reset();
    setPaying(true);
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
  const shopping = overview !== null && !returningFromCheckout && ladder.views.length > 0;
  const busy = checkout.state.status === 'starting';

  const content = (
    <div className={`flex flex-col gap-4 ${shopping ? 'pb-28 lg:pb-0' : ''}`}>
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
        backTo && <BackLink to={backTo} label="Back" />
      )}

      <EconomyStateNotice state={economy} retry={refreshEconomy} />
      {overview && (
        <>
          <BalanceLine balance={balanceState(balanceNow)} premium={premium} />
          {!returningFromCheckout && (
            <section aria-labelledby="store-packs" className="flex flex-col gap-3">
              <div className="flex items-baseline justify-between">
                <h2 id="store-packs" className="text-base font-semibold text-white">
                  Choose your Credits
                </h2>
                <span className="text-xs text-zinc-500">One-time · no renewal</span>
              </div>
              {ladder.views.length === 0 ? (
                <NoPacks />
              ) : (
                <div data-testid="store-packs" className="grid grid-cols-2 gap-3">
                  {ladder.views.map((view) => (
                    <PackCard
                      key={view.code}
                      view={view}
                      selected={view.code === selected?.code}
                      savingPercent={ladder.savings.get(view.code) ?? null}
                      unlocksThis={view.code === ladder.unlocks}
                      disabled={busy}
                      onSelect={() => setPicked(view.code)}
                    />
                  ))}
                </div>
              )}
              <PurchaseCta view={selected} onBuy={openSheet} busy={busy} />
              <TrustRow />
            </section>
          )}
          {/* Premium as a value anchor, for someone known not to have it -- secondary, under the packs. */}
          {!returningFromCheckout && <PremiumAnchor anchor={premiumAnchor(overview.catalog.plans, tier)} />}
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
          <StoreHero media={hero} copy={heroCopy} rotation={rotation} />
        </div>
        <div className="px-4 pt-4 lg:px-0 lg:pt-0">{content}</div>
      </div>

      {/* The phone's purchase bar steps aside while the payment sheet is open. */}
      {shopping && !paying && <StickyPurchaseBar view={selected} onBuy={openSheet} busy={busy} />}

      {paying && selected && (
        <PaymentMethodSheet
          planName={credits(selected.totalCredits)}
          price={`${selected.price} · one-time${selected.bonusCredits > 0 ? ` · includes ${credits(selected.bonusCredits)} free` : ''}`}
          busy={busy}
          error={checkout.state.status === 'failed' ? checkout.state.message : null}
          onChoose={(method) => void buy(method)}
          onCancel={() => {
            track('paywall_dismissed', { surface: 'credits_store', packCode: selected.code });
            setPaying(false);
            checkout.reset();
          }}
        />
      )}
    </div>
  );
}

/** Content-access decisions under which an unlock still needs Credits. */
const NEEDS_CREDITS = new Set(['credits_required', 'insufficient_credits']);

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

/**
 * The character the store opens on: where they came from, else who they last
 * chatted with, else the default. Arriving to unlock one of her posts, it also
 * learns whether that post is a video or a photo -- for the WORDS only; the
 * post itself is never shown here, only her own (non-nude) hero image.
 */
function useHero(context: ReturnType<typeof readStoreContext>, unlockAssetId: string | null): HeroMedia & { unlockMediaType: 'image' | 'video' | null } {
  const [hero, setHero] = useState<HeroMedia>({ imageUrl: null, name: null });
  const [unlockMediaType, setUnlockMediaType] = useState<'image' | 'video' | null>(null);
  const id = heroCharacterId(context, null);
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
  useEffect(() => {
    if (!id || !unlockAssetId) return;
    let cancelled = false;
    charactersApi
      .clips(id)
      .then(({ clips }) => {
        if (!cancelled) setUnlockMediaType(clips.find((clip) => clip.id === unlockAssetId)?.mediaType ?? null);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [id, unlockAssetId]);
  return { ...hero, unlockMediaType };
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
