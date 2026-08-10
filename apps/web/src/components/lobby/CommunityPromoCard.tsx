import { Link } from 'react-router-dom';

/**
 * Community / promotional card (US-28 / v2 brief §1).
 *
 * A non-persona card mixed into the discovery grid to prove the feed can host
 * multiple card types. Bold centered copy, live social-proof avatars + an
 * online count, and a primary CTA pill. Spans both grid columns for emphasis.
 * No real integration — a UI-only engagement card.
 */
export default function CommunityPromoCard() {
  const avatars = ['from-rose-500 to-fuchsia-600', 'from-sky-500 to-indigo-600', 'from-amber-400 to-orange-600', 'from-emerald-400 to-teal-600'];
  return (
    <div className="col-span-2 flex flex-col items-center gap-3 rounded-2xl border border-white/10 bg-gradient-to-br from-indigo-950 via-zinc-950 to-fuchsia-950 p-5 text-center">
      <div className="flex -space-x-2">
        {avatars.map((g, i) => (
          <span
            key={i}
            className={`h-8 w-8 rounded-full border-2 border-zinc-950 bg-gradient-to-br ${g}`}
            aria-hidden
          />
        ))}
        <span className="flex h-8 items-center rounded-full border-2 border-zinc-950 bg-zinc-800 px-2 text-[10px] font-semibold text-zinc-200">
          +2.4k
        </span>
      </div>
      <div>
        <p className="text-lg font-black uppercase tracking-tight text-white">Get 20 for free</p>
        <p className="mt-0.5 flex items-center justify-center gap-1.5 text-xs text-zinc-300">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" /> 1,283 online now
        </p>
      </div>
      <Link
        to="/subscription"
        className="rounded-full bg-white px-5 py-2 text-sm font-bold text-zinc-950 transition-transform active:scale-95"
      >
        Join the community
      </Link>
    </div>
  );
}
