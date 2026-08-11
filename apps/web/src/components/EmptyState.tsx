import type { ReactNode } from 'react';

/**
 * Reusable empty / future / unavailable state (US-18).
 *
 * One coherent presentation for "there's intentionally nothing here yet" across
 * Go Steady, Profile, and Discover's empty/error branches — so future areas
 * read as deliberate product surfaces, never as broken pages.
 */
export default function EmptyState({
  icon,
  title,
  description,
  badge,
  action,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  /** Small pill, e.g. "Coming soon". */
  badge?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-4 rounded-3xl border border-zinc-800 bg-gradient-to-b from-zinc-900/70 to-zinc-950 px-6 py-14 text-center">
      {icon && (
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-zinc-800 bg-zinc-900 text-rose-400">
          {icon}
        </div>
      )}
      <div className="flex flex-col gap-1.5">
        <h3 className="text-lg font-semibold text-white">{title}</h3>
        {description && <p className="mx-auto max-w-xs text-sm leading-snug text-zinc-400">{description}</p>}
      </div>
      {badge && (
        <span className="rounded-full border border-zinc-700 bg-zinc-800/70 px-3 py-1 text-[11px] font-medium uppercase tracking-wide text-zinc-400">
          {badge}
        </span>
      )}
      {action}
    </div>
  );
}
