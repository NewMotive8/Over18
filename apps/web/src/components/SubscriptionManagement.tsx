import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { CustomerSubscriptionDetail } from "@over18/shared";
import { subscriptionApi } from "../lib/api";
import {
  billingPeriodLabel,
  formatMoneyMinor,
  formatPlanPrice,
} from "../lib/customerEconomy";
import {
  cancelWarning,
  formatSubscriptionDate,
  periodEndLine,
  planWithdrawn,
  statusExplanation,
  statusLabel,
} from "../lib/subscriptionManagement";

/**
 * MANAGING AN EXISTING SUBSCRIPTION -- what you have, and the one thing you can
 * do about it.
 *
 * A SUBSCRIBER IS NOT SHOWN A SHOP. The plan selector answers "which billing
 * period shall I buy?", which is not a question somebody who already subscribed
 * is asking; they want the state of what they hold and a way out of it. So this
 * replaces the selector for them rather than sitting above it.
 *
 * CANCEL IS THE ONLY ACTION, because it is the only one the billing system can
 * honestly perform. There is no change-plan control: the engine's `change_plan`
 * moves no money and keeps the period end, so offering it would give away paid
 * Premium on a downgrade and a free upgrade on the way up. There is no resume
 * control either: no transition exists from cancelled back to active. Both
 * absences are deliberate and are documented in routes/customer-subscription.ts.
 *
 * EVERY VALUE IS THE SERVER'S. The plan comes from the exact version the
 * subscription names -- not the catalogue, which lists only purchasable plans
 * and would show a withdrawn plan as nothing at all -- and whether cancelling is
 * possible is `canCancel`, the same answer the change path enforces. This
 * component decides no price, no date and no permission.
 *
 * CANCELLING IS A QUIET LINK, BELOW EVERYTHING ELSE. It used to be a button
 * inside the subscription card, the most prominent control on the screen. It is
 * now a line of red text under whatever the page puts after the card (what
 * Premium includes) -- there for whoever looks for it, not offered as the thing
 * to do. `children` is that content: the card, then the children, then the
 * cancel link and its confirmation.
 *
 * SPLIT IN TWO ON PURPOSE. `SubscriptionDetailView` is pure and takes the
 * subscription as a prop, so every state of this screen can be rendered in a
 * test; the repo's web tests are static `react-dom/server` renders with no DOM,
 * and a component that could only reach its content through an effect would be
 * untestable here.
 */

export type CancelState =
  | { status: "idle" | "confirming" | "working" }
  | { status: "failed"; message: string };

type Load =
  | { status: "loading" }
  | { status: "ready"; detail: CustomerSubscriptionDetail }
  | { status: "failed"; message: string };

const FAILED_TO_LOAD = "We could not load your subscription just now.";
const FAILED_TO_CANCEL =
  "We could not cancel just now, so nothing changed. Please try again.";
const SHELL =
  "flex flex-col gap-4 rounded-2xl border border-zinc-800 bg-zinc-900/40 px-4 py-4";

export default function SubscriptionManagement({
  children,
}: {
  children?: ReactNode;
}) {
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [cancelling, setCancelling] = useState<CancelState>({ status: "idle" });

  useEffect(() => {
    let abandoned = false;
    subscriptionApi
      .detail()
      .then(({ subscription }) => {
        if (abandoned) return;
        setLoad(
          subscription
            ? { status: "ready", detail: subscription }
            : { status: "failed", message: FAILED_TO_LOAD },
        );
      })
      .catch(() => {
        if (!abandoned) setLoad({ status: "failed", message: FAILED_TO_LOAD });
      });
    return () => {
      abandoned = true;
    };
  }, []);

  /**
   * The reply IS the new state: the server re-reads the subscription after the
   * change and this renders that, so the screen never shows the component's own
   * guess at what cancelling did.
   *
   * AND NOTHING ELSE IS REFETCHED. Telling the page to reload the commercial
   * state would send it back through its loading state, unmounting this card
   * mid-cancellation and flashing "Loading your subscription" over the answer
   * the customer just asked for. There is nothing to reload anyway: cancelling
   * at period end leaves the tier Premium and the balance untouched.
   */
  const cancel = useCallback(async () => {
    setCancelling({ status: "working" });
    try {
      const { subscription } = await subscriptionApi.cancel();
      if (subscription) setLoad({ status: "ready", detail: subscription });
      setCancelling({ status: "idle" });
    } catch {
      setCancelling({ status: "failed", message: FAILED_TO_CANCEL });
    }
  }, []);

  if (load.status !== "ready") {
    return (
      <>
        <section
          aria-label="Your subscription"
          data-testid="subscription-management"
          className={SHELL}
        >
          <p role="status" className="text-sm text-zinc-400">
            {load.status === "loading"
              ? "Loading your subscription…"
              : load.message}
          </p>
        </section>
        {children}
      </>
    );
  }

  return (
    <SubscriptionDetailView
      detail={load.detail}
      cancelling={cancelling}
      onStartCancel={() => setCancelling({ status: "confirming" })}
      onDismissCancel={() => setCancelling({ status: "idle" })}
      onConfirmCancel={() => void cancel()}
    >
      {children}
    </SubscriptionDetailView>
  );
}

