import { and, asc, eq, sql } from 'drizzle-orm';
import {
  audienceMatches,
  bannerEffectiveState,
  BANNER_AUDIENCES,
  BANNER_DESTINATION_KINDS,
  HOME_BANNER_SLOTS,
  type BannerAudience,
  type BannerDestinationKind,
  type BannerProblem,
  type BannerState,
  type BannerStatus,
  type BannerViewer,
  type HomeBannerSlot,
} from '@over18/shared';
import type { Db } from '../db/client.js';
import {
  appCategories,
  bannerCreatives,
  characters,
  characterVisualAssets,
  homeBanners,
  type HomeBannerRow,
} from '../db/schema.js';
import {
  resolveBannerCreative,
  toBannerCreativeView,
  type BannerCreativeStorage,
  type BannerCreativeView,
} from './banner-creative-service.js';

/**
 * Home banners (US-102.3) — editorial banners, their lifecycle, schedule,
 * audience, destination validity and order.
 *
 * WHAT THIS FILE DOES NOT DECIDE: how Home is composed. Single banner versus
 * carousel, placement, whether Home renders banners at all — every one of those
 * is US-102.4. This owns the banners and their order, and exposes ONE function
 * (listEligibleHomeBanners) for 102.4 to build on.
 *
 * NO SCHEDULER. Scheduled → Live → Ended is derived on every read from the
 * window and the clock, via bannerEffectiveState in @over18/shared. There is no
 * cron, nothing to restart, no drift, and the boundaries are testable with an
 * injected clock instead of by waiting. `now` is a parameter everywhere for
 * exactly that reason.
 *
 * NEEDS ATTENTION IS DERIVED TOO. A banner is broken when its destination or
 * creative no longer resolves — computed per read, never stored, so repairing
 * the destination makes the banner eligible again with no sweep and no stale
 * flag. The dependency columns are ON DELETE SET NULL, so the database itself
 * produces the broken condition when a category or character disappears.
 *
 * NOTHING HERE WRITES TO ANOTHER SYSTEM. It reads categories, characters and
 * assets to answer "does this destination still resolve", and writes only
 * `home_banners`. Review, content requirements, generation and the character
 * Library are untouched.
 */

export class HomeBannerValidationError extends Error {
  constructor(
    public readonly field: string,
    message: string,
  ) {
    super(message);
    this.name = 'HomeBannerValidationError';
  }
}

export class HomeBannerOrderError extends Error {
  constructor(
    public readonly reason: 'unknown_id' | 'incomplete' | 'duplicate',
    message: string,
  ) {
    super(message);
    this.name = 'HomeBannerOrderError';
  }
}

/** Refused publish, with the problems that blocked it. */
export class HomeBannerNotPublishableError extends Error {
  constructor(public readonly problems: BannerProblem[]) {
    super('This banner cannot be published until its problems are fixed.');
    this.name = 'HomeBannerNotPublishableError';
  }
}

const TITLE_MAX = 120;
const SUBTITLE_MAX = 200;
const CTA_MAX = 40;
const URL_MAX = 2000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface BannerDestinationView {
  kind: BannerDestinationKind;
  categoryId: string | null;
  characterId: string | null;
  assetId: string | null;
  url: string | null;
  /** What the operator sees, resolved server-side. Null when it is broken. */
  label: string | null;
}

export interface HomeBannerView {
  id: string;
  title: string;
  subtitle: string | null;
  ctaLabel: string | null;
  creative: BannerCreativeView | null;
  destination: BannerDestinationView;
  status: BannerStatus;
  audience: BannerAudience;
  startsAt: string | null;
  endsAt: string | null;
  scheduleTimezone: string | null;
  /** US-102.4 — WHERE on Home this renders. Order below is within the slot. */
  slot: HomeBannerSlot;
  position: number;
  publishedAt: string | null;
  /** Derived. Never stored — see the note at the top of this file. */
  state: BannerState;
  problems: BannerProblem[];
  createdAt: string;
  updatedAt: string;
}

