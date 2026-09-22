import { useEffect, useRef } from 'react';
import { PAYMENT_METHODS, PAYMENT_METHOD_LABELS, type PaymentMethod } from '@over18/shared';

/**
 * CHOOSING HOW TO PAY (P9.1).
 *
 * The three methods the product intends to offer. While the processor is
 * undecided (P9.D1) none of them is connected, so the sheet says so plainly
 * rather than showing an Apple Pay button that is not Apple Pay.
 *
 * The choice is a HINT carried to the server, which records it on the payment.
 * It is not authority: which method actually takes the money is the provider's
 * to report, and a real hosted checkout may offer a different set.
 */

const GLYPH: Record<PaymentMethod, string> = {
  apple_pay: '',
  google_pay: 'G',
  paypal: 'P',
};

export default function PaymentMethodSheet({
  planName,
  price,
  busy,
  error,
  onChoose,
  onCancel,
}: {
  planName: string;
  price: string;
  busy: boolean;
  error: string | null;
  onChoose: (method: PaymentMethod) => void;
  onCancel: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const restoreTo = useRef<Element | null>(null);

  useEffect(() => {
    restoreTo.current = document.activeElement;
    cancelRef.current?.focus();
    return () => {
      if (restoreTo.current instanceof HTMLElement) restoreTo.current.focus();
    };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onCancel]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="pay-method-title"
      data-testid="payment-method-sheet"
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/80 p-0 backdrop-blur-sm sm:items-center sm:p-4"
      onClick={() => {
        if (!busy) onCancel();
      }}
    >
      <div
        className="w-full max-w-md rounded-t-3xl border border-zinc-800 bg-gradient-to-b from-zinc-900 to-zinc-950 p-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] sm:rounded-3xl"
        onClick={(event) => event.stopPropagation()}
      >
        <p className="text-xs font-bold uppercase tracking-widest text-amber-300">Test payment</p>
        <h3 id="pay-method-title" className="mt-2 text-xl font-bold text-white">
          {planName}
        </h3>
        <p className="mt-1 text-sm text-zinc-400">{price}</p>

        <p className="mt-4 text-xs text-zinc-500">
          Choose a method. None is connected yet — this starts a clearly marked test payment, and no card is collected.
        </p>

        {error && (
          <div role="alert" className="mt-3 rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-100">
            {error}
          </div>
        )}

        <div className="mt-4 flex flex-col gap-2">
          {PAYMENT_METHODS.map((method) => (
            <button
              key={method}
              type="button"
              data-testid={`method-${method}`}
              disabled={busy}
              onClick={() => onChoose(method)}
              className="flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-zinc-700 bg-zinc-900 px-3 text-sm font-semibold text-zinc-100 transition-colors hover:bg-zinc-800 disabled:opacity-60"
            >
              <span aria-hidden className="text-base">
                {GLYPH[method]}
              </span>
              {busy ? 'Starting…' : `${PAYMENT_METHOD_LABELS[method]} (test)`}
            </button>
          ))}
        </div>

        <button
          ref={cancelRef}
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="mt-2 min-h-11 w-full rounded-xl py-2.5 text-sm font-medium text-zinc-400 transition-colors hover:text-zinc-200 disabled:opacity-60"
        >
          Not now
        </button>
      </div>
    </div>
  );
}
