import { and, asc, desc, eq, sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { AccountStatus, AdminRoleName, AdminUserDetail, AdminUserList, AdminUserListItem, AdminUserWallet } from '@over18/shared';
import type { Db } from '../db/client.js';
import { adminRoleGrants, conversations, sessions, users } from '../db/schema.js';
import { ACCOUNT_STATUS_AUDIT_OBJECT_TYPE } from './account-status-service.js';
import { WALLET_AUDIT_OBJECT_TYPE, walletAuditObjectId } from './admin-wallet-service.js';
import { listAuditEntriesConcerning } from './audit-service.js';
import { readCustomerCommercialState } from './customer-economy.js';
import { readWalletSummaries } from './wallet-service.js';

/**
 * THE ADMIN USERS READ MODEL (P2.5.1): the list of users and the consolidated,
 * read-only detail of one -- the operational shell of User Management.
 *
 * IT OWNS NO STATE AND DERIVES NO FACT. Identity, role, account status (P2.5.2)
 * and activity are read straight from their tables; the commercial state is the
 * P3.1 resolver's answer (the same one the customer is given); the wallets are the P2.4 wallet
 * read model; the audit entries come from the audit service. Nothing here
 * computes a balance, a tier or a subscription state, and nothing here writes:
 * the status is changed by services/account-status-service.ts.
 *
 * MINIMUM DATA (P2.5 Security). The list and detail carry identity, role,
 * timestamps and aggregates -- never a password hash, a session token, an
 * OAuth credential or a payment detail. Every field is chosen explicitly.
 *
 * THE LIST is one statement per page: search, filters, a keyset cursor over
 * (created_at, id) newest first, and the staff roles and last sign-in as
 * correlated subqueries on indexed keys -- so a page costs the same whether the
 * table holds a hundred users or a million, and there is no N+1.
 */

export class AdminUserError extends Error {
  constructor(
    public readonly code: 'invalid_request' | 'user_not_found',
    message: string,
  ) {
    super(message);
    this.name = 'AdminUserError';
  }
}

export const USER_PAGE_DEFAULT = 25;
export const USER_PAGE_MAX = 100;
const SEARCH_MAX = 254;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_US = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

/** Where the admin writes it records audit entries about a user (see admin-permissions-service and plugins/admin-audit). */
const ROLE_GRANT_AUDIT_OBJECT_TYPE = 'admin_role_grant';
const ADMIN_ROUTE_AUDIT_OBJECT_TYPE = 'admin_route';

function invalid(message: string): never {
  throw new AdminUserError('invalid_request', message);
}

/** A timestamp as ISO 8601 with microseconds, UTC -- exact enough to be a cursor. */
const isoUs = (col: AnyPgColumn | SQL) => sql<string>`to_char(${col} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/* ------------------------------------------------------------------ *
 * The list
 * ------------------------------------------------------------------ */

export type UserRoleFilter = 'customer' | 'staff';

export interface UserListQuery {
  search?: string;
  role?: UserRoleFilter;
  status?: AccountStatus;
  /** Inclusive start of the first UTC day. */
  createdFrom?: Date;
  /** Exclusive: the start of the UTC day after the last one asked for. */
  createdBefore?: Date;
  cursor?: { createdAt: string; id: string };
  limit: number;
}

export function encodeUserCursor(createdAt: string, id: string): string {
  return Buffer.from(JSON.stringify({ c: createdAt, i: id })).toString('base64url');
}

function decodeUserCursor(raw: string): { createdAt: string; id: string } {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as { c?: unknown; i?: unknown };
    if (typeof parsed.c === 'string' && ISO_US.test(parsed.c) && typeof parsed.i === 'string' && UUID.test(parsed.i)) {
      return { createdAt: parsed.c, id: parsed.i };
    }
  } catch {
    // fall through to the refusal below
  }
  return invalid('cursor is not a cursor this list issued.');
}

function utcDay(raw: unknown, name: string): Date | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw !== 'string' || !DATE.test(raw)) invalid(`${name} must be a date, YYYY-MM-DD.`);
  const date = new Date(`${raw}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== raw) invalid(`${name} is not a real date.`);
  return date;
}

