import { and, desc, eq, lt, type SQL } from 'drizzle-orm';
import type { AuditEntryView } from '@over18/shared';
import type { Db } from '../db/client.js';
import { auditLog, type AuditLogRow } from '../db/schema.js';

/**
 * The audit log (PRD v1.2 §34.2): who changed what, from what to what, when,
 * and -- for anything affecting money or access -- why.
 *
 * APPEND-ONLY. This module exports a way to write an entry and ways to read
 * them. There is no update and no delete here, and the database refuses both
 * regardless (migration 0026), so the property does not depend on every future
 * caller remembering it.
 *
 * WRITE INSIDE THE CHANGE'S TRANSACTION. `recordAudit` accepts a transaction so
 * a service can commit the change and its audit row together: a change with no
 * record, or a record of a change that rolled back, are both impossible when
 * the caller passes its `tx`.
 */

export interface AuditActor {
  userId: string | null;
  email: string | null;
}

export interface AuditEntryInput {
  actor: AuditActor;
  action: string;
  objectType: string;
  objectId?: string | null;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
  requestId?: string | null;
  metadata?: Record<string, unknown>;
}

export async function recordAudit(
  db: Pick<Db, 'insert'>,
  entry: AuditEntryInput,
): Promise<void> {
  await db.insert(auditLog).values({
    actorUserId: entry.actor.userId,
    actorEmail: entry.actor.email,
    action: entry.action,
    objectType: entry.objectType,
    objectId: entry.objectId ?? null,
    // `undefined` would be dropped by the driver and read back as null anyway;
    // being explicit keeps "unknown" and "known to be empty" distinct.
    before: entry.before === undefined ? null : entry.before,
    after: entry.after === undefined ? null : entry.after,
    reason: entry.reason ?? null,
    requestId: entry.requestId ?? null,
    metadata: entry.metadata ?? {},
  });
}

export const AUDIT_PAGE_MAX = 200;
export const AUDIT_EXPORT_MAX = 5_000;

export interface AuditQuery {
  limit?: number;
  /** Return entries strictly older than this id -- the page cursor. */
  before?: number;
  objectType?: string;
  actorUserId?: string;
}

function toView(row: AuditLogRow): AuditEntryView {
  return {
    id: row.id,
    occurredAt: row.occurredAt.toISOString(),
    actorUserId: row.actorUserId,
    actorEmail: row.actorEmail,
    action: row.action,
    objectType: row.objectType,
    objectId: row.objectId,
    before: row.before ?? null,
    after: row.after ?? null,
    reason: row.reason,
    requestId: row.requestId,
    metadata: row.metadata,
  };
}

/**
 * Newest first, paged by id. Ids are a bigserial, so they order exactly as the
 * rows were written and a cursor can never skip or repeat an entry.
 */
export async function listAuditEntries(
  db: Db,
  query: AuditQuery,
  max = AUDIT_PAGE_MAX,
): Promise<{ entries: AuditEntryView[]; nextCursor: number | null }> {
  const limit = Math.min(Math.max(Math.trunc(query.limit ?? 50), 1), max);
  const conditions: SQL[] = [];
  if (query.before !== undefined) conditions.push(lt(auditLog.id, query.before));
  if (query.objectType) conditions.push(eq(auditLog.objectType, query.objectType));
  if (query.actorUserId) conditions.push(eq(auditLog.actorUserId, query.actorUserId));

  // One extra row decides whether there is a next page without a COUNT.
  const rows = await db
    .select()
    .from(auditLog)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(auditLog.id))
    .limit(limit + 1);

  const page = rows.slice(0, limit);
  return {
    entries: page.map(toView),
    nextCursor: rows.length > limit ? page[page.length - 1]!.id : null,
  };
}

const CSV_COLUMNS: ReadonlyArray<keyof AuditEntryView> = [
  'id',
  'occurredAt',
  'actorUserId',
  'actorEmail',
  'action',
  'objectType',
  'objectId',
  'before',
  'after',
  'reason',
  'requestId',
  'metadata',
];

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  // Quote everything that could break a row, and neutralise formula injection:
  // a cell a spreadsheet would evaluate (=, +, -, @) is prefixed with a quote.
  const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function auditEntriesToCsv(entries: readonly AuditEntryView[]): string {
  const lines = [CSV_COLUMNS.join(',')];
  for (const entry of entries) lines.push(CSV_COLUMNS.map((c) => csvCell(entry[c])).join(','));
  return `${lines.join('\r\n')}\r\n`;
}
