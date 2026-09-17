import type { AssetAction, AssetDistribution, CharacterContentAsset } from '../lib/api';

/**
 * A character's content shelf — presentation logic, React-free.
 *
 * WHY THIS EXISTS. Everything here was already reachable, but only from four
 * different screens and none of them the character's own: Review knew her
 * pending items, the Library her approved ones, the merchandising screens her
 * category membership and the Home composer her Hero clips. "What content does
 * Maria have?" had no single answer. This is only the arrangement and wording
 * of the answer the server now assembles.
 *
 * React-free because this repo's web tests run in node with no DOM, and a shelf
 * that silently groups an item into the wrong bucket is exactly the kind of bug
 * a static render cannot catch.
 */

/** The buckets the shelf renders, in the order an operator reads them. */
export interface ContentShelf {
  /** Approved canonical references — the character's primary set. */
  primary: CharacterContentAsset[];
  /** Approved content that is not a primary reference. */
  approved: CharacterContentAsset[];
  /** Awaiting an approve/reject decision in Review. */
  pending: CharacterContentAsset[];
  /** Rejected. Shown rather than hidden, so nothing appears to have vanished. */
  rejected: CharacterContentAsset[];
  /** Archived (P0.4): hidden everywhere, kept intact, restorable. */
  archived: CharacterContentAsset[];
}

/**
 * Splits the shelf.
 *
 * The buckets are mutually exclusive and cover every asset — an item cannot be
 * counted twice, and none can fall through and appear nowhere. That total is
 * what makes the section trustworthy as an answer to "is this everything?".
 */
export function groupCharacterContent(
  assets: readonly CharacterContentAsset[],
): ContentShelf {
  const shelf: ContentShelf = { primary: [], approved: [], pending: [], rejected: [], archived: [] };
  // By the SERVER's workflow, not by status names: both pending statuses are
  // already one state there, and a new status cannot fall through here.
  for (const asset of assets) {
    switch (asset.workflow) {
      case 'rejected':
        shelf.rejected.push(asset);
        break;
      case 'pending_review':
        shelf.pending.push(asset);
        break;
      case 'archived':
        shelf.archived.push(asset);
        break;
      case 'approved':
        (asset.isPrimary ? shelf.primary : shelf.approved).push(asset);
        break;
    }
  }
  return shelf;
}

/** Operator-facing status wording. Never an upstream term like "generated". */
/**
 * How an asset's ORIGIN reads on screen (P0.3). A label for the value the server
 * sent -- nothing is inferred here from kind, status or provenance.
 */
export function originLabel(asset: Pick<CharacterContentAsset, 'origin'>): string {
  switch (asset.origin) {
    case 'generated':
      return 'Generated';
    case 'manual':
      return 'Manual upload';
    case 'imported':
      return 'Imported';
    case 'legacy':
      return 'Origin not recorded';
  }
}

/** Operator-facing workflow wording (P0.4 reads the server's `workflow`). */
export function statusLabel(asset: Pick<CharacterContentAsset, 'workflow' | 'isPrimary'>): string {
  switch (asset.workflow) {
    case 'approved':
      return asset.isPrimary ? 'Primary reference' : 'Approved';
    case 'rejected':
      return 'Rejected';
    case 'archived':
      return 'Archived';
    case 'pending_review':
      return 'In review';
  }
}

/* ------------------------------------------------------------------ *
 * Distribution, as one line on a tile (P0.5)
 *
 * The shelf used to describe placement only -- the Hero and categories -- so a
 * clip released to her Posts tab read as "Approved, not placed anywhere yet",
 * which was simply false. Posts, Hero, Categories and Discovery are now one
 * model from the server, and this says what it says.
 * ------------------------------------------------------------------ */

/** Each LIVE channel, named the way an operator would say it. */
export function liveChannels(distribution: AssetDistribution): string[] {
  const live: string[] = [];
  if (distribution.posts.live) live.push('Posts');
  if (distribution.hero.live) live.push(`Hero #${(distribution.hero.position ?? 0) + 1}`);
  for (const category of distribution.categories) {
    if (category.live) live.push(`${category.name} #${category.position + 1}`);
  }
  const discovery = distribution.discovery.filter((entry) => entry.live);
  if (discovery.length > 0) live.push(`Discovery: ${discovery.map((d) => d.keyword).join(', ')}`);
  return live;
}

