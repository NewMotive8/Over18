import { asc, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { appCategories, appCategoryAssets, type AppCategoryRow } from '../db/schema.js';

/**
 * App Categories (US-102.1) — the merchandising categories the App CMS manages.
 *
 * SCOPE DISCIPLINE, DELIBERATE AND LOAD-BEARING. Every function here touches
 * `app_categories` and, for counting and cascade-safe deletion, the
 * `app_category_assets` LINK table. Not one of them reads or writes
 * `character_visual_assets`, `content_requirements`, `content_inbox` or any
 * generation table. That is why "managing categories never touches content" is
 * a property of the module rather than a promise in a comment — the same
 * discipline content-requirements-service.ts uses for the same reason.
 *
 * WHAT MAKES A CATEGORY THE SAME CATEGORY. Its `slug`, fixed at creation.
 * `name` is display text an operator changes freely; nothing joins on it. The
 * route layer refuses a slug change outright rather than accepting one and
 * silently breaking references.
 */

export class AppCategoryValidationError extends Error {
  constructor(
    public readonly field: string,
    message: string,
  ) {
    super(message);
    this.name = 'AppCategoryValidationError';
  }
}

export class AppCategorySlugTakenError extends Error {
  constructor(
    public readonly slug: string,
    message: string,
  ) {
    super(message);
    this.name = 'AppCategorySlugTakenError';
  }
}

/** Thrown when a reorder is not an exact permutation of what exists. */
export class AppCategoryOrderError extends Error {
  constructor(
    public readonly reason: 'unknown_id' | 'incomplete' | 'duplicate',
    message: string,
  ) {
    super(message);
    this.name = 'AppCategoryOrderError';
  }
}

export interface AppCategory {
  id: string;
  slug: string;
  name: string;
  tagline: string | null;
  enabled: boolean;
  position: number;
  createdAt: string;
  updatedAt: string;
}

/** A category plus how much content is currently merchandised in it. */
export interface AppCategoryWithUsage extends AppCategory {
  /**
   * Assignments in `app_category_assets`. Always 0 until US-102.2 ships an
   * assignment surface — but read from the real table, never hard-coded, so
   * the delete confirmation tells the truth the moment assignments exist.
   */
  assignedAssetCount: number;
}

const NAME_MAX = 80;
const TAGLINE_MAX = 160;
const SLUG_MAX = 60;

/**
 * Derives a stable slug from a display name, so an operator never has to think
 * about internal identity. Mirrors requirementKeyFromLabel's rules, with '-'
 * instead of '_' because these slugs are user-facing-adjacent (they are what a
 * future catalogue URL would use).
 *
 * The web client derives the same value for its live preview — the two
 * implementations are kept in step by a test on each side.
 */
export function slugFromName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX);
}

