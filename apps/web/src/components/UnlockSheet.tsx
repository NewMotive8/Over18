import { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import type { UnlockFailure, UnlockTarget } from '../lib/contentUnlock';
import { SparkleIcon } from './icons';

/**
 * THE UNLOCK CONFIRMATION (P8.2, customer side).
 *
 * The one place a customer agrees to spend Credits on a piece of content. It
 * says four things and no more: what is being unlocked, exactly what it costs,
 * what they have, and the two ways out.
 *
 * EVERY NUMBER IS THE SERVER'S. The price comes from the access answer for that
 * asset and the balance from the customer's commercial state. Nothing here
 * adds, subtracts or compares them -- there is no "you'll have N left", because
 * that is arithmetic this screen has no business doing and no way to keep true.
 * A balance the server did not state is said to be unavailable rather than
 * shown as zero.
 *
 * IT NEVER CLAIMS THE PURCHASE WORKED. The sheet closes only when the server
 * has confirmed; a failure keeps it open, explains itself, and -- where there
 * is one -- offers the way out the refusal implies. While a request is in
 * flight both actions are disabled rather than the sheet closing early, so it
 * cannot be dismissed into a state nobody can see the end of.
 *
 * It follows the app's existing sheet: a bottom sheet on a phone, centred on a
 * wider screen, dismissed by Escape or the backdrop, in the same zinc and rose
 * as the Premium gate -- with the amber that means Credits everywhere else.
 */

const creditLabel = (price: number | null): string =>
  price === null ? 'Credits' : `${price} ${price === 1 ? 'Credit' : 'Credits'}`;

function Row({ label, value, tone = 'plain' }: { label: string; value: string; tone?: 'plain' | 'credit' | 'muted' }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-2">
      <span className="text-sm text-zinc-400">{label}</span>
      <span
        className={`text-sm font-semibold ${tone === 'credit' ? 'text-amber-200' : tone === 'muted' ? 'text-zinc-500' : 'text-zinc-100'}`}
      >
        {value}
      </span>
    </div>
  );
}

export default function UnlockSheet({
  target,
  balance,
  busy,
  failure,
  onConfirm,
  onCancel,
}: {
  target: UnlockTarget;
  /** The server's spendable Credits, or null when it did not state them. */
  balance: number | null;
  busy: boolean;
  failure: UnlockFailure | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const restoreTo = useRef<Element | null>(null);

  useEffect(() => {
    restoreTo.current = document.activeElement;
    // The safe action takes focus, as in the CMS dialog.
    cancelRef.current?.focus();
    return () => {
      if (restoreTo.current instanceof HTMLElement) restoreTo.current.focus();
    };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // Escape is a way out, not a way to abandon a request mid-flight.
      if (event.key === 'Escape' && !busy) onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onCancel]);

  const price = creditLabel(target.creditPrice);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="unlock-sheet-title"
      data-testid="unlock-sheet"
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/80 p-0 backdrop-blur-sm sm:items-center sm:p-4"
      onClick={() => {
        if (!busy) onCancel();
      }}
    >
      <div
        className="w-full max-w-md rounded-t-3xl border border-zinc-800 bg-gradient-to-b from-zinc-900 to-zinc-950 p-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] sm:rounded-3xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center gap-2 text-amber-300">
          <SparkleIcon className="h-5 w-5" />
          <span className="text-sm font-semibold uppercase tracking-wide text-amber-400">Credits</span>
        </div>

        <h3 id="unlock-sheet-title" className="mt-3 text-xl font-bold text-white">
          Unlock this for {price}?
        </h3>

        <dl className="mt-4 divide-y divide-zinc-800 border-y border-zinc-800">
          <Row label="Content" value={target.title} />
          <Row label="Price" value={price} tone="credit" />
          <Row
            label="Your Credits"
            value={balance === null ? 'Not available' : creditLabel(balance)}
            tone={balance === null ? 'muted' : 'plain'}
          />
        </dl>

        {failure && (
          <div role="alert" className="mt-4 rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2">
            <p className="text-sm text-rose-100">{failure.message}</p>
            {failure.action && (
              <Link to={failure.action.to} className="mt-1 inline-block text-sm font-semibold text-rose-200 underline">
                {failure.action.label}
              </Link>
            )}
          </div>
        )}

        <button
          type="button"
          onClick={onConfirm}
          disabled={busy}
          aria-busy={busy}
          data-testid="unlock-confirm"
          className="mt-6 min-h-11 w-full rounded-xl bg-rose-600 py-3 text-sm font-semibold text-white transition-colors hover:bg-rose-500 disabled:opacity-60"
        >
          {busy ? 'Unlocking…' : `Unlock · ${price}`}
        </button>
        <button
          ref={cancelRef}
          type="button"
          onClick={onCancel}
          disabled={busy}
          data-testid="unlock-cancel"
          className="mt-2 min-h-11 w-full rounded-xl py-2.5 text-sm font-medium text-zinc-400 transition-colors hover:text-zinc-200 disabled:opacity-60"
        >
          Not now
        </button>
      </div>
    </div>
  );
}
