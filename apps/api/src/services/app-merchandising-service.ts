import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import {
  appCategories,
  appCategoryAssets,
  characters,
  characterVisualAssets,
  type CharacterVisualAssetRow,
} from '../db/schema.js';
import { mediaTypeOf } from './content-review-service.js';
import { PUBLIC_CONTENT_KINDS } from './asset-kinds.js';

/**
 * Content distribution & category merchandising (US-102.2).
 *
 * Puts approved Library content INTO the App Categories US-102.1 created. It
 * writes only `app_category_assets` — link rows. There is no UPDATE and no
 * DELETE against `character_visual_assets` anywhere in this file, which is what
 * makes "merchandising never modifies the Library" a property of the module
 * rather than a promise. The Review → Approved → Library lifecycle is read
 * from, never written to.
 *
 * PUBLISHABILITY IS CHECKED TWICE, ON PURPOSE.
 *
 *  1. On WRITE: only `status = 'approved'` can be newly assigned. Anything
 *     else is refused per-asset and reported back.
 *
 *  2. On READ: every query that produces a category's PUBLIC contents joins
 *     `status = 'approved'`. This is the one that actually matters, because an
 *     asset can be approved, assigned, and rejected afterwards. The link row
 *     survives that — it is not destroyed — but the asset cannot appear in a
 *     public result while it is not approved, and it reappears by itself if it
 *     is approved again. Deleting links on rejection would mean reaching into
 *     the review lifecycle from the merchandising side, i.e. exactly the
 *     competing lifecycle US-102 forbids.
 *
 * WHAT IS NOT A PUBLISHABILITY GATE: `content_rating`. It is advisory
 * throughout this product (see content_requirements), and an explicit approved
 * asset is as assignable as an sfw one. Same for `is_canonical` — a Primary
 * reference is approved content and may be merchandised. Both are surfaced to
 * the operator as visible facts, never as silent filters.
 */

/** The one rule that decides whether an asset may be publicly associated. */
export const PUBLISHABLE_STATUS = 'approved' as const;

/**
 * WHAT A HOME RAIL ACTUALLY RENDERS, WRITTEN DOWN ONCE.
 *
 * Approval is NOT the whole rule and never was. `listHomeCategories` has always
 * asked four questions of a clip before it reaches a rail, and every Admin
 * surface asked only the first — so the Admin counted, offered and accepted
 * content the app could never show, and reported it as publishable.
 *
 * The four, in the order an operator can act on them:
 *
 *  1. APPROVED. The merchandising rule above.
 *  2. CONTENT. `PUBLIC_CONTENT_KINDS` — an identity reference is public but is
 *     not content, and chat media is neither.
 *  3. THE CHARACTER IS ACTIVE. Retiring a character removes her from every
 *     public route; her clips go with her. This is the one the Admin missed
 *     most expensively, because the picker offered those clips and the write
 *     accepted them.
 *  4. THERE ARE BYTES. A row with no `storage_key` has no file to render, and
 *     `publicAssetUrl` would answer null for it anyway.
 *
 * Returned as an array of conditions rather than a single `and(...)` so callers
 * can spread it alongside their own. EVERY caller must join `characters` —
 * condition 3 names that table, and a query without the join will not compile
 * into valid SQL. That is deliberate: the join is the reminder.
 *
 * This does not RESTATE `publiclyReachableCondition`. That predicate answers a
 * different question — "may this asset's bytes be fetched by id" — and includes
 * reachability arms (Hero, keywords, canonical identity) that have nothing to
 * do with whether a category rail renders a tile. The two overlap; neither is
 * derivable from the other.
 */
export function homeRenderableConditions() {
  return [...assignableConditions(), eq(characters.status, 'active')];
}

/**
 * THE THREE RULES THAT ARE PROPERTIES OF THE ASSET ITSELF.
 *
 * `homeRenderableConditions` minus the character's publication state, and the
 * distinction is a product rule rather than a convenience.
 *
 * A CHARACTER IS BUILT BEFORE SHE IS PUBLISHED. The CMS creates her inactive on
 * purpose — "created unpublished, the safety rule is intact" — and the operator
 * journey is name → upload → approve → MERCHANDISE → Hero → publish her. So
 * refusing to assign an inactive character's clips would forbid the ordinary
 * way of preparing a character, and publishing her would then require going
 * back round every category to add what should already have been there.
 *
 * Her inactivity is therefore reported, never enforced: the picker offers those
 * clips with a warning, the write accepts them, and the counts and the rail
 * both exclude them until she is published — at which point they appear with no
 * further action. The other three cannot be resolved by publishing anyone, so
 * they stay refusals.
 */