function toAppCategory(row: AppCategoryRow): AppCategory {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    tagline: row.tagline,
    enabled: row.enabled,
    position: row.position,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export interface AppCategoryInput {
  /** Optional: derived from `name` when absent. Immutable once stored. */
  slug?: string;
  name: string;
  tagline?: string | null;
  enabled?: boolean;
}

function validate(input: Partial<AppCategoryInput>, requireName: boolean) {
  const values: Record<string, unknown> = {};

  if (input.name !== undefined) {
    const name = input.name.trim();
    if (name.length === 0) {
      throw new AppCategoryValidationError('name', 'A category needs a name.');
    }
    values.name = name.slice(0, NAME_MAX);
  } else if (requireName) {
    throw new AppCategoryValidationError('name', 'A category needs a name.');
  }

  if (input.tagline !== undefined) {
    const tagline = input.tagline === null ? null : input.tagline.trim();
    // Empty string and null mean the same thing — no tagline — so they are
    // stored the same way rather than as two indistinguishable states.
    values.tagline = tagline && tagline.length > 0 ? tagline.slice(0, TAGLINE_MAX) : null;
  }

  if (input.enabled !== undefined) {
    if (typeof input.enabled !== 'boolean') {
      throw new AppCategoryValidationError('enabled', 'Enabled must be true or false.');
    }
    values.enabled = input.enabled;
  }

  return values;
}

/** Every category, in merchandising order, with its assignment count. */
export async function listAppCategories(db: Db): Promise<AppCategoryWithUsage[]> {
  const rows = await db
    .select()
    .from(appCategories)
    .orderBy(asc(appCategories.position), asc(appCategories.createdAt));

  if (rows.length === 0) return [];

  // One grouped query rather than N counts — the list is the most-hit route in
  // the workspace and this keeps it a constant two round trips.
  const counts = await db
    .select({
      categoryId: appCategoryAssets.categoryId,
      total: sql<number>`count(*)::int`,
    })
    .from(appCategoryAssets)
    .groupBy(appCategoryAssets.categoryId);

  const byCategory = new Map(counts.map((row) => [row.categoryId, Number(row.total)]));
  return rows.map((row) => ({
    ...toAppCategory(row),
    assignedAssetCount: byCategory.get(row.id) ?? 0,
  }));
}

export async function getAppCategory(db: Db, id: string): Promise<AppCategory | null> {
  const [row] = await db.select().from(appCategories).where(eq(appCategories.id, id)).limit(1);
  return row ? toAppCategory(row) : null;
}

/**
 * Creates a category at the END of the order.
 *
 * Appending rather than inserting means creating a category never silently
 * renumbers the ones an operator has already arranged.
 */
/**
 * Slugs the Admin already routes to something that is not an app_categories
 * row. Kept here, next to the only function that can create one.
 */
const RESERVED_SLUGS = new Set(['play-with-me']);

export async function createAppCategory(db: Db, input: AppCategoryInput): Promise<AppCategory> {
  const values = validate(input, true);
  const name = values.name as string;
  const slug = (input.slug ?? slugFromName(name)).trim().toLowerCase();

  if (slug.length === 0) {
    throw new AppCategoryValidationError(
      'slug',
      'This name produces no usable identifier. Use at least one letter or number.',
    );
  }
  if (!/^[a-z0-9-]+$/.test(slug)) {
    throw new AppCategoryValidationError(
      'slug',
      'An identifier may contain only lowercase letters, numbers and hyphens.',
    );
  }

  /**
   * RESERVED SLUGS. The Admin routes a category board at
   * /admin/publishing/:slug, and Play with me — which is a derived rail, not a
   * row here — is served at the reserved `play-with-me` slug. A real category
   * created with that slug would shadow the route and be unreachable, so it is
   * refused at creation with the same error a collision produces.
   */
  if (RESERVED_SLUGS.has(slug)) {
    throw new AppCategorySlugTakenError(
      slug,
      `The identifier "${slug}" is reserved for a built-in rail.`,
    );
  }

  const [existing] = await db
    .select({ id: appCategories.id })
    .from(appCategories)
    .where(eq(appCategories.slug, slug))
    .limit(1);
  if (existing) {
    throw new AppCategorySlugTakenError(slug, `The identifier "${slug}" is already in use.`);
  }

  const [{ next } = { next: 0 }] = await db
    .select({ next: sql<number>`coalesce(max(${appCategories.position}), -1) + 1` })
    .from(appCategories);

  try {
    const [row] = await db
      .insert(appCategories)
      .values({
        slug,
        name,
        tagline: (values.tagline as string | null) ?? null,
        enabled: (values.enabled as boolean | undefined) ?? true,
        position: Number(next),
      })
      .returning();
    return toAppCategory(row!);
  } catch (error) {
    // Two operators creating the same slug at once lose the race at the unique
    // index rather than at the check above. Same answer either way.
    if (isUniqueViolation(error)) {
      throw new AppCategorySlugTakenError(slug, `The identifier "${slug}" is already in use.`);
    }
    throw error;
  }
}

/**
 * Updates presentation and state. `slug` is not accepted here at all — the
 * route rejects it explicitly so an operator gets an explanation rather than a
 * silently ignored field.
 */
export async function updateAppCategory(
  db: Db,
  id: string,
  input: Partial<AppCategoryInput>,
): Promise<AppCategory | null> {
  const values = validate(input, false);
  if (Object.keys(values).length === 0) return getAppCategory(db, id);

  const [row] = await db
    .update(appCategories)
    .set({ ...values, updatedAt: new Date() })
    .where(eq(appCategories.id, id))
    .returning();
  return row ? toAppCategory(row) : null;
}

export interface AppCategoryDeletion {
  /** Assignments released. The assets themselves are untouched. */
  releasedAssetCount: number;
}

/**
 * Deletes a category. ALWAYS PERMITTED, even when content is merchandised in
 * it — and that is a deliberate difference from content requirements, which
 * refuse deletion while in use.
 *
 * The product rule is explicit: deleting a category must never delete content.
 * Affected content becomes unassigned and remains in the Library, available for
 * reassignment. The FK on app_category_assets.category_id is ON DELETE CASCADE,
 * so the database drops the LINK rows and cannot reach the asset rows — this
 * function does not contain, and must never contain, a delete against any asset
 * table.
 *
 * The released count is read BEFORE the delete so the caller can report what
 * actually became unassigned.
 */
export async function deleteAppCategory(
  db: Db,
  id: string,
): Promise<AppCategoryDeletion | null> {
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: appCategories.id })
      .from(appCategories)
      .where(eq(appCategories.id, id))
      .limit(1);
    if (!existing) return null;

    const [{ total } = { total: 0 }] = await tx
      .select({ total: sql<number>`count(*)::int` })
      .from(appCategoryAssets)
      .where(eq(appCategoryAssets.categoryId, id));

    await tx.delete(appCategories).where(eq(appCategories.id, id));

    // Close the gap the deleted row leaves, so positions stay 0..n-1 and a
    // later reorder is comparing like with like.
    await normalisePositions(tx);

    return { releasedAssetCount: Number(total) };
  });
}