/* ------------------------------------------------------------------ *
 * Validation
 * ------------------------------------------------------------------ */

/**
 * External URL validation — SHAPE ONLY, and deliberately so.
 *
 * There is no server-side fetch to check whether the URL is alive. Probing an
 * arbitrary operator-supplied URL from the server is a textbook SSRF vector
 * (internal addresses, cloud metadata endpoints), and this ticket explicitly
 * rules it out. The UI states that we check the form of the link, not that it
 * works, rather than implying a guarantee we do not provide.
 *
 * https only: an http banner destination would downgrade every user who taps
 * it, and there is no reason an editorial link should need it.
 */
export function validateExternalUrl(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new HomeBannerValidationError('destinationUrl', 'A link is required for this destination.');
  }
  if (trimmed.length > URL_MAX) {
    throw new HomeBannerValidationError('destinationUrl', 'That link is too long.');
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new HomeBannerValidationError(
      'destinationUrl',
      'That is not a valid link. Include the full address, starting with https://',
    );
  }
  if (url.protocol !== 'https:') {
    throw new HomeBannerValidationError(
      'destinationUrl',
      'Links must start with https:// so people are never sent to an insecure page.',
    );
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new HomeBannerValidationError(
      'destinationUrl',
      'Links must not contain a username or password.',
    );
  }
  return url.toString();
}

/**
 * IANA timezone validation, using the platform's own database rather than a
 * hard-coded list that would rot. Intl throws on an unknown zone, which is the
 * check.
 */
export function validateTimezone(zone: string): string {
  const trimmed = zone.trim();
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: trimmed });
  } catch {
    throw new HomeBannerValidationError('scheduleTimezone', `Unknown time zone "${trimmed}".`);
  }
  return trimmed;
}

export interface HomeBannerInput {
  title: string;
  subtitle?: string | null;
  ctaLabel?: string | null;
  creativeId?: string | null;
  destinationKind: BannerDestinationKind;
  destinationCategoryId?: string | null;
  destinationCharacterId?: string | null;
  destinationAssetId?: string | null;
  destinationUrl?: string | null;
  audience?: BannerAudience;
  slot?: HomeBannerSlot;
  startsAt?: string | null;
  endsAt?: string | null;
  scheduleTimezone?: string | null;
}

function optionalText(value: string | null | undefined, max: number): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed.slice(0, max);
}

/**
 * Every id this service accepts names a uuid column.
 *
 * Checking the SHAPE here is what keeps a mistyped id inside the ordinary
 * validation path: without it the value reaches the driver, Postgres raises
 * `22P02 invalid input syntax for type uuid`, and — because the API installs no
 * error handler of its own — Fastify turns that into a 500 whose body echoes
 * the database's own message. An operator's typo should produce the same clean
 * 400 invalid_banner every other bad field produces.
 */
function optionalId(value: string | null | undefined, field: string, noun: string): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (!UUID_RE.test(value)) {
    throw new HomeBannerValidationError(field, `That is not a valid ${noun}. Choose one from the list.`);
  }
  return value;
}

/**
 * The window is a PAIR, so it is checked as one — never as two independent
 * fields, and never against only what this request happened to send.
 */
function assertWindowOrdered(startsAt: Date | null, endsAt: Date | null): void {
  if (startsAt && endsAt && endsAt.getTime() <= startsAt.getTime()) {
    throw new HomeBannerValidationError('endsAt', 'The end time must be after the start time.');
  }
}

/**
 * Refuses a reference to a row that does not exist, BEFORE the insert reaches
 * the database.
 *
 * A well-formed id naming nothing is a foreign-key violation, and the driver's
 * message names the table and the constraint — so leaving it to Postgres both
 * loses the useful error and leaks schema internals into a 500 body.
 *
 * This is NOT the question resolveDependencies asks. That one describes a
 * banner whose dependency disappeared AFTER it was saved: a repairable
 * Needs-attention state the operator can see and fix. This one refuses to
 * manufacture that state on purpose.
 */
