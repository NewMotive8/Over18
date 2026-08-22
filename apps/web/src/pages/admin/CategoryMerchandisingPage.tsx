import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  ApiRequestError,
  API_URL,
  charactersApi,
  merchandisingApi,
  type CandidateAssetView,
  type CategoryAssetView,
} from '../../lib/api';
import type { PublicCharacter } from '@over18/shared';
import { TILE_MEDIA_CLASS, tileFrameClass } from '../../lib/mediaTile';
import { canMove, interceptedPath, moveBy, moveItem, sameOrder } from '../../admin/categoryBoard';
import {
  blockedItems,
  blockedReason,
  membershipLabel,
  publishableOnly,
  pruneSelection,
  removalMessage,
  selectAll,
  selectRange,
  summarise,
  summariseAdd,
  toggleSelected,
} from '../../admin/merchandising';

/**
 * Admin → Categories & Publishing → merchandise one category (US-102.2).
 *
 * Two thumbnail grids and a preview, not a form. The operator is arranging a
 * user-facing surface, so the actual media is the interface: what is available
 * on the left, what is in the category on the right, and what the app would
 * show underneath.
 *
 * WHAT THIS SCREEN CAN AND CANNOT DO, BY CONSTRUCTION.
 *
 *   It can add, remove, reorder and feature ASSIGNMENTS. Every one of those
 *   writes a link row and nothing else — there is no call on this page that can
 *   approve, reject, retire, delete or regenerate a Library asset, and the
 *   removal copy says so in as many words.
 *
 *   It cannot offer non-approved content: the picker's source is server-side
 *   approved-only, so an operator is never shown something the write path would
 *   then refuse.
 *
 * FEATURED IS A BADGE, NOT A SORT KEY. Ordering comes from the saved position
 * and nothing else, so a drag that puts an ordinary item ahead of a featured
 * one persists exactly as saved.
 *
 * WHEN AN ASSIGNED ITEM LOSES APPROVAL it is shown in place, greyed, with the
 * reason and the reassurance that the assignment survives — rather than
 * silently vanishing, which would leave the operator unable to explain why the
 * count changed.
 *
 * Selection and ordering maths live in admin/merchandising.ts and
 * admin/categoryBoard.ts because the web tests run in node with no DOM. As on
 * the categories screen, drag ARITHMETIC is covered there; the gesture is not.
 */

type Banner = { kind: 'error' | 'success' | 'info'; text: string } | null;

interface Filters {
  characterId: string;
  mediaType: '' | 'image' | 'video';
  contentRating: '' | 'sfw' | 'explicit';
  search: string;
  hideAssigned: boolean;
}

const EMPTY_FILTERS: Filters = {
  characterId: '',
  mediaType: '',
  contentRating: '',
  search: '',
  hideAssigned: true,
};

