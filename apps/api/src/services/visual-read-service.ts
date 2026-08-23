import type {
  CharacterVisualIdentityResponse,
  PublicVisualAsset,
  PublicVisualIdentity,
  PublicVisualIdentityAttribute,
} from '@over18/shared';
import type { Db } from '../db/client.js';
import type { CharacterVisualAssetRow, CharacterVisualIdentityRow } from '../db/schema.js';
import { getActiveVisualIdentity } from './visual-identity-service.js';
import { listCanonicalReferences } from './visual-asset-service.js';
import { publicAssetUrl } from './public-media-service.js';

/**
 * Public read projection for Visual Identity (US-16B).
 *
 * The ONLY place the visual identity system meets the public API. It composes
 * the read-side services from US-16A and applies strict allow-list mappers so
 * that provenance, content-rating internals, draft/retired/rejected/generated
 * assets, storage details, and raw Visual DNA jsonb can NEVER reach the wire —
 * the same discipline as toPublicCharacter and system_prompt.
 */

/** Ordered allow-list of Visual DNA keys that may be shown, with display labels. */
const DNA_DISPLAY: ReadonlyArray<readonly [string, string]> = [
  ['apparentAgeBand', 'Apparent age'],
  ['face', 'Face'],
  ['eyes', 'Eyes'],
  ['nose', 'Nose'],
  ['lips', 'Lips'],
  ['skin', 'Skin'],
  ['hair', 'Hair'],
  ['body', 'Body'],
  ['distinctiveFeatures', 'Distinctive features'],
];

function humanizeKey(key: string): string {
  const spaced = key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Renders a single DNA value to a display string, or null if nothing showable. */
function renderValue(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    const parts = value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
    return parts.length > 0 ? parts.join(', ') : null;
  }
  if (typeof value === 'object') {
    const parts: string[] = [];
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const rendered = renderValue(v);
      if (rendered !== null) parts.push(`${humanizeKey(k)}: ${rendered}`);
    }
    return parts.length > 0 ? parts.join(' · ') : null;
  }
  return null;
}

/** Builds the public identity projection from an internal identity row. */
export function toPublicVisualIdentity(row: CharacterVisualIdentityRow): PublicVisualIdentity {
  const dna = row.visualDna as Record<string, unknown>;
  const attributes: PublicVisualIdentityAttribute[] = [];
  for (const [key, label] of DNA_DISPLAY) {
    const value = renderValue(dna[key]);
    if (value !== null) attributes.push({ label, value });
  }
  return {
    characterId: row.characterId,
    version: row.version,
    label: row.label,
    attributes,
  };
}

/**
 * Builds the public canonical-asset projection (only a display locator).
 *
 * US-102.4 — `imageUrl` is now an OPAQUE, id-keyed route. It used to be
 * `row.storageKey`: the server's absolute filesystem path, sent to every
 * anonymous browser. That is the same leak US-102.2 closed for the admin
 * Library and Review surfaces; the public route had been missed. Every caller
 * already treated this field as an opaque string, so the change is invisible to
 * them and the path never leaves the server.
 */
export function toPublicVisualAsset(row: CharacterVisualAssetRow): PublicVisualAsset {
  return {
    id: row.id,
    position: row.position,
    imageUrl: publicAssetUrl(row.id, row.storageKey) ?? '',
  };
}

/**
 * The public visual identity for a character: its active identity version (or
 * null) and its approved canonical reference gallery (empty when none). Assets
 * with no display locator are omitted — there is nothing to render.
 */
export async function getPublicVisualIdentity(
  db: Db,
  characterId: string,
): Promise<CharacterVisualIdentityResponse> {
  const active = await getActiveVisualIdentity(db, characterId);
  if (!active) {
    return { identity: null, canonicalAssets: [] };
  }
  const canonical = await listCanonicalReferences(db, characterId, active.id);
  return {
    identity: toPublicVisualIdentity(active),
    canonicalAssets: canonical
      .filter((row) => (row.storageKey ?? '').length > 0)
      .map(toPublicVisualAsset),
  };
}
