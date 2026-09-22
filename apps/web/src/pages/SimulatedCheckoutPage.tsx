import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { PAYMENT_METHOD_LABELS, SIMULATED_OUTCOMES, type PaymentMethod, type SimulatedOutcome } from '@over18/shared';
import PageContainer from '../components/PageContainer';
import { checkoutMessage, readCheckout, simulate, type SimulationState } from '../lib/payments';

/**
 * THE SIMULATED PAYMENT SCREEN (P9, ahead of P9.D1).
 *
 * Where a real processor's hosted checkout will be. The processor is not chosen
 * yet, so this stands in for it -- and it is built to be impossible to mistake
 * for one: a banner, a border, a colour used nowhere else in the app, the word
 * TEST wherever a customer looks, and the three outcomes shown as plain
 * buttons. No card fields, because there is nothing to type a card into.
 *
 * IT DECIDES NOTHING. Pressing an outcome asks the SERVER to emit that provider
 * event; the server verifies its signature and applies it, exactly as it will
 * apply a real webhook. This page then sends the customer back and lets the
 * account screen read what actually happened. It never reports success itself,
 * because it does not know -- only the server does.
 *
 * The route exists in every build; the SERVER refuses it unless the fake
 * provider is selected, which cannot happen in production or on Railway.
 */

const OUTCOME_LABEL: Record<SimulatedOutcome, string> = {
  success: 'Simulate successful payment',
  failure: 'Simulate declined payment',
  cancel: 'Simulate cancelled payment',
};

const OUTCOME_STYLE: Record<SimulatedOutcome, string> = {
  success: 'bg-emerald-600 text-white hover:bg-emerald-500',
  failure: 'border border-amber-500/40 bg-amber-500/10 text-amber-100 hover:bg-amber-500/20',
  cancel: 'border border-zinc-700 bg-zinc-900 text-zinc-300 hover:bg-zinc-800',
};

const money = (amountMinor: number, currency: string) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amountMinor / 100);

export default function SimulatedCheckoutPage() {
  const { checkoutRef = '' } = useParams();
  const navigate = useNavigate();
  const [state, setState] = useState<SimulationState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    readCheckout(checkoutRef)
      .then((payment) => {
        if (!cancelled) setState({ status: 'ready', payment });
      })
      .catch((error: unknown) => {
        if (!cancelled) setState({ status: 'failed', message: checkoutMessage(error) });
      });
    return () => {
      cancelled = true;
    };
  }, [checkoutRef]);

  const send = useCallback(
    async (outcome: SimulatedOutcome) => {
      if (state.status !== 'ready') return;
      setState({ status: 'sending', payment: state.payment });
      try {
        await simulate(checkoutRef, outcome);
        // Back to the account, which reads the server's answer rather than ours.
        navigate('/subscription?from=checkout', { replace: true });
      } catch (error: unknown) {
        setState({ status: 'failed', message: checkoutMessage(error) });
      }
    },
    [checkoutRef, navigate, state],
  );

  return (
    <PageContainer>
      {/* Said before anything else, and impossible to miss. */}
      <div
        role="status"
        data-testid="simulated-banner"
        className="rounded-2xl border-2 border-dashed border-amber-400 bg-amber-500/15 px-4 py-3 text-center"
      >
        <p className="text-sm font-bold uppercase tracking-widest text-amber-200">Test payment — not real</p>
        <p className="mt-1 text-xs text-amber-100/80">
          No card is collected and no money moves. This screen stands in for the payment provider, which has not been chosen yet.
        </p>
      </div>

      {state.status === 'loading' && <p className="py-10 text-center text-sm text-zinc-400">Loading the test checkout…</p>}

      {state.status === 'failed' && (
        <div role="alert" className="rounded-2xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-center">
          <p className="text-sm text-rose-100">{state.message}</p>
          <button type="button" onClick={() => navigate('/subscription')} className="mt-3 text-sm font-semibold text-rose-200 underline">
            Back to plans
          </button>
        </div>
      )}

      {(state.status === 'ready' || state.status === 'sending' || state.status === 'settled') && (
        <section className="rounded-3xl border border-zinc-800 bg-zinc-900/60 p-5">
          <h1 className="text-lg font-semibold text-white">Simulated checkout</h1>
          <dl className="mt-4 divide-y divide-zinc-800 border-y border-zinc-800">
            <Row label="Plan" value={state.payment.productRef} />
            <Row label="Amount" value={money(state.payment.amountMinor, state.payment.currency)} />
            <Row
              label="Method"
              value={
                state.payment.methodHint
                  ? `${PAYMENT_METHOD_LABELS[state.payment.methodHint as PaymentMethod] ?? state.payment.methodHint} (simulated)`
                  : 'Simulated'
              }
            />
            <Row label="Status" value={state.payment.status} />
          </dl>

          <p className="mt-4 text-xs text-zinc-500">
            Choose what the payment provider should report. The server applies the result; this page decides nothing.
          </p>

          <div className="mt-4 flex flex-col gap-2">
            {SIMULATED_OUTCOMES.map((outcome) => (
              <button
                key={outcome}
                type="button"
                data-testid={`simulate-${outcome}`}
                disabled={state.status !== 'ready'}
                onClick={() => void send(outcome)}
                className={`min-h-11 w-full rounded-xl px-3 text-sm font-semibold transition-colors disabled:opacity-60 ${OUTCOME_STYLE[outcome]}`}
              >
                {state.status === 'sending' ? 'Working…' : OUTCOME_LABEL[outcome]}
              </button>
            ))}
          </div>
        </section>
      )}
    </PageContainer>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-2">
      <dt className="text-sm text-zinc-400">{label}</dt>
      <dd className="text-sm font-semibold text-zinc-100">{value}</dd>
    </div>
  );
}