export function assignableConditions() {
  return [
    eq(characterVisualAssets.status, PUBLISHABLE_STATUS),
    inArray(characterVisualAssets.kind, [...PUBLIC_CONTENT_KINDS]),
    sql`${characterVisualAssets.storageKey} is not null and ${characterVisualAssets.storageKey} <> ''`,
  ];
}

/** Why one asset cannot appear on Home. `null` means it can. */
export type HomeIneligibility = 'not_approved' | 'not_content' | 'character_inactive' | 'no_media';

/**
 * The TS half of `homeRenderableConditions`, evaluated per row.
 *
 * Kept beside the SQL rather than in the web app so the two cannot disagree,
 * and so an operator is told WHICH rule an assignment fails instead of being
 * shown a tile that silently never renders. The conditions are checked in the
 * same order they are listed above; the first failure is the one reported,
 * because an asset that is both unapproved and orphaned is an approval problem
 * first.
 *
 * `storageKey` is tested exactly as the SQL tests it — null or empty, with no
 * trimming — so a whitespace-only key is judged identically on both sides.
 */
export function homeIneligibilityOf(row: {
  status: string;
  kind: string;
  storageKey: string | null;
  characterStatus: string;
}): HomeIneligibility | null {
  if (row.status !== PUBLISHABLE_STATUS) return 'not_approved';
  if (!(PUBLIC_CONTENT_KINDS as readonly string[]).includes(row.kind)) return 'not_content';
  if (row.storageKey === null || row.storageKey === '') return 'no_media';
  if (row.characterStatus !== 'active') return 'character_inactive';
  return null;
}

/**
 * True when a refusal is the right answer, false when a warning is.
 *
 * The single place that decides which of the four rules blocks a WRITE — see
 * `assignableConditions` for why the character's publication state is the one
 * that does not.
 */
export function refusesAssignment(reason: HomeIneligibility): boolean {
  return reason !== 'character_inactive';
}

export class MerchandisingValidationError extends Error {
  constructor(
    public readonly field: string,
    message: string,
  ) {
    super(message);
    this.name = 'MerchandisingValidationError';
  }
}

export class MerchandisingOrderError extends Error {
  constructor(
    public readonly reason: 'unknown_id' | 'incomplete' | 'duplicate',
    message: string,
  ) {
    super(message);
    this.name = 'MerchandisingOrderError';
  }
}

/**
 * Why an asset could not be added. Reported per asset, never as a batch failure.
 *
 * `character_inactive` and `no_media` were added when the write path was
 * aligned with `homeRenderableConditions`. They are REFUSALS rather than
 * warnings for the same reason `not_approved` is one: a category is a public
 * surface, and accepting an assignment the app can never render is how an
 * operator ends up publishing a category that shows nothing.
 */
export type AddRejection =
  | 'not_found'
  | 'not_approved'
  | 'already_present'
  | 'not_content'
  | 'character_inactive'
  | 'no_media';

export interface AddOutcome {
  assetId: string;
  added: boolean;
  reason?: AddRejection;
  /** Present for `not_approved`, so the UI can say WHICH state blocked it. */
  status?: string;
}

export interface CategoryAssetView {
  assetId: string;
  characterId: string;
  characterName: string;
  mediaType: 'image' | 'video';
  contentRating: string;
  /** Advisory only — never a reason an item is or is not publishable. */
  isPrimary: boolean;
  status: string;
  /** Position WITHIN this category. */
  position: number;
  featured: boolean;
  /**
   * True when this asset is currently publishable. False means the assignment
   * still exists but the item is absent from every public read — the operator
   * sees it flagged rather than silently vanishing.
   *
   * THIS NOW ANSWERS THE SAME QUESTION HOME ASKS. It used to mean "approved",
   * which is only the first of four rules, so an approved clip belonging to a
   * retired character was reported publishable and rendered nowhere.
   */
  publishable: boolean;
  /**
   * Which rule the item fails, or null when it fails none. Present so the
   * operator is told WHY a tile will not appear rather than being left to
   * compare an Admin count against a rail by eye.
   */
  ineligibleReason: HomeIneligibility | null;
  /**
   * Opaque, message-free media locator. NEVER a storage key or filesystem
   * path: the browser gets a route keyed by asset id and nothing else.
   */
  previewUrl: string | null;
  addedAt: string;
}

