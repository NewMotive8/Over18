import { useMemo, useState } from 'react';
import { adminCharactersApi, type AdminCharacterListItem } from '../../lib/api';
import { absoluteMediaUrl } from '../../lib/media';

/**
 * Review and assign an age to every character who has none.
 *
 * -- WHY A BULK SCREEN EXISTS AT ALL ----------------------------------------
 *
 * `characters.age` was created deliberately empty, so an established roster
 * arrives with nothing confirmed and every card showing no age. Confirming one
 * character at a time means opening each profile to discover whether there is
 * even a suggestion to accept. This shows the whole backlog on one screen.
 *
 * -- ONE LIST, NOT TWO -----------------------------------------------------
 *
 * An earlier version split the roster: a working list for characters with a
 * suggestion, and a read-only footnote naming the ones without. That made the
 * second group a dead end -- an operator could see who needed an age but had to
 * leave the screen to give them one, which is most of the work for the
 * characters that need the most attention. Every row is editable now, and a
 * suggestion is a PREFILL rather than a precondition.
 *
 * -- IT CONFIRMS; IT DOES NOT DECIDE ---------------------------------------
 *
 * Nothing is ticked by default and nothing is submitted without the button, so
 * no age reaches `characters.age` that an operator did not look at. That is the
 * distinction the column exists to protect: a confirmed age is a statement of
 * fact by a person, and a bulk screen is exactly where that would otherwise
 * erode.
 *
 * -- THE THUMBNAIL IS NOT DECORATION ---------------------------------------
 *
 * Judging an age means looking at her. A row reading "mika — 24?" is unanswerable
 * from a name, so the portrait is the one piece of evidence this screen is for.
 */


/* ------------------------------------------------------------------ *
 * The decisions, as pure functions
 * ------------------------------------------------------------------ */

/**
 * EXPORTED AND PURE BECAUSE THE SUITE HAS NO DOM. Web tests render to static
 * markup in a node environment, so there is no clicking -- which means the
 * rules below are only tested if they are reachable without a component. They
 * are also the rules that matter most: which characters appear, and what may be
 * submitted.
 */

/** Characters still needing an age, quick decisions first. */
export function pendingForAgeReview(
  characters: AdminCharacterListItem[],
): AdminCharacterListItem[] {
  return characters
    .filter((c) => c.age === null)
    .slice()
    .sort((a, b) => {
      // Suggested first: clearing those leaves a shorter list of the ones that
      // genuinely need a judgement.
      const bySuggestion = Number(b.suggestedAge !== null) - Number(a.suggestedAge !== null);
      return bySuggestion !== 0 ? bySuggestion : a.displayName.localeCompare(b.displayName);
    });
}

/** What her box shows: an edit if made, else her suggestion, else blank. */
export function ageBoxValue(
  character: AdminCharacterListItem,
  edits: Record<string, string>,
): string {
  const edited = edits[character.id];
  if (edited !== undefined) return edited;
  return character.suggestedAge === null ? '' : String(character.suggestedAge);
}

/**
 * Whether a row may be submitted: ticked AND holding a whole number.
 *
 * BOTH CONDITIONS. Ticking a character whose box is empty must not quietly send
 * nothing and read as success -- which is exactly what would happen to every
 * character who has no suggestion to prefill, and they are the majority of the
 * ones needing attention.
 */
export function rowIsReady(
  character: AdminCharacterListItem,
  selected: Record<string, boolean>,
  edits: Record<string, string>,
): boolean {
  if (!selected[character.id]) return false;
  const raw = ageBoxValue(character, edits).trim();
  if (raw === '') return false;
  const value = Number(raw);
  return Number.isInteger(value);
}

/** The payload for the confirm request. Only ready rows appear. */
export function readyConfirmations(
  pending: AdminCharacterListItem[],
  selected: Record<string, boolean>,
  edits: Record<string, string>,
): { characterId: string; age: number }[] {
  return pending
    .filter((c) => rowIsReady(c, selected, edits))
    .map((c) => ({ characterId: c.id, age: Number(ageBoxValue(c, edits).trim()) }));
}

/** Ticked rows that cannot be sent yet, so the screen can name them. */
export function tickedWithoutAge(
  pending: AdminCharacterListItem[],
  selected: Record<string, boolean>,
  edits: Record<string, string>,
): AdminCharacterListItem[] {
  return pending.filter((c) => selected[c.id] && !rowIsReady(c, selected, edits));
}