async function assertReferencesExist(db: Db, values: Record<string, unknown>): Promise<void> {
  const checks: Array<{
    id: string | null;
    field: string;
    message: string;
    exists: (id: string) => Promise<boolean>;
  }> = [
    {
      id: (values.creativeId as string | null | undefined) ?? null,
      field: 'creativeId',
      message: 'That creative no longer exists. Upload the artwork again.',
      exists: async (id) =>
        (await db.select({ id: bannerCreatives.id }).from(bannerCreatives).where(eq(bannerCreatives.id, id)).limit(1))
          .length > 0,
    },
    {
      id: (values.destinationCategoryId as string | null | undefined) ?? null,
      field: 'destinationCategoryId',
      message: 'That category no longer exists. Choose another.',
      exists: async (id) =>
        (await db.select({ id: appCategories.id }).from(appCategories).where(eq(appCategories.id, id)).limit(1))
          .length > 0,
    },
    {
      id: (values.destinationCharacterId as string | null | undefined) ?? null,
      field: 'destinationCharacterId',
      message: 'That character no longer exists. Choose another.',
      exists: async (id) =>
        (await db.select({ id: characters.id }).from(characters).where(eq(characters.id, id)).limit(1)).length > 0,
    },
    {
      id: (values.destinationAssetId as string | null | undefined) ?? null,
      field: 'destinationAssetId',
      message: 'That content item no longer exists. Choose another.',
      exists: async (id) =>
        (
          await db
            .select({ id: characterVisualAssets.id })
            .from(characterVisualAssets)
            .where(eq(characterVisualAssets.id, id))
            .limit(1)
        ).length > 0,
    },
  ];

  for (const check of checks) {
    if (check.id && !(await check.exists(check.id))) {
      throw new HomeBannerValidationError(check.field, check.message);
    }
  }
}

function parseInstant(value: string | null | undefined, field: string): Date | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new HomeBannerValidationError(field, 'That is not a valid date and time.');
  }
  return parsed;
}

/**
 * Shapes and checks one banner's fields.
 *
 * The destination is normalised as well as validated: choosing a category
 * CLEARS any character, asset or url left behind by a previous choice, so a
 * banner can never carry two destinations and have the reader pick one.
 */
