import { and, asc, count, eq, ne } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import {
  characterVisualAssets,
  contentRequirements,
  type ContentRequirementRow,
} from '../db/schema.js';
import type { ContentRating } from './visual-asset-service.js';
import type { MediaType } from './content-review-service.js';

/**
 * Content requirements — THE single source of truth for what a character needs.
 *
 * Everything downstream reads these rows: the Review board, character
 * completion, and (later) "Generate Missing Content". There is no second
 * checklist, and nothing in this codebase names a category or a quantity — the
 * defaults are seeded ROWS (migration 0012) that an operator edits in Settings.
 *
 * A requirement is a CATEGORY plus a QUANTITY. Individual slots are never
 * persisted: the board renders capacity from `requiredQuantity` at read time,
 * so changing a quantity can never orphan a slot record, and lowering one can
 * never delete content.
 */

export const MEDIA_TYPES: readonly MediaType[] = ['image', 'video'];
const RATINGS: readonly ContentRating[] = ['sfw', 'explicit'];
const MAX_QUANTITY = 50;

/** The key is the join value written onto assets, so it must stay url/word safe. */
const KEY_RE = /^[a-z0-9][a-z0-9_]{1,49}$/;

export interface ContentRequirement {
  id: string;
  key: string;
  label: string;
  mediaType: MediaType;
  requiredQuantity: number;
  /** ADVISORY only — never a qualification gate. See requirement-status-service. */
  contentRating: ContentRating | null;
  enabled: boolean;
  /** Whether a character's primary reference image is filed here automatically. */
  assignPrimaryReference: boolean;
  position: number;
  createdAt: string;
  updatedAt: string;
}

