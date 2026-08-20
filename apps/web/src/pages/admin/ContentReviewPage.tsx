import { useCallback, useEffect, useRef, useState } from 'react';
import {
  API_URL,
  ApiRequestError,
  contentReviewApi,
  type InboxItemView,
  type RequirementEntryView,
  type ReviewAssetView,
  type ReviewWorkspaceView,
  type TriageAssetView,
} from '../../lib/api';
import { TILE_MEDIA_CLASS, tileFrameClass } from '../../lib/mediaTile';
import {
  buildSlots,
  categoryOptions,
  groupByMedia,
  progressPercent,
  requirementSummary,
  triageExplanation,
  type BoardSlot,
} from '../../admin/requirementBoard';
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
 * Review — the content production workspace.
 *
 * This screen answers four questions at a glance: what does this character
 * need, what exists, what is waiting for a decision, and what is still missing.
 * The structure comes entirely from the configured content requirements, so
 * nothing here knows a category name or a quantity: change the configuration in
 * Settings and this board changes on its next load.
 *
 * Slots are capacity, not records. A requirement stores a category and a
 * number; the board draws that many places for content to sit.
 *
 * Decisions stay per asset — approving one item leaves the rest pending — and
 * rejection still goes through the existing confirmation state machine.
 */

const EMPTY_CATEGORY = '__none__';