function validate(input: Partial<HomeBannerInput>, requireAll: boolean) {
  const values: Record<string, unknown> = {};

  if (input.title !== undefined) {
    const title = input.title.trim();
    if (title.length === 0) {
      throw new HomeBannerValidationError('title', 'A banner needs a title.');
    }
    values.title = title.slice(0, TITLE_MAX);
  } else if (requireAll) {
    throw new HomeBannerValidationError('title', 'A banner needs a title.');
  }

  if (input.subtitle !== undefined) values.subtitle = optionalText(input.subtitle, SUBTITLE_MAX);
  if (input.ctaLabel !== undefined) values.ctaLabel = optionalText(input.ctaLabel, CTA_MAX);
  if (input.creativeId !== undefined) {
    values.creativeId = optionalId(input.creativeId, 'creativeId', 'creative');
  }

  if (input.audience !== undefined) {
    if (!BANNER_AUDIENCES.includes(input.audience)) {
      throw new HomeBannerValidationError('audience', 'Unknown audience.');
    }
    values.audience = input.audience;
  }

  if (input.slot !== undefined) {
    if (!HOME_BANNER_SLOTS.includes(input.slot)) {
      throw new HomeBannerValidationError('slot', 'Unknown Home slot.');
    }
    values.slot = input.slot;
  }

  if (input.destinationKind !== undefined) {
    if (!BANNER_DESTINATION_KINDS.includes(input.destinationKind)) {
      throw new HomeBannerValidationError('destinationKind', 'Unknown destination type.');
    }
    const kind = input.destinationKind;
    values.destinationKind = kind;
    // Exactly one destination column survives — see the note above.
    values.destinationCategoryId =
      kind === 'category'
        ? optionalId(input.destinationCategoryId, 'destinationCategoryId', 'category')
        : null;
    values.destinationCharacterId =
      kind === 'character'
        ? optionalId(input.destinationCharacterId, 'destinationCharacterId', 'character')
        : null;
    values.destinationAssetId =
      kind === 'content'
        ? optionalId(input.destinationAssetId, 'destinationAssetId', 'content item')
        : null;
    values.destinationUrl =
      kind === 'external' ? validateExternalUrl(input.destinationUrl ?? '') : null;

    if (kind === 'category' && !values.destinationCategoryId) {
      throw new HomeBannerValidationError('destinationCategoryId', 'Choose a category.');
    }
    if (kind === 'character' && !values.destinationCharacterId) {
      throw new HomeBannerValidationError('destinationCharacterId', 'Choose a character.');
    }
    if (kind === 'content' && !values.destinationAssetId) {
      throw new HomeBannerValidationError('destinationAssetId', 'Choose a content item.');
    }
  } else if (requireAll) {
    throw new HomeBannerValidationError('destinationKind', 'Choose where this banner goes.');
  }

  const startsAt = parseInstant(input.startsAt, 'startsAt');
  const endsAt = parseInstant(input.endsAt, 'endsAt');
  // NOTE: the two bounds are deliberately NOT compared here. `validate` sees
  // only this request, and a PATCH may change one side of a window whose other
  // side is already stored — so the comparison belongs to the callers, which
  // know the banner's current values. See assertWindowOrdered.
  if (input.startsAt !== undefined) values.startsAt = startsAt;
  if (input.endsAt !== undefined) values.endsAt = endsAt;
  if (input.scheduleTimezone !== undefined) {
    values.scheduleTimezone = input.scheduleTimezone
      ? validateTimezone(input.scheduleTimezone)
      : null;
  }

  return values;
}

/* ------------------------------------------------------------------ *
 * Resolving dependencies
 * ------------------------------------------------------------------ */

interface ResolvedDependencies {
  creative: BannerCreativeView | null;
  destinationLabel: string | null;
  problems: BannerProblem[];
}

/**
 * Answers, for one banner: is its creative usable, and does its destination
 * still resolve? Both questions in one place, because both feed the same
 * derived state and both must be asked on every read.
 *
 * A destination is unavailable — not merely missing — when the thing still
 * exists but has been withdrawn: a disabled category, a deactivated character,
 * an asset that lost approval. The two are distinguished so the UI can tell the
 * operator whether to re-point the banner or to go and re-enable the thing.
 */
