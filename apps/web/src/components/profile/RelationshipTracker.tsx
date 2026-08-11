import type { RelationshipState } from '../../lib/relationship';
import { RELATIONSHIP_TIERS } from '../../lib/relationship';
import { LockIcon } from '../icons';

/**
 * Horizontal Relationship Tracker (US-29 / brief §2).
 *
 * Maps the interaction tiers as a progress bar: completed tiers filled, the
 * current tier partially filled to its in-tier progress, and the next tier
 * shown locked. Deterministic mock state — no backend relationship system.
 */
export default function RelationshipTracker({ state }: { state: RelationshipState }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-zinc-900/70 p-4">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
          Relationship
        </span>
        <span className="text-xs font-semibold text-rose-400">{state.current.label}</span>
      </div>

      <div className="mt-3 flex items-center gap-1.5">
        {RELATIONSHIP_TIERS.map((tier, i) => {
          const done = i < state.tierIndex;
          const current = i === state.tierIndex;
          const fill = done ? 1 : current ? state.progress : 0;
          return (
            <div key={tier.key} className="flex flex-1 flex-col items-center gap-1">
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-rose-500 to-fuchsia-500"
                  style={{ width: `${Math.round(fill * 100)}%` }}
                />
              </div>
              <span
                className={`flex items-center gap-0.5 text-[9px] font-medium ${
                  done || current ? 'text-zinc-300' : 'text-zinc-600'
                }`}
              >
                {i === state.tierIndex + 1 && <LockIcon className="h-2.5 w-2.5" />}
                {tier.label}
              </span>
            </div>
          );
        })}
      </div>

      {state.next && (
        <p className="mt-2 text-[11px] text-zinc-500">
          Keep chatting to unlock <span className="text-zinc-300">{state.next.label}</span>.
        </p>
      )}
    </div>
  );
}
