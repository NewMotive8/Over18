import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import {
  characterVisualAssets,
  characterVisualIdentities,
  type CharacterVisualAssetRow,
} from '../db/schema.js';
import { distributableWorkflowCondition } from './asset-distribution.js';
import { uploadedPathOf } from './library-upload-service.js';
import { publicAssetUrl } from './public-media-service.js';
import { canonicalReferenceOrder } from './visual-asset-service.js';

/**
 * P0.2 — THE ONE PLACE A CHARACTER'S PORTRAIT COMES FROM.
 *
 * ── WHAT WAS WRONG ───────────────────────────────────────────────────────────
 *
 * `characters.profile_image` is a plain text column that predates first-class
 * visual assets. It was an INDEPENDENT source of truth: an operator could set
 * it through the character API, it travelled on every public payload, and
 * several web surfaces each decided for themselves whether to believe it or the
 * identity model. Two channels described the same thing — who this character
 * is — and nothing kept them in agreement.
 *
 * ── WHAT IS TRUE NOW ─────────────────────────────────────────────────────────
 *
 * A character's portrait is HER ACTIVE IDENTITY'S FIRST CANONICAL REFERENCE,
 * resolved here, server-side, once. That is the same asset the public
 * visual-identity endpoint already serves and the same row
 * `publiclyReachableCondition` already admits, so this introduces no new
 * visibility rule and no second identity source — it reads the canonical one.
 *
 * The wire field keeps its name (`profileImage`) so no client has to be
 * rewritten; what changed is where its VALUE comes from.
 *
 * ── THE LEGACY FALLBACK, AND WHY IT SURVIVES ─────────────────────────────────
 *
 * DEPRECATED, TEMPORARY, AND LAST. Characters seeded before the asset model
 * carry SCAFFOLDING canonical references whose `storage_key` is a web display
 * locator (a placehold.co URL, or `/media/maria/portrait.png`) rather than
 * stored media — `resolveMediaFile` refuses those as `outside_storage_root`, so
 * the media route cannot serve their bytes. For exactly those characters the
 * legacy column still holds the only locator a browser can fetch, and dropping
 * it today would replace live portraits with initial-letter tiles.
 *
 * So the column is no longer AUTHORITATIVE — it is a fallback consulted in one
 * function, after the canonical model has had its say. See
 * `docs/legacy-storage-audit.md` §3 for what has to be true before it can go.
 *
 * ── NO STORAGE KEY EVER LEAVES THE SERVER ────────────────────────────────────
 *
 * This module emits exactly two kinds of value: the opaque id-keyed route
 * `publicAssetUrl` builds, or the legacy column. A raw `storage_key` — which
 * for a generated asset is an absolute filesystem path — is never passed
 * through, so US-102.4's guarantee holds without qualification.
 */

/** Where the portrait a caller is holding actually came from. */
export type PortraitSource = 'canonical-reference' | 'legacy-profile-image' | 'none';

export interface CharacterPortrait {
  /** What a client should render, or null when the character has no portrait. */
  url: string | null;
  source: PortraitSource;
}

export const NO_PORTRAIT: CharacterPortrait = { url: null, source: 'none' };

/**
 * A storage key that is a WEB DISPLAY LOCATOR, not stored media.
 *
 * The seed writes canonical references whose `storage_key` is an http(s) URL or
 * a path under the web bundle's `/media/` directory — the file a browser
 * fetches is served by somebody else, and MEDIA_STORAGE_DIR holds no bytes for
 * it. Handing out `/api/media/assets/<id>/file` for one of those rows would
 * advertise a locator that answers 404.
 *
 * The upload convention is checked first, exactly as `resolveMediaFile` checks
 * it: a manual upload has BOTH a route-shaped storage key and a real
 * `provenance.storagePath`, and only the latter says where the bytes are.
 */
function isDisplayLocator(asset: CharacterVisualAssetRow): boolean {
  if (uploadedPathOf(asset)) return false;
  const key = asset.storageKey ?? '';
  return /^https?:\/\//i.test(key) || key.startsWith('/media/');
}

