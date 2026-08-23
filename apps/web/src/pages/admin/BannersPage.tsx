import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
  ApiRequestError,
  API_URL,
  homeBannersApi,
  type BannerCreativeRequirements,
  type HomeBannerView,
} from '../../lib/api';
import { HOME_BANNER_SLOTS } from '@over18/shared';
import { canMove, interceptedPath, moveBy, moveItem, sameOrder } from '../../admin/categoryBoard';
import {
  audienceLabel,
  creativeRequirementText,
  destinationLabel,
  problemSummary,
  scheduleSummary,
  stateLabel,
  stateTone,
  summarise,
} from '../../admin/bannerBoard';
import { slotLabel } from '../../admin/homeBoard';
import ConfirmDialog from '../../admin/ConfirmDialog';
import PublishingTabs from '../../admin/PublishingTabs';
import { TILE_MEDIA_CLASS, TILE_VIDEO_PLAYBACK, tileFrameClass } from '../../lib/mediaTile';

/**
 * Admin → Categories & Publishing → Banners (US-102.3).
 *
 * The list. Its job is that an operator can see, at a glance, what Home is
 * actually showing — so every row leads with the real creative and carries the
 * DERIVED state, not the stored status. Draft, Scheduled, Live, Ended,
 * Unpublished and Needs attention are computed per read from the schedule and
 * the dependencies; nothing here is a stored flag that could be stale.
 *
 * WHAT THIS SCREEN DOES NOT DECIDE: how Home arranges these. Single banner,
 * carousel, placement — US-102.4. This owns the banners and their order.
 *
 * Ordering and the unsaved-order guard are the tested ones from US-102.1/.2,
 * imported rather than reimplemented.
 */

type Notice = { kind: 'error' | 'success'; text: string } | null;

