import { and, eq, or, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import {
  appCategories,
  appCategoryAssets,
  assetKeywords,
  characters,
  characterVisualAssets,
  characterVisualIdentities,
  discoveryCategories,
  discoveryCategoryKeywords,
  homeHeroClips,
  type CharacterVisualAssetRow,
} from '../db/schema.js';
import { resolveMediaFile, type ResolvedMediaFile } from './message-media-service.js';
import { PUBLISHABLE_STATUS } from './app-merchandising-service.js';

/**
 * Public media access (US-102.4).
 *
 * WHY THIS EXISTS AT ALL. Before this ticket the public visual-identity
 * endpoint handed every anonymous browser `row.storageKey` — an absolute
 * filesystem path on the server — as its `imageUrl`. US-102.2 closed exactly
 * this hole for the admin Library and Review surfaces but the public route was
 * never cleaned up. Home cannot render a single clip without a public locator,
 * so the fix lands here rather than being deferred again.
 *
 * THE LOCATOR IS OPAQUE. A client is given `/api/media/assets/:assetId/file`
 * and nothing else. No storage key, no path, no extension, no directory. The
 * id is already public — it is a row identifier the client legitimately holds —
 * and it reveals nothing about where the bytes live.
 *
 * TWO CONDITIONS, BOTH REQUIRED, BOTH IN SQL.
 *
 *  1. APPROVED. `status = 'approved'`, the same single rule US-102.2 defined as
 *     "the one rule that decides whether an asset may be publicly associated".
 *     It is imported from there rather than restated, so there is exactly one
 *     definition of publishable in the codebase.
 *
 *  2. PUBLICLY REACHABLE. Approval alone is not enough. An approved asset that
 *     no public surface references must not be fetchable just because someone
 *     guessed its id — otherwise this route would quietly expose the entire
 *     approved Library, which is an admin surface. An asset is reachable when
 *     it is a canonical reference image of the character's ACTIVE identity
 *     version (already public via the character gallery), a Hero clip, assigned
 *     to a category that is BOTH enabled and published to Home, or carries a
 *     keyword belonging to an ENABLED discovery category.
 *
 *     That last arm is deliberately narrow. "Carries any keyword at all" would
 *     turn an operator's private organisational vocabulary into a publication
 *     switch: tagging a clip `internal-review` would make it fetchable. The
 *     keyword has to be one an enabled discovery category actually queries —
 *     which is exactly the condition under which the strip can reach the clip.
 *     Disabling the last category that uses a keyword closes its content again.
 *
 *  3. ITS CHARACTER IS ACTIVE. Retiring a character already removes them from
 *     every public route — /api/characters and the visual-identity endpoint
 *     both refuse an inactive character. Their media has to go with them, or
 *     retirement would leave the pictures reachable by id after the profile
 *     stopped existing.
 *
 * Both conditions are part of the query, not a filter applied afterwards, so
 * there is no code path through this module that returns an unapproved or
 * unreachable asset. Losing approval, being removed from a category, or the
 * category being unpublished each makes the asset 404 immediately, with no
 * sweep and no cache to invalidate.
 */

export type PublicMediaRefusal = 'not_found' | 'file_missing' | 'not_public';

export interface PublicMediaStorage {
  storageDir: string | null;
}

/** The opaque locator handed to clients. Never a storage key or path. */
export function publicAssetUrl(assetId: string, storageKey: string | null): string | null {
  return storageKey ? `/api/media/assets/${assetId}/file` : null;
}

/**
 * The one predicate for "this asset is visible to the public right now".
 *
 * Expressed as SQL rather than as a set of ids so it composes into any query
 * and cannot drift from the reads that use it. EXISTS rather than joins so an
 * asset in five published categories still yields one row.
 */
export function publiclyReachableCondition() {
  return and(
    eq(characterVisualAssets.status, PUBLISHABLE_STATUS),
    // The owning character must still be active — see condition 3 above.
    sql`exists (
      select 1 from ${characters}
      where ${characters.id} = ${characterVisualAssets.characterId}
        and ${characters.status} = 'active'
    )`,
    or(
      // A canonical reference of the character's ACTIVE identity version — the
      // gallery is version-scoped (visual-read-service passes active.id), so
      // omitting the version here would keep a superseded portrait fetchable
      // long after it stopped being shown anywhere.
      and(
        eq(characterVisualAssets.isCanonical, true),
        eq(characterVisualAssets.kind, 'reference'),
        sql`exists (
          select 1 from ${characterVisualIdentities}
          where ${characterVisualIdentities.id} = ${characterVisualAssets.visualIdentityId}
            and ${characterVisualIdentities.characterId} = ${characterVisualAssets.characterId}
            and ${characterVisualIdentities.status} = 'active'
        )`,
      ),
      // An admin-assigned Hero clip.
      sql`exists (select 1 from ${homeHeroClips} where ${homeHeroClips.assetId} = ${characterVisualAssets.id})`,
      // Merchandised into a category that is enabled AND published to Home.
      sql`exists (
        select 1
        from ${appCategoryAssets}
        join ${appCategories} on ${appCategories.id} = ${appCategoryAssets.categoryId}
        where ${appCategoryAssets.assetId} = ${characterVisualAssets.id}
          and ${appCategories.enabled} = true
          and ${appCategories.homePublished} = true
      )`,
      // Carries a keyword an ENABLED discovery category queries — i.e. the
      // strip can actually reach it. Not merely "has any keyword".
      sql`exists (
        select 1
        from ${assetKeywords}
        join ${discoveryCategoryKeywords}
          on ${discoveryCategoryKeywords.keywordId} = ${assetKeywords.keywordId}
        join ${discoveryCategories}
          on ${discoveryCategories.id} = ${discoveryCategoryKeywords.discoveryCategoryId}
        where ${assetKeywords.assetId} = ${characterVisualAssets.id}
          and ${discoveryCategories.enabled} = true
      )`,
    ),
  );
}

/**
 * Fetches an asset row ONLY when it is currently public. Returns null for
 * unknown, unapproved and unreachable alike — every one of them reads as "not
 * found" so the route leaks no existence information.
 */
export async function getPublicAsset(
  db: Db,
  assetId: string,
): Promise<CharacterVisualAssetRow | null> {
  const [row] = await db
    .select()
    .from(characterVisualAssets)
    .where(and(eq(characterVisualAssets.id, assetId), publiclyReachableCondition()))
    .limit(1);
  return row ?? null;
}

/**
 * Resolves a public asset to streamable bytes.
 *
 * Containment against MEDIA_STORAGE_DIR comes from the shared resolveMediaFile,
 * the same function the chat and admin media routes use — a path outside the
 * storage root is refused even if the column says otherwise.
 */
export function resolvePublicMedia(
  asset: CharacterVisualAssetRow,
  storage: PublicMediaStorage,
): ResolvedMediaFile | { failure: PublicMediaRefusal } {
  if (!storage.storageDir) return { failure: 'not_found' };
  const resolved = resolveMediaFile(asset, storage.storageDir);
  if ('failure' in resolved) return { failure: 'not_found' };
  return resolved;
}