export function toContentRequirement(row: ContentRequirementRow): ContentRequirement {
  return {
    id: row.id,
    key: row.key,
    label: row.label,
    mediaType: row.mediaType as MediaType,
    requiredQuantity: row.requiredQuantity,
    contentRating: row.contentRating,
    enabled: row.enabled,
    assignPrimaryReference: row.assignPrimaryReference,
    position: row.position,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export class ContentRequirementValidationError extends Error {
  constructor(
    public readonly field: string,
    message: string,
  ) {
    super(message);
    this.name = 'ContentRequirementValidationError';
  }
}

export class ContentRequirementKeyTakenError extends Error {
  constructor(key: string) {
    super(`A requirement with the key "${key}" already exists.`);
    this.name = 'ContentRequirementKeyTakenError';
  }
}

/**
 * Thrown when deleting a requirement that content is filed under.
 *
 * Deletion is deliberately the narrow path: disabling is the non-destructive
 * retirement, it keeps every asset's key intact, and re-enabling restores the
 * board exactly as it was. Deleting is only for a requirement created by
 * mistake — one nothing has ever been filed under.
 */
export class ContentRequirementInUseError extends Error {
  constructor(
    public readonly assetCount: number,
    message: string,
  ) {
    super(message);
    this.name = 'ContentRequirementInUseError';
  }
}

/** Derives a stable key from a label, so an operator never meets the rule. */
export function requirementKeyFromLabel(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 50);
}

export interface ContentRequirementInput {
  key?: string;
  label: string;
  mediaType: MediaType;
  requiredQuantity?: number;
  contentRating?: ContentRating | null;
  enabled?: boolean;
  assignPrimaryReference?: boolean;
  position?: number;
}

function validate(input: Partial<ContentRequirementInput>, requireAll: boolean) {
  const values: Record<string, unknown> = {};

  if (input.label !== undefined) {
    const label = input.label.trim();
    if (label.length === 0) {
      throw new ContentRequirementValidationError('label', 'A requirement needs a name.');
    }
    values.label = label.slice(0, 120);
  } else if (requireAll) {
    throw new ContentRequirementValidationError('label', 'A requirement needs a name.');
  }

  if (input.mediaType !== undefined) {
    if (!MEDIA_TYPES.includes(input.mediaType)) {
      throw new ContentRequirementValidationError('mediaType', 'Media type must be image or video.');
    }
    values.mediaType = input.mediaType;
  } else if (requireAll) {
    throw new ContentRequirementValidationError('mediaType', 'Media type is required.');
  }

  if (input.requiredQuantity !== undefined) {
    const q = input.requiredQuantity;
    if (!Number.isInteger(q) || q < 0 || q > MAX_QUANTITY) {
      throw new ContentRequirementValidationError(
        'requiredQuantity',
        `Required quantity must be a whole number between 0 and ${MAX_QUANTITY}.`,
      );
    }
    values.requiredQuantity = q;
  }

  if (input.contentRating !== undefined) {
    if (input.contentRating !== null && !RATINGS.includes(input.contentRating)) {
      throw new ContentRequirementValidationError(
        'contentRating',
        'Rating policy must be sfw, explicit, or left unset.',
      );
    }
    values.contentRating = input.contentRating;
  }

  if (input.enabled !== undefined) values.enabled = input.enabled;
  if (input.position !== undefined) {
    if (!Number.isInteger(input.position)) {
      throw new ContentRequirementValidationError('position', 'Position must be a whole number.');
    }
    values.position = input.position;
  }

  return values;
}

/** All requirements in board order. Disabled ones included — Settings edits them. */
export async function listContentRequirements(db: Db): Promise<ContentRequirement[]> {
  const rows = await db
    .select()
    .from(contentRequirements)
    .orderBy(asc(contentRequirements.position), asc(contentRequirements.createdAt));
  return rows.map(toContentRequirement);
}

/** Only what the board and the generation planner should act on. */
export async function listEnabledContentRequirements(db: Db): Promise<ContentRequirement[]> {
  return (await listContentRequirements(db)).filter((r) => r.enabled);
}

export async function getContentRequirement(
  db: Db,
  id: string,
): Promise<ContentRequirement | null> {
  const [row] = await db.select().from(contentRequirements).where(eq(contentRequirements.id, id));
  return row ? toContentRequirement(row) : null;
}

export async function getContentRequirementByKey(
  db: Db,
  key: string,
): Promise<ContentRequirement | null> {
  const [row] = await db.select().from(contentRequirements).where(eq(contentRequirements.key, key));
  return row ? toContentRequirement(row) : null;
}

/**
 * Which requirement a character's PRIMARY REFERENCE image is filed under.
 *
 * This is why the primary image can satisfy a requirement without any code
 * naming a category: the creation path asks this question, and Settings owns
 * the answer. Null when no requirement claims it — in which case the image is
 * simply left uncategorised, never guessed at.
 */
export async function getPrimaryReferenceRequirementKey(db: Db): Promise<string | null> {
  const [row] = await db
    .select({ key: contentRequirements.key })
    .from(contentRequirements)
    .where(
      and(
        eq(contentRequirements.assignPrimaryReference, true),
        eq(contentRequirements.enabled, true),
      ),
    )
    .limit(1);
  return row?.key ?? null;
}

/** How many assets are filed under a key — the deletion guard reads this. */
export async function countAssetsForRequirementKey(db: Db, key: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(characterVisualAssets)
    .where(eq(characterVisualAssets.requirementKey, key));
  return row?.n ?? 0;
}

/**
 * Only one requirement may claim the primary reference. The partial unique
 * index enforces it, so the previous claimant is cleared inside the same
 * transaction rather than relying on write ordering.
 */
async function clearOtherPrimaryClaims(
  tx: Pick<Db, 'update'>,
  exceptId: string | null,
): Promise<void> {
  const conditions = [eq(contentRequirements.assignPrimaryReference, true)];
  if (exceptId) conditions.push(ne(contentRequirements.id, exceptId));
  await tx
    .update(contentRequirements)
    .set({ assignPrimaryReference: false, updatedAt: new Date() })
    .where(and(...conditions));
}

export async function createContentRequirement(
  db: Db,
  input: ContentRequirementInput,
): Promise<ContentRequirement> {
  const values = validate(input, true);
  const key = (input.key ?? requirementKeyFromLabel(input.label)).trim().toLowerCase();
  if (!KEY_RE.test(key)) {
    throw new ContentRequirementValidationError(
      'key',
      'Give the requirement a name containing at least two letters or numbers.',
    );
  }
  if (await getContentRequirementByKey(db, key)) throw new ContentRequirementKeyTakenError(key);

  const claimsPrimary = input.assignPrimaryReference === true;
  return db.transaction(async (tx) => {
    if (claimsPrimary) await clearOtherPrimaryClaims(tx, null);
    const [row] = await tx
      .insert(contentRequirements)
      .values({
        ...(values as typeof contentRequirements.$inferInsert),
        key,
        assignPrimaryReference: claimsPrimary,
      })
      .returning();
    return toContentRequirement(row!);
  });
}

/**
 * Partial update. `key` is immutable: it is the value already written onto
 * assets, so renaming it would orphan content — the LABEL is what an operator
 * renames, and that affects nothing but the display.
 */
export async function updateContentRequirement(
  db: Db,
  id: string,
  input: Partial<ContentRequirementInput>,
): Promise<ContentRequirement | null> {
  const values = validate(input, false);
  const claimsPrimary = input.assignPrimaryReference;

  // Existence is checked BEFORE anything is cleared. Otherwise a PATCH against
  // an unknown id would strip the primary-reference claim from the requirement
  // that legitimately holds it, commit that, and then answer 404 — losing
  // configuration in the course of rejecting the request.
  const existing = await getContentRequirement(db, id);
  if (!existing) return null;

  // The media type decides what QUALIFIES for this requirement, so changing it
  // orphans everything already filed here — the same failure the immutable key
  // prevents. Allowed only while nothing is filed under it.
  if (input.mediaType !== undefined && input.mediaType !== existing.mediaType) {
    const assetCount = await countAssetsForRequirementKey(db, existing.key);
    if (assetCount > 0) {
      throw new ContentRequirementInUseError(
        assetCount,
        `${assetCount} item${assetCount === 1 ? ' is' : 's are'} filed under "${existing.label}" as ${existing.mediaType}. Changing the media type would leave ${assetCount === 1 ? 'it' : 'them'} counting toward nothing. Add a new requirement instead.`,
      );
    }
  }

  return db.transaction(async (tx) => {
    if (claimsPrimary === true) await clearOtherPrimaryClaims(tx, id);
    if (claimsPrimary !== undefined) values.assignPrimaryReference = claimsPrimary;
    if (Object.keys(values).length === 0) {
      const [existing] = await tx
        .select()
        .from(contentRequirements)
        .where(eq(contentRequirements.id, id));
      return existing ? toContentRequirement(existing) : null;
    }
    const [row] = await tx
      .update(contentRequirements)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(contentRequirements.id, id))
      .returning();
    return row ? toContentRequirement(row) : null;
  });
}

/**
 * Deletes a requirement NOTHING is filed under. Content is never touched: if
 * any asset carries this key the delete is refused and the operator is pointed
 * at disabling instead, which retires the requirement without losing anything.
 */
export async function deleteContentRequirement(db: Db, id: string): Promise<boolean> {
  const existing = await getContentRequirement(db, id);
  if (!existing) return false;

  const assetCount = await countAssetsForRequirementKey(db, existing.key);
  if (assetCount > 0) {
    throw new ContentRequirementInUseError(
      assetCount,
      `${assetCount} item${assetCount === 1 ? ' is' : 's are'} filed under "${existing.label}". Disable it instead — that removes it from the board and keeps every item.`,
    );
  }
  await db.delete(contentRequirements).where(eq(contentRequirements.id, id));
  return true;
}
