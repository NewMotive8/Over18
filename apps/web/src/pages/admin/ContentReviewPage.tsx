import { useCallback, useEffect, useState } from 'react';
import {
  contentReviewApi,
  type CharacterReviewSummary,
  type ReviewAssetView,
  API_URL,
} from '../../lib/api';
import { TILE_MEDIA_CLASS, tileFrameClass } from '../../lib/mediaTile';
import {
  cancel,
  canReject,
  IDLE,
  REJECT_ACTION_LABEL,
  REJECT_CONFIRM_BODY,
  REJECT_CONFIRM_TITLE,
  requestReject,
  type DecisionIntent,
} from '../../admin/reviewDecisions';

/**
 * US-106 — the operator's morning review, character first.
 *
 * One screen, three panes: who has work waiting, that character's pending
 * content, and the selected asset's detail. The character stays visible the
 * whole time, so this is never an anonymous media grid.
 *
 * Decisions are per asset. There is no bulk approve: approving one item must
 * leave the rest pending, which is the point of the workflow.
 */
export default function ContentReviewPage() {
  const [summary, setSummary] = useState<CharacterReviewSummary[]>([]);
  const [characterId, setCharacterId] = useState<string | null>(null);
  const [assets, setAssets] = useState<ReviewAssetView[]>([]);
  const [selected, setSelected] = useState<ReviewAssetView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [intent, setIntent] = useState<DecisionIntent>(IDLE);

  const refresh = useCallback(async (nextCharacterId?: string | null) => {
    setLoading(true);
    setError(null);
    try {
      const [s, q] = await Promise.all([
        contentReviewApi.summary(),
        contentReviewApi.queue({ characterId: nextCharacterId ?? undefined }),
      ]);
      setSummary(s.characters);
      setAssets(q.assets);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the review queue.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh(characterId);
  }, [characterId, refresh]);

  async function decide(asset: ReviewAssetView, decision: 'approve' | 'reject') {
    // Rejection is destructive from the operator's point of view, so it may
    // only proceed for the exact asset they confirmed.
    if (decision === 'reject' && !canReject(intent, asset.assetId)) return;
    setIntent(IDLE);
    setBusyId(asset.assetId);
    setError(null);
    try {
      await (decision === 'approve'
        ? contentReviewApi.approve(asset.assetId)
        : contentReviewApi.reject(asset.assetId));
      // Only this asset leaves the queue; everything else stays pending.
      setAssets((prev) => prev.filter((a) => a.assetId !== asset.assetId));
      setSelected((prev) => (prev?.assetId === asset.assetId ? null : prev));
      const s = await contentReviewApi.summary();
      setSummary(s.characters);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That decision could not be saved.');
    } finally {
      setBusyId(null);
    }
  }

  const totalPending = summary.reduce((n, c) => n + c.pendingCount, 0);

  return (
    <div className="mx-auto max-w-6xl">
      <h1 className="text-xl font-semibold text-white">Review</h1>
      <p className="mt-1 text-sm text-zinc-400">
        {totalPending === 0 ? 'Nothing is waiting for review.' : `${totalPending} item${totalPending === 1 ? '' : 's'} awaiting a decision.`}
      </p>

      {error && (
        <p role="alert" className="mt-4 rounded-md border border-rose-900 bg-rose-950/40 px-4 py-2 text-sm text-rose-300">
          {error}
        </p>
      )}

      <div className="mt-6 grid gap-6 lg:grid-cols-[220px_1fr_280px]">
        {/* Character context — always visible */}
        <aside>
          <h2 className="text-xs font-medium uppercase tracking-wide text-zinc-500">Characters</h2>
          <ul className="mt-3 space-y-1">
            <li>
              <button
                type="button"
                onClick={() => setCharacterId(null)}
                aria-current={characterId === null ? 'true' : undefined}
                className={`w-full rounded-md px-3 py-2 text-left text-sm ${
                  characterId === null ? 'bg-zinc-900 text-white' : 'text-zinc-400 hover:bg-zinc-900/60'
                }`}
              >
                All characters
              </button>
            </li>
            {summary.map((c) => (
              <li key={c.characterId}>
                <button
                  type="button"
                  onClick={() => setCharacterId(c.characterId)}
                  aria-current={characterId === c.characterId ? 'true' : undefined}
                  className={`flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-sm ${
                    characterId === c.characterId ? 'bg-zinc-900 text-white' : 'text-zinc-400 hover:bg-zinc-900/60'
                  }`}
                >
                  <span className="capitalize">{c.characterName}</span>
                  <span className="ml-2 rounded bg-zinc-800 px-1.5 text-xs text-zinc-300">{c.pendingCount}</span>
                </button>
              </li>
            ))}
          </ul>
        </aside>

        <section>
          {loading ? (
            <p className="text-sm text-zinc-500">Loading…</p>
          ) : assets.length === 0 ? (
            <div className="rounded-lg border border-dashed border-zinc-800 bg-zinc-900/40 px-6 py-12 text-center">
              <p className="text-sm text-zinc-300">Queue is clear</p>
              <p className="mt-1 text-sm text-zinc-500">No content is awaiting review here.</p>
            </div>
          ) : (
            <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {assets.map((a) => (
                <li key={a.assetId}>
                  <button
                    type="button"
                    onClick={() => {
                      setSelected(a);
                      setIntent(IDLE);
                    }}
                    className={`w-full overflow-hidden rounded-lg border text-left transition-colors ${
                      selected?.assetId === a.assetId
                        ? 'border-rose-600'
                        : 'border-zinc-800 hover:border-zinc-700'
                    }`}
                  >
                    {/* Same fixed frame and the same fitting rule as the
                        Library grid — see lib/mediaTile. Contain, not cover:
                        a reviewer must judge the whole asset, not a crop. */}
                    <div className={tileFrameClass()}>
                      {a.storageKey && a.mediaType === 'image' ? (
                        <img
                          src={`${API_URL}${a.storageKey}`}
                          alt=""
                          className={TILE_MEDIA_CLASS}
                          loading="lazy"
                        />
                      ) : (
                        <div className="flex h-full items-center justify-center text-xs uppercase tracking-wide text-zinc-600">
                          {a.mediaType}
                        </div>
                      )}
                    </div>
                    <div className="px-2 py-1.5">
                      <p className="truncate text-xs capitalize text-zinc-300">{a.characterName}</p>
                      <p className="text-[10px] uppercase tracking-wide text-zinc-600">{a.mediaType}</p>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Asset detail */}
        <aside>
          {selected ? (
            <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
              <p className="text-sm font-medium capitalize text-white">{selected.characterName}</p>
              <p className="text-xs text-zinc-500">{selected.mediaType} · {selected.status}</p>

              <div className="mt-3 overflow-hidden rounded bg-zinc-950">
                {selected.storageKey && selected.mediaType === 'video' ? (
                  <video src={`${API_URL}${selected.storageKey}`} controls muted playsInline className="w-full" />
                ) : selected.storageKey ? (
                  <img src={`${API_URL}${selected.storageKey}`} alt="" className="w-full" />
                ) : null}
              </div>

              <dl className="mt-4 space-y-1 text-xs text-zinc-400">
                <div className="flex justify-between gap-2">
                  <dt>Rating</dt><dd className="text-zinc-300">{selected.contentRating}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt>Primary</dt><dd className="text-zinc-300">{selected.isPrimary ? 'Yes' : 'No'}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt>Created</dt>
                  <dd className="text-zinc-300">{new Date(selected.createdAt).toLocaleString()}</dd>
                </div>
                {selected.provenance.provider && (
                  <div className="flex justify-between gap-2">
                    <dt>Source</dt>
                    <dd className="truncate text-zinc-300">{selected.provenance.provider} · {selected.provenance.model}</dd>
                  </div>
                )}
              </dl>

              {canReject(intent, selected.assetId) ? (
                <div
                  role="alertdialog"
                  aria-label={REJECT_CONFIRM_TITLE}
                  className="mt-4 rounded-md border border-rose-900 bg-rose-950/30 p-3"
                >
                  <p className="text-sm font-medium text-white">{REJECT_CONFIRM_TITLE}</p>
                  <p className="mt-1 text-xs leading-snug text-zinc-400">{REJECT_CONFIRM_BODY}</p>
                  <div className="mt-3 flex gap-2">
                    <button
                      type="button"
                      onClick={() => setIntent(cancel())}
                      className="flex-1 rounded-md border border-zinc-700 px-3 py-2 text-sm text-zinc-300"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      disabled={busyId === selected.assetId}
                      onClick={() => void decide(selected, 'reject')}
                      className="flex-1 rounded-md bg-rose-700 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
                    >
                      {REJECT_ACTION_LABEL}
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="mt-4 flex gap-2">
                    <button
                      type="button"
                      disabled={busyId === selected.assetId}
                      onClick={() => void decide(selected, 'approve')}
                      className="flex-1 rounded-md bg-rose-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
                    >
                      Approve
                    </button>
                    <button
                      type="button"
                      disabled={busyId === selected.assetId}
                      onClick={() => setIntent(requestReject(selected.assetId))}
                      className="flex-1 rounded-md border border-zinc-700 px-3 py-2 text-sm text-zinc-300 disabled:opacity-50"
                    >
                      {REJECT_ACTION_LABEL}
                    </button>
                  </div>
                  <p className="mt-2 text-[11px] leading-snug text-zinc-600">
                    Approving keeps content in the workflow for publishing later. Rejecting removes
                    it from the active workflow.
                  </p>
                </>
              )}
            </div>
          ) : (
            <p className="text-sm text-zinc-500">Select an item to inspect it.</p>
          )}
        </aside>
      </div>
    </div>
  );
}
