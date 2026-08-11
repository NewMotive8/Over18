import { Link } from 'react-router-dom';
import PageContainer from '../components/PageContainer';
import PageHeader from '../components/PageHeader';
import { SparkleIcon } from '../components/icons';

/**
 * Subscription (US-18) — placeholder commercial surface only.
 *
 * Provides the `/subscription` route the shell links to (from Profile / future
 * premium flows) so there is no navigation dead end. Intentionally NON-functional
 * commerce: NO Stripe, NO billing, NO payment call, and a configurable
 * placeholder price — monetization is out of scope for the shell ticket.
 */
const BENEFITS = ['Chat with characters', 'Voice interaction', 'Premium experiences', 'More characters'];

// Configurable placeholder — not a committed price (override via VITE_PREMIUM_PRICE_LABEL later).
const PRICE_LABEL = 'Pricing to be confirmed';

export default function SubscriptionPage() {
  return (
    <PageContainer>
      <PageHeader eyebrow="Premium" title="Go Premium" subtitle="Unlock the full experience." />

      <div className="rounded-3xl border border-zinc-800 bg-gradient-to-b from-zinc-900 to-zinc-950 p-6">
        <div className="flex items-center gap-2 text-rose-400">
          <SparkleIcon className="h-5 w-5" />
          <span className="text-sm font-semibold text-white">Premium</span>
        </div>

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

        <div className="mt-6 flex items-baseline justify-between rounded-2xl border border-zinc-800 bg-zinc-900/60 px-4 py-3">
          <span className="text-sm font-medium text-zinc-200">Monthly</span>
          <span className="text-sm text-zinc-400">{PRICE_LABEL}</span>
        </div>

        <button
          type="button"
          disabled
          aria-disabled
          className="mt-6 w-full cursor-not-allowed rounded-xl bg-rose-600/60 py-3 text-sm font-semibold text-white/80"
        >
          Subscribe — coming soon
        </button>
        <p className="mt-3 text-center text-[11px] text-zinc-600">
          Placeholder pricing — not a final commercial price. Payments are not enabled in this preview.
        </p>
      </div>

      <Link to="/characters" className="text-center text-sm text-zinc-400 transition-colors hover:text-zinc-200">
        ← Back to Discover
      </Link>
    </PageContainer>
  );
}
