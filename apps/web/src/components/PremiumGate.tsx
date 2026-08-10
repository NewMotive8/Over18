import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { SparkleIcon } from './icons';

/**
 * Premium / Subscribe gate (US-19).
 *
 * A UI-only monetization gate shown when a free user reaches premium media. It
 * routes to the existing `/subscription` placeholder — there is NO billing,
 * payment, or Stripe here, matching the subscription page's own constraints.
 * Esc or backdrop dismiss it (navigate back within the flow).
 */
const BENEFITS = ['Unlock the full gallery', 'Exclusive media', 'Priority chat', 'New drops first'];

export default function PremiumGate({ name, onClose }: { name: string; onClose: () => void }) {
  const navigate = useNavigate();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Premium"
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/80 p-0 backdrop-blur-sm sm:items-center sm:p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-t-3xl border border-zinc-800 bg-gradient-to-b from-zinc-900 to-zinc-950 p-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] sm:rounded-3xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 text-rose-400">
          <SparkleIcon className="h-5 w-5" />
          <span className="text-sm font-semibold uppercase tracking-wide text-rose-500">Premium</span>
        </div>

        <h3 className="mt-3 text-xl font-bold text-white">Unlock {name}&rsquo;s full gallery</h3>
        <p className="mt-1 text-sm text-zinc-400">
          Premium members see every photo and video, and get priority chat.
        </p>

        <ul className="mt-4 flex flex-col gap-2">
          {BENEFITS.map((b) => (
            <li key={b} className="flex items-center gap-2 text-sm text-zinc-200">
              <span aria-hidden className="text-rose-500">
                ✓
              </span>
              {b}
            </li>
          ))}
        </ul>

        <button
          type="button"
          onClick={() => navigate('/subscription')}
          className="mt-6 w-full rounded-xl bg-rose-600 py-3 text-sm font-semibold text-white transition-colors hover:bg-rose-500"
        >
          Go Premium
        </button>
        <button
          type="button"
          onClick={onClose}
          className="mt-2 w-full rounded-xl py-2.5 text-sm font-medium text-zinc-400 transition-colors hover:text-zinc-200"
        >
          Maybe later
        </button>
        <p className="mt-2 text-center text-[11px] text-zinc-600">
          Payments are not enabled in this preview.
        </p>
      </div>
    </div>
  );
}
