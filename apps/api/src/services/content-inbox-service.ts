import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { and, asc, eq, isNotNull } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { contentInbox, type ContentInboxRow } from '../db/schema.js';
import {
  acceptedExtensionOf,
  acceptedMediaTypeOf,
  uploadLibraryAsset,
  ACCEPTED_MIME_TYPES,
  type LibraryUploadStorage,
} from './library-upload-service.js';
import type { CharacterVisualAssetRow } from '../db/schema.js';
import type { ContentRating } from './visual-asset-service.js';
import type { MediaType } from './content-review-service.js';

/**
 * The unassigned inbox — uploading without knowing the character yet.
 *
 * WHY A SEPARATE TABLE. character_visual_assets.character_id and
 * visual_identity_id are NOT NULL, and making them nullable to hold unassigned
 * files would change the meaning of every character-scoped query in the
 * codebase — including the chat media selector and the public gallery — and
 * would make "an unassigned upload cannot appear under a character" depend on
 * every future query remembering to exclude nulls. Here it depends on the
 * schema: this table has no character column at all, so no character-scoped
 * query can reach it.
 *
 * ASSIGNMENT IS A CREATE, NOT A MOVE. Assigning produces a real visual asset in
 * `under_review` — Review is never bypassed — and records its id on the inbox
 * row, so the intake stays auditable after the fact.
 */

export type InboxStatus = 'unassigned' | 'assigned' | 'discarded';

export class ContentInboxError extends Error {
  constructor(
    public readonly kind:
      | 'unsupported_type'
      | 'empty_file'
      | 'not_found'
      | 'already_resolved'
      | 'file_missing',
    message: string,
  ) {
    super(message);
    this.name = 'ContentInboxError';
  }
}

export interface InboxStorage {
  /** MEDIA_STORAGE_DIR. Inbox files live in an `inbox/` subdirectory of it. */
  storageDir: string;
}

function inboxDir(storage: InboxStorage): string {
  return join(storage.storageDir, 'inbox');
}

/** True only when `candidate` sits inside `root` — no traversal, no siblings. */
function isInside(root: string, candidate: string): boolean {
  const r = resolve(root);
  const c = resolve(candidate);
  return c === r || c.startsWith(r.endsWith(sep) ? r : r + sep);
}

/**
 * The file backing an inbox row, but ONLY when it is inside the inbox
 * directory. A hand-edited storage_path can therefore never make the serving
 * route read, or the discard path delete, an arbitrary file.
 */
export function inboxPathOf(storage: InboxStorage, row: ContentInboxRow): string | null {
  const path = row.storagePath;
  if (!path) return null;
  return isInside(inboxDir(storage), path) ? path : null;
}

export interface CreateInboxItemInput {
  mimeType: string;
  bytes: Buffer;
  originalName?: string;
  uploadedBy?: string;
}

/**
 * Records one uploaded file with no character.
 *
 * Same ordering discipline as the library upload: the row exists before the
 * bytes are written, and storage_path is set only once the file is safely on
 * disk. An interrupted upload leaves a pathless row the inbox skips, never a
 * row pointing at a file that is not there.
 */
export async function createInboxItem(
  db: Db,
  storage: InboxStorage,
  input: CreateInboxItemInput,
): Promise<ContentInboxRow> {
  const mediaType = acceptedMediaTypeOf(input.mimeType);
  const ext = acceptedExtensionOf(input.mimeType);
  if (!mediaType || !ext) {
    throw new ContentInboxError(
      'unsupported_type',
      `Unsupported file type "${input.mimeType}". Accepted: ${ACCEPTED_MIME_TYPES.join(', ')}.`,
    );
  }
  if (input.bytes.length === 0) {
    throw new ContentInboxError('empty_file', 'The selected file is empty.');
  }

  const [created] = await db
    .insert(contentInbox)
    .values({
      status: 'unassigned',
      mimeType: input.mimeType,
      mediaType,
      byteSize: input.bytes.length,
      originalName: input.originalName ?? null,
      uploadedBy: input.uploadedBy ?? null,
    })
    .returning();

  const storagePath = join(inboxDir(storage), `${created!.id}.${ext}`);
  try {
    await mkdir(dirname(storagePath), { recursive: true });
    await writeFile(storagePath, input.bytes);

    const [stored] = await db
      .update(contentInbox)
      .set({ storagePath, updatedAt: new Date() })
      .where(eq(contentInbox.id, created!.id))
      .returning();
    return stored!;
  } catch (error) {
    // Roll the intake back rather than leaving a half-made item: a row with no
    // bytes can never be assigned, and bytes with no row can never be reclaimed.
    await rm(storagePath, { force: true }).catch(() => undefined);
    await db.delete(contentInbox).where(eq(contentInbox.id, created!.id)).catch(() => undefined);
    throw error;
  }
}

/** The queue, oldest first — intake is worked in arrival order. */
export async function listInbox(
  db: Db,
  filter: { status?: InboxStatus } = {},
): Promise<ContentInboxRow[]> {
  return db
    .select()
    .from(contentInbox)
    // A row whose bytes never landed is not offerable work: it could never be
    // assigned, so showing it would only ever waste an operator's time.
    .where(
      and(
        eq(contentInbox.status, filter.status ?? 'unassigned'),
        isNotNull(contentInbox.storagePath),
      ),
    )
    .orderBy(asc(contentInbox.createdAt), asc(contentInbox.id));
}

export async function getInboxItem(db: Db, id: string): Promise<ContentInboxRow | null> {
  const [row] = await db.select().from(contentInbox).where(eq(contentInbox.id, id));
  return row ?? null;
}

