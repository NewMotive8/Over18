import { and, asc, eq } from 'drizzle-orm';
import type { PublicCharacter } from '@over18/shared';
import type { Db } from '../db/client.js';
import { characters, type CharacterRow } from '../db/schema.js';
import { resolveCharacterPortrait, resolveCharacterPortraits } from './character-portrait.js';

/**
 * Framework-agnostic character service, following the auth-service pattern:
 * pure functions over a Db handle, with an explicit allow-list mapper so
 * internal columns can never leak through the API. The wire shape lives in
 * @over18/shared (PublicCharacter) so web — and a future React Native app —
 * consume exactly what the API produces.
 *
 * P0.2 — THE PORTRAIT IS NOT A COLUMN ON THIS TABLE. `profileImage` on the wire
 * is resolved from the canonical asset/identity model by `character-portrait`,
 * which is the only code that may consult the deprecated `profile_image`
 * column, and only as a fallback. Every function here that produces a
 * projection resolves through it, so there is no path by which a payload can be
 * built from the legacy column alone.
 */

/**
 * Explicit allow-list — system_prompt and status stay internal.
 *
 * The portrait is a REQUIRED ARGUMENT rather than a field read off the row: it
 * is not derivable from `characters` alone, and making the caller supply it is
 * what makes "somebody quietly reintroduced the legacy column" a compile error
 * rather than a silent regression.
 */
