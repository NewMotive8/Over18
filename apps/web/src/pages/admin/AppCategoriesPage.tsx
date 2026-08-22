import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
  ApiRequestError,
  appCategoriesApi,
  type AppCategoryView,
} from '../../lib/api';
import {
  assignedLabel,
  canMove,
  deletionMessage,
  interceptedPath,
  moveBy,
  moveItem,
  orderOf,
  previewCategories,
  reconcileOrder,
  sameOrder,
  slugPreview,
  summarise,
} from '../../admin/categoryBoard';
import ConfirmDialog from '../../admin/ConfirmDialog';
import PublishingTabs from '../../admin/PublishingTabs';

/**
 * Admin → Categories & Publishing → App Categories (US-102.1).
 *
 * The App CMS workspace for how approved Library content is ORGANISED in the
 * app. It is deliberately not a CRUD table: the thing an operator is actually
 * doing here is arranging a user-facing surface, so the arrangement and a
 * preview of it are the centre of the screen and the forms are secondary.
 *
 * TWO SPEEDS, ON PURPOSE.
 *
 *   Create, rename, enable/disable and delete apply IMMEDIATELY. They are
 *   discrete decisions and waiting on a save button would only add a step.
 *
 *   ORDER IS STAGED. Dragging rearranges locally, the preview updates live, and
 *   an explicit Save writes the whole list in one atomic request. That is what
 *   "preview the resulting order before publishing" means while no publishing
 *   pipeline exists yet (that is US-102.4) — and it is honest: the page says
 *   plainly that everything else is live configuration rather than inventing a
 *   Draft/Published badge for a decision the product does not have.
 *
 * ORDERING LOGIC LIVES IN admin/categoryBoard.ts, not here, because this repo's
 * web tests run in node with no DOM: the arithmetic behind every drag is
 * testable there, and this component stays a thin binding over it.
 *
 * Drag-and-drop uses the native HTML5 API — no new dependency in a web app with
 * four of them — and every row also has Move up / Move down controls plus arrow
 * keys, which is both the accessible route and the one a test can drive.
 */

type BannerAction = { label: string; run: () => void };
type Banner = { kind: 'error' | 'success'; text: string; action?: BannerAction } | null;

interface DraftState {
  name: string;
  tagline: string;
}

const EMPTY_DRAFT: DraftState = { name: '', tagline: '' };