export interface AssignInboxItemInput {
  inboxId: string;
  characterId: string;
  requirementKey?: string | null;
  contentRating?: ContentRating;
  assignedBy?: string;
}

/**
 * Assigns an inbox item to a character and (optionally) a requirement.
 *
 * Ordering is chosen so a failure can never orphan a file or half-assign an
 * item: the asset row and its bytes are created first (through the SAME upload
 * service every other upload uses), the inbox row is marked assigned second,
 * and the inbox file is removed last. If anything throws, the inbox item is
 * still `unassigned` and still has its file — the operator simply retries. The
 * worst case is one duplicated file, never a row pointing at nothing.
 *
 * The new asset is `under_review`: assignment is intake, not approval.
 */
export async function assignInboxItem(
  db: Db,
  storage: InboxStorage & LibraryUploadStorage,
  input: AssignInboxItemInput,
): Promise<{ item: ContentInboxRow; asset: CharacterVisualAssetRow }> {
  const existing = await getInboxItem(db, input.inboxId);
  if (!existing) throw new ContentInboxError('not_found', 'That upload is no longer in the inbox.');
  // Reported before the file check, so an already-resolved item says so rather
  // than complaining that its bytes are gone — which they legitimately are,
  // because assignment moved them under the character.
  if (existing.status !== 'unassigned') {
    throw new ContentInboxError('already_resolved', `That upload was already ${existing.status}.`);
  }

  const path = inboxPathOf(storage, existing);
  if (!path || !(await stat(path).then(() => true, () => false))) {
    throw new ContentInboxError(
      'file_missing',
      'The uploaded file is no longer on disk (storage may not be persistent).',
    );
  }

  /**
   * CLAIM the row before doing any work, with the previous status in the WHERE
   * clause. A plain read-then-write would let two concurrent assignments — a
   * double-click, a retry after a slow response, two operators — both pass the
   * guard and create two assets from one file. Here the second update matches
   * no row, so exactly one caller proceeds. It also blocks the reverse race,
   * where a discard lands between the check and the write and is silently
   * undone.
   */
  const [item] = await db
    .update(contentInbox)
    .set({
      status: 'assigned',
      assignedBy: input.assignedBy ?? null,
      assignedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(contentInbox.id, input.inboxId), eq(contentInbox.status, 'unassigned')))
    .returning();
  if (!item) {
    const current = await getInboxItem(db, input.inboxId);
    throw new ContentInboxError(
      'already_resolved',
      `That upload was already ${current?.status ?? 'resolved'}.`,
    );
  }

  let asset;
  try {
    const bytes = await readFile(path);
    asset = await uploadLibraryAsset(db, storage, {
      characterId: input.characterId,
      kind: 'generated',
      // Intake, not approval — the operator decides in Review.
      approve: false,
      requirementKey: input.requirementKey ?? null,
      contentRating: input.contentRating,
      mimeType: item.mimeType,
      bytes,
      originalName: item.originalName ?? undefined,
      uploadedBy: input.assignedBy,
    });
  } catch (error) {
    // Release the claim so the item stays in the queue and can be retried —
    // the file is still exactly where it was.
    await db
      .update(contentInbox)
      .set({ status: 'unassigned', assignedBy: null, assignedAt: null, updatedAt: new Date() })
      .where(eq(contentInbox.id, item.id))
      .catch(() => undefined);
    throw error;
  }

  const [updated] = await db
    .update(contentInbox)
    .set({ assignedAssetId: asset.id, updatedAt: new Date() })
    .where(eq(contentInbox.id, item.id))
    .returning();

  // The bytes now live under the character; the intake copy is redundant. A
  // failure here is harmless (the row is already assigned, so it leaves the
  // queue) and must not fail the assignment.
  await rm(path, { force: true }).catch(() => undefined);

  return { item: updated!, asset };
}

/**
 * Discards an unassigned upload. The row survives as a record of the intake —
 * only the bytes go, and only when they are inside the inbox directory.
 */
export async function discardInboxItem(
  db: Db,
  storage: InboxStorage,
  id: string,
): Promise<ContentInboxRow> {
  const item = await getInboxItem(db, id);
  if (!item) throw new ContentInboxError('not_found', 'That upload is no longer in the inbox.');
  if (item.status === 'assigned') {
    throw new ContentInboxError(
      'already_resolved',
      'That upload was already assigned to a character. Reject it in Review instead.',
    );
  }

  // Only clear the path once the bytes are actually gone. Swallowing a failed
  // unlink and nulling storage_path anyway would leave a file on disk that
  // nothing points at, while reporting success — the same mistake
  // deleteLibraryAsset deliberately avoids.
  const path = inboxPathOf(storage, item);
  let removed = true;
  if (path) {
    removed = await rm(path, { force: true }).then(
      () => true,
      () => false,
    );
  }

  const [updated] = await db
    .update(contentInbox)
    .set({
      status: 'discarded',
      ...(removed ? { storagePath: null } : {}),
      updatedAt: new Date(),
    })
    .where(eq(contentInbox.id, id))
    .returning();
  return updated!;
}

/** Wire-safe view. storage_path never leaves the server. */
export function inboxView(row: ContentInboxRow) {
  return {
    inboxId: row.id,
    status: row.status as InboxStatus,
    mediaType: row.mediaType as MediaType,
    originalName: row.originalName,
    byteSize: row.byteSize,
    fileUrl: row.storagePath ? `/admin/content/inbox/${row.id}/file` : null,
    assignedAssetId: row.assignedAssetId,
    createdAt: row.createdAt.toISOString(),
  };
}