export interface AgeConfirmationPanelProps {
  characters: AdminCharacterListItem[];
  /** Called after a successful confirmation so the list reloads. */
  onConfirmed: () => void;
}

export default function AgeConfirmationPanel({
  characters,
  onConfirmed,
}: AgeConfirmationPanelProps) {
  const pending = useMemo(() => pendingForAgeReview(characters), [characters]);

  const suggestedCount = pending.filter((c) => c.suggestedAge !== null).length;

  /** Ticked rows, and the age in each box. Keyed by character id. */
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<{ confirmed: number; rejected: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const ageFor = (c: AdminCharacterListItem): string => ageBoxValue(c, edits);
  const confirmations = readyConfirmations(pending, selected, edits);
  const incomplete = tickedWithoutAge(pending, selected, edits);

  const confirm = async () => {
    setSaving(true);
    setError(null);
    setResult(null);
    try {
      if (confirmations.length === 0) {
        setError('Nothing to confirm — tick a character and give her a whole number.');
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

  if (pending.length === 0) {
    return (
      <section
        className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4"
        data-testid="age-panel"
      >
        <h2 className="text-sm font-semibold text-zinc-200">Ages</h2>
        <p className="mt-1 text-sm text-emerald-400">Every character has a confirmed age.</p>
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
          {pending.length} without one
          {suggestedCount > 0 && ` · ${suggestedCount} with a suggestion`}
        </span>
      </h2>
      <p className="mt-1 text-xs text-zinc-400">
        Her card and her own conversation both show the confirmed age, or no age at all. A
        suggestion comes from her photo and is shown to nobody until you confirm it.
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        {suggestedCount > 0 && (
          <button
            type="button"
            className="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-300"
            onClick={() =>
              setSelected((s) => ({
                ...s,
                ...Object.fromEntries(
                  pending.filter((c) => c.suggestedAge !== null).map((c) => [c.id, true]),
                ),
              }))
            }
            data-testid="age-select-suggested"
          >
            Select the {suggestedCount} with a suggestion
          </button>
        )}
        <button
          type="button"
          className="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-300"
          onClick={() => setSelected({})}
          data-testid="age-clear"
        >
          Clear
        </button>
      </div>

      <ul className="mt-3 divide-y divide-zinc-800" data-testid="age-list">
        {pending.map((c) => {
          const thumb = absoluteMediaUrl(c.profileImage);
          return (
            <li key={c.id} className="flex items-center gap-3 py-2">
              <input
                type="checkbox"
                checked={Boolean(selected[c.id])}
                onChange={(e) => setSelected((s) => ({ ...s, [c.id]: e.target.checked }))}
                aria-label={`Confirm an age for ${c.displayName}`}
                data-testid={`age-check-${c.name}`}
              />
              {thumb ? (
                <img
                  src={thumb}
                  alt={c.displayName}
                  loading="lazy"
                  className="h-12 w-12 shrink-0 rounded object-cover"
                  data-testid={`age-thumb-${c.name}`}
                />
              ) : (
                /* No portrait yet. Named rather than blank, because "no photo"
                   is itself the reason an age cannot be judged from here. */
                <span
                  className="flex h-12 w-12 shrink-0 items-center justify-center rounded bg-zinc-800 text-[10px] text-zinc-500"
                  data-testid={`age-thumb-missing-${c.name}`}
                >
                  no photo
                </span>
              )}
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
              <span className="text-xs text-zinc-500">
                {c.suggestedAge === null ? 'no suggestion' : `suggested ${c.suggestedAge}`}
              </span>
            </li>
          );
        })}
      </ul>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={saving || confirmations.length === 0}
          onClick={() => void confirm()}
          className="rounded bg-emerald-700 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40"
          data-testid="age-confirm"
        >
          {saving
            ? 'Confirming…'
            : `Confirm ${confirmations.length} age${confirmations.length === 1 ? '' : 's'}`}
        </button>
        {incomplete.length > 0 && (
          <span className="text-xs text-amber-400" data-testid="age-needs-number">
            {incomplete.length} ticked without a number:{' '}
            {incomplete.map((c) => c.displayName).join(', ')}
          </span>
        )}
        {error && <span className="text-sm text-red-400">{error}</span>}
      </div>

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
    </section>
  );
}