/** Every state of the management screen, as a function of the server's answer. */
export function SubscriptionDetailView({
  detail,
  cancelling = { status: "idle" },
  onStartCancel,
  onDismissCancel,
  onConfirmCancel,
  children,
}: {
  /** Shown between the subscription card and the cancel link. */
  children?: ReactNode;
  detail: CustomerSubscriptionDetail;
  cancelling?: CancelState;
  onStartCancel?: () => void;
  onDismissCancel?: () => void;
  onConfirmCancel?: () => void;
}) {
  const period = periodEndLine(detail);
  const confirming = cancelling.status === "confirming";

  return (
    <>
      <section
        aria-label="Your subscription"
        data-testid="subscription-management"
        data-status={detail.status}
        className={SHELL}
      >
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
              Your subscription
            </p>
            <h2
              data-testid="subscription-plan-name"
              className="mt-0.5 truncate text-lg font-semibold text-white"
            >
              {detail.plan.displayName}
            </h2>
            <p
              data-testid="subscription-price"
              className="mt-0.5 text-sm text-zinc-400"
            >
              {formatPlanPrice(detail.plan)} &middot;{" "}
              {billingPeriodLabel(detail.plan)}
            </p>
          </div>
          <span
            data-testid="subscription-status"
            className={`shrink-0 rounded-full px-3 py-1 text-xs font-semibold ${
              detail.cancelAtPeriodEnd
                ? "bg-amber-400/15 text-amber-200"
                : "bg-emerald-400/15 text-emerald-200"
            }`}
          >
            {statusLabel(detail.status)}
          </span>
        </header>

        {planWithdrawn(detail) && (
          <p
            role="status"
            data-testid="plan-withdrawn"
            className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-100"
          >
            This plan is no longer offered, so your Premium is not active.
            Please contact support.
          </p>
        )}

        <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          <Row
            label={period.label}
            value={period.date}
            testId="row-period-end"
          />
          <Row
            label="Credits included"
            value={`${detail.plan.monthlyIncludedCredits} each billing cycle`}
            testId="row-included-credits"
          />
          <Row
            label="Started"
            value={
              detail.startedAt
                ? formatSubscriptionDate(detail.startedAt)
                : "Not recorded"
            }
            testId="row-started"
          />
          <Row
            label="Last payment"
            value={
              detail.lastPayment
                ? `${formatMoneyMinor(
                    detail.lastPayment.amountMinor,
                    detail.lastPayment.currency,
                  )} on ${formatSubscriptionDate(detail.lastPayment.paidAt)}`
                : "No payment recorded"
            }
            testId="row-last-payment"
          />
        </dl>

        <p
          data-testid="subscription-explanation"
          className="text-sm text-zinc-300"
        >
          {statusExplanation(detail)}
        </p>
      </section>

      {children}

      <div
        data-testid="cancel-area"
        className="flex flex-col items-center gap-3"
      >
        {detail.canCancel && !confirming && (
          <button
            type="button"
            data-testid="cancel-premium"
            onClick={onStartCancel}
            className="min-h-[2.75rem] px-2 text-sm font-medium text-rose-500 underline-offset-4 transition-colors hover:text-rose-400 hover:underline"
          >
            Cancel Premium
          </button>
        )}

        {confirming && (
          <div
            role="group"
            aria-label="Confirm cancellation"
            data-testid="cancel-confirm"
            className="flex w-full flex-col gap-3 rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3"
          >
            <p className="text-sm text-amber-100">{cancelWarning(detail)}</p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                data-testid="cancel-confirm-yes"
                onClick={onConfirmCancel}
                className="min-h-[2.75rem] rounded-xl bg-rose-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-rose-500"
              >
                Yes, cancel Premium
              </button>
              <button
                type="button"
                data-testid="cancel-confirm-no"
                onClick={onDismissCancel}
                className="min-h-[2.75rem] rounded-xl border border-zinc-700 px-4 py-2 text-sm font-semibold text-zinc-200 transition-colors hover:border-zinc-500 hover:text-white"
              >
                No, keep my subscription
              </button>
            </div>
          </div>
        )}

        {cancelling.status === "working" && (
          <p role="status" className="text-sm text-zinc-400">
            Cancelling…
          </p>
        )}

        {cancelling.status === "failed" && (
          <p
            role="status"
            data-testid="cancel-failed"
            className="text-sm text-rose-300"
          >
            {cancelling.message}
          </p>
        )}
      </div>
    </>
  );
}

function Row({
  label,
  value,
  testId,
}: {
  label: string;
  value: string;
  testId: string;
}) {
  return (
    <div
      data-testid={testId}
      className="flex items-baseline justify-between gap-3 border-b border-zinc-800/60 pb-1.5"
    >
      <dt className="text-zinc-500">{label}</dt>
      <dd className="text-right font-medium text-zinc-100">{value}</dd>
    </div>
  );
}