/**
 * The public locator for a canonical reference, or null when this deployment
 * cannot serve it. Unknown shapes resolve to the opaque route — the media route
 * decides whether bytes come back, and nothing internal is disclosed either way.
 */
export function portraitUrlOf(asset: CharacterVisualAssetRow): string | null {
  if (isDisplayLocator(asset)) return null;
  return publicAssetUrl(asset.id, asset.storageKey);
}

/** The legacy column, trimmed, with the empty string read as absent. */
function legacyLocator(profileImage: string | null | undefined): string | null {
  const trimmed = profileImage?.trim() ?? '';
  return trimmed.length > 0 ? trimmed : null;
}

/** Canonical first, deprecated legacy column second, nothing third. */
export function choosePortrait(
  canonical: readonly CharacterVisualAssetRow[],
  profileImage: string | null | undefined,
): CharacterPortrait {
  for (const asset of canonical) {
    const url = portraitUrlOf(asset);
    if (url) return { url, source: 'canonical-reference' };
  }
  const legacy = legacyLocator(profileImage);
  return legacy ? { url: legacy, source: 'legacy-profile-image' } : NO_PORTRAIT;
}

/** The character fields this resolver needs: an id, and the legacy fallback. */
export interface PortraitSubject {
  id: string;
  profileImage: string | null;
}

/**
 * Portraits for many characters in ONE query.
 *
 * Batched deliberately: the admin roster and `/api/browse/characters` project
 * dozens of characters at a time, and a per-character lookup would turn one
 * list into one query per row. A character with no canonical reference simply
 * does not appear in the join and falls through to the legacy column.
 */
export async function resolveCharacterPortraits(
  db: Db,
  subjects: readonly PortraitSubject[],
): Promise<Map<string, CharacterPortrait>> {
  const out = new Map<string, CharacterPortrait>();
  if (subjects.length === 0) return out;

  const rows = await db
    .select({ asset: characterVisualAssets })
    .from(characterVisualAssets)
    .innerJoin(
      characterVisualIdentities,
      eq(characterVisualIdentities.id, characterVisualAssets.visualIdentityId),
    )
    .where(
      and(
        inArray(
          characterVisualAssets.characterId,
          subjects.map((s) => s.id),
        ),
        // Only the ACTIVE identity version speaks for the character today. A
        // retired version's references stay in the database (P0.6) and stay out
        // of this answer.
        eq(characterVisualIdentities.status, 'active'),
        eq(characterVisualAssets.kind, 'reference'),
        // BORROWED, NEVER RESTATED (P0.5). The one definition of "approved, and
        // nothing else" lives in `asset-distribution`, and `approved` excludes
        // pending, rejected AND archived by construction — the P0.4 property
        // every approval gate inherits for free.
        //
        // Only the STATUS rule is borrowed. The rest of that module's gate
        // restricts `kind` to PUBLIC CONTENT, and a portrait is the opposite of
        // content: it is her identity reference, which is why the kind rule
        // above is this module's own.
        distributableWorkflowCondition(),
        eq(characterVisualAssets.isCanonical, true),
      ),
    );

  const byCharacter = new Map<string, CharacterVisualAssetRow[]>();
  for (const row of rows) {
    const list = byCharacter.get(row.asset.characterId);
    if (list) list.push(row.asset);
    else byCharacter.set(row.asset.characterId, [row.asset]);
  }

  for (const subject of subjects) {
    const canonical = (byCharacter.get(subject.id) ?? []).sort(canonicalReferenceOrder);
    out.set(subject.id, choosePortrait(canonical, subject.profileImage));
  }
  return out;
}

/** One character's portrait. */
export async function resolveCharacterPortrait(
  db: Db,
  subject: PortraitSubject,
): Promise<CharacterPortrait> {
  const portraits = await resolveCharacterPortraits(db, [subject]);
  return portraits.get(subject.id) ?? NO_PORTRAIT;
}
