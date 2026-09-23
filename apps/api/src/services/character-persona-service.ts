import { readFile } from 'node:fs/promises';
import { eq } from 'drizzle-orm';
import type { CharacterPersona, ProposedCharacterProfile } from '@over18/shared';
import type { Db } from '../db/client.js';
import { characterPersonas, type CharacterPersonaRow } from '../db/schema.js';
import {
  containsMinorTerm,
  getActiveVisualIdentity,
  isAdultAgeBand,
} from './visual-identity-service.js';
import { listCanonicalReferences } from './visual-asset-service.js';
import { uploadedMimeTypeOf, uploadedPathOf } from './library-upload-service.js';
import type { PersonaGenerator } from './character-persona-generator.js';

/**
 * Persona validation + persistence (Phase 2 avatar-derived persona).
 *
 * Framework-agnostic pure functions over a Db handle, following the
 * character-/visual-identity-service pattern. Owns:
 *  - validation of a CharacterPersona payload (structural + adult-safety)
 *  - persistence of the CURRENT persona (generated fields + admin edits,
 *    already merged) and which fields an admin has explicitly written
 *  - regeneration orchestration: resolve the character's avatar, call the
 *    generator, merge the result in without touching admin-edited fields
 *
 * No vision/LLM concerns live here — those belong to
 * character-persona-generator.ts, injected as a PersonaGenerator function.
 */

export class CharacterPersonaValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CharacterPersonaValidationError';
  }
}

const MAX_SHORT_FIELD_CHARS = 200;
const MAX_LONG_FIELD_CHARS = 300;
const MAX_ARRAY_ITEMS = 6;
const MAX_ARRAY_ITEM_CHARS = 120;

/**
 * Strips control characters/newlines and collapses whitespace. Never throws.
 *
 * Built from character codes rather than a regex control-character class, so
 * there is no ambiguity about what gets matched: anything below U+0020
 * (space) or equal to U+007F (DEL) is dropped, everything else survives.
 */
function clean(value: string, maxChars: number): string {
  let out = '';
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    out += code < 0x20 || code === 0x7f ? ' ' : ch;
  }
  return out.replace(/\s+/g, ' ').trim().slice(0, maxChars);
}

function cleanStringArray(value: unknown, maxChars: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => clean(item, maxChars))
    .filter((item) => item.length > 0)
    .slice(0, MAX_ARRAY_ITEMS);
}

/** Optional-string fields, cleaned and capped at MAX_SHORT_FIELD_CHARS. */
const SHORT_STRING_FIELDS = [
  'ageRange',
  'lifeStage',
  'occupation',
  'education',
  'visualStyle',
  'socialStyle',
  'humorStyle',
  'flirtingStyle',
  'speechRegister',
  'relationshipToWorkOrSchool',
] as const satisfies ReadonlyArray<keyof CharacterPersona>;

/** Optional string-array fields, cleaned item-by-item. */
const ARRAY_FIELDS = [
  'demeanor',
  'interests',
  'hobbies',
  'dailyContext',
  'recurringConcerns',
  'backgroundNotes',
] as const satisfies ReadonlyArray<keyof CharacterPersona>;

/**
 * Validates and normalises a persona payload. UNKNOWN KEYS ARE NEVER READ —
 * this function only ever accesses the named CharacterPersona properties, so
 * a hallucinated or hand-edited key (e.g. a sensitive-trait field this
 * product never asks for) simply has no path into the returned object. This
 * is the primary guard described in the Phase 2 handoff's privacy section.
 *
 * Partial by design: every field is optional, so this validates whatever
 * subset is present — used both for a full generated persona and for a
 * partial admin edit.
 *
 * Throws CharacterPersonaValidationError on a structural or adult-safety
 * violation; a field that is simply the wrong type or empty is silently
 * dropped rather than failing the whole payload (same tolerance the existing
 * Autofill validator applies to `interests`).
 */
export function validateCharacterPersona(value: unknown): CharacterPersona {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CharacterPersonaValidationError('Persona must be a JSON object.');
  }
  const record = value as Record<string, unknown>;
  const out: CharacterPersona = {};

  if (record.age !== undefined) {
    const age = record.age;
    if (typeof age !== 'number' || !Number.isInteger(age)) {
      throw new CharacterPersonaValidationError('age must be an integer.');
    }
    if (age < 18) {
      throw new CharacterPersonaValidationError('age must denote an adult (18 or older).');
    }
    out.age = age;
  }

  for (const field of SHORT_STRING_FIELDS) {
    const raw = record[field];
    if (typeof raw !== 'string') continue;
    const cleaned = clean(raw, MAX_SHORT_FIELD_CHARS);
    if (cleaned.length === 0) continue;
    if (field === 'ageRange' && !isAdultAgeBand(cleaned)) {
      throw new CharacterPersonaValidationError(
        'ageRange must denote an adult; non-adult or ambiguous values are rejected.',
      );
    }
    if (field === 'lifeStage' && containsMinorTerm(cleaned)) {
      throw new CharacterPersonaValidationError(
        'lifeStage must not denote a minor.',
      );
    }
    (out as Record<string, unknown>)[field] = cleaned;
  }

  if (typeof record.sourceSummary === 'string') {
    const cleaned = clean(record.sourceSummary, MAX_LONG_FIELD_CHARS);
    if (cleaned.length > 0) out.sourceSummary = cleaned;
  }

  for (const field of ARRAY_FIELDS) {
    const cleaned = cleanStringArray(record[field], MAX_ARRAY_ITEM_CHARS);
    if (cleaned.length > 0) (out as Record<string, unknown>)[field] = cleaned;
  }

  return out;
}

