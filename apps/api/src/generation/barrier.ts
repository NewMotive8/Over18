import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { characters } from '../db/schema.js';
import { getActiveVisualIdentity } from '../services/visual-identity-service.js';

/**
 * THE CHARACTER LIFECYCLE BARRIER (P0.7).
 *
 * One question, asked in one place: may this character receive generated
 * content right now? Generation is the only part of the system that creates
 * content on its own, minutes after an operator asked for it and without
 * anyone watching, so it is the part that most needs a gate it cannot forget.
 *
 * ── WHAT BLOCKS ──────────────────────────────────────────────────────────────
 *
 *   character_not_found   she does not exist (or no longer does). Her assets,
 *                         jobs and results cascade away with her, so anything
 *                         produced after that point is an orphan by definition.
 *   no_active_identity    no active visual identity version to bind the asset
 *                         to. This was already enforced at job creation; it is
 *                         named here so both ends ask the same question.
 *
 * ── WHAT DELIBERATELY DOES NOT BLOCK ─────────────────────────────────────────
 *
 * An INACTIVE character. The ordinary journey is create → upload → generate →
 * approve → merchandise → PUBLISH HER, so refusing to generate for an
 * unpublished character would forbid the normal way of preparing one. Her
 * publication state already gates every customer-facing read (P0.5), and a
 * generated asset lands pending review either way (P0.4) -- it cannot reach a
 * customer because it exists.
 *
 * ── WHERE DESTRUCTIVE LIFECYCLE WILL PLUG IN ─────────────────────────────────
 *
 * P9.4 owns permanent character deletion and retention. When it introduces a
 * state for "being deleted", this function is the one place that has to learn
 * it: every entry point already asks here, at submission AND at commit.
 *
 * ── WHY IT IS ASKED TWICE ────────────────────────────────────────────────────
 *
 * A provider call takes seconds to minutes. A character that passed the gate
 * when the job was created can be gone by the time bytes come back, and
 * committing then would either orphan a file or fail a foreign key inside a
 * catch-all that records it as an unknown provider error. Asking again at
 * commit turns that race into a clean, named refusal.
 */

export type GenerationBarrierReason = 'character_not_found' | 'no_active_identity';

export type GenerationBarrier =
  | { ok: true; characterId: string; identityId: string }
  | { ok: false; reason: GenerationBarrierReason; message: string };

const MESSAGES: Record<GenerationBarrierReason, string> = {
  character_not_found: 'character does not exist, so generated content would have no owner',
  no_active_identity: 'character has no active visual identity to attach the asset to',
};

export async function checkGenerationBarrier(
  db: Db,
  characterId: string,
): Promise<GenerationBarrier> {
  const [character] = await db
    .select({ id: characters.id })
    .from(characters)
    .where(eq(characters.id, characterId))
    .limit(1);
  if (!character) {
    return { ok: false, reason: 'character_not_found', message: MESSAGES.character_not_found };
  }

  const identity = await getActiveVisualIdentity(db, characterId);
  if (!identity) {
    return { ok: false, reason: 'no_active_identity', message: MESSAGES.no_active_identity };
  }

  return { ok: true, characterId, identityId: identity.id };
}
