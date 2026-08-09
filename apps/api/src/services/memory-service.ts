import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { memories } from '../db/schema.js';

/**
 * Memory storage service (US-12 — Basic User Memory).
 *
 * Plain PostgreSQL rows, deliberately simple: no RAG, no embeddings, no
 * semantic search. Facts are short plain-text sentences scoped strictly to
 * (user_id, character_id) — what a user tells one character never reaches
 * another. Content is internal prompt material and is never exposed through
 * the public API (same rule as characters.system_prompt).
 */

/**
 * Minimal connection contract: satisfied by both the pooled Db and a
 * transaction handle, so memory reads can run inside sendMessage's
 * transaction while writes run on the pool after commit.
 */
export type MemoryDb = Pick<Db, 'select' | 'insert' | 'delete'>;

/** Hard cap on a single stored fact; longer "facts" are noise, not memory. */
export const MEMORY_MAX_CONTENT_LENGTH = 300;

/** Default per-(user, character) storage cap; oldest facts evicted beyond it. */
export const DEFAULT_MEMORY_MAX_STORED = 100;

/**
 * Canonical form of a fact: whitespace collapsed, trimmed. Returns null for
 * empty or over-length content so callers can simply filter. Normalization
 * is what makes the (user, character, content) unique index an effective
 * dedup guarantee.
 */
export function normalizeFact(fact: string): string | null {
  const normalized = fact.replace(/\s+/g, ' ').trim();
  if (normalized.length === 0 || normalized.length > MEMORY_MAX_CONTENT_LENGTH) return null;
  return normalized;
}

/**
 * Stores extracted facts for a (user, character) pair.
 *
 * - Normalizes and de-duplicates within the batch.
 * - Database-level dedup via ON CONFLICT DO NOTHING on the unique index —
 *   re-extracting a known fact is a silent no-op.
 * - Enforces the storage cap by evicting the OLDEST facts beyond maxStored.
 *
 * Returns the number of newly inserted rows.
 */
export async function storeMemories(
  db: MemoryDb,
  userId: string,
  characterId: string,
  facts: string[],
  maxStored: number = DEFAULT_MEMORY_MAX_STORED,
): Promise<number> {
  const normalized = [...new Set(facts.map(normalizeFact).filter((f): f is string => f !== null))];
  if (normalized.length === 0) return 0;

  const inserted = await db
    .insert(memories)
    .values(normalized.map((content) => ({ userId, characterId, content })))
    .onConflictDoNothing({
      target: [memories.userId, memories.characterId, memories.content],
    })
    .returning({ id: memories.id });

  if (inserted.length > 0) {
    // Evict oldest rows beyond the cap (stable order: created_at, then id).
    const rows = await db
      .select({ id: memories.id })
      .from(memories)
      .where(and(eq(memories.userId, userId), eq(memories.characterId, characterId)))
      .orderBy(asc(memories.createdAt), asc(memories.id));
    if (rows.length > maxStored) {
      const evict = rows.slice(0, rows.length - maxStored).map((r) => r.id);
      await db.delete(memories).where(inArray(memories.id, evict));
    }
  }

  return inserted.length;
}

/**
 * All remembered facts for a (user, character) pair, oldest first.
 * Chronological order keeps downstream selection (selectMemoriesForPrompt,
 * which prefers the newest under its budgets) deterministic.
 */
export async function listMemories(
  db: MemoryDb,
  userId: string,
  characterId: string,
): Promise<string[]> {
  const rows = await db
    .select({ content: memories.content })
    .from(memories)
    .where(and(eq(memories.userId, userId), eq(memories.characterId, characterId)))
    .orderBy(asc(memories.createdAt), asc(memories.id));
  return rows.map((r) => r.content);
}