export default function CategoryMerchandisingPage() {
  const { categorySlug } = useParams<{ categorySlug: string }>();

  const [category, setCategory] = useState<{
    id: string;
    slug: string;
    name: string;
    tagline: string | null;
    enabled: boolean;
  } | null>(null);
  const [contents, setContents] = useState<CategoryAssetView[] | null>(null);
  const [savedOrder, setSavedOrder] = useState<string[]>([]);
  const [candidates, setCandidates] = useState<CandidateAssetView[] | null>(null);
  const [characters, setCharacters] = useState<PublicCharacter[]>([]);

  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [pickerSelected, setPickerSelected] = useState<ReadonlySet<string>>(new Set());
  const [pickerAnchor, setPickerAnchor] = useState<string | null>(null);
  const [contentSelected, setContentSelected] = useState<ReadonlySet<string>>(new Set());
  const [contentAnchor, setContentAnchor] = useState<string | null>(null);

  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<Banner>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string[] | null>(null);

  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const tileRefs = useRef(new Map<string, HTMLLIElement | null>());

  /** An in-app destination held back while the order is unsaved. */
  const [pendingNav, setPendingNav] = useState<string | null>(null);
  const navigate = useNavigate();
  const location = useLocation();

  /* ---------------- loading ---------------- */

  const loadCategory = useCallback(async () => {
    if (!categorySlug) return null;
    const resolved = await merchandisingApi.categoryBySlug(categorySlug);
    setCategory(resolved);
    return resolved;
  }, [categorySlug]);

  const loadContents = useCallback(async (categoryId: string, preserveOrder = false) => {
    const { assets } = await merchandisingApi.contents(categoryId);
    setContents((current) => {
      if (!preserveOrder || !current) return assets;
      // Keep the operator's staged arrangement; take server truth for content.
      const byId = new Map(assets.map((asset) => [asset.assetId, asset]));
      const kept: CategoryAssetView[] = [];
      for (const item of current) {
        const fresh = byId.get(item.assetId);
        if (fresh) {
          kept.push(fresh);
          byId.delete(item.assetId);
        }
      }
      for (const asset of assets) if (byId.has(asset.assetId)) kept.push(asset);
      return kept;
    });
    setSavedOrder(assets.map((asset) => asset.assetId));
  }, []);

  const loadCandidates = useCallback(
    async (categoryId: string, active: Filters) => {
      const { assets } = await merchandisingApi.candidates({
        categoryId,
        characterId: active.characterId || undefined,
        mediaType: active.mediaType || undefined,
        contentRating: active.contentRating || undefined,
        search: active.search || undefined,
        excludeAssigned: active.hideAssigned,
      });
      setCandidates(assets);
      // A selection must always mean what is on screen.
      setPickerSelected((current) => pruneSelection(current, assets.map((a) => a.assetId)));
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;
    setLoadError(null);
    (async () => {
      try {
        const resolved = await loadCategory();
        if (cancelled || !resolved) return;
        await Promise.all([
          loadContents(resolved.id),
          loadCandidates(resolved.id, EMPTY_FILTERS),
          charactersApi.list().then(setCharacters).catch(() => setCharacters([])),
        ]);
      } catch (err) {
        if (cancelled) return;
        setLoadError(
          err instanceof ApiRequestError && err.status === 404
            ? 'That category no longer exists.'
            : err instanceof Error
              ? err.message
              : "Couldn't load this category.",
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadCategory, loadContents, loadCandidates]);

  // Re-query the picker whenever a filter changes.
  useEffect(() => {
    if (!category) return;
    const handle = setTimeout(() => {
      void loadCandidates(category.id, filters).catch(() => {
        setBanner({ kind: 'error', text: "Couldn't refresh the library list." });
      });
    }, 200);
    return () => clearTimeout(handle);
  }, [category, filters, loadCandidates]);

  /* ---------------- derived ---------------- */

  const totals = useMemo(() => summarise(contents ?? []), [contents]);
  const publishable = useMemo(() => publishableOnly(contents ?? []), [contents]);
  const blocked = useMemo(() => blockedItems(contents ?? []), [contents]);
  const orderDirty = useMemo(
    () => (contents ? !sameOrder(contents.map((a) => a.assetId), savedOrder) : false),
    [contents, savedOrder],
  );
  const visibleCandidateIds = useMemo(
    () => (candidates ?? []).map((a) => a.assetId),
    [candidates],
  );

  async function run(action: () => Promise<unknown>, failure: string, success?: string) {
    if (busy) return false;
    setBusy(true);
    setBanner(null);
    try {
      await action();
      if (success) setBanner({ kind: 'success', text: success });
      return true;
    } catch (err) {
      setBanner({ kind: 'error', text: err instanceof ApiRequestError ? err.message : failure });
      return false;
    } finally {
      setBusy(false);
    }
  }

  /* ---------------- actions ---------------- */

  async function addSelected() {
    if (!category || pickerSelected.size === 0) return;
    const ids = [...pickerSelected];
    await run(
      async () => {
        const result = await merchandisingApi.add(category.id, ids);
        await Promise.all([loadContents(category.id, true), loadCandidates(category.id, filters)]);
        setPickerSelected(new Set());
        const summary = summariseAdd(result.outcomes);
        setBanner({
          kind: summary.added > 0 ? 'success' : 'info',
          text: summary.message,
        });
      },
      "Couldn't add those items.",
    );
  }

  async function removeAssets(ids: string[]) {
    if (!category || ids.length === 0) return;
    const ok = await run(
      async () => {
        const result = await merchandisingApi.remove(category.id, ids);
        await Promise.all([loadContents(category.id, true), loadCandidates(category.id, filters)]);
        setContentSelected(new Set());
        setBanner({
          kind: 'success',
          text: `${result.removed} item${
            result.removed === 1 ? '' : 's'
          } removed from this category. Nothing was changed in the Library.`,
        });
      },
      "Couldn't remove those items.",
    );
    if (ok) setConfirmRemove(null);
  }

  async function toggleFeatured(asset: CategoryAssetView) {
    if (!category) return;
    await run(
      async () => {
        await merchandisingApi.setFeatured(category.id, asset.assetId, !asset.featured);
        await loadContents(category.id);
      },
      "Couldn't change that item.",
      asset.featured ? 'No longer featured.' : 'Featured — it keeps its place and gains a badge.',
    );
  }

  async function saveOrder() {
    if (!category || !contents || busy) return;
    setBusy(true);
    setBanner(null);
    try {
      const { assets } = await merchandisingApi.reorder(
        category.id,
        contents.map((a) => a.assetId),
      );
      setContents(assets);
      setSavedOrder(assets.map((a) => a.assetId));
      setBanner({ kind: 'success', text: 'Order saved.' });
    } catch (err) {
      setBanner({
        kind: 'error',
        text: err instanceof ApiRequestError ? err.message : "Couldn't save the new order.",
      });
      if (err instanceof ApiRequestError && err.status === 409) {
        await loadContents(category.id);
      }
    } finally {
      setBusy(false);
    }
  }

  /* ---------------- guarding an unsaved order ---------------- */

  /**
   * Reloads, tab closes and links out of the app. Same protection the
   * categories workspace has, for the same staged-order pattern — leaving with
   * a drag-arranged rail unsaved silently discards the arrangement.
   */
  useEffect(() => {
    if (!orderDirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [orderDirty]);

  /**
   * In-app navigation, including this page's own "← All categories" link.
   *
   * The decision of WHICH clicks to hold back is interceptedPath in
   * admin/categoryBoard.ts — the same unit-tested rule the categories
   * workspace uses, deliberately reused rather than reimplemented, so
   * modifier-clicks, new tabs, downloads, external links, mailto:/tel: and
   * same-page hashes keep behaving normally on both screens.
   */
  useEffect(() => {
    if (!orderDirty) return;
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      const anchor = target?.closest?.('a[href]') as HTMLAnchorElement | null;
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

  function applyOrder(next: CategoryAssetView[]) {
    setContents(next);
    setBanner(null);
  }

  function nudge(assetId: string, delta: number) {
    if (!contents) return;
    const withIds = contents.map((a) => ({ ...a, id: a.assetId }));
    applyOrder(moveBy(withIds, assetId, delta).map(({ id: _id, ...rest }) => rest as CategoryAssetView));
    requestAnimationFrame(() => tileRefs.current.get(assetId)?.focus());
  }

  function handleDrop(targetId: string, transferred?: string) {
    const sourceId = transferred || dragId;
    setDragId(null);
    setDragOverId(null);
    if (!contents || !sourceId || sourceId === targetId) return;
    const from = contents.findIndex((a) => a.assetId === sourceId);
    const to = contents.findIndex((a) => a.assetId === targetId);
    if (from === -1 || to === -1) return;
    applyOrder(moveItem(contents, from, to));
  }

  function pickerClick(event: ReactMouseEvent, assetId: string) {
    if (event.shiftKey) {
      setPickerSelected(selectRange(pickerSelected, visibleCandidateIds, pickerAnchor, assetId));
    } else {
      setPickerSelected(toggleSelected(pickerSelected, assetId));
    }
    setPickerAnchor(assetId);
  }

  function contentClick(event: ReactMouseEvent, assetId: string) {
    const visible = (contents ?? []).map((a) => a.assetId);
    if (event.shiftKey) {
      setContentSelected(selectRange(contentSelected, visible, contentAnchor, assetId));
    } else {
      setContentSelected(toggleSelected(contentSelected, assetId));
    }
    setContentAnchor(assetId);
  }

  /* ---------------- render ---------------- */

  if (loadError) {
    return (
      <div className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6">
        <div className="rounded-2xl border border-red-500/40 bg-red-500/10 p-6 text-sm text-red-200">
          <p className="font-medium">{loadError}</p>
          <Link
            to="/admin/publishing"
            className="mt-3 inline-block rounded-lg border border-red-400/40 px-3 py-1.5 text-xs text-red-100 hover:bg-red-500/20"
          >
            Back to categories
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-[1400px] px-4 pb-28 pt-6 sm:px-6">
      <header className="mb-5">
        <Link
          to="/admin/publishing"
          className="text-xs font-medium text-neutral-400 hover:text-neutral-200"
        >
          ← All categories
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold text-neutral-100 sm:text-3xl">
            {category?.name ?? 'Loading…'}
          </h1>
          {category && !category.enabled && (
            <span className="rounded-full bg-neutral-700/40 px-2 py-0.5 text-[11px] text-neutral-300">
              Hidden from the app
            </span>
          )}
        </div>
        {category?.tagline && <p className="mt-1 text-sm text-neutral-400">{category.tagline}</p>}
        <p className="mt-2 text-xs text-neutral-500">
          {totals.assigned} assigned · {totals.publishable} live in the app · {totals.featured}{' '}
          featured
          {totals.blocked > 0 && ` · ${totals.blocked} hidden pending Review`}
        </p>
      </header>

      {banner && (
        <div
          role="status"
          aria-live="polite"
          className={`mb-4 rounded-xl border px-4 py-3 text-sm ${
            banner.kind === 'error'
              ? 'border-red-500/40 bg-red-500/10 text-red-200'
              : banner.kind === 'info'
                ? 'border-neutral-700 bg-neutral-900 text-neutral-300'
                : 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200'
          }`}
        >
          {banner.text}
        </div>
      )}

      <div className="grid gap-6 xl:grid-cols-2">
        {/* ---------------- picker ---------------- */}
        <section aria-labelledby="picker-heading" className="min-w-0">
          <h2 id="picker-heading" className="text-sm font-semibold text-neutral-200">
            Approved library
          </h2>
          <p className="mt-0.5 text-xs text-neutral-500">
            Only approved content can be added. Items still in Review are not shown.
          </p>

          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            <label className="text-xs text-neutral-400">
              Search by character
              <input
                value={filters.search}
                onChange={(event) => setFilters({ ...filters, search: event.target.value })}
                className="mt-1 w-full rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 outline-none focus:border-neutral-400"
              />
            </label>
            <label className="text-xs text-neutral-400">
              Character
              <select
                value={filters.characterId}
                onChange={(event) => setFilters({ ...filters, characterId: event.target.value })}
                className="mt-1 w-full rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 outline-none focus:border-neutral-400"
              >
                <option value="">All characters</option>
                {characters.map((character) => (
                  <option key={character.id} value={character.id}>
                    {character.displayName}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs text-neutral-400">
              Media
              <select
                value={filters.mediaType}
                onChange={(event) =>
                  setFilters({ ...filters, mediaType: event.target.value as Filters['mediaType'] })
                }
                className="mt-1 w-full rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 outline-none focus:border-neutral-400"
              >
                <option value="">Images and video</option>
                <option value="image">Images</option>
                <option value="video">Video</option>
              </select>
            </label>
            <label className="text-xs text-neutral-400">
              Rating
              <select
                value={filters.contentRating}
                onChange={(event) =>
                  setFilters({
                    ...filters,
                    contentRating: event.target.value as Filters['contentRating'],
                  })
                }
                className="mt-1 w-full rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 outline-none focus:border-neutral-400"
              >
                <option value="">Any rating</option>
                <option value="sfw">SFW</option>
                <option value="explicit">Explicit</option>
              </select>
            </label>
          </div>

          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
            <label className="flex items-center gap-2 text-xs text-neutral-400">
              <input
                type="checkbox"
                checked={filters.hideAssigned}
                onChange={(event) =>
                  setFilters({ ...filters, hideAssigned: event.target.checked })
                }
              />
              Hide items already in this category
            </label>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setPickerSelected(selectAll(visibleCandidateIds))}
                disabled={busy || visibleCandidateIds.length === 0}
                className="rounded-md border border-neutral-800 px-2.5 py-1 text-xs text-neutral-300 hover:bg-neutral-800 disabled:opacity-40"
              >
                Select all shown
              </button>
              <button
                type="button"
                onClick={() => setPickerSelected(new Set())}
                disabled={busy || pickerSelected.size === 0}
                className="rounded-md border border-neutral-800 px-2.5 py-1 text-xs text-neutral-300 hover:bg-neutral-800 disabled:opacity-40"
              >
                Clear
              </button>
            </div>
          </div>

          {candidates === null ? (
            <TileSkeleton label="Loading approved library…" />
          ) : candidates.length === 0 ? (
            <EmptyPanel
              title="Nothing matches"
              body="No approved content matches these filters. Content becomes available here once it is approved in Review."
            />
          ) : (
            <ul className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
              {candidates.map((candidate) => {
                const selected = pickerSelected.has(candidate.assetId);
                return (
                  <li key={candidate.assetId}>
                    <button
                      type="button"
                      aria-pressed={selected}
                      onClick={(event) => pickerClick(event, candidate.assetId)}
                      className={`w-full rounded-xl border p-1.5 text-left transition ${
                        selected
                          ? 'border-neutral-300 bg-neutral-800/60'
                          : 'border-neutral-800 hover:border-neutral-700'
                      }`}
                    >
                      <Thumb previewUrl={candidate.previewUrl} mediaType={candidate.mediaType} />
                      <p className="mt-1.5 truncate text-[11px] font-medium text-neutral-200">
                        {candidate.characterName}
                      </p>
                      <p className="truncate text-[10px] text-neutral-500">
                        {membershipLabel(candidate)}
                      </p>
                      <div className="mt-1 flex flex-wrap gap-1">
                        <Tag>{candidate.mediaType}</Tag>
                        <Tag>{candidate.contentRating}</Tag>
                        {candidate.isPrimary && <Tag>primary</Tag>}
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          {pickerSelected.size > 0 && (
            <div className="sticky bottom-4 mt-3 flex items-center justify-between gap-3 rounded-xl border border-neutral-700 bg-neutral-950/95 px-3 py-2 backdrop-blur">
              <span className="text-sm text-neutral-300">
                {pickerSelected.size} selected
              </span>
              <button
                type="button"
                onClick={() => void addSelected()}
                disabled={busy}
                className="rounded-lg bg-neutral-100 px-3.5 py-2 text-sm font-medium text-neutral-900 hover:bg-white disabled:opacity-50"
              >
                {busy ? 'Adding…' : `Add ${pickerSelected.size} to ${category?.name ?? 'category'}`}
              </button>
            </div>
          )}
        </section>

        {/* ---------------- category contents ---------------- */}
        <section aria-labelledby="contents-heading" className="min-w-0">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 id="contents-heading" className="text-sm font-semibold text-neutral-200">
                In this category
              </h2>
              <p className="mt-0.5 text-xs text-neutral-500">
                Drag to reorder, or focus a tile and press Alt + ← / →. Featuring adds a badge; it never changes the order.
              </p>
            </div>
            {contentSelected.size > 0 && (
              <button
                type="button"
                onClick={() => setConfirmRemove([...contentSelected])}
                disabled={busy}
                className="rounded-md border border-neutral-800 px-2.5 py-1 text-xs text-red-300 hover:bg-red-500/10 disabled:opacity-50"
              >
                Remove {contentSelected.size} selected
              </button>
            )}
          </div>

          {contents === null ? (
            <TileSkeleton label="Loading this category…" />
          ) : contents.length === 0 ? (
            <EmptyPanel
              title="Nothing here yet"
              body="Pick approved content on the left and add it. Adding content here never moves or copies it — the same item can appear in as many categories as you like."
            />
          ) : (
            <ul className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
              {contents.map((asset, index) => {
                const selected = contentSelected.has(asset.assetId);
                return (
                  <li
                    key={asset.assetId}
                    ref={(el) => {
                      tileRefs.current.set(asset.assetId, el);
                    }}
                    tabIndex={0}
                    draggable={!busy}
                    aria-label={`${asset.characterName}, position ${index + 1} of ${contents.length}${
                      asset.featured ? ', featured' : ''
                    }${asset.publishable ? '' : ', hidden pending review'}`}
                    onDragStart={(event) => {
                      // Firefox aborts a drag with no transfer data.
                      event.dataTransfer.setData('text/plain', asset.assetId);
                      event.dataTransfer.effectAllowed = 'move';
                      setDragId(asset.assetId);
                    }}
                    onDragEnd={() => {
                      setDragId(null);
                      setDragOverId(null);
                    }}
                    onDragOver={(event) => {
                      event.preventDefault();
                      event.dataTransfer.dropEffect = 'move';
                      setDragOverId(asset.assetId);
                    }}
                    onDragLeave={() =>
                      setDragOverId((current) => (current === asset.assetId ? null : current))
                    }
                    onDrop={(event) => {
                      event.preventDefault();
                      handleDrop(asset.assetId, event.dataTransfer.getData('text/plain'));
                    }}
                    onKeyDown={(event: ReactKeyboardEvent<HTMLLIElement>) => {
                      if (!event.altKey && !event.metaKey) return;
                      if (event.key === 'ArrowLeft') {
                        event.preventDefault();
                        nudge(asset.assetId, -1);
                      }
                      if (event.key === 'ArrowRight') {
                        event.preventDefault();
                        nudge(asset.assetId, 1);
                      }
                    }}
                    className={`rounded-xl border p-1.5 outline-none transition focus-visible:ring-2 focus-visible:ring-neutral-400 ${
                      dragOverId === asset.assetId && dragId !== asset.assetId
                        ? 'border-neutral-400'
                        : selected
                          ? 'border-neutral-300 bg-neutral-800/60'
                          : 'border-neutral-800'
                    } ${dragId === asset.assetId ? 'opacity-50' : ''} ${
                      asset.publishable ? '' : 'bg-amber-500/5'
                    }`}
                  >
                    <button
                      type="button"
                      aria-pressed={selected}
                      onClick={(event) => contentClick(event, asset.assetId)}
                      className="block w-full text-left"
                    >
                      <div className={asset.publishable ? '' : 'opacity-50'}>
                        <Thumb previewUrl={asset.previewUrl} mediaType={asset.mediaType} />
                      </div>
                      <p className="mt-1.5 flex items-center gap-1 truncate text-[11px] font-medium text-neutral-200">
                        {asset.featured && <span aria-hidden>★</span>}
                        <span className="truncate">{asset.characterName}</span>
                      </p>
                    </button>

                    {!asset.publishable && (
                      <p className="mt-1 text-[10px] leading-snug text-amber-300/90">
                        {blockedReason(asset)}
                      </p>
                    )}

                    <div className="mt-1.5 flex items-center justify-between gap-1">
                      <div className="flex gap-0.5">
                        <button
                          type="button"
                          onClick={() => nudge(asset.assetId, -1)}
                          disabled={busy || !canMove(contents.map((a) => ({ id: a.assetId })), asset.assetId, -1)}
                          aria-label={`Move ${asset.characterName} earlier`}
                          className="rounded border border-neutral-800 px-1.5 text-xs text-neutral-400 hover:bg-neutral-800 disabled:opacity-30"
                        >
                          ←
                        </button>
                        <button
                          type="button"
                          onClick={() => nudge(asset.assetId, 1)}
                          disabled={busy || !canMove(contents.map((a) => ({ id: a.assetId })), asset.assetId, 1)}
                          aria-label={`Move ${asset.characterName} later`}
                          className="rounded border border-neutral-800 px-1.5 text-xs text-neutral-400 hover:bg-neutral-800 disabled:opacity-30"
                        >
                          →
                        </button>
                      </div>
                      <div className="flex gap-0.5">
                        <button
                          type="button"
                          onClick={() => void toggleFeatured(asset)}
                          disabled={busy}
                          aria-pressed={asset.featured}
                          aria-label={`${asset.featured ? 'Unfeature' : 'Feature'} ${asset.characterName}`}
                          className={`rounded border px-1.5 text-xs disabled:opacity-40 ${
                            asset.featured
                              ? 'border-amber-400/40 bg-amber-400/10 text-amber-300'
                              : 'border-neutral-800 text-neutral-400 hover:bg-neutral-800'
                          }`}
                        >
                          ★
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmRemove([asset.assetId])}
                          disabled={busy}
                          aria-label={`Remove ${asset.characterName} from this category`}
                          className="rounded border border-neutral-800 px-1.5 text-xs text-red-300 hover:bg-red-500/10 disabled:opacity-40"
                        >
                          ✕
                        </button>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          {blocked.length > 0 && (
            <p className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-200/90">
              {blocked.length} item{blocked.length === 1 ? '' : 's'} here{' '}
              {blocked.length === 1 ? 'is' : 'are'} not approved right now, so{' '}
              {blocked.length === 1 ? 'it is' : 'they are'} hidden from the app. The assignment is
              kept — approving in Review brings {blocked.length === 1 ? 'it' : 'them'} back
              automatically.
            </p>
          )}
        </section>
      </div>

      {/* ---------------- preview ---------------- */}
      <section aria-labelledby="rail-preview-heading" className="mt-8">
        <h2 id="rail-preview-heading" className="text-sm font-semibold text-neutral-200">
          How this category looks in the app
        </h2>
        <p className="mt-0.5 text-xs text-neutral-500">
          Approved content only, in exactly the order shown above
          {orderDirty && ' — including the changes you have not saved yet'}.
        </p>
        <div className="mt-3 rounded-2xl border border-neutral-800 bg-neutral-900/40 p-4">
          <h3 className="text-base font-medium text-neutral-100">{category?.name ?? ''}</h3>
          {category?.tagline && <p className="text-xs text-neutral-500">{category.tagline}</p>}
          {publishable.length === 0 ? (
            <p className="mt-3 rounded-lg border border-dashed border-neutral-800 px-3 py-6 text-center text-xs text-neutral-500">
              This category would appear empty in the app.
            </p>
          ) : (
            <div className="mt-3 flex gap-3 overflow-x-auto pb-2">
              {publishable.map((asset) => (
                <div key={asset.assetId} className="w-28 shrink-0">
                  <Thumb previewUrl={asset.previewUrl} mediaType={asset.mediaType} />
                  <p className="mt-1 flex items-center gap-1 truncate text-[11px] text-neutral-300">
                    {asset.featured && <span aria-hidden>★</span>}
                    <span className="truncate">{asset.characterName}</span>
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      {pendingNav !== null && (
        <LeaveDialog
          onCancel={() => setPendingNav(null)}
          onConfirm={() => {
            const destination = pendingNav;
            setPendingNav(null);
            if (destination) navigate(destination);
          }}
        />
      )}

      {confirmRemove && (
        <RemoveDialog
          count={confirmRemove.length}
          busy={busy}
          onCancel={() => setConfirmRemove(null)}
          onConfirm={() => void removeAssets(confirmRemove)}
        />
      )}

      {orderDirty && (
        <div className="fixed inset-x-0 bottom-0 z-20 border-t border-neutral-800 bg-neutral-950/95 px-4 py-3 backdrop-blur">
          <div className="mx-auto flex max-w-[1400px] flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-neutral-300">
              New order not saved yet — the preview below shows how it will look.
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => category && void loadContents(category.id)}
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

/* ------------------------------------------------------------------ *
 * Pieces
 * ------------------------------------------------------------------ */

/**
 * A thumbnail. `previewUrl` is the server's opaque per-asset route — the client
 * never sees a storage key or a filesystem path.
 */
function Thumb({
  previewUrl,
  mediaType,
}: {
  previewUrl: string | null;
  mediaType: 'image' | 'video';
}) {
  return (
    <div className={tileFrameClass(true)}>
      {previewUrl && mediaType === 'video' ? (
        <video
          src={`${API_URL}${previewUrl}`}
          muted
          playsInline
          preload="metadata"
          className={TILE_MEDIA_CLASS}
        />
      ) : previewUrl ? (
        <img src={`${API_URL}${previewUrl}`} alt="" loading="lazy" className={TILE_MEDIA_CLASS} />
      ) : (
        <span className="text-[10px] text-neutral-600">no preview</span>
      )}
    </div>
  );
}

function Tag({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded bg-neutral-800/70 px-1 py-0.5 text-[9px] uppercase tracking-wide text-neutral-400">
      {children}
    </span>
  );
}

function TileSkeleton({ label }: { label: string }) {
  return (
    <div
      aria-busy="true"
      className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4"
    >
      {[0, 1, 2, 3, 4, 5].map((n) => (
        <div
          key={n}
          className="aspect-[4/5] animate-pulse rounded-xl border border-neutral-800 bg-neutral-900/50"
        />
      ))}
      <span className="sr-only">{label}</span>
    </div>
  );
}

function EmptyPanel({ title, body }: { title: string; body: string }) {
  return (
    <div className="mt-3 rounded-2xl border border-dashed border-neutral-800 bg-neutral-900/30 p-6 text-center">
      <h3 className="text-sm font-medium text-neutral-200">{title}</h3>
      <p className="mx-auto mt-1.5 max-w-sm text-xs leading-relaxed text-neutral-400">{body}</p>
    </div>
  );
}

/**
 * The one modal used by both confirmations on this screen.
 *
 * Same contract as the categories workspace: focus moves to the safe action,
 * Tab and Shift+Tab cycle between the two buttons and cannot escape, Escape
 * and a backdrop click dismiss, and focus returns to whatever opened it. One
 * implementation rather than two, so the two dialogs cannot drift apart.
 */
function ConfirmModal({
  title,
  body,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onCancel,
  busy,
  tone = 'default',
}: {
  title: string;
  body: string;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  busy: boolean;
  tone?: 'default' | 'danger';
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const restoreTo = useRef<Element | null>(null);

  useEffect(() => {
    restoreTo.current = document.activeElement;
    cancelRef.current?.focus();
    return () => {
      if (restoreTo.current instanceof HTMLElement) restoreTo.current.focus();
    };
  }, []);

  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.stopPropagation();
      if (!busy) onCancel();
      return;
    }
    if (event.key !== 'Tab') return;
    const first = cancelRef.current;
    const last = confirmRef.current;
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div
      className="fixed inset-0 z-30 flex items-center justify-center bg-black/60 px-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel();
      }}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="merch-dialog-title"
        aria-describedby="merch-dialog-body"
        onKeyDown={onKeyDown}
        className="w-full max-w-md rounded-2xl border border-neutral-800 bg-neutral-950 p-5 shadow-2xl"
      >
        <h2 id="merch-dialog-title" className="text-base font-medium text-neutral-100">
          {title}
        </h2>
        <p id="merch-dialog-body" className="mt-2 text-sm leading-relaxed text-neutral-400">
          {body}
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded-lg border border-neutral-700 px-3.5 py-2 text-sm text-neutral-300 hover:bg-neutral-800 disabled:opacity-50"
          >
            {cancelLabel}
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className={`rounded-lg px-3.5 py-2 text-sm font-medium disabled:opacity-50 ${
              tone === 'danger'
                ? 'bg-red-500/90 text-white hover:bg-red-500'
                : 'bg-neutral-100 text-neutral-900 hover:bg-white'
            }`}
          >
            {busy ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Removal confirmation. The copy is the point: this is where the operator is
 * told, explicitly, that removing from a category changes nothing in the
 * Library.
 */
function RemoveDialog({
  count,
  busy,
  onCancel,
  onConfirm,
}: {
  count: number;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <ConfirmModal
      tone="danger"
      title={`Remove ${count} item${count === 1 ? '' : 's'} from this category?`}
      body={removalMessage(count)}
      confirmLabel="Remove from category"
      cancelLabel="Keep them"
      busy={busy}
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  );
}

/** Shown when a staged reorder would be lost by navigating away. */
function LeaveDialog({ onCancel, onConfirm }: { onCancel: () => void; onConfirm: () => void }) {
  return (
    <ConfirmModal
      title="Leave without saving the new order?"
      body="The order you arranged has not been saved yet. Leaving now keeps the last saved order — everything else you changed on this page has already been applied."
      confirmLabel="Leave without saving"
      cancelLabel="Stay here"
      busy={false}
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  );
}