export default function AppCategoriesPage() {
  const [categories, setCategories] = useState<AppCategoryView[] | null>(null);
  const [savedOrder, setSavedOrder] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<Banner>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<DraftState>(EMPTY_DRAFT);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<DraftState>(EMPTY_DRAFT);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);

  /** An in-app destination held back while the order is unsaved. */
  const [pendingNav, setPendingNav] = useState<string | null>(null);
  const navigate = useNavigate();
  const location = useLocation();

  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  /** Rows keyed by id, so a keyboard move can keep focus on the moved row. */
  const rowRefs = useRef(new Map<string, HTMLLIElement | null>());
  /**
   * Where focus lands after a delete. The dialog normally restores focus to
   * whatever opened it — but that control was the deleted row's own Delete
   * button, which no longer exists, so focus would fall to the document body
   * and a keyboard operator would lose their place.
   */
  const listHeadingRef = useRef<HTMLHeadingElement>(null);

  const load = useCallback(async (preserveOrder = false) => {
    setLoadError(null);
    try {
      const { categories: fresh } = await appCategoriesApi.list();
      setCategories((current) =>
        preserveOrder && current ? reconcileOrder(current, fresh) : fresh,
      );
      setSavedOrder(orderOf(fresh));
    } catch (err) {
      setLoadError(
        err instanceof Error ? err.message : "Couldn't load the app categories.",
      );
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const orderDirty = useMemo(
    () => (categories ? !sameOrder(orderOf(categories), savedOrder) : false),
    [categories, savedOrder],
  );

  const totals = useMemo(() => summarise(categories ?? []), [categories]);
  const preview = useMemo(() => previewCategories(categories ?? []), [categories]);

  async function run(action: () => Promise<unknown>, failure: string, success?: string) {
    if (busy) return false;
    setBusy(true);
    setBanner(null);
    try {
      await action();
      if (success) setBanner({ kind: 'success', text: success });
      return true;
    } catch (err) {
      setBanner({
        kind: 'error',
        text: err instanceof ApiRequestError ? err.message : failure,
      });
      return false;
    } finally {
      setBusy(false);
    }
  }

  /* ---------------- create / edit / state ---------------- */

  async function handleCreate(event: FormEvent) {
    event.preventDefault();
    const name = draft.name.trim();
    if (!name) return;
    const ok = await run(
      async () => {
        await appCategoriesApi.create({
          name,
          tagline: draft.tagline.trim() || null,
        });
        await load(true);
      },
      "Couldn't create that category.",
      `"${name}" created.`,
    );
    if (ok) {
      setDraft(EMPTY_DRAFT);
      setCreating(false);
    }
  }

  async function handleEditSave(event: FormEvent) {
    event.preventDefault();
    if (!editingId) return;
    const name = editDraft.name.trim();
    if (!name) return;
    const ok = await run(
      async () => {
        await appCategoriesApi.update(editingId, {
          name,
          tagline: editDraft.tagline.trim() || null,
        });
        await load(true);
      },
      "Couldn't save those changes.",
      'Changes saved.',
    );
    if (ok) setEditingId(null);
  }

  async function toggleEnabled(category: AppCategoryView) {
    await run(
      async () => {
        await appCategoriesApi.update(category.id, { enabled: !category.enabled });
        await load(true);
      },
      "Couldn't change that category.",
      category.enabled
        ? `"${category.name}" is hidden from the app.`
        : `"${category.name}" is showing in the app.`,
    );
  }

  async function handleDelete(category: AppCategoryView) {
    const ok = await run(
      async () => {
        const result = await appCategoriesApi.remove(category.id);
        await load(true);
        setBanner({
          kind: 'success',
          text:
            result.releasedAssetCount > 0
              ? `"${category.name}" deleted. ${result.releasedAssetCount} item${
                  result.releasedAssetCount === 1 ? '' : 's'
                } became unassigned and remain in the Library.`
              : `"${category.name}" deleted.`,
        });
      },
      "Couldn't delete that category.",
    );
    if (ok) {
      setConfirmingDeleteId(null);
      // After the dialog has unmounted and tried its own restore.
      requestAnimationFrame(() => listHeadingRef.current?.focus());
    }
  }

  /* ---------------- ordering ---------------- */

  function applyLocalOrder(next: AppCategoryView[]) {
    setCategories(next);
    setBanner(null);
  }

  function nudge(id: string, delta: number) {
    if (!categories) return;
    applyLocalOrder(moveBy(categories, id, delta));
    // Keep the moved row focused so repeated presses keep working.
    requestAnimationFrame(() => rowRefs.current.get(id)?.focus());
  }

  /**
   * `transferredId` is the id the drag carried. It is preferred over React
   * state because the dataTransfer payload survives cases where a dragstart
   * state update did not land — and it is the value the browser itself
   * associates with the drag.
   */
  function handleDrop(targetId: string, transferredId?: string) {
    const sourceId = transferredId || dragId;
    if (!categories || !sourceId || sourceId === targetId) {
      setDragId(null);
      setDragOverId(null);
      return;
    }
    const from = categories.findIndex((c) => c.id === sourceId);
    const to = categories.findIndex((c) => c.id === targetId);
    if (from === -1 || to === -1) {
      setDragId(null);
      setDragOverId(null);
      return;
    }
    applyLocalOrder(moveItem(categories, from, to));
    setDragId(null);
    setDragOverId(null);
  }

  /**
   * Not routed through `run` because the 409 case needs its own recovery.
   *
   * The server refuses a reorder that is not an exact permutation of what
   * exists — the stale-browser case, where someone else added or removed a
   * category since this list was loaded. Telling the operator to reload and
   * then giving them nothing to click is where this screen used to leave them
   * stuck, re-pressing a Save that could never succeed. So a 409 carries a
   * Reload action that takes the server's list and discards the local order.
   */
  async function saveOrder() {
    if (!categories || busy) return;
    setBusy(true);
    setBanner(null);
    try {
      const { categories: fresh } = await appCategoriesApi.reorder(orderOf(categories));
      setCategories(fresh);
      setSavedOrder(orderOf(fresh));
      setBanner({ kind: 'success', text: 'Order saved.' });
    } catch (err) {
      const stale = err instanceof ApiRequestError && err.status === 409;
      setBanner({
        kind: 'error',
        text: err instanceof ApiRequestError ? err.message : "Couldn't save the new order.",
        action: stale
          ? {
              label: 'Reload categories',
              run: () => {
                setBanner(null);
                // preserveOrder = false: the local arrangement is what is out
                // of date, so it is deliberately dropped for the server's.
                void load(false);
              },
            }
          : undefined,
      });
    } finally {
      setBusy(false);
    }
  }

  function discardOrder() {
    if (!categories) return;
    applyLocalOrder(reconcileOrder(savedOrder.map((id) => ({ id })), categories));
  }

  /* ---------------- guarding an unsaved order ---------------- */

  /**
   * Reloads, tab closes and links out of the app. The browser shows its own
   * generic prompt; the text is not ours to choose.
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
   * In-app navigation. This app mounts a plain BrowserRouter rather than a data
   * router, so react-router's useBlocker is not available; a capture-phase
   * click listener is the equivalent that works here. It runs before the
   * router's own handler, holds the destination, and asks.
   *
   * Which clicks are left alone — modifier-clicks, new tabs, downloads,
   * external links, same-page anchors — is decided by interceptedPath in
   * admin/categoryBoard.ts, where it is unit-tested. Swallowing a
   * "open in new tab" would be a worse bug than the one this prevents.
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

  const categoryBeingDeleted =
    categories?.find((category) => category.id === confirmingDeleteId) ?? null;

  /* ---------------- render ---------------- */

  return (
    <div className="mx-auto w-full max-w-6xl px-4 pb-24 pt-6 sm:px-6">
      <header className="mb-6">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-neutral-500">
          Categories &amp; Publishing
        </p>
        <h1 className="mt-1 text-2xl font-semibold text-neutral-100 sm:text-3xl">App categories</h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-neutral-400">
          How approved Library content is grouped and ordered in the app. These are merchandising
          categories — separate from the content requirements that decide what gets produced.
        </p>
      </header>

      <PublishingTabs />

      {banner && (
        <div
          role="status"
          aria-live="polite"
          className={`mb-4 rounded-xl border px-4 py-3 text-sm ${
            banner.kind === 'error'
              ? 'border-red-500/40 bg-red-500/10 text-red-200'
              : 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200'
          }`}
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span>{banner.text}</span>
            {banner.action && (
              <button
                type="button"
                onClick={banner.action.run}
                className="shrink-0 rounded-lg border border-current/40 px-3 py-1.5 text-xs font-medium hover:bg-white/10"
              >
                {banner.action.label}
              </button>
            )}
          </div>
        </div>
      )}

      {loadError && (
        <div className="rounded-2xl border border-red-500/40 bg-red-500/10 p-6 text-sm text-red-200">
          <p className="font-medium">{loadError}</p>
          <button
            type="button"
            onClick={() => void load()}
            className="mt-3 rounded-lg border border-red-400/40 px-3 py-1.5 text-xs font-medium text-red-100 hover:bg-red-500/20"
          >
            Try again
          </button>
        </div>
      )}

      {!loadError && categories === null && <LoadingState />}

      {!loadError && categories !== null && (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
          <section aria-labelledby="category-list-heading" className="min-w-0">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2
                  id="category-list-heading"
                  ref={listHeadingRef}
                  tabIndex={-1}
                  className="text-sm font-semibold text-neutral-200 outline-none"
                >
                  {totals.total === 0
                    ? 'No categories yet'
                    : `${totals.total} categor${totals.total === 1 ? 'y' : 'ies'}`}
                </h2>
                {totals.total > 0 && (
                  <p className="mt-0.5 text-xs text-neutral-500">
                    {totals.enabled} showing in the app
                    {totals.disabled > 0 && `, ${totals.disabled} hidden`}
                  </p>
                )}
              </div>
              {!creating && (
                <button
                  type="button"
                  onClick={() => setCreating(true)}
                  className="rounded-lg bg-neutral-100 px-3.5 py-2 text-sm font-medium text-neutral-900 transition hover:bg-white disabled:opacity-50"
                  disabled={busy}
                >
                  New category
                </button>
              )}
            </div>

            {creating && (
              <CategoryForm
                heading="New category"
                draft={draft}
                onChange={setDraft}
                onSubmit={handleCreate}
                onCancel={() => {
                  setCreating(false);
                  setDraft(EMPTY_DRAFT);
                }}
                busy={busy}
                showSlug
                submitLabel="Create category"
              />
            )}

            {totals.total === 0 && !creating ? (
              <EmptyCategories onCreate={() => setCreating(true)} />
            ) : (
              <ul className="space-y-2">
                {categories.map((category, index) => (
                  <li
                    key={category.id}
                    ref={(el) => {
                      rowRefs.current.set(category.id, el);
                    }}
                    tabIndex={0}
                    /*
                     * Not draggable while this row is being edited: a draggable
                     * ancestor swallows mouse text-selection inside descendant
                     * inputs in Chrome and Safari, so an operator could not
                     * highlight the name they were editing.
                     */
                    draggable={!busy && editingId !== category.id}
                    aria-label={`${category.name}, position ${index + 1} of ${categories.length}`}
                    onDragStart={(event) => {
                      /*
                       * Firefox ABORTS a drag whose dragstart sets no transfer
                       * data, so this line is what makes reordering work there
                       * at all. The payload is the row id, which also lets the
                       * drop read the source without trusting React state.
                       */
                      event.dataTransfer.setData('text/plain', category.id);
                      event.dataTransfer.effectAllowed = 'move';
                      setDragId(category.id);
                    }}
                    onDragEnd={() => {
                      setDragId(null);
                      setDragOverId(null);
                    }}
                    onDragOver={(event) => {
                      event.preventDefault();
                      // Without this the cursor reads "no drop" in Firefox.
                      event.dataTransfer.dropEffect = 'move';
                      setDragOverId(category.id);
                    }}
                    onDragLeave={() =>
                      setDragOverId((current) => (current === category.id ? null : current))
                    }
                    onDrop={(event) => {
                      event.preventDefault();
                      handleDrop(category.id, event.dataTransfer.getData('text/plain'));
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'ArrowUp' && (event.metaKey || event.altKey)) {
                        event.preventDefault();
                        nudge(category.id, -1);
                      }
                      if (event.key === 'ArrowDown' && (event.metaKey || event.altKey)) {
                        event.preventDefault();
                        nudge(category.id, 1);
                      }
                    }}
                    className={`rounded-xl border bg-neutral-900/60 p-3 outline-none transition focus-visible:ring-2 focus-visible:ring-neutral-400 sm:p-4 ${
                      dragOverId === category.id && dragId !== category.id
                        ? 'border-neutral-400'
                        : 'border-neutral-800'
                    } ${dragId === category.id ? 'opacity-50' : ''} ${
                      category.enabled ? '' : 'bg-neutral-900/30'
                    }`}
                  >
                    {editingId === category.id ? (
                      <CategoryForm
                        heading={`Edit "${category.name}"`}
                        draft={editDraft}
                        onChange={setEditDraft}
                        onSubmit={handleEditSave}
                        onCancel={() => setEditingId(null)}
                        busy={busy}
                        slugNote={category.slug}
                        submitLabel="Save changes"
                        embedded
                      />
                    ) : (
                      <CategoryRow
                        category={category}
                        index={index}
                        total={categories.length}
                        busy={busy}
                        canMoveUp={canMove(categories, category.id, -1)}
                        canMoveDown={canMove(categories, category.id, 1)}
                        onMove={(delta) => nudge(category.id, delta)}
                        onEdit={() => {
                          setEditingId(category.id);
                          setEditDraft({
                            name: category.name,
                            tagline: category.tagline ?? '',
                          });
                        }}
                        onToggle={() => void toggleEnabled(category)}
                        onAskDelete={() => setConfirmingDeleteId(category.id)}
                      />
                    )}
                  </li>
                ))}
              </ul>
            )}

            {totals.total > 1 && (
              <p className="mt-3 text-xs text-neutral-500">
                Drag a category to reorder, or focus a row and press{' '}
                <kbd className="rounded border border-neutral-700 px-1">Alt</kbd> +{' '}
                <kbd className="rounded border border-neutral-700 px-1">↑</kbd> /{' '}
                <kbd className="rounded border border-neutral-700 px-1">↓</kbd>. Order is saved
                separately; everything else applies straight away.
              </p>
            )}
          </section>

          <CategoryPreview categories={preview} hiddenCount={totals.disabled} />
        </div>
      )}

      <ConfirmDialog
        open={categoryBeingDeleted !== null}
        tone="danger"
        title={categoryBeingDeleted ? `Delete "${categoryBeingDeleted.name}"?` : ''}
        body={categoryBeingDeleted ? deletionMessage(categoryBeingDeleted) : ''}
        confirmLabel="Delete category"
        cancelLabel="Keep it"
        busy={busy}
        onCancel={() => setConfirmingDeleteId(null)}
        onConfirm={() => {
          if (categoryBeingDeleted) void handleDelete(categoryBeingDeleted);
        }}
      />

      <ConfirmDialog
        open={pendingNav !== null}
        title="Leave without saving the new order?"
        body="The order you arranged has not been saved yet. Leaving now keeps the last saved order — nothing else on this page is affected."
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

      {orderDirty && (
        <div className="fixed inset-x-0 bottom-0 z-20 border-t border-neutral-800 bg-neutral-950/95 px-4 py-3 backdrop-blur">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-neutral-300">
              New order not saved yet — the preview shows how it will look.
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={discardOrder}
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

function LoadingState() {
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]" aria-busy="true">
      <div className="space-y-2">
        {[0, 1, 2].map((n) => (
          <div
            key={n}
            className="h-20 animate-pulse rounded-xl border border-neutral-800 bg-neutral-900/50"
          />
        ))}
      </div>
      <div className="h-64 animate-pulse rounded-2xl border border-neutral-800 bg-neutral-900/50" />
      <span className="sr-only">Loading app categories…</span>
    </div>
  );
}

function EmptyCategories({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="rounded-2xl border border-dashed border-neutral-800 bg-neutral-900/30 p-8 text-center">
      <h3 className="text-base font-medium text-neutral-200">No categories yet</h3>
      <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-neutral-400">
        Categories are how approved content is grouped in the app. Nothing is predefined — create
        the first one and arrange them however the app should read.
      </p>
      <button
        type="button"
        onClick={onCreate}
        className="mt-5 rounded-lg bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-900 hover:bg-white"
      >
        Create the first category
      </button>
    </div>
  );
}

function CategoryRow({
  category,
  index,
  total,
  busy,
  canMoveUp,
  canMoveDown,
  onMove,
  onEdit,
  onToggle,
  onAskDelete,
}: {
  category: AppCategoryView;
  index: number;
  total: number;
  busy: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMove: (delta: number) => void;
  onEdit: () => void;
  onToggle: () => void;
  onAskDelete: () => void;
}) {
  return (
    <div>
      <div className="flex items-start gap-3">
        <div className="flex shrink-0 flex-col items-center gap-0.5 pt-0.5">
          <span aria-hidden className="cursor-grab select-none text-neutral-600">
            ⠿
          </span>
          <span className="text-[11px] tabular-nums text-neutral-600">{index + 1}</span>
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3
              className={`truncate text-sm font-medium ${
                category.enabled ? 'text-neutral-100' : 'text-neutral-500'
              }`}
            >
              {category.name}
            </h3>
            <span
              className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                category.enabled
                  ? 'bg-emerald-500/15 text-emerald-300'
                  : 'bg-neutral-700/40 text-neutral-400'
              }`}
            >
              {category.enabled ? 'Showing' : 'Hidden'}
            </span>
          </div>
          {category.tagline && (
            <p className="mt-0.5 truncate text-xs text-neutral-400">{category.tagline}</p>
          )}
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-neutral-500">
            <code className="rounded bg-neutral-800/70 px-1 py-0.5 text-neutral-400">
              {category.slug}
            </code>
            <span aria-hidden>·</span>
            <span>{assignedLabel(category.assignedAssetCount)}</span>
            {typeof category.publishableAssetCount === 'number' &&
              category.publishableAssetCount !== category.assignedAssetCount && (
                <>
                  <span aria-hidden>·</span>
                  <span className="text-amber-300/90">
                    {category.publishableAssetCount} live in the app
                  </span>
                </>
              )}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => onMove(-1)}
            disabled={busy || !canMoveUp}
            aria-label={`Move ${category.name} up`}
            className="rounded-md border border-neutral-800 px-2 py-1 text-xs text-neutral-400 hover:bg-neutral-800 disabled:opacity-30"
          >
            ↑
          </button>
          <button
            type="button"
            onClick={() => onMove(1)}
            disabled={busy || !canMoveDown}
            aria-label={`Move ${category.name} down`}
            className="rounded-md border border-neutral-800 px-2 py-1 text-xs text-neutral-400 hover:bg-neutral-800 disabled:opacity-30"
          >
            ↓
          </button>
          <span className="sr-only">
            Position {index + 1} of {total}
          </span>
          <Link
            to={`/admin/publishing/${category.slug}`}
            className="mr-1 rounded-md border border-neutral-800 px-2.5 py-1 text-xs text-neutral-200 hover:bg-neutral-800"
          >
            Merchandise
          </Link>
          <button
            type="button"
            onClick={onToggle}
            disabled={busy}
            className="ml-1 rounded-md border border-neutral-800 px-2.5 py-1 text-xs text-neutral-300 hover:bg-neutral-800 disabled:opacity-50"
          >
            {category.enabled ? 'Hide' : 'Show'}
          </button>
          <button
            type="button"
            onClick={onEdit}
            disabled={busy}
            className="rounded-md border border-neutral-800 px-2.5 py-1 text-xs text-neutral-300 hover:bg-neutral-800 disabled:opacity-50"
          >
            Edit
          </button>
          <button
            type="button"
            onClick={onAskDelete}
            disabled={busy}
            className="rounded-md border border-neutral-800 px-2.5 py-1 text-xs text-red-300 hover:bg-red-500/10 disabled:opacity-50"
          >
            Delete
          </button>
        </div>
      </div>

    </div>
  );
}

function CategoryForm({
  heading,
  draft,
  onChange,
  onSubmit,
  onCancel,
  busy,
  submitLabel,
  showSlug = false,
  slugNote,
  embedded = false,
}: {
  heading: string;
  draft: DraftState;
  onChange: (next: DraftState) => void;
  onSubmit: (event: FormEvent) => void;
  onCancel: () => void;
  busy: boolean;
  submitLabel: string;
  showSlug?: boolean;
  slugNote?: string;
  embedded?: boolean;
}) {
  const derived = slugPreview(draft.name);
  return (
    <form
      onSubmit={onSubmit}
      className={
        embedded
          ? ''
          : 'mb-3 rounded-xl border border-neutral-800 bg-neutral-900/60 p-4'
      }
    >
      <h3 className="text-sm font-medium text-neutral-200">{heading}</h3>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="block text-xs text-neutral-400">
          Name
          <input
            value={draft.name}
            onChange={(event) => onChange({ ...draft, name: event.target.value })}
            maxLength={80}
            required
            autoFocus
            className="mt-1 w-full rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 outline-none focus:border-neutral-400"
          />
        </label>
        <label className="block text-xs text-neutral-400">
          Tagline <span className="text-neutral-600">(optional)</span>
          <input
            value={draft.tagline}
            onChange={(event) => onChange({ ...draft, tagline: event.target.value })}
            maxLength={160}
            className="mt-1 w-full rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 outline-none focus:border-neutral-400"
          />
        </label>
      </div>

      {showSlug && (
        <p className="mt-2 text-[11px] text-neutral-500">
          Identifier:{' '}
          <code className="rounded bg-neutral-800/70 px-1 py-0.5 text-neutral-300">
            {derived || '—'}
          </code>{' '}
          — set once and never changes, so renaming later is always safe.
        </p>
      )}
      {slugNote && (
        <p className="mt-2 text-[11px] text-neutral-500">
          Identifier{' '}
          <code className="rounded bg-neutral-800/70 px-1 py-0.5 text-neutral-300">{slugNote}</code>{' '}
          stays the same — renaming never breaks anything pointing at this category.
        </p>
      )}

      <div className="mt-3 flex gap-2">
        <button
          type="submit"
          disabled={busy || draft.name.trim().length === 0}
          className="rounded-lg bg-neutral-100 px-3.5 py-2 text-sm font-medium text-neutral-900 hover:bg-white disabled:opacity-50"
        >
          {busy ? 'Saving…' : submitLabel}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="rounded-lg border border-neutral-700 px-3.5 py-2 text-sm text-neutral-300 hover:bg-neutral-800 disabled:opacity-50"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

/**
 * "How this looks in the app."
 *
 * The point of the workspace: an operator should not have to translate rows
 * into a user-facing surface in their head. It renders the enabled categories
 * in their CURRENT (possibly unsaved) order, which is what makes the staged
 * reorder reviewable before it is committed.
 *
 * The rails are honestly empty: assigning content to a category is US-102.2, so
 * the preview says so rather than showing invented thumbnails.
 */
function CategoryPreview({
  categories,
  hiddenCount,
}: {
  categories: AppCategoryView[];
  hiddenCount: number;
}) {
  return (
    <aside
      aria-labelledby="category-preview-heading"
      className="lg:sticky lg:top-6 lg:self-start"
    >
      <div className="rounded-2xl border border-neutral-800 bg-neutral-900/40 p-4">
        <h2 id="category-preview-heading" className="text-sm font-semibold text-neutral-200">
          How this looks in the app
        </h2>
        <p className="mt-1 text-xs text-neutral-500">
          Enabled categories, in the order shown on the left.
          {hiddenCount > 0 && ` ${hiddenCount} hidden categor${hiddenCount === 1 ? 'y is' : 'ies are'} not shown.`}
        </p>

        {categories.length === 0 ? (
          <p className="mt-4 rounded-lg border border-dashed border-neutral-800 px-3 py-6 text-center text-xs text-neutral-500">
            Nothing would appear in the app yet.
          </p>
        ) : (
          <>
            <div className="mt-4 flex flex-wrap gap-1.5" aria-hidden>
              {categories.map((category, index) => (
                <span
                  key={category.id}
                  className={`rounded-full px-3 py-1 text-xs ${
                    index === 0
                      ? 'bg-neutral-100 text-neutral-900'
                      : 'bg-neutral-800 text-neutral-300'
                  }`}
                >
                  {category.name}
                </span>
              ))}
            </div>

            <ul className="mt-5 space-y-4">
              {categories.map((category) => (
                <li key={category.id}>
                  <div className="flex items-baseline justify-between gap-2">
                    <h3 className="truncate text-sm font-medium text-neutral-100">
                      {category.name}
                    </h3>
                    <span className="shrink-0 text-[11px] text-neutral-500">
                      {assignedLabel(category.assignedAssetCount)}
                    </span>
                  </div>
                  {category.tagline && (
                    <p className="truncate text-xs text-neutral-500">{category.tagline}</p>
                  )}
                  <div className="mt-2 flex gap-2 overflow-hidden" aria-hidden>
                    {[0, 1, 2].map((n) => (
                      <div
                        key={n}
                        className="h-16 w-12 shrink-0 rounded-md border border-dashed border-neutral-800 bg-neutral-900"
                      />
                    ))}
                  </div>
                </li>
              ))}
            </ul>

            <p className="mt-5 border-t border-neutral-800 pt-3 text-[11px] leading-relaxed text-neutral-500">
              Rails are empty because assigning approved Library content to a category is a separate
              step, arriving with content distribution (US-102.2).
            </p>
          </>
        )}
      </div>
    </aside>
  );
}