export default function ContentReviewPage() {
  const [workspace, setWorkspace] = useState<ReviewWorkspaceView | null>(null);
  const [inbox, setInbox] = useState<InboxItemView[]>([]);
  const [characterId, setCharacterId] = useState<string | null>(null);
  const [view, setView] = useState<'board' | 'inbox'>('board');
  const [selected, setSelected] = useState<ReviewAssetView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [intent, setIntent] = useState<DecisionIntent>(IDLE);
  const uploadTarget = useRef<{ characterId: string; requirementKey?: string } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const inboxInput = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async (nextCharacterId?: string | null) => {
    setError(null);
    try {
      const [next, queue] = await Promise.all([
        contentReviewApi.workspace(nextCharacterId ?? undefined),
        contentReviewApi.inbox(),
      ]);
      setWorkspace(next);
      setInbox(queue.items);
      // Re-point the inspector at the refreshed row. Without this the panel
      // keeps a stale copy, and a category just changed appears to snap back.
      setSelected((prev) => {
        if (!prev) return prev;
        const all = [
          ...(next.selected?.requirements.flatMap((r) => r.assets) ?? []),
          ...(next.selected?.triage ?? []),
        ];
        return all.find((a) => a.assetId === prev.assetId) ?? null;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the review workspace.');
    }
  }, []);

  useEffect(() => {
    void refresh(characterId);
  }, [characterId, refresh]);

  async function run(action: () => Promise<unknown>, failure: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await action();
      await refresh(characterId);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : failure);
    } finally {
      setBusy(false);
    }
  }

  async function decide(asset: ReviewAssetView, decision: 'approve' | 'reject') {
    if (decision === 'reject' && !canReject(intent, asset.assetId)) return;
    setIntent(IDLE);
    setSelected((prev) => (prev?.assetId === asset.assetId ? null : prev));
    await run(
      () =>
        decision === 'approve'
          ? contentReviewApi.approve(asset.assetId)
          : contentReviewApi.reject(asset.assetId),
      'That decision could not be saved.',
    );
  }

  const selectedBoard = workspace?.selected ?? null;
  const requirements = workspace?.requirements ?? [];
  // Categories are offered per MEDIUM: a video filed under an image category
  // would be stored, look filed, and count toward nothing.
  const optionsFor = (mediaType?: 'image' | 'video') =>
    categoryOptions(requirements, mediaType);

  return (
    <div className="mx-auto max-w-6xl">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-white">Review</h1>
          <p className="mt-1 text-sm text-zinc-400">
            {/* Loading is not the same as "nothing configured" — saying so
                before the configuration arrives would be a lie on every load. */}
            {workspace !== null && requirements.length === 0
              ? 'No content requirements are configured yet — set them up in Settings.'
              : 'Required content, per character. Approve what is good; the rest stays here.'}
          </p>
        </div>
        <div>
          {/* One file input, reused: the target (character, and optionally a
              category) is set by whichever empty slot was clicked. */}
          <input
            ref={fileInput}
            type="file"
            accept="image/jpeg,image/png,image/webp,video/mp4,video/webm,video/quicktime"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              const target = uploadTarget.current;
              if (!file || !target) return;
              void run(
                () =>
                  contentReviewApi.uploadForCharacter(
                    file,
                    target.characterId,
                    target.requirementKey,
                  ),
                "That file couldn't be uploaded.",
              );
            }}
          />
          <input
            ref={inboxInput}
            type="file"
            accept="image/jpeg,image/png,image/webp,video/mp4,video/webm,video/quicktime"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (!file) return;
              void run(() => contentReviewApi.uploadToInbox(file), "That file couldn't be uploaded.");
            }}
          />
          <button
            type="button"
            disabled={busy}
            onClick={() => inboxInput.current?.click()}
            className="rounded-lg bg-rose-600 px-4 py-2 text-sm font-medium text-white hover:bg-rose-500 disabled:opacity-50"
          >
            Upload
          </button>
          <p className="mt-1 text-right text-[11px] text-zinc-600">No character needed</p>
        </div>
      </div>

      {error && (
        <p
          role="alert"
          className="mt-4 rounded-md border border-rose-900 bg-rose-950/40 px-4 py-2 text-sm text-rose-300"
        >
          {error}
        </p>
      )}

      <div className="mt-6 grid gap-6 lg:grid-cols-[220px_minmax(0,1fr)_290px]">
        {/* ── rail ─────────────────────────────────────────── */}
        <aside>
          <h2 className="text-xs font-medium uppercase tracking-wide text-zinc-500">Intake</h2>
          <button
            type="button"
            onClick={() => setView('inbox')}
            aria-current={view === 'inbox' ? 'true' : undefined}
            className={`mt-3 flex w-full items-center justify-between rounded-lg border border-dashed px-3 py-2 text-left text-sm ${
              view === 'inbox'
                ? 'border-rose-700 bg-zinc-900 text-white'
                : 'border-zinc-700 text-zinc-400 hover:bg-zinc-900/60'
            }`}
          >
            <span>Inbox</span>
            {inbox.length > 0 && (
              <span className="rounded-full bg-rose-600 px-2 text-xs text-white">{inbox.length}</span>
            )}
          </button>

          <h2 className="mt-6 text-xs font-medium uppercase tracking-wide text-zinc-500">
            Characters
          </h2>
          <ul className="mt-3 space-y-1">
            {(workspace?.characters ?? []).map((c) => (
              <li key={c.characterId}>
                <button
                  type="button"
                  onClick={() => {
                    setCharacterId(c.characterId);
                    setView('board');
                    setSelected(null);
                  }}
                  aria-current={
                    view === 'board' && characterId === c.characterId ? 'true' : undefined
                  }
                  className={`flex w-full items-center justify-between gap-2 rounded-md px-3 py-2 text-left text-sm ${
                    view === 'board' && characterId === c.characterId
                      ? 'bg-zinc-900 text-white'
                      : 'text-zinc-400 hover:bg-zinc-900/60'
                  }`}
                >
                  <span className="truncate capitalize">{c.displayName}</span>
                  <span
                    className={`shrink-0 text-xs tabular-nums ${
                      c.complete ? 'text-emerald-500' : 'text-zinc-500'
                    }`}
                  >
                    {c.approved}/{c.required}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </aside>

        {/* ── board / inbox ────────────────────────────────── */}
        <section>
          {view === 'inbox' ? (
            <InboxPanel
              items={inbox}
              busy={busy}
              characters={workspace?.characters ?? []}
              optionsFor={optionsFor}
              onAssign={(inboxId, body) =>
                run(
                  () => contentReviewApi.assignInboxItem(inboxId, body),
                  "That upload couldn't be assigned.",
                )
              }
              onDiscard={(inboxId) =>
                run(
                  () => contentReviewApi.discardInboxItem(inboxId),
                  "That upload couldn't be discarded.",
                )
              }
              onUpload={() => inboxInput.current?.click()}
            />
          ) : !selectedBoard ? (
            <div className="rounded-lg border border-dashed border-zinc-800 bg-zinc-900/40 px-6 py-12 text-center">
              <p className="text-sm text-zinc-300">Choose a character</p>
              <p className="mt-1 text-sm text-zinc-500">
                Their required content appears here, with what is missing.
              </p>
            </div>
          ) : (
            <>
              <header className="flex items-end justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <h2 className="text-lg font-semibold capitalize text-white">
                    {selectedBoard.character.displayName}
                  </h2>
                  {/* Two spans in one bar, so they must never total more than
                      100%: approved first, then pending only as far as the
                      remaining capacity. With nothing required, neither shows. */}
                  <div className="mt-2 flex h-1.5 overflow-hidden rounded-full bg-zinc-900">
                    {selectedBoard.totals.required > 0 && (
                      <>
                        <span
                          className="bg-emerald-500"
                          style={{
                            width: `${progressPercent(selectedBoard.totals.approved, selectedBoard.totals.required)}%`,
                          }}
                        />
                        <span
                          className="bg-amber-500"
                          style={{
                            width: `${progressPercent(
                              Math.min(
                                selectedBoard.totals.pending,
                                Math.max(
                                  0,
                                  selectedBoard.totals.required - selectedBoard.totals.approved,
                                ),
                              ),
                              selectedBoard.totals.required,
                            )}%`,
                          }}
                        />
                      </>
                    )}
                  </div>
                  <p className="mt-2 flex flex-wrap gap-x-4 text-xs text-zinc-500">
                    <span>
                      <b className="font-medium text-zinc-300">{selectedBoard.totals.approved}</b> of{' '}
                      {selectedBoard.totals.required} approved
                    </span>
                    <span>
                      <b className="font-medium text-zinc-300">{selectedBoard.totals.pending}</b>{' '}
                      awaiting review
                    </span>
                    <span>
                      <b className="font-medium text-zinc-300">{selectedBoard.totals.missing}</b>{' '}
                      still missing
                    </span>
                  </p>
                </div>
              </header>

              {selectedBoard.requirements.length === 0 ? (
                <div className="mt-6 rounded-lg border border-dashed border-zinc-800 px-6 py-10 text-center text-sm text-zinc-500">
                  No content requirements are configured. Add them in Settings and they appear here.
                </div>
              ) : (
                groupByMedia(selectedBoard.requirements).map((group) => (
                  <div key={group.mediaType} className="mt-7">
                    <h3 className="border-b border-zinc-800 pb-2 text-xs font-medium uppercase tracking-wide text-zinc-500">
                      {group.label}
                    </h3>
                    {group.entries.map((entry) => (
                      <RequirementRow
                        key={entry.key}
                        entry={entry}
                        selectedId={selected?.assetId ?? null}
                        busy={busy}
                        onSelect={(asset) => {
                          setSelected(asset);
                          setIntent(IDLE);
                        }}
                        onApprove={(asset) => void decide(asset, 'approve')}
                        onUploadHere={() => {
                          uploadTarget.current = {
                            characterId: selectedBoard.character.id,
                            requirementKey: entry.key,
                          };
                          fileInput.current?.click();
                        }}
                      />
                    ))}
                  </div>
                ))
              )}

              {selectedBoard.triage.length > 0 && (
                <TriagePanel
                  items={selectedBoard.triage}
                  optionsFor={optionsFor}
                  busy={busy}
                  onFile={(assetId, key) =>
                    run(
                      () => contentReviewApi.setRequirement(assetId, key),
                      "That item couldn't be filed.",
                    )
                  }
                />
              )}
            </>
          )}
        </section>

        {/* ── inspector ────────────────────────────────────── */}
        <aside>
          {selected ? (
            <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
              <p className="text-sm font-medium capitalize text-white">{selected.characterName}</p>
              <p className="text-xs text-zinc-500">
                {selected.mediaType} · {selected.status.replace('_', ' ')}
              </p>

              <div className="mt-3 overflow-hidden rounded bg-zinc-950">
                {selected.storageKey && selected.mediaType === 'video' ? (
                  <video
                    src={`${API_URL}${selected.storageKey}`}
                    controls
                    muted
                    playsInline
                    className="w-full"
                  />
                ) : selected.storageKey ? (
                  <img src={`${API_URL}${selected.storageKey}`} alt="" className="w-full" />
                ) : null}
              </div>

              <dl className="mt-4 space-y-1 text-xs text-zinc-400">
                <div className="flex justify-between gap-2">
                  <dt>Rating</dt>
                  <dd className="text-zinc-300">{selected.contentRating}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt>Primary</dt>
                  <dd className="text-zinc-300">{selected.isPrimary ? 'Yes' : 'No'}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt>Added</dt>
                  <dd className="text-zinc-300">{new Date(selected.createdAt).toLocaleString()}</dd>
                </div>
                {selected.provenance.provider && (
                  <div className="flex justify-between gap-2">
                    <dt>Source</dt>
                    <dd className="truncate text-zinc-300">
                      {selected.provenance.provider} · {selected.provenance.model}
                    </dd>
                  </div>
                )}
              </dl>

              <label className="mt-4 block">
                <span className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">
                  Content category
                </span>
                <select
                  value={selected.requirementKey ?? EMPTY_CATEGORY}
                  disabled={busy}
                  onChange={(e) => {
                    const value = e.target.value;
                    void run(
                      () =>
                        contentReviewApi.setRequirement(
                          selected.assetId,
                          value === EMPTY_CATEGORY ? null : value,
                        ),
                      "That item couldn't be filed.",
                    );
                  }}
                  className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-100"
                >
                  <option value={EMPTY_CATEGORY}>— Uncategorised —</option>
                  {optionsFor(selected.mediaType).map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>

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
                      disabled={busy}
                      onClick={() => void decide(selected, 'reject')}
                      className="flex-1 rounded-md bg-rose-700 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
                    >
                      {REJECT_ACTION_LABEL}
                    </button>
                  </div>
                </div>
              ) : (
                selected.status !== 'approved' && (
                  <>
                    <div className="mt-4 flex gap-2">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void decide(selected, 'approve')}
                        className="flex-1 rounded-md bg-rose-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
                      >
                        Approve
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => setIntent(requestReject(selected.assetId))}
                        className="flex-1 rounded-md border border-zinc-700 px-3 py-2 text-sm text-zinc-300 disabled:opacity-50"
                      >
                        {REJECT_ACTION_LABEL}
                      </button>
                    </div>
                    <p className="mt-2 text-[11px] leading-snug text-zinc-600">
                      Approving counts this toward the character&rsquo;s requirement and adds it to
                      the Library. Rejecting removes it from the active workflow.
                    </p>
                  </>
                )
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

/* ------------------------------------------------------------------ *
 * One requirement: its capacity, and what is sitting in it
 * ------------------------------------------------------------------ */

function RequirementRow({
  entry,
  selectedId,
  busy,
  onSelect,
  onApprove,
  onUploadHere,
}: {
  entry: RequirementEntryView;
  selectedId: string | null;
  busy: boolean;
  onSelect: (asset: ReviewAssetView) => void;
  onApprove: (asset: ReviewAssetView) => void;
  onUploadHere: () => void;
}) {
  const slots = buildSlots(entry);
  return (
    <div className="mt-4">
      <div className="flex items-center gap-2.5">
        <span className="text-[13px] font-medium text-zinc-200">{entry.label}</span>
        <span className="text-xs tabular-nums text-zinc-500">{requirementSummary(entry)}</span>
        {entry.satisfied && <span className="text-xs text-emerald-500">✓</span>}
        {entry.pending > 0 && (
          <span className="text-[11px] uppercase tracking-wide text-amber-500">
            {entry.pending} awaiting
          </span>
        )}
        {entry.contentRating && (
          <span className="ml-auto rounded border border-zinc-800 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-zinc-600">
            {entry.contentRating}
          </span>
        )}
      </div>

      <ul className="mt-2.5 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        {slots.map((slot) => (
          <li key={slot.id}>
            <Slot
              slot={slot}
              selected={slot.asset?.assetId === selectedId}
              busy={busy}
              onSelect={onSelect}
              onApprove={onApprove}
              onUploadHere={onUploadHere}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

function Slot({
  slot,
  selected,
  busy,
  onSelect,
  onApprove,
  onUploadHere,
}: {
  slot: BoardSlot;
  selected: boolean;
  busy: boolean;
  onSelect: (asset: ReviewAssetView) => void;
  onApprove: (asset: ReviewAssetView) => void;
  onUploadHere: () => void;
}) {
  if (!slot.asset) {
    return (
      <div className="flex aspect-[3/4] flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-zinc-700 p-2.5 text-center">
        <span className="text-[11px] uppercase tracking-wide text-zinc-600">Empty</span>
        <button
          type="button"
          disabled={busy}
          onClick={onUploadHere}
          className="w-full rounded-md bg-rose-600/90 px-2 py-1.5 text-[11px] font-medium text-white hover:bg-rose-500 disabled:opacity-50"
        >
          Upload here
        </button>
      </div>
    );
  }

  const asset = slot.asset;
  const pending = slot.state === 'pending';
  return (
    <div
      className={`overflow-hidden rounded-lg border ${
        selected
          ? 'border-rose-600 ring-1 ring-rose-600'
          : pending
            ? 'border-amber-600/50'
            : 'border-emerald-700/40'
      }`}
    >
      <button
        type="button"
        onClick={() => onSelect(asset)}
        className="block w-full text-left"
        aria-label={`Inspect ${asset.mediaType}`}
      >
        {/* Same fixed frame and the same fitting rule as the Library grid —
            see lib/mediaTile. Contain, not cover: a reviewer must judge the
            whole asset, never a crop of it. */}
        <div className={`${tileFrameClass()} flex items-center justify-center`}>
          {asset.storageKey && asset.mediaType === 'image' ? (
            <img
              src={`${API_URL}${asset.storageKey}`}
              alt=""
              loading="lazy"
              className={TILE_MEDIA_CLASS}
            />
          ) : (
            <span className="text-xs uppercase tracking-wide text-zinc-600">{asset.mediaType}</span>
          )}
          <span
            className={`absolute bottom-1.5 left-1.5 rounded-full px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${
              pending
                ? 'bg-amber-950/80 text-amber-300'
                : 'bg-emerald-950/80 text-emerald-300'
            }`}
          >
            {pending ? 'Awaiting review' : 'Approved'}
          </span>
          {slot.surplus && (
            <span className="absolute right-1.5 top-1.5 rounded bg-zinc-900/90 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-zinc-400">
              Extra
            </span>
          )}
        </div>
      </button>
      {pending && (
        <div className="px-2 pb-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => onApprove(asset)}
            className="w-full rounded-md bg-rose-600 px-2 py-1.5 text-[11px] font-medium text-white hover:bg-rose-500 disabled:opacity-50"
          >
            Approve
          </button>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Needs triage — content counting toward nothing, and why
 * ------------------------------------------------------------------ */

function TriagePanel({
  items,
  optionsFor,
  busy,
  onFile,
}: {
  items: TriageAssetView[];
  optionsFor: (mediaType?: 'image' | 'video') => Array<{ value: string; label: string }>;
  busy: boolean;
  onFile: (assetId: string, requirementKey: string | null) => void;
}) {
  return (
    <div className="mt-8 rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-xs font-medium uppercase tracking-wide text-zinc-500">
          Needs triage — {items.length} item{items.length === 1 ? '' : 's'} counting toward nothing
        </h3>
        <span className="text-xs text-zinc-600">Pick a category to place them on the board</span>
      </div>
      <ul className="mt-3 space-y-3">
        {items.map((item) => (
          <li key={item.assetId} className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <div className="h-12 w-9 shrink-0 overflow-hidden rounded bg-zinc-950">
                {item.storageKey && item.mediaType === 'image' && (
                  <img
                    src={`${API_URL}${item.storageKey}`}
                    alt=""
                    loading="lazy"
                    className={TILE_MEDIA_CLASS}
                  />
                )}
              </div>
              <div className="min-w-0">
                <p className="truncate text-[13px] text-zinc-300">
                  {item.mediaType} · {item.status.replace('_', ' ')}
                </p>
                <p className="truncate text-[11px] text-zinc-600">
                  {triageExplanation(item.reason)}
                </p>
              </div>
            </div>
            <select
              value={item.requirementKey ?? EMPTY_CATEGORY}
              disabled={busy}
              onChange={(e) =>
                onFile(item.assetId, e.target.value === EMPTY_CATEGORY ? null : e.target.value)
              }
              className="shrink-0 rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-xs text-zinc-100"
            >
              <option value={EMPTY_CATEGORY}>Uncategorised</option>
              {/* An item parked under a DISABLED requirement keeps its key. It
                  is shown, unselectable, so the select is never blank and the
                  operator cannot clear the key by accident — clearing it is the
                  one action that stops re-enabling from restoring the board. */}
              {item.requirementKey &&
                !optionsFor(item.mediaType).some((o) => o.value === item.requirementKey) && (
                  <option value={item.requirementKey} disabled>
                    {item.requirementKey} (not available)
                  </option>
                )}
              {optionsFor(item.mediaType).map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Inbox — uploads that belong to nobody yet
 * ------------------------------------------------------------------ */

function InboxPanel({
  items,
  characters,
  optionsFor,
  busy,
  onAssign,
  onDiscard,
  onUpload,
}: {
  items: InboxItemView[];
  characters: ReviewWorkspaceView['characters'];
  optionsFor: (mediaType?: 'image' | 'video') => Array<{ value: string; label: string }>;
  busy: boolean;
  onAssign: (
    inboxId: string,
    body: { characterId: string; requirementKey?: string | null },
  ) => void;
  onDiscard: (inboxId: string) => void;
  onUpload: () => void;
}) {
  const [draft, setDraft] = useState<Record<string, { characterId: string; requirementKey: string }>>(
    {},
  );
  const valueFor = (id: string) => draft[id] ?? { characterId: '', requirementKey: EMPTY_CATEGORY };

  return (
    <div>
      <header className="flex items-end justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-white">Inbox</h2>
          <p className="mt-1 text-sm text-zinc-500">
            Uploads that have no character yet. Assign one to place it on a board — it stays in
            Review until you approve it.
          </p>
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={onUpload}
          className="shrink-0 rounded-lg border border-zinc-700 px-3 py-2 text-sm text-zinc-200 hover:border-zinc-600 disabled:opacity-50"
        >
          Add files
        </button>
      </header>

      {items.length === 0 ? (
        <div className="mt-6 rounded-lg border border-dashed border-zinc-800 px-6 py-12 text-center">
          <p className="text-sm text-zinc-300">Inbox is empty</p>
          <p className="mt-1 text-sm text-zinc-500">
            Upload anything here without deciding whose it is first.
          </p>
        </div>
      ) : (
        <ul className="mt-6 space-y-3">
          {items.map((item) => {
            const value = valueFor(item.inboxId);
            return (
              <li
                key={item.inboxId}
                className="flex flex-wrap items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-900/40 p-3"
              >
                <div className="h-16 w-12 shrink-0 overflow-hidden rounded bg-zinc-950">
                  {item.fileUrl && item.mediaType === 'image' && (
                    <img
                      src={`${API_URL}${item.fileUrl}`}
                      alt=""
                      loading="lazy"
                      className={TILE_MEDIA_CLASS}
                    />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-zinc-200">
                    {item.originalName ?? 'Untitled upload'}
                  </p>
                  <p className="text-[11px] text-zinc-600">
                    {item.mediaType} · {Math.max(1, Math.round(item.byteSize / 1024))} KB
                  </p>
                </div>

                <select
                  value={value.characterId}
                  disabled={busy}
                  onChange={(e) =>
                    setDraft((d) => ({
                      ...d,
                      [item.inboxId]: { ...value, characterId: e.target.value },
                    }))
                  }
                  className="rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-xs text-zinc-100"
                >
                  <option value="">Choose a character…</option>
                  {characters.map((c) => (
                    <option key={c.characterId} value={c.characterId}>
                      {c.displayName}
                    </option>
                  ))}
                </select>

                <select
                  value={value.requirementKey}
                  disabled={busy}
                  onChange={(e) =>
                    setDraft((d) => ({
                      ...d,
                      [item.inboxId]: { ...value, requirementKey: e.target.value },
                    }))
                  }
                  className="rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-xs text-zinc-100"
                >
                  <option value={EMPTY_CATEGORY}>Category later</option>
                  {optionsFor(item.mediaType).map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>

                <button
                  type="button"
                  disabled={busy || !value.characterId}
                  onClick={() =>
                    onAssign(item.inboxId, {
                      characterId: value.characterId,
                      requirementKey:
                        value.requirementKey === EMPTY_CATEGORY ? null : value.requirementKey,
                    })
                  }
                  className="rounded-lg bg-rose-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-rose-500 disabled:opacity-40"
                >
                  Assign
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onDiscard(item.inboxId)}
                  className="text-xs text-zinc-500 hover:text-zinc-300 disabled:opacity-50"
                >
                  Discard
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
