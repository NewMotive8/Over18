import type { CharacterPublishability, CharacterReadiness } from '../lib/api';

/**
 * Readiness and Publishability, as the SERVER decided them.
 *
 * Purely presentational. Every rule -- what counts toward a requirement, what
 * makes her publishable -- lives in the API's character-readiness-service. This
 * component renders the verdict and the server's own explanation of each
 * blocker, and must never add a condition of its own: a second copy of the rules
 * in the browser is how the admin and the app start disagreeing.
 */

function Verdict({
  title,
  ok,
  yes,
  no,
  reasons,
  note,
}: {
  title: string;
  ok: boolean;
  yes: string;
  no: string;
  reasons: readonly { code: string; message: string }[];
  note: string;
}) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 px-4 py-3" data-testid={`eligibility-${title.toLowerCase()}`}>
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">{title}</p>
        <span
          className={`rounded px-2 py-0.5 text-[11px] font-semibold ${
            ok ? 'bg-emerald-950 text-emerald-400' : 'bg-amber-950 text-amber-300'
          }`}
        >
          {ok ? yes : no}
        </span>
      </div>
      {!ok && reasons.length > 0 && (
        <ul className="mt-2 space-y-1 text-xs text-zinc-300">
          {reasons.map((reason, index) => (
            <li key={`${reason.code}-${index}`} className="flex gap-2">
              <span aria-hidden className="text-amber-400">•</span>
              <span>{reason.message}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-2 text-[11px] text-zinc-500">{note}</p>
    </div>
  );
}

export default function CharacterEligibilityPanel({
  readiness,
  publishability,
}: {
  readiness: CharacterReadiness;
  publishability: CharacterPublishability;
}) {
  return (
    <section aria-label="Readiness and publishability" className="mb-6 grid gap-3 sm:grid-cols-2">
      <Verdict
        title="Readiness"
        ok={readiness.ready}
        yes="Ready"
        no="Not ready"
        reasons={readiness.blockers}
        note="Production work: required content and an active identity."
      />
      <Verdict
        title="Publishability"
        ok={publishability.publishable}
        yes="Publishable"
        no="Not publishable"
        reasons={publishability.blockers}
        note="Whether she may be shown to users. Placement on Posts, Home, categories or Discovery is separate."
      />
    </section>
  );
}