function dedupeFields(existing: string[], added: string[]): string[] {
  return Array.from(new Set([...existing, ...added]));
}

/** The current persona row for a character, or null if none exists yet. */
export async function getCharacterPersona(
  db: Db,
  characterId: string,
): Promise<CharacterPersonaRow | null> {
  const [row] = await db
    .select()
    .from(characterPersonas)
    .where(eq(characterPersonas.characterId, characterId))
    .limit(1);
  return row ?? null;
}

/**
 * Admin edit path. `edits` is a PARTIAL persona — only the keys present are
 * validated, merged onto the current persona, and recorded in `editedFields`
 * so a later regeneration knows to leave them alone. Upserts: a character
 * with no persona row yet gets one, seeded from `edits` alone.
 */
export async function saveCharacterPersona(
  db: Db,
  characterId: string,
  edits: Record<string, unknown>,
): Promise<CharacterPersonaRow> {
  const validated = validateCharacterPersona(edits);
  const editedKeys = Object.keys(validated);

  const existing = await getCharacterPersona(db, characterId);
  const persona: CharacterPersona = { ...(existing?.persona ?? {}), ...validated };
  const editedFields = dedupeFields(existing?.editedFields ?? [], editedKeys);

  const [row] = await db
    .insert(characterPersonas)
    .values({ characterId, persona, editedFields })
    .onConflictDoUpdate({
      target: characterPersonas.characterId,
      set: { persona, editedFields, updatedAt: new Date() },
    })
    .returning();
  return row!;
}

/**
 * Releases a field back to autopilot — or all of them.
 *
 * WHY THIS HAS TO EXIST. Typing into a field records it in `editedFields`,
 * and regeneration then skips it forever. That is the right default when a
 * human has deliberately written something, but without a way back it is a
 * one-way door: the only escape was a DELETE against the database, and a
 * pinned field an operator no longer remembers pinning quietly stops
 * tracking her photo. On a roster meant to run mostly on autopilot, opting
 * out has to be as reversible as opting in.
 *
 * IT CLEARS THE PIN, NOT THE TEXT. The field keeps its current value until
 * the next generation replaces it, because the generated value it would
 * revert TO is not stored anywhere — persona holds the merged result, not
 * both sides. Blanking the text here would destroy the operator's words
 * immediately in exchange for nothing, so the honest behaviour is: stop
 * protecting it, and let the next run of the photo update it.
 *
 * Omit `field` to release everything. Unknown or already-unpinned fields are
 * a no-op rather than an error — the caller is asking for an end state, not
 * performing a transition.
 */
export async function releaseCharacterPersonaField(
  db: Db,
  characterId: string,
  field?: string,
): Promise<CharacterPersonaRow | null> {
  const existing = await getCharacterPersona(db, characterId);
  if (!existing) return null;

  const editedFields = field
    ? existing.editedFields.filter((f) => f !== field)
    : [];
  if (editedFields.length === existing.editedFields.length) return existing;

  const [row] = await db
    .update(characterPersonas)
    .set({ editedFields, updatedAt: new Date() })
    .where(eq(characterPersonas.characterId, characterId))
    .returning();
  return row ?? null;
}

export class CharacterPersonaRegenerationError extends Error {
  constructor(
    public readonly kind: 'no_source_image' | 'read_failed',
    message: string,
  ) {
    super(message);
    this.name = 'CharacterPersonaRegenerationError';
  }
}

/**
 * Re-runs the generator against the character's current canonical reference
 * image. The generator is given that image and her display name; nothing she
 * already has — profile, persona, or a previous generation — is part of the
 * request (see PersonaGeneratorInput).
 *
 * FAILURE NEVER TOUCHES THE DATABASE. If resolving the source image fails, or
 * the generator itself throws (PersonaGeneratorError), this rethrows
 * immediately without reading or writing the persona row — the existing
 * persona (if any) survives completely untouched. This is the entire
 * mechanism behind the handoff's "persona generation failure must not break
 * ordinary chat" / "never wipe the previous persona on a failed regeneration".
 *
 * On success, generated fields are merged onto the existing persona EXCEPT
 * any key already in `editedFields` — an admin's explicit edit always wins
 * over a fresh generation. `editedFields` itself is unchanged by
 * regeneration; only saveCharacterPersona ever adds to it.
 */
