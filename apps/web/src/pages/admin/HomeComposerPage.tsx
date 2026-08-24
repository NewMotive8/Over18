import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  adminHomeApi,
  API_URL,
  ApiRequestError,
  type HeroCandidateView,
  type HeroClipAdminView,
  type HomeCategoryView,
  type PublicClip,
  type PublicHome,
} from '../../lib/api';
import {
  contentSummary,
  heroFallbackNote,
  heroMode,
  heroModeLabel,
  emptyReason,
  previewSummary,
  publishedInOrder,
  summariseHome,
  unpublished,
} from '../../admin/homeBoard';
import { canMove, interceptedPath, moveBy, sameOrder } from '../../admin/categoryBoard';
import ConfirmDialog from '../../admin/ConfirmDialog';
import PublishingTabs from '../../admin/PublishingTabs';
import { TILE_MEDIA_CLASS, TILE_VIDEO_PLAYBACK, tileFrameClass } from '../../lib/mediaTile';
import { useLocation, useNavigate } from 'react-router-dom';

/**
 * Admin → Categories & Publishing → Home (US-102.4).
 *
 * Where an operator composes what the app's Home shows: which App Categories
 * appear and in what order, which clips are in the Hero, and the Play with me
 * rail. Preview renders the real public payload.
 *
 * PUBLISHING IS PER CATEGORY AND SEPARATE FROM `enabled`. The screen says so in
 * as many words, because the two flags are easy to confuse and the consequence
 * of confusing them — a category live on Home that the operator thought was
 * only "enabled" — is exactly the mistake this ticket exists to prevent.
 *
 * Ordering and the unsaved-order guard are the tested ones from US-102.1/.2/.3,
 * imported rather than reimplemented.
 */

type Notice = { kind: 'error' | 'success'; text: string } | null;

