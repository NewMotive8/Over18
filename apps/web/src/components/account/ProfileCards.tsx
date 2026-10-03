import { Link } from 'react-router-dom';
import { PREMIUM_SUMMARY, type MembershipView } from '../../lib/membership';
import { CrownIcon, ProfileIcon, SparkleIcon } from '../icons';

/**
 * THE PROFILE PAGE'S PIECES (profile redesign).
 *
 * Presentational only: what to say is decided by `lib/membership.ts` and the
 * customer-economy selectors from the server's facts, and handed in. One accent
 * per meaning -- rose for Premium and the one sales action, amber for Credits,
 * neutral for the account -- so the eye goes to what matters for THIS customer.
 */

/** Who is signed in: the account's email, legibly, and a Premium mark when the server says so. */
export function IdentityHeader({ email, premium }: { email: string; premium: boolean }) {
  return (
    <section aria-label="Your account" data-testid="profile-identity" className="flex items-center gap-3">
      <span aria-hidden className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border border-zinc-800 bg-zinc-900 text-rose-400">
        <ProfileIcon className="h-6 w-6" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">Signed in as</p>
        {/* Long addresses wrap rather than overflow or hide behind an ellipsis --
            at the @ first, and mid-part only when a part alone is too long. */}
        <p data-testid="profile-email" className="text-base font-semibold leading-snug text-white [overflow-wrap:anywhere]">
          {email.includes('@') ? (
            <>
              {email.slice(0, email.indexOf('@'))}
              <wbr />
              {email.slice(email.indexOf('@'))}
            </>
          ) : (
            email
          )}
        </p>
      </div>
      {premium && (
        <span data-testid="profile-premium-badge" className="inline-flex shrink-0 items-center gap-1 rounded-full border border-rose-500/30 bg-rose-500/10 px-2.5 py-1 text-xs font-semibold text-rose-200">
          <CrownIcon aria-hidden className="h-3 w-3" />
          Premium
        </span>
      )}
    </section>
  );
}

/** The plan -- for a Free customer, the one place on the page that sells Premium. */
export function MembershipCard({ view }: { view: MembershipView }) {
  if (view.kind === 'unavailable') return null;
  return (
    <section
      aria-labelledby="membership-title"
      data-testid="profile-membership"
      data-kind={view.kind}
      className={`rounded-3xl border p-4 ${view.kind === 'premium' ? 'border-rose-500/25 bg-gradient-to-b from-rose-500/10 to-zinc-950' : 'border-zinc-800 bg-zinc-900/50'}`}
    >
      <h2 id="membership-title" className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
        Membership
      </h2>

      {view.kind === 'loading' && <div aria-busy className="mt-2 h-10 animate-pulse rounded-xl bg-zinc-800/60" />}

      {view.kind === 'free' && (
        <>
          <p className="mt-1 text-lg font-semibold text-white">Free plan</p>
          <p className="mt-1 text-sm leading-relaxed text-zinc-400">{PREMIUM_SUMMARY}</p>
          <Link
            to="/subscription"
            data-testid="profile-go-premium"
            className="mt-4 flex min-h-12 w-full items-center justify-center rounded-xl bg-rose-600 px-4 text-sm font-semibold text-white transition-colors hover:bg-rose-500"
          >
            Go Premium
          </Link>
        </>
      )}

      {view.kind === 'premium' && (
        <>
          <p className="mt-1 flex items-center gap-1.5 text-lg font-semibold text-white">
            <CrownIcon aria-hidden className="h-4 w-4 shrink-0 text-rose-300" />
            <span className="min-w-0 break-words">{view.planName}</span>
          </p>
          {view.dateLine && (
            <p data-testid="profile-plan-date" className="mt-1 text-sm text-zinc-300">
              {view.dateLine}
              {view.cancelling && <span className="text-zinc-500"> · Cancelled, will not renew</span>}
            </p>
          )}
          {!view.dateLine && view.cancelling && (
            <p data-testid="profile-plan-date" className="mt-1 text-sm text-zinc-300">
              Cancelled, will not renew
            </p>
          )}
          {view.notice && (
            <p role="status" data-testid="profile-plan-notice" className="mt-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-100">
              {view.notice}
            </p>
          )}
        </>
      )}
    </section>
  );
}

/** The balance -- the server's, read through the shared customer-economy state -- and the way to add to it. */
export function CreditsCard({ credits }: { credits: number | null }) {
  if (credits === null) return null;
  return (
    <section aria-labelledby="credits-title" data-testid="profile-credits" className="flex items-center gap-4 rounded-3xl border border-amber-500/20 bg-amber-500/5 p-4">
      <span aria-hidden className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-amber-400/15 text-amber-300">
        <SparkleIcon className="h-5 w-5" />
      </span>
      <div className="min-w-0 flex-1">
        <h2 id="credits-title" className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
          Credits
        </h2>
        <p className="flex items-baseline gap-1.5">
          <span data-testid="profile-credits-balance" className="text-2xl font-bold tabular-nums text-white">
            {credits.toLocaleString('en-US')}
          </span>
          <span className="text-sm font-medium text-amber-200">available</span>
        </p>
      </div>
      <Link
        to="/credits"
        data-testid="profile-top-up"
        className="flex min-h-11 shrink-0 items-center rounded-xl bg-amber-400 px-4 text-sm font-bold text-zinc-950 transition-colors hover:bg-amber-300"
      >
        Top up
      </Link>
    </section>
  );
}

/** Sign out: always there, never competing with the page's purpose. */
export function SignOutLink({ onSignOut }: { onSignOut: () => void }) {
  return (
    <button
      type="button"
      onClick={onSignOut}
      data-testid="profile-sign-out"
      className="mx-auto mt-2 flex min-h-11 items-center px-4 text-sm font-medium text-zinc-400 underline-offset-4 transition-colors hover:text-white hover:underline"
    >
      Sign out
    </button>
  );
}