export interface CandidateAssetView {
  assetId: string;
  characterId: string;
  characterName: string;
  mediaType: 'image' | 'video';
  contentRating: string;
  isPrimary: boolean;
  previewUrl: string | null;
  approvedAt: string | null;
  /** Which other categories already merchandise this asset. */
  categoryCount: number;
  /** True when it is already in the category being merchandised. */
  inThisCategory: boolean;
  /**
   * Non-null when this candidate may be assigned but would not appear on Home
   * yet — in practice, a character who has not been published. Shown on the
   * tile so the choice is informed rather than discovered later as a short rail.
   */
  ineligibleReason: HomeIneligibility | null;
}

/** The opaque locator the browser is given for an asset's bytes. */
export function assetPreviewUrl(assetId: string, storageKey: string | null): string | null {
  return storageKey ? `/admin/content/assets/${assetId}/file` : null;
}

function mediaTypeFor(
  storageKey: string | null,
  provenance: Record<string, unknown> | null,
): 'image' | 'video' {
  return mediaTypeOf(storageKey, provenance) === 'video' ? 'video' : 'image';
}

/* ------------------------------------------------------------------ *
 * Reading a category's contents
 * ------------------------------------------------------------------ */

/**
 * Everything assigned to a category, INCLUDING items that have lost approval.
 *
 * This is the ADMIN view — the operator has to be able to see and clean up an
 * assignment whose asset was rejected after the fact. `publishable` marks
 * those. The public view is listPublishableCategoryAssets below, and the two
 * are separate functions precisely so a public caller cannot get this one by
 * forgetting a flag.
 *
 * ORDERING IS `position` ALONE, with a stable id tiebreak. `featured` is a
 * BADGE, not a sort key — it used to be the leading ORDER BY term, which made
 * it impossible to drag an ordinary item ahead of a featured one: the save
 * wrote the requested positions and the next read sorted them straight back.
 * The operator's saved order is now the only ordering authority.
 */
export async function listCategoryAssetsForAdmin(
  db: Db,
  categoryId: string,
): Promise<CategoryAssetView[]> {
  const rows = await db
    .select({
      link: appCategoryAssets,
      asset: characterVisualAssets,
      characterName: characters.name,
      // Selected for `homeIneligibilityOf`, not for display. Without it this
      // view cannot tell an approved clip of a retired character apart from
      // one the app will actually render.
      characterStatus: characters.status,
    })
    .from(appCategoryAssets)
    .innerJoin(characterVisualAssets, eq(characterVisualAssets.id, appCategoryAssets.assetId))
    .innerJoin(characters, eq(characters.id, characterVisualAssets.characterId))
    .where(eq(appCategoryAssets.categoryId, categoryId))
    // position ONLY. See the note above: featured must never reorder anything.
    .orderBy(asc(appCategoryAssets.position), asc(appCategoryAssets.assetId));

  return rows.map(({ link, asset, characterName, characterStatus }) => ({
    assetId: asset.id,
    characterId: asset.characterId,
    characterName,
    mediaType: mediaTypeFor(asset.storageKey, asset.provenance as Record<string, unknown> | null),
    contentRating: asset.contentRating,
    isPrimary: asset.isCanonical,
    status: asset.status,
    position: link.position,
    featured: link.featured,
    publishable: ineligibilityFor(asset, characterStatus) === null,
    ineligibleReason: ineligibilityFor(asset, characterStatus),
    previewUrl: assetPreviewUrl(asset.id, asset.storageKey),
    addedAt: link.createdAt.toISOString(),
  }));
}

/** Narrows an asset row to the four fields the eligibility rules read. */
function ineligibilityFor(
  asset: Pick<CharacterVisualAssetRow, 'status' | 'kind' | 'storageKey'>,
  characterStatus: string,
): HomeIneligibility | null {
  return homeIneligibilityOf({
    status: asset.status,
    kind: asset.kind,
    storageKey: asset.storageKey,
    characterStatus,
  });
}