async function resolveDependencies(
  db: Db,
  row: HomeBannerRow,
  storage: BannerCreativeStorage,
): Promise<ResolvedDependencies> {
  const problems: BannerProblem[] = [];

  let creative: BannerCreativeView | null = null;
  if (!row.creativeId) {
    problems.push('creative_missing');
  } else {
    const [creativeRow] = await db
      .select()
      .from(bannerCreatives)
      .where(eq(bannerCreatives.id, row.creativeId))
      .limit(1);
    if (!creativeRow) {
      problems.push('creative_missing');
    } else {
      creative = toBannerCreativeView(creativeRow);
      if (!resolveBannerCreative(creativeRow, storage).ok) problems.push('creative_invalid');
    }
  }

  let destinationLabel: string | null = null;
  switch (row.destinationKind) {
    case 'category': {
      if (!row.destinationCategoryId) {
        problems.push('destination_missing');
        break;
      }
      const [category] = await db
        .select()
        .from(appCategories)
        .where(eq(appCategories.id, row.destinationCategoryId))
        .limit(1);
      if (!category) problems.push('destination_missing');
      else if (!category.enabled) {
        problems.push('destination_unavailable');
        destinationLabel = category.name;
      } else destinationLabel = category.name;
      break;
    }
    case 'character': {
      if (!row.destinationCharacterId) {
        problems.push('destination_missing');
        break;
      }
      const [character] = await db
        .select()
        .from(characters)
        .where(eq(characters.id, row.destinationCharacterId))
        .limit(1);
      if (!character) problems.push('destination_missing');
      else if (character.status !== 'active') {
        problems.push('destination_unavailable');
        destinationLabel = character.displayName;
      } else destinationLabel = character.displayName;
      break;
    }
    case 'content': {
      if (!row.destinationAssetId) {
        problems.push('destination_missing');
        break;
      }
      const [asset] = await db
        .select({ id: characterVisualAssets.id, status: characterVisualAssets.status })
        .from(characterVisualAssets)
        .where(eq(characterVisualAssets.id, row.destinationAssetId))
        .limit(1);
      if (!asset) problems.push('destination_missing');
      else if (asset.status !== 'approved') {
        problems.push('destination_unavailable');
        destinationLabel = 'Content item';
      } else destinationLabel = 'Content item';
      break;
    }
    case 'external': {
      if (!row.destinationUrl) {
        problems.push('destination_missing');
        break;
      }
      try {
        // Re-validated on READ, not just on write: a row could predate a rule
        // change, and the public surface must never inherit a stale pass.
        destinationLabel = validateExternalUrl(row.destinationUrl);
      } catch {
        problems.push('destination_invalid_url');
      }
      break;
    }
    default:
      problems.push('destination_missing');
  }

  return { creative, destinationLabel, problems };
}