export async function regenerateCharacterPersona(
  db: Db,
  /**
   * HER NAME, AND NOTHING ELSE ABOUT HER.
   *
   * This parameter used to carry shortBio, personality and interests through
   * to the generator. It no longer can, and the narrowing is the safeguard:
   * the compiler now rejects any caller that tries to hand her stored profile
   * to a photo analysis. See PersonaGeneratorInput for why that turned out to
   * matter more than the consistency it was buying.
   *
   * A name is not profile text — it is the label on the thing being
   * described, and the model needs it only so the prose it writes is about
   * someone rather than "the woman in the image".
   */
  character: { displayName: string },
  characterId: string,
  generator: PersonaGenerator,
): Promise<{ row: CharacterPersonaRow; proposedProfile?: ProposedCharacterProfile }> {
  const identity = await getActiveVisualIdentity(db, characterId);
  if (!identity) {
    throw new CharacterPersonaRegenerationError(
      'no_source_image',
      'This character has no active visual identity, so there is no avatar to analyse.',
    );
  }
  const references = await listCanonicalReferences(db, characterId, identity.id);
  if (references.length === 0) {
    throw new CharacterPersonaRegenerationError(
      'no_source_image',
      'This character has no primary reference image, so there is no avatar to analyse.',
    );
  }

  /**
   * The first reference whose bytes are actually READABLE, not simply the
   * first one listed.
   *
   * WHY THIS WALKS THE LIST. A character's canonical set can legitimately mix
   * references that have real uploaded files with ones that do not — seeded
   * placeholder rows carry an external/absent locator, and they sort FIRST
   * because they hold explicit positions while a fresh upload's position is
   * null. Taking [0] and failing meant a character could have a perfectly
   * good uploaded avatar sitting at [1] and still be permanently
   * un-regenerable, which is how this was found.
   */
  let asset: (typeof references)[number] | undefined;
  let imageBytes: Buffer | undefined;
  for (const candidate of references) {
    const path = uploadedPathOf(candidate);
    if (!path) continue;
    try {
      imageBytes = await readFile(path);
      asset = candidate;
      break;
    } catch {
      // Row says there is a file, disk disagrees. Try the next one.
    }
  }
  if (!asset || !imageBytes) {
    throw new CharacterPersonaRegenerationError(
      'read_failed',
      'None of her primary reference images has a readable file on this server. ' +
        'Upload a reference image and try again.',
    );
  }

  // Throws PersonaGeneratorError straight through — the whole point of the
  // ordering above (resolve -> read -> THEN generate) is that neither of
  // those steps has written anything, so a generator failure leaves nothing
  // to undo.
  /**
   * THE WHOLE GENERATION REQUEST. Three values, all of them either the image
   * or the label on it. Her persona row is read AFTERWARDS, below, and only
   * to honour the operator's own pinned edits — never to inform the
   * generation itself.
   */
  const result = await generator({
    displayName: character.displayName,
    imageBytes,
    imageMimeType: uploadedMimeTypeOf(asset),
  });

  const existing = await getCharacterPersona(db, characterId);
  const editedFields = existing?.editedFields ?? [];

  /**
   * GENERATING REPLACES HER PERSONA; IT DOES NOT MERGE INTO IT.
   *
   * This used to start from the existing persona and overlay whatever the
   * model returned, which meant a field the model DID NOT mention this time
   * kept its previous text for ever. Regenerating against a new reference
   * photo therefore left fragments of the old one behind, invisibly, with no
   * way to tell which lines came from which image and no way to clear them.
   *
   * The new generation is now the whole persona. What survives it is the
   * operator's OWN edits, and only those: `editedFields` is re-applied on top
   * afterwards, which is the same promise the panel makes in as many words --
   * "anything you type in here is yours". Nothing else carries over.
   */
  const merged: CharacterPersona = { ...result.persona };
  for (const key of editedFields) {
    const kept = (existing?.persona as Record<string, unknown> | undefined)?.[key];
    if (kept !== undefined) (merged as Record<string, unknown>)[key] = kept;
  }

  const [row] = await db
    .insert(characterPersonas)
    .values({
      characterId,
      persona: merged,
      editedFields,
      sourceAssetId: asset.id,
      generatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: characterPersonas.characterId,
      set: {
        persona: merged,
        sourceAssetId: asset.id,
        generatedAt: new Date(),
        updatedAt: new Date(),
      },
    })
    .returning();
  /**
   * The persona is PERSISTED; the profile rewrite is only RETURNED.
   *
   * Autofill has never written to the database, so re-rolling it cannot
   * destroy an operator's work — and shortBio/personality/interests are
   * exactly the fields an operator hand-writes. Saving a photo-derived
   * rewrite of them here would make one button capable of replacing the
   * whole roster's identity with no undo. The caller shows it and a human
   * accepts it.
   */
  return { row: row!, proposedProfile: result.profile };
}
