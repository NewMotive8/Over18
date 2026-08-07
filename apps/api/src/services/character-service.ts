import { asc, eq } from 'drizzle-orm';
import type { PublicCharacter } from '@over18/shared';
import type { Db } from '../db/client.js';
import { characters, type CharacterRow } from '../db/schema.js';

/**
 * Framework-agnostic character service, following the auth-service pattern:
 * pure functions over a Db handle, with an explicit allow-list mapper so
 * internal columns can never leak through the API. The wire shape lives in
 * @over18/shared (PublicCharacter) so web — and a future React Native app —
 * consume exactly what the API produces.
 */

/** Explicit allow-list — system_prompt and status stay internal. */
export function toPublicCharacter(row: CharacterRow): PublicCharacter {
  return {
    id: row.id,
    name: row.name,
    displayName: row.displayName,
    profileImage: row.profileImage,
    shortBio: row.shortBio,
    personality: row.personality,
    interests: row.interests,
    conversationStyle: row.conversationStyle,
  };
}

/** Active characters in a stable, deterministic order (by display name, then id). */
export async function listActiveCharacters(db: Db): Promise<PublicCharacter[]> {
  const rows = await db
    .select()
    .from(characters)
    .where(eq(characters.status, 'active'))
    .orderBy(asc(characters.displayName), asc(characters.id));
  return rows.map(toPublicCharacter);
}
