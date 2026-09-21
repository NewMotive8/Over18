import { isStaging } from '../lib/environment';

/**
 * THE STAGING WARNING.
 *
 * A permanent hazard band immediately below the header, on the customer app and
 * the admin alike, so nobody can mistake a review environment for the real
 * product -- or, worse, mistake real customer data for test data.
 *
 * IT CANNOT APPEAR IN PRODUCTION. It renders only when the bundle was BUILT
 * with `VITE_ENVIRONMENT=staging`, and `isStaging` recognises nothing else.
 * A production build contains no staging marker to switch on.
 *
 * It is not dismissible and it does not scroll away with the content, because a
 * warning you can turn off is a warning that will be off at the moment it
 * mattered.
 *
 * The stripes are decorative and hidden from assistive technology; the sentence
 * is what carries the meaning, and it is announced as a status.
 */
export default function StagingBanner() {
  if (!isStaging()) return null;

  return (
    <div
      role="status"
      data-testid="staging-banner"
      aria-label="This is the staging environment"
      className="relative z-20 w-full select-none border-y-2 border-black"
      style={{
        // 45° hazard stripes: the universal "do not mistake this for the real
        // thing" signal, in the one colour pair nobody uses decoratively here.
        backgroundImage:
          'repeating-linear-gradient(45deg, #facc15 0, #facc15 12px, #000 12px, #000 24px)',
      }}
    >
      <p className="flex items-center justify-center px-2 py-1.5">
        {/* A solid plate behind the words, so the text stays legible over the
            stripes rather than fighting them. */}
        <span className="rounded-sm bg-yellow-400 px-3 py-1 text-center text-[11px] font-black uppercase tracking-[0.18em] text-black sm:text-xs">
          This is staging environment
        </span>
      </p>
    </div>
  );
}