/**
 * The PUBLIC contents of a category: approved only, always.
 *
 * The approval condition is part of the query, not a filter applied afterwards,
 * so there is no code path that returns a non-approved asset from here — which
 * is the guarantee "under-review, rejected or otherwise non-publishable content
 * must not appear publicly" actually rests on.
 *
 * US-102.4 will consume this for Home. Nothing public reads it yet.
 */
export async function listPublishableCategoryAssets(
  db: Db,
  categoryId: string,
): Promise<CategoryAssetView[]> {
  const all = await listCategoryAssetsForAdmin(db, categoryId);
  // The admin view above deliberately shows everything that was ever linked,
  // including rows that have since lost approval. The PUBLIC view applies the
  // full rail rule — `homeRenderableConditions` — so this function and the rail
  // cannot answer differently about the same category.
  const rows = await db
    .select({ assetId: characterVisualAssets.id })
    .from(appCategoryAssets)
    .innerJoin(characterVisualAssets, eq(characterVisualAssets.id, appCategoryAssets.assetId))
    .innerJoin(characters, eq(characters.id, characterVisualAssets.characterId))
    .where(and(eq(appCategoryAssets.categoryId, categoryId), ...homeRenderableConditions()));
  const publishable = new Set(rows.map((row) => row.assetId));
  return all.filter((item) => publishable.has(item.assetId));
}

/* ------------------------------------------------------------------ *
 * Choosing what to add
 * ------------------------------------------------------------------ */

export interface CandidateFilter {
  characterId?: string;
  mediaType?: 'image' | 'video';
  contentRating?: string;
  /** Free text over the character's name. */
  search?: string;
  /** Marks (and optionally hides) what is already in this category. */
  categoryId?: string;
  excludeAssigned?: boolean;
  limit?: number;
}

/**
 * The picker's source list: APPROVED, NON-REFERENCE, VIDEO content.
 *
 * Approval is a SQL condition here too, so a non-approved asset is never even
 * offered — the operator cannot select something the write path would then
 * refuse. Rating and Primary status are returned as visible facts, never used
 * to exclude anything.
 *
 * VIDEO-ONLY IS NOT A FILTER. An App Category is a public surface, and every
 * public surface in this product is already clip-only — Play with Me, Search
 * and the Hero each had to close that separately. Offering an approved image
 * here left the one door through which one could still reach them: a category
 * assignment. So it is enforced, not defaulted, and `filter.mediaType` can
 * only ever narrow further — asking for images returns nothing rather than
 * re-opening the door.
 */