/** Channels that hold a record but show nothing, each with the reason. */
export function dormantChannels(distribution: AssetDistribution): string[] {
  const dormant: string[] = [];
  if (distribution.posts.released && !distribution.posts.live) dormant.push('Posts');
  if (distribution.hero.placed && !distribution.hero.live) dormant.push('Home Hero');
  for (const category of distribution.categories) {
    if (category.live) continue;
    dormant.push(
      category.reason === 'category_disabled'
        ? `${category.name} (category disabled)`
        : category.reason === 'category_unpublished'
          ? `${category.name} (category not on Home)`
          : category.name,
    );
  }
  for (const entry of distribution.discovery) {
    if (!entry.live) {
      dormant.push(
        entry.categories.length === 0
          ? `keyword "${entry.keyword}" (no Discovery category uses it)`
          : `keyword "${entry.keyword}"`,
      );
    }
  }
  return dormant;
}

/** Why nothing of this asset can be live, said plainly. */
export function distributionBlockerLabel(blocker: AssetDistribution['blocker']): string | null {
  switch (blocker) {
    case 'pending_review':
      return 'waiting for review';
    case 'rejected':
      return 'rejected';
    case 'archived':
      return 'archived';
    case 'not_content':
      return 'not content — identity and chat media are never distributed';
    case 'no_media':
      return 'it has no file';
    case 'character_inactive':
      return 'she is not published';
    case null:
      return null;
  }
}

/**
 * Where this item currently appears, in one line -- and when it appears
 * nowhere, why.
 */
export function distributionLabel(asset: CharacterContentAsset): string {
  const live = liveChannels(asset.distribution);
  if (live.length > 0) return `Live: ${live.join(' · ')}`;

  const dormant = dormantChannels(asset.distribution);
  const blocker = distributionBlockerLabel(asset.distribution.blocker);
  if (dormant.length > 0) {
    return blocker
      ? `Not live (${blocker}) — kept: ${dormant.join(' · ')}`
      : `Not live — kept: ${dormant.join(' · ')}`;
  }
  if (blocker) return `Not distributed (${blocker})`;
  return 'Approved, not distributed anywhere yet';
}

/** True when this item could be distributed but reaches nobody. */
export function isUndistributed(asset: CharacterContentAsset): boolean {
  return (
    asset.workflow === 'approved' &&
    !asset.isPrimary &&
    asset.distribution.blocker === null &&
    !asset.distribution.liveAnywhere
  );
}

/** "12 items · 8 approved · 3 in review · 1 rejected" — the shelf in one line. */
export function shelfSummary(shelf: ContentShelf): string {
  const total =
    shelf.primary.length +
    shelf.approved.length +
    shelf.pending.length +
    shelf.rejected.length +
    shelf.archived.length;
  if (total === 0) return 'No content yet';
  const parts = [`${total} item${total === 1 ? '' : 's'}`];
  const approved = shelf.primary.length + shelf.approved.length;
  if (approved > 0) parts.push(`${approved} approved`);
  if (shelf.pending.length > 0) parts.push(`${shelf.pending.length} in review`);
  if (shelf.rejected.length > 0) parts.push(`${shelf.rejected.length} rejected`);
  if (shelf.archived.length > 0) parts.push(`${shelf.archived.length} archived`);
  return parts.join(' · ');
}

/* ------------------------------------------------------------------ *
 * What can an operator DO with one item, from here?
 *
 * The shelf could already answer "what content does she have?" but not "and
 * now what?" — approving meant Review, categorising meant the merchandising
 * screen, the Hero meant the Home composer. Every one of those endpoints
 * already existed; only the character's own page could not reach them.
 *
 * These rules decide which controls an item offers. They live here rather than
 * in the tile because the rule is the thing worth testing: offering Approve on
 * something already approved, or "Add to Hero" on something that is not, is a
 * button whose only effect is an error message.
 * ------------------------------------------------------------------ */