/** The query string, checked. Anything unrecognised or malformed is refused, never guessed. */
export function parseUserListQuery(raw: Record<string, unknown>): UserListQuery {
  const query: UserListQuery = { limit: USER_PAGE_DEFAULT };

  if (raw.search !== undefined) {
    if (typeof raw.search !== 'string' || raw.search.length > SEARCH_MAX) invalid(`search must be text of at most ${SEARCH_MAX} characters.`);
    const search = raw.search.trim();
    if (search) query.search = search;
  }
  if (raw.role !== undefined && raw.role !== '' && raw.role !== 'all') {
    if (raw.role !== 'customer' && raw.role !== 'staff') invalid('role must be "customer", "staff" or "all".');
    query.role = raw.role;
  }
  if (raw.status !== undefined && raw.status !== '' && raw.status !== 'all') {
    if (raw.status !== 'active' && raw.status !== 'suspended') invalid('status must be "active", "suspended" or "all".');
    query.status = raw.status;
  }
  const from = utcDay(raw.createdFrom, 'createdFrom');
  const to = utcDay(raw.createdTo, 'createdTo');
  if (from) query.createdFrom = from;
  if (to) query.createdBefore = new Date(to.getTime() + 86_400_000);
  if (from && to && from > to) invalid('createdFrom must not be after createdTo.');
  if (raw.cursor !== undefined && raw.cursor !== '') {
    if (typeof raw.cursor !== 'string') invalid('cursor must be text.');
    query.cursor = decodeUserCursor(raw.cursor);
  }
  if (raw.limit !== undefined && raw.limit !== '') {
    const limit = Number(raw.limit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > USER_PAGE_MAX) invalid(`limit must be a whole number from 1 to ${USER_PAGE_MAX}.`);
    query.limit = limit;
  }
  return query;
}

/** `%`, `_` and `\` are literal in a search, not patterns. */
const likeLiteral = (text: string) => text.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * One page of users, newest account first. A search that is a whole User ID
 * finds exactly that user; any other search matches part of the email address
 * (emails are stored lower-case).
 */
export async function listUsers(db: Pick<Db, 'select'>, raw: Record<string, unknown>): Promise<AdminUserList> {
  const query = parseUserListQuery(raw);
  const conditions: SQL[] = [];
  if (query.search) {
    conditions.push(
      UUID.test(query.search)
        ? eq(users.id, query.search.toLowerCase())
        : sql`lower(${users.email}) like ${`%${likeLiteral(query.search.toLowerCase())}%`} escape '\\'`,
    );
  }
  if (query.role) conditions.push(eq(users.role, query.role === 'staff' ? 'admin' : 'user'));
  if (query.status) conditions.push(eq(users.status, query.status));
  if (query.createdFrom) conditions.push(sql`${users.createdAt} >= ${query.createdFrom.toISOString()}::timestamptz`);
  if (query.createdBefore) conditions.push(sql`${users.createdAt} < ${query.createdBefore.toISOString()}::timestamptz`);
  if (query.cursor) {
    conditions.push(sql`(${users.createdAt}, ${users.id}) < (${query.cursor.createdAt}::timestamptz, ${query.cursor.id}::uuid)`);
  }

  // The correlated subqueries name their tables and the outer row explicitly:
  // drizzle renders a single-table select's columns unqualified, and an
  // unqualified "id" inside `from sessions` would silently mean sessions.id.
  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      role: users.role,
      status: users.status,
      createdAt: isoUs(users.createdAt),
      lastSignInAt: sql<string | null>`(select ${isoUs(sql`max(s.created_at)`)} from sessions s where s.user_id = "users"."id")`,
      staffRoles: sql<AdminRoleName[]>`(select coalesce(json_agg(g.role order by g.role), '[]'::json) from admin_role_grants g where g.user_id = "users"."id")`,
    })
    .from(users)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(users.createdAt), desc(users.id))
    .limit(query.limit + 1);

  const page: AdminUserListItem[] = rows.slice(0, query.limit);
  const last = page.at(-1);
  return { users: page, nextCursor: rows.length > query.limit && last ? encodeUserCursor(last.createdAt, last.id) : null };
}

/* ------------------------------------------------------------------ *
 * The detail
 * ------------------------------------------------------------------ */