export async function listAssignmentCandidates(
  db: Db,
  filter: CandidateFilter = {},
): Promise<CandidateAssetView[]> {
  const conditions = [
    /**
     * THE PICKER OFFERS WHAT HOME CAN RENDER, AND NOTHING ELSE.
     *
     * It used to ask only for approval and content kind, so it offered clips
     * belonging to RETIRED characters and rows with no file. Assigning one
     * succeeded, the Admin counted it as publishable, and the rail rendered
     * nothing — the operator's only evidence being a category that came out
     * shorter than the number the Admin had just shown them.
     *
     * Spread from `assignableConditions` rather than restated, so a rule added
     * to the write path is applied here or the build breaks.
     *
     * IT OFFERS EXACTLY WHAT THE WRITE WILL ACCEPT — which is deliberately NOT
     * the same as what Home will render. An unpublished character's clips are
     * still offered, because merchandising her before publishing her is the
     * intended journey; they arrive carrying `ineligibleReason` so the operator
     * is told they will not appear yet. Offering only Home-renderable content
     * would make preparing a character impossible.
     *
     * IT STILL CARRIES THE KIND GATE — that condition now lives in the shared
     * list rather than here. A REFERENCE IS NOT MERCHANDISE: the picker once
     * offered identity images alongside content, because a canonical portrait
     * is approved and approval was the only question being asked. Excluded by
     * kind rather than by de-prioritising or filtering in the UI, so no
     * ordering change and no client default can bring it back. Visual identity
     * remains the place identity images are managed.
     */
    ...assignableConditions(),
  ];
  if (filter.characterId) {
    conditions.push(eq(characterVisualAssets.characterId, filter.characterId));
  }
  if (filter.contentRating === 'sfw' || filter.contentRating === 'explicit') {
    conditions.push(eq(characterVisualAssets.contentRating, filter.contentRating));
  }
  if (filter.search && filter.search.trim().length > 0) {
    const term = `%${filter.search.trim().toLowerCase()}%`;
    conditions.push(sql`lower(${characters.name}) like ${term}`);
  }

  const rows = await db
    .select({
      asset: characterVisualAssets,
      characterName: characters.name,
      characterStatus: characters.status,
    })
    .from(characterVisualAssets)
    .innerJoin(characters, eq(characters.id, characterVisualAssets.characterId))
    .where(and(...conditions))
    .orderBy(desc(characterVisualAssets.approvedAt), desc(characterVisualAssets.createdAt));

  // Media type is resolved in TS, not SQL: a manual upload's storage_key is an
  // extensionless route, so extension sniffing misclassifies every upload.
  const withMedia = rows.map(({ asset, characterName, characterStatus }) => ({
    asset,
    characterName,
    characterStatus,
    mediaType: mediaTypeFor(asset.storageKey, asset.provenance as Record<string, unknown> | null),
  }));
  /**
   * VIDEO ONLY, unconditionally.
   *
   * Applied in TS rather than SQL for the reason above: the stored media type
   * is not readable from the row without `mediaTypeFor`. It is the same place
   * the optional filter was already applied, so this adds a condition rather
   * than a second pass.
   *
   * `mediaTypeFor` answers 'image' whenever it cannot prove 'video', so an
   * asset whose type is unclear is EXCLUDED. That is the correct direction to
   * fail for a rule about what may reach the public app.
   *
   * The caller's `mediaType` is still honoured, but only to narrow: asking for
   * images now yields an empty list, which is the truthful answer.
   */
  const typed = withMedia.filter(
    (row) =>
      row.mediaType === 'video' && (filter.mediaType ? row.mediaType === filter.mediaType : true),
  );

  // How many categories each candidate already appears in, so the picker can
  // show that adding one here does not remove it from anywhere else.
  const counts = await db
    .select({
      assetId: appCategoryAssets.assetId,
      total: sql<number>`count(*)::int`,
    })
    .from(appCategoryAssets)
    .groupBy(appCategoryAssets.assetId);
  const countByAsset = new Map(counts.map((row) => [row.assetId, Number(row.total)]));

  let assigned = new Set<string>();
  if (filter.categoryId) {
    const links = await db
      .select({ assetId: appCategoryAssets.assetId })
      .from(appCategoryAssets)
      .where(eq(appCategoryAssets.categoryId, filter.categoryId));
    assigned = new Set(links.map((row) => row.assetId));
  }

  const mapped: CandidateAssetView[] = typed.map(
    ({ asset, characterName, characterStatus, mediaType }) => ({
      assetId: asset.id,
      characterId: asset.characterId,
      characterName,
      mediaType,
      contentRating: asset.contentRating,
      isPrimary: asset.isCanonical,
      previewUrl: assetPreviewUrl(asset.id, asset.storageKey),
      approvedAt: asset.approvedAt ? asset.approvedAt.toISOString() : null,
      categoryCount: countByAsset.get(asset.id) ?? 0,
      inThisCategory: assigned.has(asset.id),
      ineligibleReason: ineligibilityFor(asset, characterStatus),
    }),
  );

  const visible = filter.excludeAssigned ? mapped.filter((row) => !row.inThisCategory) : mapped;
  return typeof filter.limit === 'number' ? visible.slice(0, filter.limit) : visible;
}

/* ------------------------------------------------------------------ *
 * Writing assignments
 * ------------------------------------------------------------------ */

/**
 * Adds many assets at once, reporting each outcome separately.
 *
 * PARTIAL SUCCESS IS THE POINT. Selecting twenty tiles and hitting one that was
 * rejected while the picker was open must not discard the other nineteen, and
 * must not silently pretend the twentieth worked. Every id comes back with what
 * happened to it.
 *
 * New links append AFTER everything already in the category, so adding never
 * disturbs an arrangement the operator has already made.
 */
