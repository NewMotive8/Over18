import type { CharacterReadiness } from '../lib/api';

/**
 * Readiness, as the SERVER decided it.
 *
 * Purely presentational. Every rule -- what counts toward a requirement --
 * lives in the API's character-readiness-service. This component renders the
 * verdict and the server's own explanation of each blocker, and must never add
 * a condition of its own: a second copy of the rules in the browser is how the
 * admin and the app start disagreeing.
 *
 * PUBLISHABILITY IS NO LONGER SHOWN HERE. The verdict, its blockers and the
 * `publishability` field of the character detail are all still computed and
 * still returned by the API -- only this card was removed, and nothing about
 * whether a character may be shown to users changed with it.
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

export default function CharacterEligibilityPanel({ readiness }: { readiness: CharacterReadiness }) {
  return (
    <section aria-label="Readiness" className="mb-6 grid gap-3">
      <Verdict
        title="Readiness"
        ok={readiness.ready}
        yes="Ready"
        no="Not ready"
        reasons={readiness.blockers}
        note="Production work: required content and an active identity."
      />
    </section>
  );
}