export interface AssetActions {
  /** Awaiting a decision: Approve and Reject apply. */
  canApprove: boolean;
  canReject: boolean;
  /** Approved, released or not: it may be archived. */
  canArchive: boolean;
  /** Archived: it may be restored. */
  canUnarchive: boolean;
  /** Approved: it may be placed on a public surface. */
  canAddToCategory: boolean;
  canAddToHero: boolean;
  /** Already in the Hero, so adding again would do nothing. */
  inHero: boolean;
  /**
   * Approved CONTENT that is not yet on her Posts tab — the release is
   * available. References and chat media never offer it: one is identity, the
   * other is private, and neither can be a post.
   */
  canPublish: boolean;
  /** Live on her Posts tab, so it can be taken down without un-approving it. */
  canUnpublish: boolean;
}

/**
 * The controls one item offers.
 *
 * THE LIFECYCLE CONTROLS ARE THE SERVER'S LIST (P0.4). `asset.actions` comes
 * from the same rules the server enforces on every transition, so this reads
 * it and decides nothing: an item offers Approve because the server said it
 * may be approved, not because this file recognised a status name.
 *
 * Placement (category, Hero) is merchandising rather than moderation; it stays
 * "approved only", which the server's write-side rule for both also requires.
 */
export function assetActions(asset: CharacterContentAsset): AssetActions {
  const offered = new Set<AssetAction>(asset.actions);
  const approved = asset.workflow === 'approved';
  const inHero = asset.distribution.hero.placed;
  return {
    canApprove: offered.has('approve'),
    canReject: offered.has('reject'),
    canArchive: offered.has('archive'),
    canUnarchive: offered.has('unarchive'),
    canAddToCategory: approved,
    canAddToHero: approved && !inHero,
    inHero,
    canPublish: offered.has('publish'),
    canUnpublish: offered.has('unpublish'),
  };
}

/* ------------------------------------------------------------------ *
 * Lifecycle actions, as the operator reads them (P0.4)
 * ------------------------------------------------------------------ */

/** The button for each server action. The API says publish; the product says release. */
export const LIFECYCLE_ACTION_LABEL: Record<AssetAction, string> = {
  approve: 'Approve',
  reject: 'Reject',
  publish: 'Release to Posts',
  unpublish: 'Take off Posts',
  archive: 'Archive',
  unarchive: 'Unarchive',
};

/** The order buttons appear in, whatever order the server listed them. */
const ACTION_ORDER: readonly AssetAction[] = [
  'approve',
  'reject',
  'publish',
  'unpublish',
  'archive',
  'unarchive',
];

export function orderedActions(actions: readonly AssetAction[]): AssetAction[] {
  return ACTION_ORDER.filter((action) => actions.includes(action));
}

/**
 * Actions that ask first. Reject and archive take something out of use, and
 * unarchive can put something back on public surfaces -- each says what will
 * happen before it does. Approve and the release toggle are single explicit
 * clicks whose label already says what they do.
 */
export function needsConfirmation(action: AssetAction): boolean {
  return action === 'reject' || action === 'archive' || action === 'unarchive';
}

/** What archiving does and does NOT do, said before the operator confirms. */
export function archiveConsequence(asset: Pick<CharacterContentAsset, 'role'>): string {
  const surfaces =
    asset.role === 'chat'
      ? 'She stops sending it in new chats; messages that already carried it keep it.'
      : 'It disappears from her Posts tab, Home, categories and Discovery.';
  return `${surfaces} Nothing is deleted: the file, its history, its approval, its release and its placements are all kept, and Unarchive restores them.`;
}

/**
 * What unarchiving does -- and what it will NOT put back.
 *
 * Unarchiving returns an item to Approved and nothing more: its release and
 * placements are cleared, so nothing reappears in front of customers without
 * someone choosing it. Where it USED to be is named, because that is what the
 * operator is giving up and will have to redo.
 *
 * `distribution` is optional because Review's view does not carry it.
 */