/**
 * Applies a new order.
 *
 * `orderedIds` must be an EXACT PERMUTATION of the categories that currently
 * exist. A partial list is refused rather than applied, because the obvious
 * failure mode here is a stale browser: someone reorders a list they loaded
 * before a colleague added a category, and a lenient implementation would
 * quietly push the new category to an arbitrary place — or drop it from the
 * ordering entirely. Refusing turns a silent data problem into a reload.
 *
 * One transaction, positions rewritten to 0..n-1.
 *
 * IT ALSO RENUMBERS THE HOME ORDER, and that is the fix for a reported bug
 * rather than an extra feature. `app_categories` carries TWO order columns:
 * `position`, which this writes and which drives this list and Home's pill
 * strip, and `home_position`, which is the only key Home's category RAILS read.
 * Nothing kept them related. `home_position` is assigned on publication as
 * `max + 1` — append order, never an arrangement anyone chose — so an operator
 * who dragged categories here and pressed Save saw the list reorder, saw the
 * pills reorder, and saw the rails keep their old sequence. The order was
 * persisted and then ignored, which is indistinguishable from a save that did
 * nothing.
 *
 * ONLY THE PUBLISHED SUBSET IS RENUMBERED, in the relative order given here, so
 * an unpublished category cannot occupy a Home slot and publishing one still
 * appends. The Home composer is untouched and still writes `home_position`
 * directly: it remains the way to give Home an order that DIFFERS from this
 * list. The consequence, stated plainly because it is a real trade: reordering
 * here now overwrites a Home-specific arrangement set there. That is the
 * intended direction — an operator who has just arranged this list has said
 * what she wants, and silently keeping a different order was the bug.
 */