export async function addAssetsToCategory(
  db: Db,
  categoryId: string,
  assetIds: string[],
): Promise<AddOutcome[]> {
  if (assetIds.length === 0) return [];
  const unique = [...new Set(assetIds)];

  return db.transaction(async (tx) => {
    const found = await tx
      .select({
        id: characterVisualAssets.id,
        status: characterVisualAssets.status,
        kind: characterVisualAssets.kind,
        storageKey: characterVisualAssets.storageKey,
        characterStatus: characters.status,
      })
      .from(characterVisualAssets)
      .innerJoin(characters, eq(characters.id, characterVisualAssets.characterId))
      .where(inArray(characterVisualAssets.id, unique));
    const rowById = new Map(found.map((row) => [row.id, row]));

    const existing = await tx
      .select({ assetId: appCategoryAssets.assetId })
      .from(appCategoryAssets)
      .where(eq(appCategoryAssets.categoryId, categoryId));
    const alreadyIn = new Set(existing.map((row) => row.assetId));

    const [{ next } = { next: 0 }] = await tx
      .select({ next: sql<number>`coalesce(max(${appCategoryAssets.position}), -1) + 1` })
      .from(appCategoryAssets)
      .where(eq(appCategoryAssets.categoryId, categoryId));

    let position = Number(next);
    const outcomes: AddOutcome[] = [];

    for (const assetId of unique) {
      const row = rowById.get(assetId);
      const status = row?.status;
      if (row === undefined || status === undefined) {
        outcomes.push({ assetId, added: false, reason: 'not_found' });
        continue;
      }
      if (alreadyIn.has(assetId)) {
        outcomes.push({ assetId, added: false, reason: 'already_present' });
        continue;
      }
      /**
       * THE WRITE-SIDE HALF OF THE WHOLE ELIGIBILITY RULE.
       *
       * `listAssignmentCandidates` already refuses to OFFER anything Home
       * cannot render, but the picker is not the only way into this function —
       * an id can be posted directly, and an id selected while the picker was
       * open can go stale before Add is pressed. A category is a public
       * surface, so the boundary has to hold on the write too, not only on the
       * list the operator happened to be shown.
       *
       * All four rules are asked through `homeIneligibilityOf`, the same helper
       * the read path uses, so a refusal here and a "will not render" flag
       * there can never disagree. Rating and Primary status are still NOT
       * consulted — neither has ever decided publishability.
       */
      const ineligible = homeIneligibilityOf({
        status,
        kind: row.kind,
        storageKey: row.storageKey,
        characterStatus: row.characterStatus,
      });
      if (ineligible !== null && refusesAssignment(ineligible)) {
        outcomes.push({ assetId, added: false, reason: ineligible, status });
        continue;
      }
      await tx
        .insert(appCategoryAssets)
        .values({ categoryId, assetId, position: position++ })
        .onConflictDoNothing();
      outcomes.push({ assetId, added: true });
    }

    return outcomes;
  });
}

export interface RemoveResult {
  removed: number;
}

/**
 * Removes assignments. DELETES LINK ROWS ONLY.
 *
 * There is no statement in this function that can reach `character_visual_assets`
 * — the asset keeps its status, its approval timestamp, its Primary flag, its
 * file and its place in the Library, and stays available to every other
 * category it belongs to.
 */
export async function removeAssetsFromCategory(
  db: Db,
  categoryId: string,
  assetIds: string[],
): Promise<RemoveResult> {
  if (assetIds.length === 0) return { removed: 0 };
  const unique = [...new Set(assetIds)];
  return db.transaction(async (tx) => {
    const deleted = await tx
      .delete(appCategoryAssets)
      .where(
        and(
          eq(appCategoryAssets.categoryId, categoryId),
          inArray(appCategoryAssets.assetId, unique),
        ),
      )
      .returning({ assetId: appCategoryAssets.assetId });
    await normalisePositions(tx, categoryId);
    return { removed: deleted.length };
  });
}

/**
 * Sets or clears the featured flag on ONE assignment.
 *
 * A property of the link, so featuring an item in one category says nothing
 * about it anywhere else, and nothing at all about the asset.
 *
 * PURELY VISUAL. Featuring does not move an item: position is the only
 * ordering authority, so a featured item stays exactly where the operator put
 * it and simply carries a badge.
 */
export async function setAssetFeatured(
  db: Db,
  categoryId: string,
  assetId: string,
  featured: boolean,
): Promise<boolean> {
  const updated = await db
    .update(appCategoryAssets)
    .set({ featured })
    .where(
      and(eq(appCategoryAssets.categoryId, categoryId), eq(appCategoryAssets.assetId, assetId)),
    )
    .returning({ assetId: appCategoryAssets.assetId });
  return updated.length > 0;
}

