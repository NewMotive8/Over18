import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { contentCardLabel, type ContentCardView } from '../lib/contentAccess';
import { CrownIcon, LockIcon, SparkleIcon } from './icons';

/**
 * THE CONTENT CARD (P8.1) -- one tile, in whatever state the server says.
 *
 * IT DECIDES NOTHING. The state, the price and the words all come from
 * `contentCardView`, which only translates the P4.2 answer. No tier, balance,
 * price or entitlement is read or compared here, so a state the server did not
 * send cannot appear on screen.
 *
 * LOCKED CONTENT STILL LOOKS LIKE CONTENT. The real media stays on the tile,
 * blurred and dimmed behind the lock, so a customer can see that something is
 * there -- never an empty grey box. The blur is presentation, NOT protection:
 * the media a locked tile blurs is whatever the server served it. A
 * server-made preview for locked content is the unlock phase's to add (P8),
 * and until then nothing is locked in production because the economy is off.
 *
 * PREMIUM AND CREDITS NEVER LOOK ALIKE: Premium is rose and says Premium,
 * Credits are amber and always carry the price. Every state is stated in
 * words, not by colour alone, and a control that does not work yet is disabled
 * and says why.
 */

const TONE: Record<NonNullable<ContentCardView['badge']>['tone'], string> = {
  premium: 'border-rose-400/30 bg-rose-500/20 text-rose-50',
  credit: 'border-amber-400/30 bg-amber-500/20 text-amber-50',
  neutral: 'border-white/15 bg-black/50 text-zinc-100',
};

function Badge({ badge }: { badge: NonNullable<ContentCardView['badge']> }) {
  const Icon = badge.tone === 'premium' ? CrownIcon : badge.tone === 'credit' ? SparkleIcon : LockIcon;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[11px] font-semibold backdrop-blur-sm ${TONE[badge.tone]}`}
    >
      <Icon aria-hidden className="h-3 w-3" />
      {badge.label}
    </span>
  );
}

export default function LockedContentCard({
  view,
  title,
  media,
  footer,
  onOpen,
  onUnlock,
}: {
  view: ContentCardView;
  /** What this tile is, for assistive technology. */
  title: string;
  /** The real media. Rendered blurred and inert while the content is locked. */
  media: ReactNode;
  /** Decoration the surface owns, shown only when the media is. */
  footer?: ReactNode;
  /** Opens the media. Only ever called when the server revealed it. */
  onOpen?: () => void;
  /**
   * Starts the unlock the surface offered (P8.2): it opens a confirmation.
   * Nothing is charged by pressing this, and the tile does not change until the
   * server says it has.
   */
  onUnlock?: () => void;
}) {
  // The approved tile frame, unchanged -- including the order of its classes,
  // which the Posts tab's presentation guard checks.
  const frame = 'aspect-[3/4] w-full overflow-hidden rounded-2xl border border-white/5 bg-zinc-900';

  if (view.revealed) {
    return (
      <button type="button" onClick={onOpen} aria-label={title} className={`group relative block ${frame}`}>
        {media}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-1/3 bg-gradient-to-t from-black/70 to-transparent" />
        {view.badge && <span className="absolute left-2 top-2">{<Badge badge={view.badge} />}</span>}
        {footer}
      </button>
    );
  }

  return (
    <div
      role="group"
      aria-label={contentCardLabel(view, title)}
      data-testid="locked-content-card"
      data-state={view.state}
      className={`relative ${frame}`}
    >
      {/* The content, present but unreadable. Decorative here: the state is in text below. */}
      <div aria-hidden className="absolute inset-0 scale-110 blur-xl saturate-50">
        {media}
      </div>
      <div aria-hidden className="absolute inset-0 bg-gradient-to-b from-black/50 via-black/60 to-black/80" />

      {view.badge && <span className="absolute left-2 top-2">{<Badge badge={view.badge} />}</span>}

      <div className="absolute inset-x-0 bottom-0 flex flex-col items-center gap-2 px-3 pb-3 text-center">
        <span aria-hidden className="flex h-9 w-9 items-center justify-center rounded-full border border-white/15 bg-black/50 text-white">
          <LockIcon className="h-4 w-4" />
        </span>
        {view.message && <p className="text-[12px] font-medium leading-snug text-zinc-100">{view.message}</p>}
        {view.cta &&
          (view.cta.action === 'unlock' && !view.cta.disabled ? (
            <button
              type="button"
              onClick={onUnlock}
              className="min-h-11 w-full rounded-xl bg-rose-600 px-3 text-[13px] font-semibold text-white transition-colors hover:bg-rose-500"
            >
              {view.cta.label}
            </button>
          ) : view.cta.disabled || view.cta.to === null ? (
            <>
              <button
                type="button"
                disabled
                aria-describedby={view.cta.hint ? `${view.state}-hint` : undefined}
                className="min-h-11 w-full rounded-xl border border-white/15 bg-white/10 px-3 text-[13px] font-semibold text-zinc-100 opacity-60"
              >
                {view.cta.label}
              </button>
              {view.cta.hint && (
                <p id={`${view.state}-hint`} className="text-[11px] text-zinc-300">
                  {view.cta.hint}
                </p>
              )}
            </>
          ) : (
            <Link
              to={view.cta.to}
              className="flex min-h-11 w-full items-center justify-center rounded-xl bg-rose-600 px-3 text-[13px] font-semibold text-white transition-colors hover:bg-rose-500"
            >
              {view.cta.label}
            </Link>
          ))}
      </div>
    </div>
  );
}
