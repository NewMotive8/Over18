import type { AdminCharacterContentAccess, AdminClipAccess, ContentAccessState } from '@over18/shared';
import type { Db } from '../db/client.js';
import { recordAudit, type AuditActor } from './audit-service.js';
import { getCharacterForAdmin } from './character-service.js';
import {
  describeAssetCommercial,
  readClipAllocation,
  removeClipAllocation,
  retireContentOffer,
  setClipAllocation,
  setContentOffer,
  liveOfferFor,
} from './commercial-boundary.js';
import { listCharacterContent } from './content-review-service.js';

/**
 * ADMIN CONTENT ACCESS (P4.D2): which of a character's clips are Free, and
 * which are Premium.
 *
 * IT ADDS NO CONTENT MANAGEMENT. Clips are uploaded, approved and released
 * exactly as before; this only says what each one costs to see. The clips it
 * works on are the ones the character's existing admin content shelf lists, so
 * there is no second idea of "her clips" anywhere.
 *
 * IT OWNS NO ACCESS RULE EITHER. A clip's state is an offer (P4.1), written
 * through the commercial boundary; a character's Premium-by-default is her
 * allocation row, read by the same module. This service chooses which clips to
 * make Free, and records what it did.
 *
 * THE TWO OPERATOR ACTIONS, from the P4.D2 decision:
 *   mark        one clip Free or Premium;
 *   allocate    "N of her clips should be Free" -- the system picks N at
 *               random, and every other clip becomes Premium.
 * Both write offers for the clips she has NOW. A clip uploaded afterwards
 * needs no write at all: her allocation already makes it Premium.
 *
 * Nothing is charged, unlocked or granted here, and -- like every commercial
 * write -- nothing at all happens while the economy is off.
 */

export class AdminContentAccessError extends Error {
  constructor(
    public readonly code: 'invalid_request' | 'character_not_found' | 'asset_not_found',
    message: string,
  ) {
    super(message);
    this.name = 'AdminContentAccessError';
  }
}

/** What an allocation is recorded against: one character's content access. */
export const CONTENT_ACCESS_AUDIT_OBJECT_TYPE = 'content_access';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The states an operator may set on one clip here. Credit pricing is a separate decision (P4.1). */
const CLIP_STATES: readonly ContentAccessState[] = ['free', 'premium'];

function invalid(message: string): never {
  throw new AdminContentAccessError('invalid_request', message);
}

async function requireCharacter(db: Db, characterId: string): Promise<string> {
  if (typeof characterId !== 'string' || !UUID.test(characterId)) invalid('The character id must be a character id.');
  const character = await getCharacterForAdmin(db, characterId);
  if (!character) throw new AdminContentAccessError('character_not_found', 'Character not found.');
  return characterId;
}

/** Her clips: the content assets her own admin shelf lists, in the order it lists them. */
async function clipsOf(db: Db, characterId: string) {
  const { assets } = await listCharacterContent(db, characterId);
  return assets.filter((asset) => asset.role === 'content');
}

/** One character's clips with the access each one has now, and the allocation behind it. */
export async function readCharacterContentAccess(
  db: Db,
  characterId: string,
  options: { economyEnabled: boolean },
): Promise<AdminCharacterContentAccess> {
  const id = await requireCharacter(db, characterId);
  const [clips, allocation] = await Promise.all([clipsOf(db, id), readClipAllocation(db, id)]);
  const terms = await describeAssetCommercial(db, clips.map((clip) => clip.assetId));

  const items: AdminClipAccess[] = clips.map((clip) => {
    const view = terms.get(clip.assetId)!;
    return {
      assetId: clip.assetId,
      mediaType: clip.mediaType,
      workflow: clip.workflow,
      live: clip.distribution.liveAnywhere,
      state: view.state,
      /** True while nothing was written for this clip: it reads its character's default. */
      byDefault: view.implicit,
      creditPrice: view.creditPrice,
      ageFloor: view.ageFloor,
    };
  });

  return {
    characterId: id,
    economyEnabled: options.economyEnabled,
    allocation: { configured: allocation !== null, freeClipCount: allocation?.freeClipCount ?? null },
    clips: items,
    counts: {
      clips: items.length,
      free: items.filter((clip) => clip.state === 'free').length,
      premium: items.filter((clip) => clip.state === 'premium').length,
    },
  };
}

interface ActorContext {
  actor: AuditActor & { userId: string };
  requestId: string | null;
}