/**
 * One user, consolidated and read-only. `auditVisible` is the caller's
 * permission to read the audit log (`audit.read`); without it the audit panel
 * says so rather than showing anything. `operator` is who is looking and
 * whether they hold `users.status.manage`: the detail says whether THEY may
 * change this account's status, by the rules account-status-service enforces.
 */
export async function readUserDetail(
  db: Db,
  userId: string,
  options: { economyEnabled: boolean; auditVisible: boolean; operator: { userId: string; canManageStatus: boolean } },
): Promise<AdminUserDetail> {
  if (typeof userId !== 'string' || !UUID.test(userId)) invalid('The User ID must be a user id.');
  const [user] = await db
    .select({
      id: users.id,
      email: users.email,
      role: users.role,
      status: users.status,
      createdAt: isoUs(users.createdAt),
      updatedAt: isoUs(users.updatedAt),
    })
    .from(users)
    .where(eq(users.id, userId));
  if (!user) throw new AdminUserError('user_not_found', `No user has the ID ${userId}.`);

  const [grants, activity, commercial, summaries] = await Promise.all([
    db
      .select({ role: adminRoleGrants.role, grantedAt: isoUs(adminRoleGrants.grantedAt), grantedBy: adminRoleGrants.grantedBy })
      .from(adminRoleGrants)
      .where(eq(adminRoleGrants.userId, userId))
      .orderBy(asc(adminRoleGrants.role)),
    db.execute<{ last_sign_in_at: string | null; active_sessions: number; conversations: number; last_conversation_at: string | null }>(sql`
      select
        (select ${isoUs(sql`max(${sessions.createdAt})`)} from ${sessions} where ${sessions.userId} = ${userId}) as last_sign_in_at,
        (select count(*)::int from ${sessions} where ${sessions.userId} = ${userId} and ${sessions.expiresAt} > now()) as active_sessions,
        (select count(*)::int from ${conversations} where ${conversations.userId} = ${userId}) as conversations,
        (select ${isoUs(sql`max(${conversations.updatedAt})`)} from ${conversations} where ${conversations.userId} = ${userId}) as last_conversation_at`),
    readCustomerCommercialState(db, { id: user.id, email: user.email, role: user.role }),
    readWalletSummaries(db, userId),
  ]);

  const wallets: AdminUserWallet[] = summaries.map((w) => ({
    currency: w.currency,
    exists: w.exists,
    included: w.classes.included.spendable,
    earned: w.classes.earned.spendable,
    purchased: w.classes.purchased.spendable,
    held: w.held,
    spendable: w.balance,
    transactions: w.version,
  }));

  const audit: AdminUserDetail['audit'] = options.auditVisible
    ? {
        available: true,
        entries: await listAuditEntriesConcerning(db, {
          actorUserId: userId,
          objects: [
            { objectType: ROLE_GRANT_AUDIT_OBJECT_TYPE, objectId: userId },
            { objectType: ADMIN_ROUTE_AUDIT_OBJECT_TYPE, objectId: userId },
            { objectType: ACCOUNT_STATUS_AUDIT_OBJECT_TYPE, objectId: userId },
            ...summaries.map((w) => ({ objectType: WALLET_AUDIT_OBJECT_TYPE, objectId: walletAuditObjectId(userId, w.currency) })),
          ],
        }),
      }
    : { available: false, reason: 'audit_read_required' };

  // The same rules, in the same order, as account-status-service refuses them.
  const statusChange: AdminUserDetail['account']['statusChange'] =
    user.id === options.operator.userId
      ? { allowed: false, reason: 'own_account' }
      : user.role !== 'user'
        ? { allowed: false, reason: 'staff_account' }
        : !options.operator.canManageStatus
          ? { allowed: false, reason: 'permission_required' }
          : { allowed: true };

  const facts = activity.rows[0]!;
  return {
    identity: { id: user.id, email: user.email },
    account: {
      role: user.role,
      staffRoles: grants,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
      status: user.status,
      statusChange,
    },
    activity: {
      lastSignInAt: facts.last_sign_in_at,
      activeSessions: facts.active_sessions,
      conversations: facts.conversations,
      lastConversationAt: facts.last_conversation_at,
    },
    commercial: { economyEnabled: options.economyEnabled, tier: commercial.tier, subscription: commercial.subscription, age: commercial.age },
    wallets,
    audit,
  };
}