async function toView(
  db: Db,
  row: HomeBannerRow,
  storage: BannerCreativeStorage,
  now: Date,
): Promise<HomeBannerView> {
  const { creative, destinationLabel, problems } = await resolveDependencies(db, row, storage);
  const startsAt = row.startsAt ? row.startsAt.toISOString() : null;
  const endsAt = row.endsAt ? row.endsAt.toISOString() : null;
  const status = row.status as BannerStatus;

  return {
    id: row.id,
    title: row.title,
    subtitle: row.subtitle,
    ctaLabel: row.ctaLabel,
    creative,
    destination: {
      kind: row.destinationKind as BannerDestinationKind,
      categoryId: row.destinationCategoryId,
      characterId: row.destinationCharacterId,
      assetId: row.destinationAssetId,
      url: row.destinationUrl,
      label: destinationLabel,
    },
    status,
    audience: row.audience as BannerAudience,
    startsAt,
    endsAt,
    scheduleTimezone: row.scheduleTimezone,
    slot: (HOME_BANNER_SLOTS.includes(row.slot as HomeBannerSlot)
      ? row.slot
      : 'before_search') as HomeBannerSlot,
    position: row.position,
    publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
    state: bannerEffectiveState({ status, startsAt, endsAt, problems }, now),
    problems,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/* ------------------------------------------------------------------ *
 * Reads
 * ------------------------------------------------------------------ */

/** Every banner in order, whatever its state. The admin list. */
export async function listHomeBanners(
  db: Db,
  storage: BannerCreativeStorage,
  now: Date,
): Promise<HomeBannerView[]> {
  const rows = await db
    .select()
    .from(homeBanners)
    // US-102.4: slot-major. Position is order WITHIN a slot, so sorting by
    // position alone would interleave two independent arrangements.
    .orderBy(asc(homeBanners.slot), asc(homeBanners.position), asc(homeBanners.createdAt));
  return Promise.all(rows.map((row) => toView(db, row, storage, now)));
}

export async function getHomeBanner(
  db: Db,
  storage: BannerCreativeStorage,
  id: string,
  now: Date,
): Promise<HomeBannerView | null> {
  const [row] = await db.select().from(homeBanners).where(eq(homeBanners.id, id)).limit(1);
  return row ? toView(db, row, storage, now) : null;
}

/**
 * THE PUBLIC SURFACE'S ONLY ENTRY POINT (consumed by US-102.4).
 *
 * A separate function from listHomeBanners rather than a flag on it, for the
 * same reason US-102.2 split its two reads: a public caller must not be able to
 * get the admin list by forgetting an argument. Everything that makes a banner
 * ineligible — draft, unpublished, outside its window, broken destination,
 * missing creative, wrong audience — is applied here, in one place.
 *
 * Nothing calls this yet. It exists tested so 102.4 starts from a proven filter.
 */
export async function listEligibleHomeBanners(
  db: Db,
  storage: BannerCreativeStorage,
  options: { now: Date; viewer: BannerViewer },
): Promise<HomeBannerView[]> {
  // `published` is the only status that can ever be eligible, so the query
  // excludes the rest before any work is done per banner.
  const rows = await db
    .select()
    .from(homeBanners)
    .where(eq(homeBanners.status, 'published'))
    .orderBy(asc(homeBanners.slot), asc(homeBanners.position), asc(homeBanners.createdAt));

  const views = await Promise.all(rows.map((row) => toView(db, row, storage, options.now)));
  return views.filter(
    (banner) => banner.state === 'live' && audienceMatches(banner.audience, options.viewer),
  );
}

/* ------------------------------------------------------------------ *
 * Writes
 * ------------------------------------------------------------------ */

/**
 * Creates a banner. ALWAYS a draft, whatever the caller sends — there is no
 * input that can make a new banner public, which is the strongest form of
 * "saving a draft must never make it public".
 *
 * Appended to the end OF ITS SLOT, so creating one never renumbers an
 * arrangement — and never renumbers the other slot's, either.
 */
export async function createHomeBanner(
  db: Db,
  storage: BannerCreativeStorage,
  input: HomeBannerInput,
  now: Date,
): Promise<HomeBannerView> {
  const values = validate(input, true);
  assertWindowOrdered(
    (values.startsAt as Date | null | undefined) ?? null,
    (values.endsAt as Date | null | undefined) ?? null,
  );
  await assertReferencesExist(db, values);

  const slot = (values.slot as HomeBannerSlot | undefined) ?? 'before_search';
  const [{ next } = { next: 0 }] = await db
    .select({ next: sql<number>`coalesce(max(${homeBanners.position}), -1) + 1` })
    .from(homeBanners)
    .where(eq(homeBanners.slot, slot));

  const [created] = await db
    .insert(homeBanners)
    .values({
      title: values.title as string,
      subtitle: (values.subtitle as string | null) ?? null,
      ctaLabel: (values.ctaLabel as string | null) ?? null,
      creativeId: (values.creativeId as string | null) ?? null,
      destinationKind: values.destinationKind as string,
      destinationCategoryId: (values.destinationCategoryId as string | null) ?? null,
      destinationCharacterId: (values.destinationCharacterId as string | null) ?? null,
      destinationAssetId: (values.destinationAssetId as string | null) ?? null,
      destinationUrl: (values.destinationUrl as string | null) ?? null,
      audience: (values.audience as BannerAudience | undefined) ?? 'everyone',
      slot,
      startsAt: (values.startsAt as Date | null) ?? null,
      endsAt: (values.endsAt as Date | null) ?? null,
      scheduleTimezone: (values.scheduleTimezone as string | null) ?? null,
      position: Number(next),
      status: 'draft',
    })
    .returning();

  return toView(db, created!, storage, now);
}

/**
 * Edits a banner. NEVER changes `status`: publish and unpublish are explicit
 * actions with their own routes, so no edit can publish something by accident
 * and no edit can quietly take a live banner down.
 *
 * There is no draft copy. Editing a PUBLISHED banner changes what is live,
 * immediately — the product decision for this ticket — and the editor says so
 * on screen rather than leaving the operator to discover it.
 *
 * The schedule is validated against the STORED window, not just the fields this
 * request carried. Changing one side alone must still be compared with the side
 * already saved — otherwise an edit can leave a banner whose end precedes its
 * start, which is permanently ineligible and shows no problem to explain why.
 */
export async function updateHomeBanner(
  db: Db,
  storage: BannerCreativeStorage,
  id: string,
  input: Partial<HomeBannerInput>,
  now: Date,
): Promise<HomeBannerView | null> {
  const values = validate(input, false);
  if (Object.keys(values).length === 0) return getHomeBanner(db, storage, id, now);

  const [existing] = await db.select().from(homeBanners).where(eq(homeBanners.id, id)).limit(1);
  if (!existing) return null;

  assertWindowOrdered(
    'startsAt' in values ? (values.startsAt as Date | null) : existing.startsAt,
    'endsAt' in values ? (values.endsAt as Date | null) : existing.endsAt,
  );
  await assertReferencesExist(db, values);

  // MOVING BETWEEN SLOTS re-homes the position. `position` is an order within a
  // slot, so carrying the old number across would collide with whatever already
  // holds it there; appending to the end of the destination is the only move
  // that cannot disturb an arrangement the operator already made.
  const movedSlot = 'slot' in values && values.slot !== existing.slot;
  if (movedSlot) {
    const [{ next } = { next: 0 }] = await db
      .select({ next: sql<number>`coalesce(max(${homeBanners.position}), -1) + 1` })
      .from(homeBanners)
      .where(eq(homeBanners.slot, values.slot as HomeBannerSlot));
    values.position = Number(next);
  }

  const [row] = await db
    .update(homeBanners)
    .set({ ...values, updatedAt: new Date() })
    .where(eq(homeBanners.id, id))
    .returning();
  return row ? toView(db, row, storage, now) : null;
}

/**
 * Publishes a banner — and REFUSES if it is already broken.
 *
 * Checking here as well as on every read is deliberate: the read-time filter
 * makes a broken banner invisible, but publishing one anyway would leave the
 * operator with something that looks published and never appears. Better to
 * say why up front.
 */
export async function publishHomeBanner(
  db: Db,
  storage: BannerCreativeStorage,
  id: string,
  now: Date,
): Promise<HomeBannerView | null> {
  const [row] = await db.select().from(homeBanners).where(eq(homeBanners.id, id)).limit(1);
  if (!row) return null;

  const { problems } = await resolveDependencies(db, row, storage);
  if (problems.length > 0) throw new HomeBannerNotPublishableError(problems);

  const [updated] = await db
    .update(homeBanners)
    .set({ status: 'published', publishedAt: row.publishedAt ?? now, updatedAt: new Date() })
    .where(eq(homeBanners.id, id))
    .returning();
  return toView(db, updated!, storage, now);
}

/**
 * Withdraws a banner from public presentation. Keeps the row, the creative,
 * the schedule and the audience — republishing restores it exactly.
 */
export async function unpublishHomeBanner(
  db: Db,
  storage: BannerCreativeStorage,
  id: string,
  now: Date,
): Promise<HomeBannerView | null> {
  const [row] = await db
    .update(homeBanners)
    .set({ status: 'unpublished', updatedAt: new Date() })
    .where(eq(homeBanners.id, id))
    .returning();
  return row ? toView(db, row, storage, now) : null;
}

/**
 * Deletes a banner. THE CREATIVE SURVIVES: the FK lives on the banner, so
 * removing the banner cannot reach banner_creatives, and neither the row nor
 * the file is touched. There is no statement in this function against any other
 * table — by design.
 */
export async function deleteHomeBanner(db: Db, id: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: homeBanners.id })
      .from(homeBanners)
      .where(eq(homeBanners.id, id))
      .limit(1);
    if (!existing) return false;
    await tx.delete(homeBanners).where(eq(homeBanners.id, id));
    await normalisePositions(tx);
    return true;
  });
}