export async function reorderAppCategories(db: Db, orderedIds: string[]): Promise<AppCategory[]> {
  const unique = new Set(orderedIds);
  if (unique.size !== orderedIds.length) {
    throw new AppCategoryOrderError('duplicate', 'The same category was listed more than once.');
  }

  return db.transaction(async (tx) => {
    const existing = await tx
      .select({ id: appCategories.id, homePublished: appCategories.homePublished })
      .from(appCategories);
    const existingIds = new Set(existing.map((row) => row.id));
    const publishedIds = new Set(existing.filter((row) => row.homePublished).map((row) => row.id));

    for (const id of orderedIds) {
      if (!existingIds.has(id)) {
        throw new AppCategoryOrderError('unknown_id', 'That category no longer exists.');
      }
    }
    if (orderedIds.length !== existingIds.size) {
      throw new AppCategoryOrderError(
        'incomplete',
        'The order is out of date — it does not list every category. Reload and try again.',
      );
    }

    const now = new Date();
    for (const [index, id] of orderedIds.entries()) {
      await tx
        .update(appCategories)
        .set({ position: index, updatedAt: now })
        .where(eq(appCategories.id, id));
    }

    // Home's rails follow `home_position`. Renumber the PUBLISHED categories
    // 0..n-1 in the order just given, so the arrangement the operator made is
    // the arrangement the app renders. Unpublished categories keep whatever
    // they had; publishing one still appends to the end.
    const publishedInNewOrder = orderedIds.filter((id) => publishedIds.has(id));
    for (const [index, id] of publishedInNewOrder.entries()) {
      await tx
        .update(appCategories)
        .set({ homePosition: index, updatedAt: now })
        .where(eq(appCategories.id, id));
    }

    const rows = await tx
      .select()
      .from(appCategories)
      .orderBy(asc(appCategories.position), asc(appCategories.createdAt));
    return rows.map(toAppCategory);
  });
}

/** Rewrites positions to 0..n-1 in current order. */
async function normalisePositions(tx: Pick<Db, 'select' | 'update'>): Promise<void> {
  const rows = await tx
    .select({ id: appCategories.id })
    .from(appCategories)
    .orderBy(asc(appCategories.position), asc(appCategories.createdAt));
  for (const [index, row] of rows.entries()) {
    await tx.update(appCategories).set({ position: index }).where(eq(appCategories.id, row.id));
  }
}

/**
 * Postgres reports a duplicate key as 23505, but Drizzle wraps the driver error
 * — the code lives on `cause`, sometimes nested. Walking the chain is what
 * stops a duplicate slug surfacing as a 500. (Same helper shape, and same
 * hard-won reason, as content-requirements-service.ts.)
 */
function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth++) {
    if (typeof current === 'object' && 'code' in current && (current as { code?: string }).code === '23505') {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Test/US-102.2 seam: link an approved asset to a category.
 *
 * NOT AN ASSIGNMENT FEATURE. There is no route, no client method and no UI for
 * this in US-102.1 — it exists so the delete-safety guarantee can be proven
 * against real link rows today, and so US-102.2 has a typed starting point
 * rather than raw SQL. It performs no eligibility check; the approved-only rule
 * belongs with the assignment surface that US-102.2 will build.
 */
export async function linkAssetToCategory(
  db: Db,
  categoryId: string,
  assetId: string,
  position = 0,
): Promise<void> {
  await db
    .insert(appCategoryAssets)
    .values({ categoryId, assetId, position })
    .onConflictDoNothing();
}

/** Reads a category's asset ids. Used by tests to prove links were released. */
export async function listCategoryAssetIds(db: Db, categoryId: string): Promise<string[]> {
  const rows = await db
    .select({ assetId: appCategoryAssets.assetId })
    .from(appCategoryAssets)
    .where(eq(appCategoryAssets.categoryId, categoryId))
    .orderBy(asc(appCategoryAssets.position));
  return rows.map((row) => row.assetId);
}