export default function HomeComposerPage() {
  const [categories, setCategories] = useState<HomeCategoryView[] | null>(null);
  const [hero, setHero] = useState<HeroClipAdminView[]>([]);
  /** What the app is borrowing while the Hero is unconfigured. Never saved. */
  const [heroBorrowed, setHeroBorrowed] = useState<PublicClip[]>([]);
  const [candidates, setCandidates] = useState<HeroCandidateView[] | null>(null);
  const [preview, setPreview] = useState<{ newVisitor: PublicHome; returning: PublicHome } | null>(
    null,
  );

  const [order, setOrder] = useState<string[]>([]);
  const [savedOrder, setSavedOrder] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pendingNav, setPendingNav] = useState<string | null>(null);

  const navigate = useNavigate();
  const location = useLocation();

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const data = await adminHomeApi.overview();
      setCategories(data.categories);
      setHero(data.hero);
      setHeroBorrowed(data.heroFallback);
      const ids = publishedInOrder(data.categories).map((c) => c.id);
      setOrder(ids);
      setSavedOrder(ids);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Couldn't load the Home composer.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const orderDirty = useMemo(() => !sameOrder(order, savedOrder), [order, savedOrder]);

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
      const anchor = (event.target as HTMLElement | null)?.closest?.('a[href]') as
        | HTMLAnchorElement
        | null;
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

  const publishedList = useMemo(() => {
    if (!categories) return [];
    const byId = new Map(categories.map((c) => [c.id, c]));
    return order.map((id) => byId.get(id)).filter((c): c is HomeCategoryView => Boolean(c));
  }, [categories, order]);

  const availableList = useMemo(() => (categories ? unpublished(categories) : []), [categories]);
  const totals = useMemo(() => summariseHome(categories ?? []), [categories]);

  /**
   * Derived from the CURRENT rail, so a character added a moment ago reads as
   * already present without refetching the candidate list.
   */

  /** Same derivation, same reason: the endpoint does not mark who is on the rail. */

  async function togglePublished(category: HomeCategoryView, next: boolean) {
    await run(
      async () => {
        await adminHomeApi.setPublished(category.id, next);
        await load();
      },
      "Couldn't change that category.",
      next
        ? `"${category.name}" is now on Home.`
        : `"${category.name}" is off Home. Nothing was deleted.`,
    );
  }

  async function saveOrder() {
    await run(
      async () => {
        const res = await adminHomeApi.orderCategories(order);
        setCategories(res.categories);
        setSavedOrder(order);
      },
      "Couldn't save the Home order.",
      'Home order saved.',
    );
  }

  /**
   * Keeps the Hero panel honest after a change.
   *
   * A configured Hero has no fallback by definition, so that case needs no
   * request. Emptying the Hero is the case that matters: the app starts
   * borrowing again and the panel has to show what it is borrowing, which only
   * the server can say.
   */
  async function syncHero(clips: HeroClipAdminView[]) {
    setHero(clips);
    if (clips.length > 0) {
      setHeroBorrowed([]);
      return;
    }
    const overview = await adminHomeApi.overview();
    setHeroBorrowed(overview.heroFallback);
  }

  async function loadCandidates() {
    await run(async () => {
      const res = await adminHomeApi.heroCandidates();
      setCandidates(res.candidates);
    }, "Couldn't load approved content.");
  }

  async function addHero(assetId: string) {
    await run(
      async () => {
        const res = await adminHomeApi.addHero([assetId]);
        await syncHero(res.clips);
        const refreshed = await adminHomeApi.heroCandidates();
        setCandidates(refreshed.candidates);
      },
      "Couldn't add that clip.",
      'Added to the Hero.',
    );
  }

  async function removeHero(clip: HeroClipAdminView) {
    await run(
      async () => {
        const res = await adminHomeApi.removeHero(clip.assetId);
        await syncHero(res.clips);
        if (candidates) {
          const refreshed = await adminHomeApi.heroCandidates();
          setCandidates(refreshed.candidates);
        }
      },
      "Couldn't remove that clip.",
      'Removed from the Hero. The content itself is untouched.',
    );
  }

  async function moveHero(assetId: string, delta: number) {
    const ids = moveBy(
      hero.map((c) => ({ id: c.assetId })),
      assetId,
      delta,
    ).map((c) => c.id);
    await run(
      async () => {
        const res = await adminHomeApi.orderHero(ids);
        setHero(res.clips);
      },
      "Couldn't reorder the Hero.",
      'Hero order saved.',
    );
  }

  async function loadPreview() {
    await run(async () => {
      const res = await adminHomeApi.preview();
      setPreview({ newVisitor: res.newVisitor, returning: res.returning });
    }, "Couldn't build the preview.");
  }

  /* ---------------- render ---------------- */

  return (
    <div className="mx-auto w-full max-w-6xl px-4 pb-28 pt-6 sm:px-6">
      <header className="mb-4">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-neutral-500">
          Categories &amp; Publishing
        </p>
        <h1 className="mt-1 text-2xl font-semibold text-neutral-100 sm:text-3xl">Home</h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-neutral-400">
          What the app&apos;s Home shows. Publishing a category here is separate from enabling it —
          a category can be enabled across the CMS and still not appear on Home until you publish
          it below.
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

      {!loadError && categories === null && (
        <div aria-busy="true" className="space-y-2">
          {[0, 1, 2].map((n) => (
            <div
              key={n}
              className="h-24 animate-pulse rounded-xl border border-neutral-800 bg-neutral-900/50"
            />
          ))}
          <span className="sr-only">Loading the Home composer…</span>
        </div>
      )}

      {!loadError && categories !== null && (
        <div className="space-y-8">
          {/* ---------------- Hero ---------------- */}
          <section>
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-sm font-semibold text-neutral-200">
                  Hero{' '}
                  <span
                    className={`ml-1 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${
                      heroMode(hero) === 'configured'
                        ? 'bg-emerald-500/15 text-emerald-300'
                        : 'bg-amber-500/15 text-amber-300'
                    }`}
                  >
                    {heroMode(hero) === 'configured' ? 'Configured' : 'Fallback'}
                  </span>
                </h2>
                <p className="mt-0.5 text-xs text-neutral-500">
                  {heroModeLabel(heroMode(hero))}
                </p>
              </div>
              <button
                type="button"
                onClick={() => (candidates ? setCandidates(null) : void loadCandidates())}
                disabled={busy}
                className="rounded-lg border border-neutral-700 px-3 py-1.5 text-xs text-neutral-300 hover:bg-neutral-800 disabled:opacity-50"
              >
                {candidates ? 'Close picker' : 'Add clips'}
              </button>
            </div>

            {hero.length === 0 ? (
              <div className="rounded-xl border border-dashed border-amber-500/40 bg-amber-500/5 p-4">
                <p className="text-xs text-amber-200/90">{heroFallbackNote(heroBorrowed)}</p>
                {heroBorrowed.length > 0 && (
                  <ul className="mt-3 flex flex-wrap gap-2">
                    {heroBorrowed.map((clip, index) => (
                      <li key={clip.id} className="w-16">
                        <div className={tileFrameClass(true)}>
                          <img
                            src={`${API_URL}${clip.url}`}
                            alt=""
                            loading="lazy"
                            className={TILE_MEDIA_CLASS}
                          />
                        </div>
                        <span className="mt-1 block truncate text-[10px] text-neutral-500">
                          {index + 1}. {clip.characterName}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ) : (
              <ul className="space-y-2">
                {hero.map((clip, index) => (
                  <li
                    key={clip.assetId}
                    className={`flex items-center gap-3 rounded-xl border bg-neutral-900/60 p-2.5 ${
                      clip.publishable ? 'border-neutral-800' : 'border-amber-500/40'
                    }`}
                  >
                    <span className="w-5 shrink-0 text-center text-[11px] tabular-nums text-neutral-600">
                      {index + 1}
                    </span>
                    <div className="w-16 shrink-0">
                      <div className={tileFrameClass(true)}>
                        {clip.previewUrl ? (
                          clip.mediaType === 'video' ? (
                            <video
                              src={`${API_URL}${clip.previewUrl}`}
                              {...TILE_VIDEO_PLAYBACK}
                              preload="metadata"
                              className={TILE_MEDIA_CLASS}
                            />
                          ) : (
                            <img
                              src={`${API_URL}${clip.previewUrl}`}
                              alt=""
                              loading="lazy"
                              className={TILE_MEDIA_CLASS}
                            />
                          )
                        ) : null}
                      </div>
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm text-neutral-200">{clip.characterName}</p>
                      {!clip.publishable && (
                        <p className="mt-0.5 text-[11px] text-amber-300/90">
                          No longer approved ({clip.status}) — hidden on Home until it is approved
                          again. Still assigned.
                        </p>
                      )}
                    </div>
                    <div className="flex shrink-0 gap-1">
                      <button
                        type="button"
                        onClick={() => void moveHero(clip.assetId, -1)}
                        disabled={busy || !canMove(hero.map((c) => ({ id: c.assetId })), clip.assetId, -1)}
                        aria-label={`Move ${clip.characterName} up`}
                        className="rounded-md border border-neutral-800 px-2 py-1 text-xs text-neutral-400 hover:bg-neutral-800 disabled:opacity-30"
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        onClick={() => void moveHero(clip.assetId, 1)}
                        disabled={busy || !canMove(hero.map((c) => ({ id: c.assetId })), clip.assetId, 1)}
                        aria-label={`Move ${clip.characterName} down`}
                        className="rounded-md border border-neutral-800 px-2 py-1 text-xs text-neutral-400 hover:bg-neutral-800 disabled:opacity-30"
                      >
                        ↓
                      </button>
                      <button
                        type="button"
                        onClick={() => void removeHero(clip)}
                        disabled={busy}
                        className="rounded-md border border-neutral-800 px-2.5 py-1 text-xs text-red-300 hover:bg-red-500/10 disabled:opacity-50"
                      >
                        Remove
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}

            {candidates && (
              <div className="mt-3 rounded-xl border border-neutral-800 bg-neutral-900/40 p-3">
                <p className="mb-2 text-xs text-neutral-400">
                  Approved content, newest first. Adding a clip never changes the content itself.
                </p>
                <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
                  {candidates.map((candidate) => (
                    <button
                      key={candidate.assetId}
                      type="button"
                      onClick={() => void addHero(candidate.assetId)}
                      disabled={busy || candidate.inHero}
                      className="group text-left disabled:opacity-40"
                    >
                      <div className={tileFrameClass(true)}>
                        {candidate.previewUrl ? (
                          candidate.mediaType === 'video' ? (
                            <video
                              src={`${API_URL}${candidate.previewUrl}`}
                              {...TILE_VIDEO_PLAYBACK}
                              preload="metadata"
                              className={TILE_MEDIA_CLASS}
                            />
                          ) : (
                            <img
                              src={`${API_URL}${candidate.previewUrl}`}
                              alt=""
                              loading="lazy"
                              className={TILE_MEDIA_CLASS}
                            />
                          )
                        ) : null}
                      </div>
                      <span className="mt-1 block truncate text-[11px] text-neutral-400">
                        {candidate.inHero ? 'In Hero' : candidate.characterName}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </section>

          {/* PLAY WITH ME HAS NO CONTROLS. The rail is one deterministic
              rule — active character, her newest publicly reachable video, one
              card — so there is nothing here to arrange. An operator who wants
              a character on the rail approves and publishes a video of hers. */}
          {/* ---------------- Categories on Home ---------------- */}
          <section>
            <div className="mb-2">
              <h2 className="text-sm font-semibold text-neutral-200">
                Categories on Home ({totals.published} of {totals.total})
              </h2>
              <p className="mt-0.5 text-xs text-neutral-500">
                These appear below Play with me, in this order.
                {totals.needsAttention > 0 && (
                  <span className="text-amber-300/90">
                    {' '}
                    · {totals.needsAttention} would render empty
                  </span>
                )}
              </p>
            </div>

            {publishedList.length === 0 ? (
              <p className="rounded-xl border border-dashed border-neutral-800 bg-neutral-900/30 p-4 text-xs text-neutral-400">
                No categories are published to Home. The app shows no category rails until you
                publish one.
              </p>
            ) : (
              <ul className="space-y-2">
                {publishedList.map((category, index) => {
                  const reason = emptyReason(category);
                  return (
                    <li
                      key={category.id}
                      className={`flex flex-wrap items-center gap-3 rounded-xl border bg-neutral-900/60 p-3 ${
                        reason ? 'border-amber-500/40' : 'border-neutral-800'
                      }`}
                    >
                      <span className="w-5 shrink-0 text-center text-[11px] tabular-nums text-neutral-600">
                        {index + 1}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-neutral-100">
                          {category.name}
                        </p>
                        <p className="mt-0.5 text-[11px] text-neutral-500">
                          {contentSummary(category)}
                          {!category.enabled && ' · disabled in the CMS'}
                        </p>
                        {reason && (
                          <p className="mt-1.5 rounded border border-amber-500/30 bg-amber-500/5 px-2 py-1 text-[11px] leading-snug text-amber-200/90">
                            {reason}
                          </p>
                        )}
                      </div>
                      <div className="flex shrink-0 gap-1">
                        <button
                          type="button"
                          onClick={() => setOrder(moveBy(order.map((id) => ({ id })), category.id, -1).map((o) => o.id))}
                          disabled={busy || index === 0}
                          aria-label={`Move ${category.name} up`}
                          className="rounded-md border border-neutral-800 px-2 py-1 text-xs text-neutral-400 hover:bg-neutral-800 disabled:opacity-30"
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          onClick={() => setOrder(moveBy(order.map((id) => ({ id })), category.id, 1).map((o) => o.id))}
                          disabled={busy || index === publishedList.length - 1}
                          aria-label={`Move ${category.name} down`}
                          className="rounded-md border border-neutral-800 px-2 py-1 text-xs text-neutral-400 hover:bg-neutral-800 disabled:opacity-30"
                        >
                          ↓
                        </button>
                        <button
                          type="button"
                          onClick={() => void togglePublished(category, false)}
                          disabled={busy}
                          className="rounded-md border border-neutral-800 px-2.5 py-1 text-xs text-neutral-300 hover:bg-neutral-800 disabled:opacity-50"
                        >
                          Remove from Home
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}

            {availableList.length > 0 && (
              <div className="mt-4">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
                  Not on Home
                </h3>
                <ul className="mt-2 space-y-1.5">
                  {availableList.map((category) => (
                    <li
                      key={category.id}
                      className="flex items-center gap-3 rounded-lg border border-neutral-800 bg-neutral-900/40 px-3 py-2"
                    >
                      <span className="min-w-0 flex-1 truncate text-sm text-neutral-300">
                        {category.name}
                        <span className="ml-2 text-[11px] text-neutral-500">
                          {contentSummary(category)}
                          {!category.enabled && ' · disabled'}
                        </span>
                      </span>
                      <button
                        type="button"
                        onClick={() => void togglePublished(category, true)}
                        disabled={busy}
                        className="shrink-0 rounded-md border border-emerald-500/40 px-2.5 py-1 text-xs text-emerald-300 hover:bg-emerald-500/10 disabled:opacity-50"
                      >
                        Publish to Home
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>

          {/* ---------------- Preview ---------------- */}
          <section>
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-sm font-semibold text-neutral-200">Preview</h2>
                <p className="mt-0.5 text-xs text-neutral-500">
                  Exactly what the app would build right now, for each audience.
                </p>
              </div>
              <button
                type="button"
                onClick={() => void loadPreview()}
                disabled={busy}
                className="rounded-lg bg-neutral-100 px-3.5 py-2 text-sm font-medium text-neutral-900 hover:bg-white disabled:opacity-50"
              >
                {preview ? 'Refresh preview' : 'Build preview'}
              </button>
            </div>
            {preview && (
              <div className="grid gap-3 sm:grid-cols-2">
                {(
                  [
                    ['New users', preview.newVisitor],
                    ['Returning users', preview.returning],
                  ] as const
                ).map(([label, payload]) => (
                  <div
                    key={label}
                    className="rounded-xl border border-neutral-800 bg-neutral-900/40 p-3"
                  >
                    <p className="text-xs font-semibold text-neutral-200">{label}</p>
                    <p className="mt-1 text-[11px] leading-relaxed text-neutral-400">
                      {previewSummary(payload)}
                    </p>
                    <ol className="mt-2 space-y-0.5 text-[11px] text-neutral-500">
                      {payload.hero.length > 0 && <li>Hero — {payload.hero.length} clips</li>}
                      {payload.playWithMe.length > 0 && <li>Play with me</li>}
                      {payload.categories
                        .filter((c) => c.clips.length > 0)
                        .map((c) => (
                          <li key={c.id}>
                            {c.name} — {c.clips.length}
                          </li>
                        ))}
                    </ol>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      )}

      {pendingNav !== null && (
        <ConfirmDialog
          open
          title="Leave without saving the new order?"
          body="The Home order you arranged has not been saved yet. Leaving now keeps the last saved order — publishing changes you made have already been applied."
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
            <p className="text-sm text-neutral-300">New Home order not saved yet.</p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setOrder(savedOrder)}
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