export function unarchiveConsequence(
  asset: Pick<CharacterContentAsset, 'role' | 'publishedAt'> &
    Partial<Pick<CharacterContentAsset, 'distribution'>>,
): string {
  if (asset.role === 'chat') {
    return 'It returns to Approved, and she can send it in chats again. It never appears anywhere public.';
  }
  const cleared: string[] = [];
  if (asset.publishedAt) cleared.push('her Posts tab');
  if (asset.distribution?.hero.placed) cleared.push('the Home Hero');
  for (const category of asset.distribution?.categories ?? []) cleared.push(category.name);
  const base = 'It returns to Approved, and stays hidden from customers: releasing it to her Posts tab and placing it are separate decisions afterwards.';
  if (cleared.length > 0) {
    return `${base} It will NOT go back on ${cleared.join(', ')} — those are cleared, along with any Discovery keywords, and you would add them again.`;
  }
  return asset.distribution
    ? base
    : `${base} Any release, placement or Discovery keyword it had is cleared.`;
}

/** The notice after an action succeeds. */
export function lifecycleNotice(action: AssetAction, asset: Pick<CharacterContentAsset, 'role'>): string {
  switch (action) {
    case 'approve':
      return asset.role === 'chat'
        ? 'Approved. She can now send it in chats.'
        : 'Approved. It is not on her Posts tab until you release it.';
    case 'reject':
      return 'Rejected. It stays on record; delete it separately if you want it gone.';
    case 'publish':
      return 'Released to her Posts tab.';
    case 'unpublish':
      return 'Taken off her Posts tab. It is still approved — nothing was rejected or deleted.';
    case 'archive':
      return 'Archived. It is hidden everywhere, and nothing was deleted.';
    case 'unarchive':
      return asset.role === 'chat'
        ? 'Unarchived. She can send it in chats again.'
        : 'Unarchived. It is approved again, and not released or placed — release it when you want it live.';
  }
}

/**
 * Whether this clip is live on the character's Posts tab.
 *
 * Named rather than inlined because "approved" and "live" are now different
 * questions and the screen has to be able to say which it means.
 */
export function isPublished(asset: CharacterContentAsset): boolean {
  return asset.publishedAt !== null;
}

/** The categories this item is NOT in yet — the only ones worth offering. */
export function categoryChoices(
  asset: CharacterContentAsset,
  categories: readonly { id: string; name: string }[],
): { id: string; name: string }[] {
  const already = new Set(asset.distribution.categories.map((c) => c.id));
  return categories.filter((category) => !already.has(category.id));
}

/**
 * What approving will and will NOT do, said before the operator commits.
 *
 * The failure this prevents is the common one: approving and assuming the item
 * is now on the app. It is not — approval clears it for use, placement makes it
 * visible, and publishing the character is a third, separate thing.
 */
export function approveConsequence(characterIsLive: boolean): string {
  return characterIsLive
    ? 'Approving clears it for use. It appears on the app only once it is in the Hero or a published category.'
    : 'Approving clears it for use. Nothing of hers is public until she is published.';
}

/* ------------------------------------------------------------------ *
 * Per-clip keywords
 *
 * REUSES THE EXISTING KEYWORD SYSTEM AND ADDS NOTHING TO IT. The server
 * already stores tags in `asset_keywords`, and one endpoint —
 * `PUT /admin/discovery/content/:assetId/keywords` — REPLACES the whole set
 * for one asset. Add, remove and edit are therefore all the same operation on
 * the client: build the next set, send it once, for that asset only.
 *
 * These helpers exist so the draft-set arithmetic is testable. Getting it
 * wrong is silent and destructive — a botched "remove" sends a set that drops
 * keywords the operator never touched.
 * ------------------------------------------------------------------ */

/**
 * Normalises one typed keyword the way the operator means it.
 *
 * Trims and collapses inner whitespace, and lowercases — the server keys
 * keywords canonically, so "Beach" and "beach " must not read as two tags in
 * the editor when they will be one in the database.
 */
