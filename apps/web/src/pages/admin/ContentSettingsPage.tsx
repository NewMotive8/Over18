import { useCallback, useEffect, useState } from 'react';
import {
  ApiRequestError,
  contentRequirementsApi,
  type CharacterProgressView,
  type ContentRequirementRowView,
  type RequirementTotals,
} from '../../lib/api';
import { configurationSummary, impactOf } from '../../admin/requirementBoard';

/**
 * Admin → Settings → Content requirements.
 *
 * The definition of what every character needs. It is deliberately not a bare
 * CRUD table: an operator changing a number needs to see the CONSEQUENCE before
 * saving — how many characters are affected, and the reassurance that changing
 * a requirement re-plans work rather than deleting content.
 *
 * Every category shown here is a database row. Nothing in this application
 * declares a category or a quantity.
 */

type Pending = Record<string, number>;

export default function ContentSettingsPage() {
  const [rows, setRows] = useState<ContentRequirementRowView[] | null>(null);
  const [totals, setTotals] = useState<RequirementTotals>({ items: 0, images: 0, videos: 0 });
  const [characters, setCharacters] = useState<CharacterProgressView[]>([]);
  const [pending, setPending] = useState<Pending>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<{ label: string; mediaType: 'image' | 'video'; quantity: number }>(
    { label: '', mediaType: 'video', quantity: 1 },
  );

  const load = useCallback(async () => {
    setError(null);
    try {
      const [config, impact] = await Promise.all([
        contentRequirementsApi.list(),
        contentRequirementsApi.impact(),
      ]);
      setRows(config.requirements);
      setTotals(config.totals);
      setCharacters(impact.characters);
      setPending({});
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't load the content requirements.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(action: () => Promise<unknown>, failure: string, success?: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      await load();
      if (success) setNotice(success);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : failure);
    } finally {
      setBusy(false);
    }
  }

  /** Quantity edits are staged, so the impact can be read before committing. */
  const quantityOf = (row: ContentRequirementRowView) =>
    pending[row.id] ?? row.requiredQuantity;
  const dirty = rows?.filter((r) => quantityOf(r) !== r.requiredQuantity) ?? [];

  const previewTotals = (rows ?? [])
    .filter((r) => r.enabled)
    .reduce<RequirementTotals>(
      (acc, r) => {
        const q = quantityOf(r);
        return {
          items: acc.items + q,
          images: acc.images + (r.mediaType === 'image' ? q : 0),
          videos: acc.videos + (r.mediaType === 'video' ? q : 0),
        };
      },
      { items: 0, images: 0, videos: 0 },
    );

  return (
    <div className="mx-auto max-w-4xl">
      <h1 className="text-xl font-semibold text-white">Content requirements</h1>
      <p className="mt-1 text-sm text-zinc-400">
        What every character needs. This is the single source of truth for the Review board,
        character completion, and generating what is missing.
      </p>

      {error && (
        <p
          role="alert"
          className="mt-4 rounded-md border border-rose-900 bg-rose-950/40 px-4 py-2 text-sm text-rose-300"
        >
          {error}
        </p>
      )}
      {notice && (
        <p className="mt-4 rounded-md border border-emerald-900 bg-emerald-950/30 px-4 py-2 text-sm text-emerald-300">
          {notice}
        </p>
      )}

      {rows === null ? (
        <p className="mt-6 text-sm text-zinc-500">Loading…</p>
      ) : (
        <>
          <section className="mt-6 overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900/40">
            <header className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
              <h2 className="text-xs font-medium uppercase tracking-wide text-zinc-500">
                Requirements
              </h2>
              <button
                type="button"
                onClick={() => setAdding((a) => !a)}
                className="rounded-lg bg-rose-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-rose-500"
              >
                {adding ? 'Cancel' : 'Add requirement'}
              </button>
            </header>

            {adding && (
              <div className="flex flex-wrap items-end gap-3 border-b border-zinc-800 bg-zinc-950/40 px-4 py-3">
                <label className="flex-1">
                  <span className="text-[11px] uppercase tracking-wide text-zinc-500">Name</span>
                  <input
                    type="text"
                    value={draft.label}
                    onChange={(e) => setDraft({ ...draft, label: e.target.value })}
                    placeholder="Behind the scenes"
                    className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-100"
                  />
                </label>
                <label>
                  <span className="text-[11px] uppercase tracking-wide text-zinc-500">Media</span>
                  <select
                    value={draft.mediaType}
                    onChange={(e) =>
                      setDraft({ ...draft, mediaType: e.target.value as 'image' | 'video' })
                    }
                    className="mt-1 block rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-100"
                  >
                    <option value="image">Image</option>
                    <option value="video">Video</option>
                  </select>
                </label>
                <label>
                  <span className="text-[11px] uppercase tracking-wide text-zinc-500">Required</span>
                  <input
                    type="number"
                    min={0}
                    value={draft.quantity}
                    onChange={(e) => setDraft({ ...draft, quantity: Number(e.target.value) })}
                    className="mt-1 block w-20 rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-100"
                  />
                </label>
                <button
                  type="button"
                  disabled={busy || draft.label.trim().length === 0}
                  onClick={() =>
                    void run(
                      async () => {
                        await contentRequirementsApi.create({
                          label: draft.label,
                          mediaType: draft.mediaType,
                          requiredQuantity: draft.quantity,
                        });
                        setDraft({ label: '', mediaType: 'video', quantity: 1 });
                        setAdding(false);
                      },
                      "That requirement couldn't be added.",
                      'Requirement added.',
                    )
                  }
                  className="rounded-lg bg-rose-600 px-3 py-2 text-sm font-medium text-white hover:bg-rose-500 disabled:opacity-40"
                >
                  Add
                </button>
              </div>
            )}

            <table className="w-full">
              <thead>
                <tr className="border-b border-zinc-800 text-left text-[11px] uppercase tracking-wide text-zinc-500">
                  <th className="px-4 py-2.5 font-medium">Category</th>
                  <th className="w-24 px-4 py-2.5 font-medium">Media</th>
                  <th className="w-32 px-4 py-2.5 font-medium">Required</th>
                  <th className="w-32 px-4 py-2.5 font-medium">Rating policy</th>
                  <th className="w-28 px-4 py-2.5 font-medium">Enabled</th>
                  <th className="w-20 px-4 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr
                    key={row.id}
                    className={`border-b border-zinc-800 last:border-b-0 ${
                      row.enabled ? '' : 'opacity-50'
                    }`}
                  >
                    <td className="px-4 py-3">
                      <input
                        type="text"
                        defaultValue={row.label}
                        onBlur={(e) => {
                          const label = e.target.value.trim();
                          if (label && label !== row.label) {
                            void run(
                              () => contentRequirementsApi.update(row.id, { label }),
                              "That name couldn't be saved.",
                            );
                          }
                        }}
                        className="w-full border-0 bg-transparent p-0 text-sm text-zinc-200 focus:outline-none focus:ring-0"
                      />
                      <span className="font-mono text-[11px] text-zinc-600">{row.key}</span>
                      {row.assignPrimaryReference && (
                        <span className="ml-2 rounded border border-zinc-800 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-zinc-500">
                          Primary image
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-sm capitalize text-zinc-400">{row.mediaType}</td>
                    <td className="px-4 py-3">
                      <div className="inline-flex items-center overflow-hidden rounded-lg border border-zinc-700">
                        <button
                          type="button"
                          disabled={busy || quantityOf(row) === 0}
                          onClick={() =>
                            setPending((p) => ({ ...p, [row.id]: Math.max(0, quantityOf(row) - 1) }))
                          }
                          className="px-2.5 py-1 text-zinc-400 hover:bg-zinc-800 hover:text-white disabled:opacity-40"
                          aria-label={`One fewer ${row.label}`}
                        >
                          −
                        </button>
                        <span
                          className={`border-x border-zinc-700 px-3 py-1 text-sm tabular-nums ${
                            quantityOf(row) === row.requiredQuantity
                              ? 'text-zinc-200'
                              : 'text-amber-300'
                          }`}
                        >
                          {quantityOf(row)}
                        </span>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => setPending((p) => ({ ...p, [row.id]: quantityOf(row) + 1 }))}
                          className="px-2.5 py-1 text-zinc-400 hover:bg-zinc-800 hover:text-white disabled:opacity-40"
                          aria-label={`One more ${row.label}`}
                        >
                          +
                        </button>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <select
                        value={row.contentRating ?? 'any'}
                        disabled={busy}
                        onChange={(e) =>
                          void run(
                            () =>
                              contentRequirementsApi.update(row.id, {
                                contentRating:
                                  e.target.value === 'any'
                                    ? null
                                    : (e.target.value as 'sfw' | 'explicit'),
                              }),
                            "That rating policy couldn't be saved.",
                          )
                        }
                        className="rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-100"
                      >
                        <option value="sfw">sfw</option>
                        <option value="explicit">explicit</option>
                        <option value="any">any</option>
                      </select>
                    </td>
                    <td className="px-4 py-3">
                      <button
                        type="button"
                        role="switch"
                        aria-checked={row.enabled}
                        aria-label={`${row.enabled ? 'Disable' : 'Enable'} ${row.label}`}
                        disabled={busy}
                        onClick={() =>
                          void run(
                            () => contentRequirementsApi.update(row.id, { enabled: !row.enabled }),
                            "That change couldn't be saved.",
                            row.enabled
                              ? `${row.label} disabled. Its content is untouched and returns if you enable it again.`
                              : `${row.label} is back on the board.`,
                          )
                        }
                        className={`relative h-5 w-9 rounded-full transition-colors ${
                          row.enabled ? 'bg-rose-600/60' : 'bg-zinc-700'
                        }`}
                      >
                        <span
                          className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${
                            row.enabled ? 'left-[18px]' : 'left-0.5 bg-zinc-400'
                          }`}
                        />
                      </button>
                    </td>
                    <td className="px-4 py-3 text-right">
                      {row.assignedAssetCount === 0 ? (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            void run(
                              () => contentRequirementsApi.remove(row.id),
                              "That requirement couldn't be removed.",
                              'Requirement removed.',
                            )
                          }
                          className="text-[11px] uppercase tracking-wide text-zinc-600 hover:text-zinc-300 disabled:opacity-50"
                        >
                          Remove
                        </button>
                      ) : (
                        <span
                          className="text-[11px] text-zinc-700"
                          title={`${row.assignedAssetCount} item${row.assignedAssetCount === 1 ? '' : 's'} filed here — disable it instead of deleting.`}
                        >
                          {row.assignedAssetCount} filed
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <p className="border-t border-zinc-800 bg-zinc-950/50 px-4 py-3 text-sm text-zinc-400">
              {configurationSummary(dirty.length > 0 ? previewTotals : totals)}
            </p>
          </section>

          {dirty.length > 0 && (
            <div className="mt-4 rounded-lg border border-amber-900/40 bg-amber-950/10 px-4 py-3">
              <p className="text-sm font-medium text-amber-300">
                Unsaved change
                {dirty.length > 1 ? 's' : ''} —{' '}
                {dirty
                  .map((r) => `${r.label} ${r.requiredQuantity} → ${quantityOf(r)}`)
                  .join(', ')}
                .
              </p>
              <ul className="mt-1.5 space-y-1">
                {dirty.map((r) => (
                  <li key={r.id} className="text-xs text-zinc-400">
                    {impactOf(r.label, r.requiredQuantity, quantityOf(r), characters.length)}
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-xs text-zinc-500">
                Changing a requirement never deletes, regenerates or re-files existing content — it
                only changes what counts as missing from now on.
              </p>
              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void run(
                      async () => {
                        for (const row of dirty) {
                          await contentRequirementsApi.update(row.id, {
                            requiredQuantity: quantityOf(row),
                          });
                        }
                      },
                      "Those quantities couldn't be saved.",
                      'Requirements updated. No content was changed.',
                    )
                  }
                  className="rounded-lg bg-rose-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-rose-500 disabled:opacity-50"
                >
                  Save requirements
                </button>
                <button
                  type="button"
                  onClick={() => setPending({})}
                  className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300"
                >
                  Discard
                </button>
              </div>
            </div>
          )}

          <section className="mt-8 overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900/40">
            <header className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
              <h2 className="text-xs font-medium uppercase tracking-wide text-zinc-500">
                Effect on characters
              </h2>
              <span className="text-xs text-zinc-600">
                {dirty.length > 0 ? 'saved configuration — save to apply your change' : 'live'}
              </span>
            </header>
            {characters.length === 0 ? (
              <p className="px-4 py-6 text-sm text-zinc-500">No characters yet.</p>
            ) : (
              <table className="w-full">
                <thead>
                  <tr className="border-b border-zinc-800 text-left text-[11px] uppercase tracking-wide text-zinc-500">
                    <th className="px-4 py-2.5 font-medium">Character</th>
                    <th className="w-36 px-4 py-2.5 font-medium">Approved</th>
                    <th className="w-36 px-4 py-2.5 font-medium">Awaiting review</th>
                    <th className="w-28 px-4 py-2.5 font-medium">Missing</th>
                  </tr>
                </thead>
                <tbody>
                  {characters.map((c) => (
                    <tr key={c.characterId} className="border-b border-zinc-800 last:border-b-0">
                      <td className="px-4 py-2.5 text-sm capitalize text-zinc-300">
                        {c.displayName}
                      </td>
                      <td className="px-4 py-2.5 text-sm tabular-nums text-zinc-400">
                        {c.approved} / {c.required}
                      </td>
                      <td className="px-4 py-2.5 text-sm tabular-nums text-zinc-400">{c.pending}</td>
                      <td
                        className={`px-4 py-2.5 text-sm tabular-nums ${
                          c.missing > 0 ? 'text-amber-400' : 'text-emerald-500'
                        }`}
                      >
                        {c.missing}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </>
      )}
    </div>
  );
}