/** Marks ONE clip Free or Premium, whatever her allocation says. */
export async function setClipAccess(
  db: Db,
  commerce: { enabled: boolean },
  input: { characterId: string; assetId: string; state: unknown; reason: unknown },
  ctx: ActorContext,
): Promise<AdminCharacterContentAccess> {
  const id = await requireCharacter(db, input.characterId);
  if (!CLIP_STATES.includes(input.state as ContentAccessState)) invalid(`state must be one of: ${CLIP_STATES.join(', ')}.`);
  const state = input.state as ContentAccessState;
  const reason = requireReason(input.reason);
  const clips = await clipsOf(db, id);
  const clip = clips.find((candidate) => candidate.assetId === input.assetId);
  if (!clip) throw new AdminContentAccessError('asset_not_found', 'That clip is not one of this character\'s clips.');

  const before = (await describeAssetCommercial(db, [clip.assetId])).get(clip.assetId)!;
  await db.transaction(async (tx) => {
    await setContentOffer(tx, commerce, { assetId: clip.assetId, state });
    await recordAudit(tx, {
      actor: ctx.actor,
      action: `content.access.${state}`,
      objectType: CONTENT_ACCESS_AUDIT_OBJECT_TYPE,
      objectId: clip.assetId,
      before: { state: before.state, byDefault: before.implicit },
      after: { state, byDefault: false },
      reason,
      requestId: ctx.requestId,
      metadata: { characterId: id, source: 'admin' },
    });
  });
  return readCharacterContentAccess(db, id, { economyEnabled: commerce.enabled });
}

/**
 * "N of her clips should be Free."
 *
 * Opts her in (so everything she has, and everything she gets later, is
 * Premium by default), picks N of her current clips at random, and writes them
 * Free -- every other clip of hers Premium. Applying it again re-picks.
 */
export async function allocateFreeClips(
  db: Db,
  commerce: { enabled: boolean },
  input: { characterId: string; freeClipCount: unknown; reason: unknown },
  ctx: ActorContext,
): Promise<AdminCharacterContentAccess> {
  const id = await requireCharacter(db, input.characterId);
  if (typeof input.freeClipCount !== 'number' || !Number.isSafeInteger(input.freeClipCount) || input.freeClipCount < 0) {
    invalid('freeClipCount must be a whole number of clips, 0 or more.');
  }
  const freeClipCount = input.freeClipCount;
  const reason = requireReason(input.reason);
  const clips = await clipsOf(db, id);
  const chosen = new Set(pickAtRandom(clips.map((clip) => clip.assetId), freeClipCount));

  await db.transaction(async (tx) => {
    await setClipAllocation(tx, commerce, { characterId: id, freeClipCount, actorUserId: ctx.actor.userId });
    for (const clip of clips) {
      await setContentOffer(tx, commerce, { assetId: clip.assetId, state: chosen.has(clip.assetId) ? 'free' : 'premium' });
    }
    await recordAudit(tx, {
      actor: ctx.actor,
      action: 'content.access.allocate',
      objectType: CONTENT_ACCESS_AUDIT_OBJECT_TYPE,
      objectId: id,
      before: null,
      after: { freeClipCount, free: [...chosen], clips: clips.length },
      reason,
      requestId: ctx.requestId,
      metadata: { characterId: id, source: 'admin', premium: clips.length - chosen.size },
    });
  });
  return readCharacterContentAccess(db, id, { economyEnabled: commerce.enabled });
}

/**
 * Takes her back out of Free/Premium: the allocation goes, and every offer
 * written for her clips is retired, so they read exactly as they did before --
 * Free. Retired offers stay as the record of what was.
 */
export async function clearContentAccess(
  db: Db,
  commerce: { enabled: boolean },
  input: { characterId: string; reason: unknown },
  ctx: ActorContext,
): Promise<AdminCharacterContentAccess> {
  const id = await requireCharacter(db, input.characterId);
  const reason = requireReason(input.reason);
  const clips = await clipsOf(db, id);

  await db.transaction(async (tx) => {
    const removed = await removeClipAllocation(tx, commerce, id);
    let retired = 0;
    for (const clip of clips) {
      const offer = await liveOfferFor(tx, clip.assetId);
      if (offer && (await retireContentOffer(tx, commerce, offer.id))) retired += 1;
    }
    await recordAudit(tx, {
      actor: ctx.actor,
      action: 'content.access.clear',
      objectType: CONTENT_ACCESS_AUDIT_OBJECT_TYPE,
      objectId: id,
      before: { allocated: removed },
      after: { allocated: false, retiredOffers: retired },
      reason,
      requestId: ctx.requestId,
      metadata: { characterId: id, source: 'admin' },
    });
  });
  return readCharacterContentAccess(db, id, { economyEnabled: commerce.enabled });
}

function requireReason(reason: unknown): string {
  if (typeof reason !== 'string' || reason.trim() === '') invalid('A reason is required.');
  const trimmed = reason.trim();
  if (trimmed.length > 500) invalid('The reason must be at most 500 characters.');
  return trimmed;
}

/** `count` of these, chosen without bias (Fisher-Yates, as far as it needs to go). */
function pickAtRandom(ids: readonly string[], count: number): string[] {
  const pool = [...ids];
  const take = Math.min(count, pool.length);
  for (let i = 0; i < take; i++) {
    const j = i + Math.floor(Math.random() * (pool.length - i));
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }
  return pool.slice(0, take);
}
