import type { AppCategoryView } from '../lib/api';

/**
 * App Categories workspace logic (US-102.1) — React-free on purpose.
 *
 * The ordering rules are the part of this screen that actually breaks: an
 * off-by-one in a drag, a keyboard move that falls off the end, a "Save order"
 * button that stays lit when nothing changed, a preview that quietly shows a
 * disabled category. None of that is observable in a static render, and this
 * repo's web tests run in node with `react-dom/server` — no DOM, no pointer
 * events. So every decision lives here as a pure function over plain arrays and
 * the component is a thin binding over it.
 *
 * A consequence worth stating plainly: the drag GESTURE cannot be exercised by
 * these tests. What is covered is the arithmetic every gesture ends in, plus
 * the keyboard path, which is the accessible route to the same behaviour.
 */

/** Ordering is by array position; `position` from the server is only a seed. */
export type OrderedCategory = Pick<AppCategoryView, 'id'>;

/**
 * Derives the slug the server will assign, for the create form's live preview.
 *
 * MUST match slugFromName in app-category-service.ts. Both sides have a test
 * over the same cases; if one drifts, one of them fails.
 */
export function slugPreview(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/**
 * Moves the item at `from` so it lands at index `to`.
 *
 * Out-of-range indices return the list unchanged rather than throwing: a drop
 * outside the list is a normal thing for a person to do, not an error.
 */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  if (from === to) return [...list];
  if (from < 0 || from >= list.length) return [...list];
  if (to < 0 || to >= list.length) return [...list];
  const next = [...list];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);
  return next;
}

/**
 * Keyboard/button move: shifts one category by `delta` places, CLAMPED.
 *
 * Clamping rather than wrapping is deliberate — pressing "up" on the first row
 * should do nothing visible, not teleport it to the bottom.
 */
export function moveBy<T extends { id: string }>(
  list: readonly T[],
  id: string,
  delta: number,
): T[] {
  const from = list.findIndex((item) => item.id === id);
  if (from === -1) return [...list];
  const to = Math.min(Math.max(from + delta, 0), list.length - 1);
  return moveItem(list, from, to);
}

/** Can this row still move in that direction? Drives disabled states. */
export function canMove<T extends { id: string }>(
  list: readonly T[],
  id: string,
  delta: number,
): boolean {
  const index = list.findIndex((item) => item.id === id);
  if (index === -1) return false;
  const target = index + delta;
  return target >= 0 && target < list.length;
}

export function orderOf(list: readonly OrderedCategory[]): string[] {
  return list.map((item) => item.id);
}

/** True when two orders are the same sequence — what "Save order" listens to. */
export function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

/**
 * Reconciles a locally-reordered list against a freshly-loaded server list.
 *
 * Used after any non-ordering change (rename, enable, delete) so an operator's
 * in-progress arrangement is not thrown away by a refresh. Server rows are the
 * source of truth for CONTENT; the local array is the source of truth for
 * ORDER. Anything new on the server is appended, anything gone is dropped.
 */
export function reconcileOrder<T extends { id: string }>(
  local: readonly { id: string }[],
  server: readonly T[],
): T[] {
  const byId = new Map(server.map((item) => [item.id, item]));
  const merged: T[] = [];
  for (const { id } of local) {
    const match = byId.get(id);
    if (match) {
      merged.push(match);
      byId.delete(id);
    }
  }
  for (const remaining of server) {
    if (byId.has(remaining.id)) merged.push(remaining);
  }
  return merged;
}

/**
 * What the app would actually show: enabled categories only, in order.
 *
 * Disabled categories are retired from the app but stay in the workspace, so
 * the preview is the one place the distinction has to be enforced.
 */
export function previewCategories(list: readonly AppCategoryView[]): AppCategoryView[] {
  return list.filter((category) => category.enabled);
}

export interface CategorySummary {
  total: number;
  enabled: number;
  disabled: number;
  assignedAssets: number;
}

export function summarise(list: readonly AppCategoryView[]): CategorySummary {
  const enabled = list.filter((category) => category.enabled).length;
  return {
    total: list.length,
    enabled,
    disabled: list.length - enabled,
    assignedAssets: list.reduce((n, category) => n + category.assignedAssetCount, 0),
  };
}

/**
 * The sentence shown in the delete confirmation.
 *
 * The product rule is that deleting a category never deletes content, and the
 * US-102 brief asks for that to be communicated explicitly rather than assumed.
 * So the copy states the consequence in both directions — what goes, and what
 * stays — and names the real number.
 */
export function deletionMessage(category: AppCategoryView): string {
  if (category.assignedAssetCount === 0) {
    return `"${category.name}" is empty, so nothing is affected. This cannot be undone.`;
  }
  const items =
    category.assignedAssetCount === 1 ? '1 item' : `${category.assignedAssetCount} items`;
  return `${items} will be removed from "${category.name}" and become unassigned. Nothing is deleted from the Library — every item stays there and can be added to another category.`;
}

/** Human phrasing for the count badge on a row. */
export function assignedLabel(count: number): string {
  if (count === 0) return 'No content yet';
  return count === 1 ? '1 item' : `${count} items`;
}

/* ------------------------------------------------------------------ *
 * Guarding an unsaved order against navigation
 * ------------------------------------------------------------------ */

export interface LinkClickIntent {
  /** The anchor's raw href attribute — may be relative, absolute or a hash. */
  href: string | null;
  /** The app's own origin, for deciding whether this leaves the app. */
  origin: string;
  /** Where we already are; navigating to the same place needs no warning. */
  currentPath: string;
  /** The anchor's target attribute; anything but _self opens elsewhere. */
  target?: string | null;
  hasDownload?: boolean;
  /** Ctrl/Cmd/Shift/Alt or a non-primary button — the user wants a new tab. */
  modified?: boolean;
}

/**
 * Decides whether a click should be held back because the staged category
 * order has not been saved.
 *
 * Extracted here rather than left inline because the interesting part is the
 * set of clicks that must NOT be intercepted. Swallowing a modifier-click, a
 * download, an external link or a same-page anchor would be a worse bug than
 * the one the guard exists to prevent — an operator who cannot open a link in
 * a new tab has no idea why.
 *
 * Returns the in-app path to navigate to once confirmed, or null to let the
 * click proceed untouched.
 *
 * This app mounts a plain BrowserRouter, not a data router, so react-router's
 * useBlocker is unavailable; a capture-phase click listener plus this rule is
 * the equivalent that works here.
 */
export function interceptedPath(intent: LinkClickIntent): string | null {
  const { href, origin, currentPath } = intent;
  if (!href) return null;
  if (intent.modified) return null;
  if (intent.hasDownload) return null;
  if (intent.target && intent.target !== '_self') return null;
  // A same-page hash or a non-http scheme is not an in-app navigation.
  if (href.startsWith('#')) return null;

  let url: URL;
  try {
    url = new URL(href, origin);
  } catch {
    return null;
  }
  if (url.origin !== origin) return null;
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

  const destination = `${url.pathname}${url.search}`;
  if (url.pathname === currentPath) return null;
  return destination;
}