/**
 * Applies a new order WITHIN ONE SLOT. Exact permutation or refuse, matching
 * US-102.1/.2: the failure to design for is a stale browser reordering a list
 * that has changed underneath it.
 *
 * Scoped to a slot because US-102.4 made `position` an order within a slot
 * rather than across all banners. A whole-table permutation would force the
 * operator to restate the other slot's arrangement to change this one, and any
 * banner moved between slots meanwhile would make both lists "incomplete".
 */
export async function reorderHomeBanners(
  db: Db,
  slot: HomeBannerSlot,
  orderedIds: string[],
): Promise<void> {
  if (!HOME_BANNER_SLOTS.includes(slot)) {
    throw new HomeBannerOrderError('unknown_id', 'Unknown Home slot.');
  }
  if (new Set(orderedIds).size !== orderedIds.length) {
    throw new HomeBannerOrderError('duplicate', 'The same banner was listed more than once.');
  }
  await db.transaction(async (tx) => {
    const existing = await tx
      .select({ id: homeBanners.id })
      .from(homeBanners)
      .where(eq(homeBanners.slot, slot));
    const existingIds = new Set(existing.map((row) => row.id));
    for (const id of orderedIds) {
      if (!existingIds.has(id)) {
        throw new HomeBannerOrderError('unknown_id', 'That banner is not in this slot.');
      }
    }
    if (orderedIds.length !== existingIds.size) {
      throw new HomeBannerOrderError(
        'incomplete',
        'The order is out of date — it does not list every banner in this slot. Reload and try again.',
      );
    }
    for (const [index, id] of orderedIds.entries()) {
      await tx
        .update(homeBanners)
        .set({ position: index, updatedAt: new Date() })
        .where(eq(homeBanners.id, id));
    }
  });
}