export function toPublicCharacter(row: CharacterRow, portrait: string | null): PublicCharacter {
  return {
    id: row.id,
    name: row.name,
    displayName: row.displayName,
    profileImage: portrait,
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
  // One query for the whole page, not one per character.
  const portraits = await resolveCharacterPortraits(db, rows);
  return rows.map((row) => toPublicCharacter(row, portraits.get(row.id)?.url ?? null));
}

/** A single active character by id, or null (unknown id and inactive both read as "not found"). */
export async function getActiveCharacterById(db: Db, id: string): Promise<PublicCharacter | null> {
  const row = await db.query.characters.findFirst({
    where: and(eq(characters.id, id), eq(characters.status, 'active')),
  });
  if (!row) return null;
  return toPublicCharacter(row, (await resolveCharacterPortrait(db, row)).url);
}

/* ------------------------------------------------------------------ *
 * US-101 — admin character management
 *
 * Writes live here rather than in a route so the validation rules have one
 * home. The ADMIN projection is a second, wider allow-list: an operator has to
 * see and edit system_prompt and status to create a usable character at all,
 * and every caller of it is admin-gated. toPublicCharacter is untouched, so
 * nothing internal can reach the public API by accident.
 * ------------------------------------------------------------------ */

export interface AdminCharacter extends PublicCharacter {
  systemPrompt: string;
  status: 'active' | 'inactive';
  createdAt: string;
  updatedAt: string;
  /** True once every profile field a character needs is filled in. */
  profileComplete: boolean;
  /** Which profile fields are still empty, so the UI can say so precisely. */
  missingProfileFields: ProfileField[];
}

/**
 * The profile fields an operator fills in after a character exists.
 *
 * These are exactly the US-03 character model's descriptive fields — no second
 * character model, and nothing invented. `name` and `displayName` are excluded
 * because they are set at creation time and are never empty.
 */
export const PROFILE_FIELDS = [
  'shortBio',
  'personality',
  'conversationStyle',
  'systemPrompt',
] as const;
export type ProfileField = (typeof PROFILE_FIELDS)[number];

/**
 * Which profile fields are still blank.
 *
 * A character can exist with an empty profile (created from just an image and
 * a name), so "incomplete" is a normal, reportable state rather than an error.
 * Emptiness is represented as '' rather than NULL: the columns stay NOT NULL,
 * so nothing downstream — toPublicCharacter, the prompt builder, chat — has to
 * learn about nulls, and there is no nullability migration to undo later.
 */
export function missingProfileFields(row: CharacterRow): ProfileField[] {
  return PROFILE_FIELDS.filter((field) => row[field].trim().length === 0);
}

export function toAdminCharacter(row: CharacterRow, portrait: string | null): AdminCharacter {
  const missing = missingProfileFields(row);
  return {
    ...toPublicCharacter(row, portrait),
    systemPrompt: row.systemPrompt,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    profileComplete: missing.length === 0,
    missingProfileFields: missing,
  };
}

export class CharacterValidationError extends Error {
  constructor(
    public readonly field: string,
    message: string,
  ) {
    super(message);
    this.name = 'CharacterValidationError';
  }
}

/** Thrown when the unique `name` slug is already taken. */
export class CharacterNameTakenError extends Error {
  constructor(name: string) {
    super(`A character with the name "${name}" already exists.`);
    this.name = 'CharacterNameTakenError';
  }
}

/**
 * The stable slug. Lowercase, url-safe, and unique — it is what the media
 * manifest and the seed data key off, so it must not contain surprises.
 */
const NAME_RE = /^[a-z0-9][a-z0-9-]{1,49}$/;

/**
 * Exactly the columns the existing schema already has. No new character
 * attributes are invented here: every field below is a column on `characters`.
 *
 * P0.2 — `profileImage` IS DELIBERATELY ABSENT. It used to be accepted here, so
 * `POST /admin/characters` and `PATCH /admin/characters/:id` could establish the
 * legacy column as a character's authoritative portrait, in parallel with — and
 * capable of contradicting — her identity references. A portrait is now changed
 * the one way the P0 model defines: upload or re-order the canonical references
 * of her active identity version. A request body that still carries the field is
 * ignored rather than rejected, so an older admin client keeps working; it
 * simply no longer decides anything.
 */
export interface CharacterInput {
  name: string;
  displayName: string;
  shortBio: string;
  personality: string;
  conversationStyle: string;
  systemPrompt: string;
  interests?: string[];
  status?: 'active' | 'inactive';
}

const REQUIRED_TEXT: ReadonlyArray<[keyof CharacterInput, string]> = [
  ['displayName', 'Display name'],
  ['shortBio', 'Short bio'],
  ['personality', 'Personality'],
  ['conversationStyle', 'Conversation style'],
  ['systemPrompt', 'System prompt'],
];

/**
 * Trims, validates and normalises. Shared by create and update.
 *
 * `allowEmptyProfile` exists for the draft-creation path: a character created
 * from just an image and a name legitimately has an empty profile. It never
 * relaxes `name` or `displayName`, which identify the character.
 */
function normalise(
  input: Partial<CharacterInput>,
  requireAll: boolean,
  allowEmptyProfile = false,
) {
  const out: Record<string, unknown> = {};

  if (input.name !== undefined) {
    const name = input.name.trim().toLowerCase();
    if (!NAME_RE.test(name)) {
      throw new CharacterValidationError(
        'name',
        'Name must be 2-50 characters, lowercase letters, numbers or hyphens, and start with a letter or number.',
      );
    }
    out.name = name;
  } else if (requireAll) {
    throw new CharacterValidationError('name', 'Name is required.');
  }

  for (const [field, label] of REQUIRED_TEXT) {
    const value = input[field];
    const optionalHere =
      allowEmptyProfile && (PROFILE_FIELDS as readonly string[]).includes(field as string);
    if (value !== undefined) {
      const trimmed = String(value).trim();
      if (trimmed.length === 0 && !optionalHere) {
        throw new CharacterValidationError(field as string, `${label} cannot be empty.`);
      }
      out[field] = trimmed;
    } else if (requireAll && !optionalHere) {
      throw new CharacterValidationError(field as string, `${label} is required.`);
    }
  }

  if (input.interests !== undefined) {
    out.interests = input.interests.map((i) => i.trim()).filter((i) => i.length > 0);
  }
  if (input.status !== undefined) out.status = input.status;

  return out;
}

/** Every character, newest first — admin needs drafts and inactive ones too. */
export async function listAllCharacters(db: Db): Promise<AdminCharacter[]> {
  const rows = await db
    .select()
    .from(characters)
    .orderBy(asc(characters.displayName), asc(characters.id));
  const portraits = await resolveCharacterPortraits(db, rows);
  return rows.map((row) => toAdminCharacter(row, portraits.get(row.id)?.url ?? null));
}

/** Any character by id regardless of status. Null when unknown. */
export async function getCharacterForAdmin(db: Db, id: string): Promise<AdminCharacter | null> {
  const row = await db.query.characters.findFirst({ where: eq(characters.id, id) });
  if (!row) return null;
  return toAdminCharacter(row, (await resolveCharacterPortrait(db, row)).url);
}

/**
 * Postgres unique-violation detection, walking the cause chain: Drizzle wraps
 * driver errors in DrizzleQueryError, so the `23505` lives on `error.cause`,
 * not on the error handed to us. Checking only the top level silently turns a
 * duplicate name into a 500 — which is exactly what the test caught.
 */
function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth++) {
    if (typeof current === 'object' && 'code' in current && (current as { code?: unknown }).code === '23505') {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Creates a character from the minimum an operator can supply: a name.
 *
 * The descriptive profile starts EMPTY and is filled in afterwards, by hand or
 * by Autofill. That is the point — a character exists as soon as there is an
 * image and a name, so the operator can get media in front of themselves
 * without first writing five paragraphs of persona.
 *
 * Empty means '', not NULL. The columns stay NOT NULL, so this adds no
 * nullability for the chat path or the prompt builder to handle, and there is
 * no migration to reverse when the profile is completed.
 *
 * Created INACTIVE. A character with no persona would otherwise appear to real
 * users the instant she is created, with an empty bio and a system prompt that
 * says nothing — the public list filters on status='active', so starting
 * inactive is what makes "create first, write later" safe to do in production.
 */
export async function createCharacterDraft(
  db: Db,
  input: { name: string; displayName?: string },
): Promise<AdminCharacter> {
  const displayName = (input.displayName ?? input.name).trim();
  if (displayName.length === 0) {
    throw new CharacterValidationError('displayName', 'Display name is required.');
  }
  return createCharacter(db, {
    name: input.name,
    displayName,
    shortBio: '',
    personality: '',
    conversationStyle: '',
    systemPrompt: '',
    status: 'inactive',
  }, { allowEmptyProfile: true });
}

export async function createCharacter(
  db: Db,
  input: CharacterInput,
  options: { allowEmptyProfile?: boolean } = {},
): Promise<AdminCharacter> {
  const values = normalise(input, true, options.allowEmptyProfile);
  try {
    const [row] = await db
      .insert(characters)
      .values(values as typeof characters.$inferInsert)
      .returning();
    // A character created this instant has no identity version and no
    // references, so her portrait is legitimately null. It becomes real the
    // moment her first primary reference is uploaded — which is the only way it
    // can now be set.
    return toAdminCharacter(row!, (await resolveCharacterPortrait(db, row!)).url);
  } catch (error) {
    // The DB unique index is the real guard; catching it here turns a 500 into
    // a clear 409 without a check-then-insert race.
    if (isUniqueViolation(error)) throw new CharacterNameTakenError(String(values.name));
    throw error;
  }
}

/** Partial update. Null when the character does not exist. */
export async function updateCharacter(
  db: Db,
  id: string,
  input: Partial<CharacterInput>,
): Promise<AdminCharacter | null> {
  const values = normalise(input, false);
  if (Object.keys(values).length === 0) return getCharacterForAdmin(db, id);

  try {
    const [row] = await db
      .update(characters)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(characters.id, id))
      .returning();
    if (!row) return null;
    return toAdminCharacter(row, (await resolveCharacterPortrait(db, row)).url);
  } catch (error) {
    if (isUniqueViolation(error)) throw new CharacterNameTakenError(String(values.name));
    throw error;
  }
}