/**
 * Applies an order within a category.
 *
 * Exact-permutation-or-refuse, for the same reason US-102.1's category reorder
 * works this way: the failure to design for is a stale browser, where a lenient
 * implementation would quietly drop an item a colleague just added. Note this
 * validates against EVERY assignment including non-publishable ones, because
 * the admin list the operator dragged shows those too.
 */
export async function reorderCategoryAssets(
  db: Db,
  categoryId: string,
  orderedAssetIds: string[],
): Promise<void> {
  const unique = new Set(orderedAssetIds);
  if (unique.size !== orderedAssetIds.length) {
    throw new MerchandisingOrderError('duplicate', 'The same item was listed more than once.');
  }

  await db.transaction(async (tx) => {
    const existing = await tx
      .select({ assetId: appCategoryAssets.assetId })
      .from(appCategoryAssets)
      .where(eq(appCategoryAssets.categoryId, categoryId));
    const existingIds = new Set(existing.map((row) => row.assetId));

    for (const assetId of orderedAssetIds) {
      if (!existingIds.has(assetId)) {
        throw new MerchandisingOrderError('unknown_id', 'That item is no longer in this category.');
      }
    }
    if (orderedAssetIds.length !== existingIds.size) {
      throw new MerchandisingOrderError(
        'incomplete',
        'The order is out of date — it does not list every item in this category. Reload and try again.',
      );
    }

    for (const [index, assetId] of orderedAssetIds.entries()) {
      await tx
        .update(appCategoryAssets)
        .set({ position: index })
        .where(
          and(eq(appCategoryAssets.categoryId, categoryId), eq(appCategoryAssets.assetId, assetId)),
        );
    }
  });
}

/** Per-category assignment counts, split by what is currently publishable. */
export async function categoryAssignmentCounts(
  db: Db,
): Promise<Map<string, { total: number; publishable: number }>> {
  const rows = await db
    .select({
      categoryId: appCategoryAssets.categoryId,
      status: characterVisualAssets.status,
      kind: characterVisualAssets.kind,
      storageKey: characterVisualAssets.storageKey,
      characterStatus: characters.status,
      total: sql<number>`count(*)::int`,
    })
    .from(appCategoryAssets)
    .innerJoin(characterVisualAssets, eq(characterVisualAssets.id, appCategoryAssets.assetId))
    .innerJoin(characters, eq(characters.id, characterVisualAssets.characterId))
    .groupBy(
      appCategoryAssets.categoryId,
      characterVisualAssets.status,
      characterVisualAssets.kind,
      characterVisualAssets.storageKey,
      characters.status,
    );

  const byCategory = new Map<string, { total: number; publishable: number }>();
  for (const row of rows) {
    const entry = byCategory.get(row.categoryId) ?? { total: 0, publishable: 0 };
    entry.total += Number(row.total);
    // `publishable` means "Home would render this", not "it is approved".
    // Grouping now carries every field the rule reads so the tally is decided
    // by the same helper the per-asset view uses.
    const renderable =
      homeIneligibilityOf({
        status: row.status,
        kind: row.kind,
        storageKey: row.storageKey,
        characterStatus: row.characterStatus,
      }) === null;
    if (renderable) entry.publishable += Number(row.total);
    byCategory.set(row.categoryId, entry);
  }
  return byCategory;
}

/** Resolves a category by its stable slug — what the workspace URL carries. */
export async function getCategoryBySlug(db: Db, slug: string) {
  const [row] = await db
    .select()
    .from(appCategories)
    .where(eq(appCategories.slug, slug))
    .limit(1);
  return row ?? null;
}

/** Rewrites positions to 0..n-1 within one category. */
async function normalisePositions(
  tx: Pick<Db, 'select' | 'update'>,
  categoryId: string,
): Promise<void> {
  const rows = await tx
    .select({ assetId: appCategoryAssets.assetId })
    .from(appCategoryAssets)
    .where(eq(appCategoryAssets.categoryId, categoryId))
    .orderBy(asc(appCategoryAssets.position), asc(appCategoryAssets.assetId));
  for (const [index, row] of rows.entries()) {
    await tx
      .update(appCategoryAssets)
      .set({ position: index })
      .where(
        and(
          eq(appCategoryAssets.categoryId, categoryId),
          eq(appCategoryAssets.assetId, row.assetId),
        ),
      );
  }
}