export function normaliseKeyword(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Accepts one entry, or several separated by commas.
 *
 * Operators paste comma-separated lists; refusing them means retyping. Empty
 * and duplicate entries are dropped rather than rejected, because neither is a
 * mistake worth an error message.
 */
export function addKeywords(current: readonly string[], input: string): string[] {
  const next = [...current];
  for (const part of input.split(',')) {
    const keyword = normaliseKeyword(part);
    if (keyword.length > 0 && !next.includes(keyword)) next.push(keyword);
  }
  return next;
}

/** Removes exactly one keyword. Every other keyword survives untouched. */
export function removeKeyword(current: readonly string[], keyword: string): string[] {
  const target = normaliseKeyword(keyword);
  return current.filter((k) => normaliseKeyword(k) !== target);
}

/**
 * Whether the draft differs from what is saved — order-insensitively.
 *
 * Order carries no meaning in a keyword set, so a reordering is not an unsaved
 * change and must not light up the Save button.
 */
export function keywordsDiffer(saved: readonly string[], draft: readonly string[]): boolean {
  if (saved.length !== draft.length) return true;
  const a = [...saved].map(normaliseKeyword).sort();
  const b = [...draft].map(normaliseKeyword).sort();
  return a.some((keyword, index) => keyword !== b[index]);
}

/* ------------------------------------------------------------------ *
 * Is she live, and if not, what is missing?
 *
 * A name-only character is created INACTIVE on purpose — nothing half-written
 * reaches real users until someone says so, and that rule is not relaxed here.
 * What was missing is the explanation: the operator saw a character that
 * existed, was not public, and gave no indication of why or what to do. State
 * the three facts plainly instead.
 * ------------------------------------------------------------------ */

export interface CharacterReadiness {
  live: boolean;
  /** What is true right now, in one line. */
  headline: string;
  /** The single next action, or null when she is already live. */
  nextStep: string | null;
  /** True while content management is available regardless of being unpublished. */
  contentAllowed: boolean;
}

export function characterReadiness(character: {
  status: string;
  profileComplete: boolean;
}): CharacterReadiness {
  if (character.status === 'active') {
    return {
      live: true,
      headline: 'Live — visitors can find her.',
      nextStep: null,
      contentAllowed: true,
    };
  }
  return {
    live: false,
    headline: 'She exists, but is not published — nobody can see her yet.',
    // The publish button is gated on the profile, so name the gate rather than
    // leaving a disabled control unexplained.
    nextStep: character.profileComplete
      ? 'Press Publish to make her public.'
      : 'Write her profile — or use Autofill — then press Publish.',
    // UPLOADING IS NOT GATED ON PUBLISHING. Content can be built up while she
    // is unpublished, which is the whole point of creating her by name first.
    contentAllowed: true,
  };
}

/* ------------------------------------------------------------------ *
 * Regular and Explicit — the Character page's two content shelves
 * ------------------------------------------------------------------ */

/**
 * The two shelves a character's content is uploaded into.
 *
 * `contentRating` IS the distinction, reusing the column that has always
 * carried it. Regular is `sfw`, Explicit is `explicit`. Nothing new is stored
 * and no migration is involved — the field existed and was simply never
 * surfaced as a place to put things.
 */
export type ContentSection = 'regular' | 'explicit' | 'chat';

/** The shelves the Content area renders, in the order an operator reads them. */
export const CONTENT_SECTIONS: readonly ContentSection[] = ['regular', 'explicit', 'chat'];

/**
 * The rating a section uploads with. One direction, stated once.
 *
 * Chat Content is `sfw` because the chat selector only ever considers sfw
 * assets — sending an explicit clip unprompted in a conversation is a separate
 * product decision nobody has made. The rating axis stays orthogonal to the
 * kind axis, which is why chat is not a rating.
 */
export const SECTION_RATING: Record<ContentSection, 'sfw' | 'explicit'> = {
  regular: 'sfw',
  explicit: 'explicit',
  chat: 'sfw',
};

/** What each shelf will let an operator pick, and what the server enforces. */
export const SECTION_ACCEPTS: Record<ContentSection, 'video' | 'both'> = {
  regular: 'video',
  explicit: 'video',
  chat: 'both',
};

/** The `accept` attribute for each shelf's file input. */
export const SECTION_FILE_ACCEPT: Record<ContentSection, string> = {
  regular: 'video/mp4,video/webm,video/quicktime',
  explicit: 'video/mp4,video/webm,video/quicktime',
  chat: 'image/jpeg,image/png,image/webp,video/mp4,video/webm,video/quicktime',
};

export interface SectionShelves {
  regular: CharacterContentAsset[];
  explicit: CharacterContentAsset[];
  /** Chat Content — private conversation media. Never a public surface. */
  chat: CharacterContentAsset[];
  /**
   * Everything the three shelves deliberately do not show: identity
   * references, and any image that predates the video-only rule on Regular and
   * Explicit.
   *
   * NAMED AND RETURNED rather than dropped inside the loop, so the split is
   * exhaustive and can be tested as such — every asset lands in exactly one of
   * the four lists. The Character page renders the three shelves; these rows
   * stay in the database, untouched, and are managed from the screens that own
   * them.
   */
  excluded: CharacterContentAsset[];
}

/**
 * Splits a character's assets into the three shelves.
 *
 * KIND DECIDES FIRST, and that ordering is the point. A Chat asset is
 * `kind: 'chat'` whatever its media type or rating, so it lands on the Chat
 * shelf and can never be mistaken for a Regular clip — which is exactly the
 * ambiguity that existed while chat media and Regular content were the same
 * rows on the same columns.
 *
 * REFERENCES ARE NOT CONTENT. A canonical portrait is `kind: 'reference'` and
 * belongs to Visual identity, which has its own section on this page. Left in,
 * it would land under Regular — every reference carries the default `sfw`
 * rating — and read as a clip she had uploaded.
 *
 * IMAGES ARE NOT ON REGULAR OR EXPLICIT. Both are video shelves and the upload
 * path refuses images, but assets uploaded before that rule exist, so they are
 * separated rather than assumed away. Chat Content accepts both, so no such
 * exclusion applies there.
 *
 * Every asset lands in exactly one of the four lists.
 */
export function groupBySection(
  assets: readonly CharacterContentAsset[],
): SectionShelves {
  const shelves: SectionShelves = { regular: [], explicit: [], chat: [], excluded: [] };
  for (const asset of assets) {
    if (asset.kind === 'chat') {
      shelves.chat.push(asset);
    } else if (asset.kind === 'reference' || asset.mediaType !== 'video') {
      shelves.excluded.push(asset);
    } else if (asset.contentRating === 'explicit') {
      shelves.explicit.push(asset);
    } else {
      shelves.regular.push(asset);
    }
  }
  return shelves;
}

/**
 * One shelf's count, said plainly.
 *
 * Regular and Explicit hold videos and say so. Chat Content holds both, so it
 * counts "items" rather than claiming a mix is all video.
 */
export function sectionSummary(
  items: readonly CharacterContentAsset[],
  section: ContentSection = 'regular',
): string {
  const noun = SECTION_ACCEPTS[section] === 'video' ? 'video' : 'item';
  if (items.length === 0) return `No ${noun}s yet.`;
  return `${items.length} ${noun}${items.length === 1 ? '' : 's'}`;
}

/* ------------------------------------------------------------------ *
 * Deleting a content item from the Character page
 *
 * THERE IS ONE DELETION PATH AND THIS IS NOT A SECOND ONE. The Character
 * page calls the SAME endpoint the Content Library's Delete calls —
 * `DELETE /admin/content/assets/:assetId`, served by `deleteLibraryAsset`,
 * which removes the row and the file it owns. Nothing here decides what
 * deletion means; it decides what to OFFER, what to WARN, and what to do
 * with the answer. The rules the server enforces are mirrored, never
 * re-implemented.
 * ------------------------------------------------------------------ */

/**
 * Whether the page may offer Delete for this item, and why not when it may not.
 *
 * The one refusal is CANONICAL. `deleteLibraryAsset` answers 409 for a Primary
 * (canonical) asset because canonical membership IS the public gallery, and
 * the reason is mirrored here so the operator reads it before clicking rather
 * than after. This is a mirror of a server rule, not a rule of its own: if the
 * check were somehow wrong, the server still refuses.
 *
 * Everything on the three shelves is otherwise deletable — approved or not,
 * placed or not, image or video. Placement is a warning, never a veto: the
 * schema already resolves it, and inventing a "cannot delete a published clip"
 * rule here would be a new safety semantic nobody asked for.
 */
export function assetDeletable(
  asset: CharacterContentAsset,
): { deletable: true } | { deletable: false; reason: string } {
  if (asset.isPrimary) {
    return {
      deletable: false,
      reason:
        'This is a Primary reference and belongs to the public gallery. Remove it from Primary before deleting.',
    };
  }
  return { deletable: true };
}

/**
 * What the operator is told BEFORE confirming — every consequence that is not
 * visible from the tile.
 *
 * Placement is named rather than summarised because "it is in 2 categories" is
 * not something anyone can act on. The chat clause is separate because the
 * consequence there is different in kind: an already-sent message keeps its
 * text and loses its attachment (`messages.media_asset_id` is ON DELETE SET
 * NULL), which is not something the tile shows and not something a reasonable
 * operator would guess.
 */
export function deletionConsequence(asset: CharacterContentAsset): string {
  const parts = ['This permanently deletes the item and its stored file. It cannot be undone.'];

  const placements: string[] = [];
  if (asset.distribution.posts.released) placements.push('her Posts tab');
  if (asset.distribution.hero.placed) placements.push('the Home Hero');
  for (const category of asset.distribution.categories) placements.push(category.name);
  for (const entry of asset.distribution.discovery) placements.push(`Discovery ("${entry.keyword}")`);
  if (placements.length > 0) {
    parts.push(`It is currently in ${placements.join(', ')} and will be removed from there.`);
  }

  if (asset.kind === 'chat') {
    parts.push(
      'She will no longer be able to send it, and any message that already carried it keeps its text but loses the attachment.',
    );
  }

  return parts.join(' ');
}

/** What the page needs from the outside world to delete one item. */
export interface DeleteAssetDeps {
  /** The canonical Content Library delete — `contentLibraryApi.remove`. */
  remove: (assetId: string) => Promise<unknown>;
  /** Re-reads this character's content from the server. */
  reload: () => Promise<void>;
}

/**
 * The outcome, stated precisely enough to render honestly.
 *
 * `deleted` exists because "the delete failed" and "the delete worked but the
 * page could not refresh" are different facts and must not share a message.
 * Reporting the second as a failure would tell an operator to retry something
 * that already happened.
 */
export type DeleteAssetOutcome =
  | { ok: true }
  | { ok: false; deleted: boolean; message: string };

/**
 * Delete one item, then make the page tell the truth about it.
 *
 * The refresh is a RE-READ, not a local splice. Removing the tile optimistically
 * would show exactly the same thing whether the server had deleted the asset or
 * refused it, which is the "silently pretend it succeeded" failure. Re-reading
 * means the shelf can only lose the item if the server actually lost it.
 *
 * On failure nothing is re-read, so the item stays visible and the operator can
 * see what they still have.
 */
export async function deleteCharacterAsset(
  asset: CharacterContentAsset,
  deps: DeleteAssetDeps,
): Promise<DeleteAssetOutcome> {
  const allowed = assetDeletable(asset);
  if (!allowed.deletable) {
    // Refused before the request: never send one the server will answer 409 to.
    return { ok: false, deleted: false, message: allowed.reason };
  }

  try {
    await deps.remove(asset.assetId);
  } catch (err) {
    return {
      ok: false,
      deleted: false,
      message: err instanceof Error ? err.message : 'Could not delete this item.',
    };
  }

  try {
    await deps.reload();
  } catch {
    return {
      ok: false,
      deleted: true,
      message: 'Deleted, but the page could not refresh. Reload to see the current content.',
    };
  }

  return { ok: true };
}
