import { useMemo, useState } from 'react';
import { adminCharactersApi, type AdminCharacterListItem } from '../../lib/api';

/**
 * Review and confirm the ages of characters who have none.
 *
 * -- WHY A BULK SCREEN EXISTS AT ALL ----------------------------------------
 *
 * `characters.age` was created deliberately empty, so an established roster
 * arrives with nothing confirmed and every card showing no age. Confirming one
 * character at a time means opening each profile to discover whether there is
 * even a suggestion to accept. This shows the whole backlog on one screen.
 *
 * -- IT CONFIRMS; IT DOES NOT DECIDE ---------------------------------------
 *
 * Every number sent is one an operator could see and change first, and nothing
 * is submitted without them pressing the button. The suggestion is pre-filled
 * because that is the point of a review screen -- but it is pre-filled into an
 * editable box, labelled as a suggestion, and a row is only sent if it is
 * ticked. Nothing here can write an age nobody looked at.
 *
 * -- TWO DIFFERENT BACKLOGS, SHOWN SEPARATELY ------------------------------
 *
 * A character with a suggestion needs a glance. A character with none needs a
 * persona generated or a number invented, which is a bigger job and a different
 * decision. Mixing them into one list hides the second behind the first.
 */

export interface AgeConfirmationPanelProps {
  characters: AdminCharacterListItem[];
  /** Called after a successful confirmation so the list reloads. */
  onConfirmed: () => void;
}

const needsAge = (c: AdminCharacterListItem): boolean => c.age === null;

export default function AgeConfirmationPanel({
  characters,
  onConfirmed,
}: AgeConfirmationPanelProps) {
  const { withSuggestion, withoutSuggestion } = useMemo(() => {
    const pending = characters.filter(needsAge);
    return {
      withSuggestion: pending.filter((c) => c.suggestedAge !== null),
      withoutSuggestion: pending.filter((c) => c.suggestedAge === null),
    };
  }, [characters]);

  /** Ticked rows, and the age in each box. Keyed by character id. */
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<{ confirmed: number; rejected: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const ageFor = (c: AdminCharacterListItem): string =>
    edits[c.id] ?? (c.suggestedAge === null ? '' : String(c.suggestedAge));

  const chosen = withSuggestion.filter((c) => selected[c.id]);

  const confirm = async () => {
    setSaving(true);
    setError(null);
    setResult(null);
    try {
      const confirmations = chosen
        .map((c) => ({ characterId: c.id, age: Number(ageFor(c).trim()) }))
        // A blank or non-numeric box is simply not sent; the server would
        // reject it anyway, and a local filter keeps the message honest.
        .filter((c) => Number.isInteger(c.age));

      if (confirmations.length === 0) {
        setError('Nothing to confirm — tick a character and give a whole number.');
        return;
      }

      const response = await adminCharactersApi.confirmAges(confirmations);
      setResult({
        confirmed: response.confirmed.length,
        rejected: response.rejected.map((r: { characterId: string; reason: string }) => {
          const name = characters.find((c) => c.id === r.characterId)?.displayName ?? r.characterId;
          return `${name}: ${r.reason}`;
        }),
      });
      setSelected({});
      setEdits({});
      if (response.confirmed.length > 0) onConfirmed();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not confirm those ages.');
    } finally {
      setSaving(false);
    }
  };

  if (withSuggestion.length === 0 && withoutSuggestion.length === 0) {
    return (
      <section className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4" data-testid="age-panel">
        <h2 className="text-sm font-semibold text-zinc-200">Ages</h2>
        <p className="mt-1 text-sm text-emerald-400">
          Every character has a confirmed age.
        </p>
      </section>
    );
  }

  return (
    <section
      className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4"
      data-testid="age-panel"
    >
      <h2 className="text-sm font-semibold text-zinc-200">
        Ages to confirm
        <span className="ml-2 font-normal text-zinc-400">
          {withSuggestion.length + withoutSuggestion.length} character
          {withSuggestion.length + withoutSuggestion.length === 1 ? '' : 's'} without one
        </span>
      </h2>
      <p className="mt-1 text-xs text-zinc-400">
        A card and her own conversation both show the confirmed age, or no age at all. The
        suggestion below comes from her photo and is not shown to anyone until you confirm it.
      </p>

      {withSuggestion.length > 0 && (
        <>
          <div className="mt-4 flex items-center gap-3">
            <button
              type="button"
              className="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-300"
              onClick={() =>
                setSelected(Object.fromEntries(withSuggestion.map((c) => [c.id, true])))
              }
              data-testid="age-select-all"
            >
              Select all {withSuggestion.length} with a suggestion
            </button>
            <button
              type="button"
              className="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-300"
              onClick={() => setSelected({})}
            >
              Clear
            </button>
          </div>

          <ul className="mt-3 divide-y divide-zinc-800" data-testid="age-suggestion-list">
            {withSuggestion.map((c) => (
              <li key={c.id} className="flex items-center gap-3 py-2">
                <input
                  type="checkbox"
                  checked={Boolean(selected[c.id])}
                  onChange={(e) => setSelected((s) => ({ ...s, [c.id]: e.target.checked }))}
                  aria-label={`Confirm an age for ${c.displayName}`}
                  data-testid={`age-check-${c.name}`}
                />
                <span className="min-w-32 text-sm text-zinc-200">{c.displayName}</span>
                <input
                  type="number"
                  min={18}
                  max={120}
                  step={1}
                  value={ageFor(c)}
                  onChange={(e) => setEdits((d) => ({ ...d, [c.id]: e.target.value }))}
                  className="w-20 rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm text-zinc-100"
                  aria-label={`Age for ${c.displayName}`}
                  data-testid={`age-input-${c.name}`}
                />
                <span className="text-xs text-zinc-500">suggested {c.suggestedAge}</span>
              </li>
            ))}
          </ul>

          <div className="mt-3 flex items-center gap-3">
            <button
              type="button"
              disabled={saving || chosen.length === 0}
              onClick={() => void confirm()}
              className="rounded bg-emerald-700 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40"
              data-testid="age-confirm"
            >
              {saving ? 'Confirming…' : `Confirm ${chosen.length} age${chosen.length === 1 ? '' : 's'}`}
            </button>
            {error && <span className="text-sm text-red-400">{error}</span>}
          </div>
        </>
      )}

      {result && (
        <div className="mt-3 text-sm" data-testid="age-result">
          <p className="text-emerald-400">
            Confirmed {result.confirmed} age{result.confirmed === 1 ? '' : 's'}.
          </p>
          {result.rejected.length > 0 && (
            <ul className="mt-1 list-inside list-disc text-red-400">
              {result.rejected.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {withoutSuggestion.length > 0 && (
        <div className="mt-5 border-t border-zinc-800 pt-3" data-testid="age-no-suggestion">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-400">
            No suggestion available — {withoutSuggestion.length}
          </h3>
          <p className="mt-1 text-xs text-zinc-500">
            Nothing has estimated these. Each needs a persona generated from her photo, or an age
            typed on her own page.
          </p>
          <p className="mt-2 text-sm text-zinc-300">
            {withoutSuggestion.map((c) => c.displayName).join(', ')}
          </p>
        </div>
      )}
    </section>
  );
}