export default function BannersPage() {
  const [banners, setBanners] = useState<HomeBannerView[] | null>(null);
  const [requirements, setRequirements] = useState<BannerCreativeRequirements | null>(null);
  const [savedOrder, setSavedOrder] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [pendingNav, setPendingNav] = useState<string | null>(null);

  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const rowRefs = useRef(new Map<string, HTMLLIElement | null>());
  const navigate = useNavigate();
  const location = useLocation();

  const load = useCallback(async (preserveOrder = false) => {
    setLoadError(null);
    try {
      const { banners: fresh, requirements: rules } = await homeBannersApi.list();
      setRequirements(rules);
      setBanners((current) => {
        if (!preserveOrder || !current) return fresh;
        const byId = new Map(fresh.map((b) => [b.id, b]));
        const kept: HomeBannerView[] = [];
        for (const item of current) {
          const updated = byId.get(item.id);
          if (updated) {
            kept.push(updated);
            byId.delete(item.id);
          }
        }
        for (const b of fresh) if (byId.has(b.id)) kept.push(b);
        return kept;
      });
      setSavedOrder(fresh.map((b) => b.id));
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Couldn't load the banners.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const orderDirty = useMemo(
    () => (banners ? !sameOrder(banners.map((b) => b.id), savedOrder) : false),
    [banners, savedOrder],
  );
  const totals = useMemo(() => summarise(banners ?? []), [banners]);

  /* -------- unsaved-order guard (same rule as the sibling screens) -------- */

  useEffect(() => {
    if (!orderDirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [orderDirty]);

  useEffect(() => {
    if (!orderDirty) return;
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented) return;
      const anchor = (event.target as HTMLElement | null)?.closest?.(
        'a[href]',
      ) as HTMLAnchorElement | null;
      if (!anchor) return;
      const destination = interceptedPath({
        href: anchor.getAttribute('href'),
        origin: window.location.origin,
        currentPath: location.pathname,
        target: anchor.getAttribute('target'),
        hasDownload: anchor.hasAttribute('download'),
        modified:
          event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0,
      });
      if (!destination) return;
      event.preventDefault();
      event.stopPropagation();
      setPendingNav(destination);
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, [orderDirty, location.pathname]);

  /* ---------------- actions ---------------- */

  async function run(action: () => Promise<unknown>, failure: string, success?: string) {
    if (busy) return false;
    setBusy(true);
    setNotice(null);
    try {
      await action();
      if (success) setNotice({ kind: 'success', text: success });
      return true;
    } catch (err) {
      setNotice({ kind: 'error', text: err instanceof ApiRequestError ? err.message : failure });
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function publish(banner: HomeBannerView) {
    await run(
      async () => {
        await homeBannersApi.publish(banner.id);
        await load(true);
      },
      "Couldn't publish that banner.",
      `"${banner.title}" published.`,
    );
  }

  async function unpublish(banner: HomeBannerView) {
    await run(
      async () => {
        await homeBannersApi.unpublish(banner.id);
        await load(true);
      },
      "Couldn't unpublish that banner.",
      `"${banner.title}" is no longer shown. It has not been deleted.`,
    );
  }

  async function remove(banner: HomeBannerView) {
    const ok = await run(
      async () => {
        await homeBannersApi.remove(banner.id);
        await load(true);
      },
      "Couldn't delete that banner.",
      `"${banner.title}" deleted. Its creative is still available for another banner.`,
    );
    if (ok) setConfirmDeleteId(null);
  }

  /**
   * Saves the arrangement, ONE SLOT AT A TIME.
   *
   * US-102.4 made `position` an order within a slot, so the API takes an exact
   * permutation of a single slot. Sending every banner at once — which is what
   * this did before slots existed — is rejected as incomplete for whichever
   * slot it names. Only slots the operator actually rearranged are sent, so an
   * untouched slot is never restated.
   */
  async function saveOrder() {
    if (!banners || busy) return;
    setBusy(true);
    setNotice(null);
    const slotOf = new Map(banners.map((b) => [b.id, b.slot]));
    try {
      let fresh = banners;
      for (const slot of HOME_BANNER_SLOTS) {
        const now = banners.filter((b) => b.slot === slot).map((b) => b.id);
        const before = savedOrder.filter((id) => slotOf.get(id) === slot);
        if (now.length === 0 || sameOrder(now, before)) continue;
        const res = await homeBannersApi.reorder(slot, now);
        fresh = res.banners;
      }
      setBanners(fresh);
      setSavedOrder(fresh.map((b) => b.id));
      setNotice({ kind: 'success', text: 'Order saved.' });
    } catch (err) {
      setNotice({
        kind: 'error',
        text: err instanceof ApiRequestError ? err.message : "Couldn't save the new order.",
      });
      // One slot may already have been written before another failed. Reloading
      // is the only way to stop the screen claiming an arrangement the server
      // does not have — a stale savedOrder would leave the operator with an
      // "unsaved" bar over changes that are, in part, already live.
      await load(false);
    } finally {
      setBusy(false);
    }
  }

  function applyOrder(next: HomeBannerView[]) {
    setBanners(next);
    setNotice(null);
  }

  function nudge(id: string, delta: number) {
    if (!banners) return;
    const current = banners.find((b) => b.id === id);
    const neighbourIndex = banners.findIndex((b) => b.id === id) + delta;
    const neighbour = banners[neighbourIndex];
    // Same rule as drag: a nudge never carries a banner into the other slot.
    if (!current || !neighbour || neighbour.slot !== current.slot) return;
    applyOrder(moveBy(banners, id, delta));
    requestAnimationFrame(() => rowRefs.current.get(id)?.focus());
  }

  function handleDrop(targetId: string, transferred?: string) {
    const sourceId = transferred || dragId;
    setDragId(null);
    setDragOverId(null);
    if (!banners || !sourceId || sourceId === targetId) return;
    const from = banners.findIndex((b) => b.id === sourceId);
    const to = banners.findIndex((b) => b.id === targetId);
    if (from === -1 || to === -1) return;
    // Ordering is within a slot. Dragging across slots would look like a
    // reorder but mean "move this banner elsewhere on the page", which is an
    // edit — so it is refused here rather than silently reassigning.
    if (banners[from]!.slot !== banners[to]!.slot) {
      setNotice({
        kind: 'error',
        text: 'Banners are ordered within their slot. Change the slot in the banner editor.',
      });
      return;
    }
    applyOrder(moveItem(banners, from, to));
  }

  const deleting = banners?.find((b) => b.id === confirmDeleteId) ?? null;

  /* ---------------- render ---------------- */

  return (
    <div className="mx-auto w-full max-w-6xl px-4 pb-28 pt-6 sm:px-6">
      <header className="mb-4">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-neutral-500">
          Categories &amp; Publishing
        </p>
        <h1 className="mt-1 text-2xl font-semibold text-neutral-100 sm:text-3xl">Home banners</h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-neutral-400">
          Editorial banners for the app&apos;s Home surface. How Home arranges them — one at a
          time, a carousel, where on the page — is decided separately.
        </p>
      </header>

      <PublishingTabs />

      {notice && (
        <div
          role="status"
          aria-live="polite"
          className={`mb-4 rounded-xl border px-4 py-3 text-sm ${
            notice.kind === 'error'
              ? 'border-red-500/40 bg-red-500/10 text-red-200'
              : 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200'
          }`}
        >
          {notice.text}
        </div>
      )}

      {loadError && (
        <div className="rounded-2xl border border-red-500/40 bg-red-500/10 p-6 text-sm text-red-200">
          <p className="font-medium">{loadError}</p>
          <button
            type="button"
            onClick={() => void load()}
            className="mt-3 rounded-lg border border-red-400/40 px-3 py-1.5 text-xs text-red-100 hover:bg-red-500/20"
          >
            Try again
          </button>
        </div>
      )}

      {!loadError && banners === null && (
        <div aria-busy="true" className="space-y-2">
          {[0, 1, 2].map((n) => (
            <div
              key={n}
              className="h-28 animate-pulse rounded-xl border border-neutral-800 bg-neutral-900/50"
            />
          ))}
          <span className="sr-only">Loading banners…</span>
        </div>
      )}

      {!loadError && banners !== null && (
        <>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-neutral-200">
                {totals.total === 0
                  ? 'No banners yet'
                  : `${totals.total} banner${totals.total === 1 ? '' : 's'}`}
              </h2>
              {totals.total > 0 && (
                <p className="mt-0.5 text-xs text-neutral-500">
                  {totals.live} live · {totals.scheduled} scheduled · {totals.drafts} draft
                  {totals.needsAttention > 0 && (
                    <span className="text-amber-300/90">
                      {' '}
                      · {totals.needsAttention} needs attention
                    </span>
                  )}
                </p>
              )}
            </div>
            <Link
              to="/admin/publishing/banners/new"
              className="rounded-lg bg-neutral-100 px-3.5 py-2 text-sm font-medium text-neutral-900 hover:bg-white"
            >
              New banner
            </Link>
          </div>

          {requirements && (
            <p className="mb-3 rounded-lg border border-neutral-800 bg-neutral-900/40 px-3 py-2 text-[11px] text-neutral-400">
              Creative requirements: {creativeRequirementText(requirements)}
            </p>
          )}

          {banners.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-neutral-800 bg-neutral-900/30 p-8 text-center">
              <h3 className="text-base font-medium text-neutral-200">No banners yet</h3>
              <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-neutral-400">
                A banner is a piece of featured editorial content: artwork, a headline, and
                somewhere it sends people. Nothing is published until you say so.
              </p>
              <Link
                to="/admin/publishing/banners/new"
                className="mt-5 inline-block rounded-lg bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-900 hover:bg-white"
              >
                Create the first banner
              </Link>
            </div>
          ) : (
            <ul className="space-y-2">
              {banners.map((banner, index) => (
                <li
                  key={banner.id}
                  ref={(el) => {
                    rowRefs.current.set(banner.id, el);
                  }}
                  tabIndex={0}
                  draggable={!busy}
                  aria-label={`${banner.title}, ${stateLabel(banner.state)}, position ${index + 1} of ${banners.length}`}
                  onDragStart={(event) => {
                    event.dataTransfer.setData('text/plain', banner.id);
                    event.dataTransfer.effectAllowed = 'move';
                    setDragId(banner.id);
                  }}
                  onDragEnd={() => {
                    setDragId(null);
                    setDragOverId(null);
                  }}
                  onDragOver={(event) => {
                    event.preventDefault();
                    event.dataTransfer.dropEffect = 'move';
                    setDragOverId(banner.id);
                  }}
                  onDragLeave={() =>
                    setDragOverId((current) => (current === banner.id ? null : current))
                  }
                  onDrop={(event) => {
                    event.preventDefault();
                    handleDrop(banner.id, event.dataTransfer.getData('text/plain'));
                  }}
                  onKeyDown={(event) => {
                    if (!event.altKey && !event.metaKey) return;
                    if (event.key === 'ArrowUp') {
                      event.preventDefault();
                      nudge(banner.id, -1);
                    }
                    if (event.key === 'ArrowDown') {
                      event.preventDefault();
                      nudge(banner.id, 1);
                    }
                  }}
                  className={`rounded-xl border bg-neutral-900/60 p-3 outline-none transition focus-visible:ring-2 focus-visible:ring-neutral-400 sm:p-4 ${
                    dragOverId === banner.id && dragId !== banner.id
                      ? 'border-neutral-400'
                      : banner.state === 'needs_attention'
                        ? 'border-amber-500/40'
                        : 'border-neutral-800'
                  } ${dragId === banner.id ? 'opacity-50' : ''}`}
                >
                  <div className="flex flex-wrap items-start gap-3 sm:flex-nowrap">
                    <div className="flex shrink-0 flex-col items-center gap-0.5 pt-1">
                      <span aria-hidden className="cursor-grab select-none text-neutral-600">
                        ⠿
                      </span>
                      <span className="text-[11px] tabular-nums text-neutral-600">{index + 1}</span>
                    </div>

                    <div className="w-28 shrink-0">
                      <BannerThumb banner={banner} />
                    </div>

                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="truncate text-sm font-medium text-neutral-100">
                          {banner.title}
                        </h3>
                        <StateChip state={banner.state} />
                      </div>
                      {banner.subtitle && (
                        <p className="mt-0.5 truncate text-xs text-neutral-400">{banner.subtitle}</p>
                      )}
                      <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-neutral-500">
                        {/* Which slot, first: ordering here is WITHIN a slot, so
                            the row's number means nothing without it. */}
                        <span className="text-neutral-400">{slotLabel(banner.slot)}</span>
                        <span aria-hidden>·</span>
                        <span>{destinationLabel(banner)}</span>
                        <span aria-hidden>·</span>
                        <span>{audienceLabel(banner.audience)}</span>
                        <span aria-hidden>·</span>
                        <span>{scheduleSummary(banner)}</span>
                      </p>
                      {banner.problems.length > 0 && (
                        <p className="mt-1.5 rounded border border-amber-500/30 bg-amber-500/5 px-2 py-1 text-[11px] leading-snug text-amber-200/90">
                          {problemSummary(banner.problems)}
                        </p>
                      )}
                    </div>

                    <div className="flex shrink-0 flex-wrap items-center gap-1">
                      <button
                        type="button"
                        onClick={() => nudge(banner.id, -1)}
                        disabled={busy || !canMove(banners, banner.id, -1)}
                        aria-label={`Move ${banner.title} up`}
                        className="rounded-md border border-neutral-800 px-2 py-1 text-xs text-neutral-400 hover:bg-neutral-800 disabled:opacity-30"
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        onClick={() => nudge(banner.id, 1)}
                        disabled={busy || !canMove(banners, banner.id, 1)}
                        aria-label={`Move ${banner.title} down`}
                        className="rounded-md border border-neutral-800 px-2 py-1 text-xs text-neutral-400 hover:bg-neutral-800 disabled:opacity-30"
                      >
                        ↓
                      </button>
                      {banner.status === 'published' ? (
                        <button
                          type="button"
                          onClick={() => void unpublish(banner)}
                          disabled={busy}
                          className="rounded-md border border-neutral-800 px-2.5 py-1 text-xs text-neutral-300 hover:bg-neutral-800 disabled:opacity-50"
                        >
                          Unpublish
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => void publish(banner)}
                          disabled={busy}
                          className="rounded-md border border-emerald-500/40 px-2.5 py-1 text-xs text-emerald-300 hover:bg-emerald-500/10 disabled:opacity-50"
                        >
                          Publish
                        </button>
                      )}
                      <Link
                        to={`/admin/publishing/banners/${banner.id}`}
                        className="rounded-md border border-neutral-800 px-2.5 py-1 text-xs text-neutral-200 hover:bg-neutral-800"
                      >
                        Edit
                      </Link>
                      <button
                        type="button"
                        onClick={() => setConfirmDeleteId(banner.id)}
                        disabled={busy}
                        className="rounded-md border border-neutral-800 px-2.5 py-1 text-xs text-red-300 hover:bg-red-500/10 disabled:opacity-50"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}

          {banners.length > 1 && (
            <p className="mt-3 text-xs text-neutral-500">
              Drag a banner to reorder, or focus a row and press{' '}
              <kbd className="rounded border border-neutral-700 px-1">Alt</kbd> +{' '}
              <kbd className="rounded border border-neutral-700 px-1">↑</kbd> /{' '}
              <kbd className="rounded border border-neutral-700 px-1">↓</kbd>. Order is saved
              separately; publishing and unpublishing apply straight away.
            </p>
          )}
        </>
      )}

      {deleting && (
        <ConfirmDialog
          open
          tone="danger"
          title={`Delete "${deleting.title}"?`}
          body="The banner is removed for good. Its creative file is kept and stays available for another banner, and its destination is not affected."
          confirmLabel="Delete banner"
          cancelLabel="Keep it"
          busy={busy}
          onCancel={() => setConfirmDeleteId(null)}
          onConfirm={() => void remove(deleting)}
        />
      )}

      {pendingNav !== null && (
        <ConfirmDialog
          open
          title="Leave without saving the new order?"
          body="The order you arranged has not been saved yet. Leaving now keeps the last saved order — publishing changes you made have already been applied."
          confirmLabel="Leave without saving"
          cancelLabel="Stay here"
          busy={false}
          onCancel={() => setPendingNav(null)}
          onConfirm={() => {
            const destination = pendingNav;
            setPendingNav(null);
            if (destination) navigate(destination);
          }}
        />
      )}

      {orderDirty && (
        <div className="fixed inset-x-0 bottom-0 z-20 border-t border-neutral-800 bg-neutral-950/95 px-4 py-3 backdrop-blur">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-neutral-300">New order not saved yet.</p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => void load(false)}
                disabled={busy}
                className="rounded-lg border border-neutral-700 px-3.5 py-2 text-sm text-neutral-300 hover:bg-neutral-800 disabled:opacity-50"
              >
                Discard
              </button>
              <button
                type="button"
                onClick={() => void saveOrder()}
                disabled={busy}
                className="rounded-lg bg-neutral-100 px-3.5 py-2 text-sm font-medium text-neutral-900 hover:bg-white disabled:opacity-50"
              >
                {busy ? 'Saving…' : 'Save order'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export function StateChip({ state }: { state: HomeBannerView['state'] }) {
  const tone = stateTone(state);
  const classes =
    tone === 'positive'
      ? 'bg-emerald-500/15 text-emerald-300'
      : tone === 'warning'
        ? 'bg-amber-500/15 text-amber-300'
        : tone === 'muted'
          ? 'bg-neutral-700/40 text-neutral-400'
          : 'bg-neutral-700/40 text-neutral-300';
  return (
    <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${classes}`}>
      {stateLabel(state)}
    </span>
  );
}

export function BannerThumb({ banner }: { banner: HomeBannerView }) {
  const creative = banner.creative;
  return (
    <div className={tileFrameClass(true)}>
      {creative && creative.mediaType === 'video' ? (
        <video
          src={`${API_URL}${creative.fileUrl}`}
          {...TILE_VIDEO_PLAYBACK}
          preload="metadata"
          className={TILE_MEDIA_CLASS}
        />
      ) : creative ? (
        <img
          src={`${API_URL}${creative.fileUrl}`}
          alt=""
          loading="lazy"
          className={TILE_MEDIA_CLASS}
        />
      ) : (
        <span className="text-[10px] text-neutral-600">no creative</span>
      )}
    </div>
  );
}