/** Renumbers each slot to 0..n-1 independently. */
async function normalisePositions(tx: Pick<Db, 'select' | 'update'>): Promise<void> {
  for (const slot of HOME_BANNER_SLOTS) {
    const rows = await tx
      .select({ id: homeBanners.id })
      .from(homeBanners)
      .where(eq(homeBanners.slot, slot))
      .orderBy(asc(homeBanners.position), asc(homeBanners.createdAt));
    for (const [index, row] of rows.entries()) {
      await tx.update(homeBanners).set({ position: index }).where(eq(homeBanners.id, row.id));
    }
  }
}

/* ------------------------------------------------------------------ *
 * Destination pickers
 * ------------------------------------------------------------------ */

/**
 * What an operator may point a banner at, as selectable entities — the ticket
 * requires pickers, never raw identifiers typed by hand.
 *
 * Only things that would actually work are offered: enabled categories, active
 * characters, approved content. Offering a disabled category would create a
 * Needs-attention banner on save.
 */
export async function listBannerDestinations(db: Db) {
  const [categoryRows, characterRows, assetRows] = await Promise.all([
    db
      .select({ id: appCategories.id, name: appCategories.name, slug: appCategories.slug })
      .from(appCategories)
      .where(eq(appCategories.enabled, true))
      .orderBy(asc(appCategories.position)),
    db
      .select({ id: characters.id, name: characters.name, displayName: characters.displayName })
      .from(characters)
      .where(eq(characters.status, 'active'))
      .orderBy(asc(characters.displayName)),
    db
      .select({
        id: characterVisualAssets.id,
        characterId: characterVisualAssets.characterId,
        characterName: characters.name,
      })
      .from(characterVisualAssets)
      .innerJoin(characters, eq(characters.id, characterVisualAssets.characterId))
      .where(and(eq(characterVisualAssets.status, 'approved')))
      .orderBy(asc(characters.name))
      .limit(200),
  ]);

  return { categories: categoryRows, characters: characterRows, content: assetRows };
}
