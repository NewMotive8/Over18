import { createHash, randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { and, eq, gt, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { sessions, users, type UserRow } from '../db/schema.js';

/**
 * Framework-agnostic authentication service.
 *
 * This module knows nothing about HTTP, cookies, or browsers — it works purely
 * with tokens and database rows, so the same logic can serve the web app today
 * and a React Native client (sending the token as a bearer header) later.
 */

const BCRYPT_COST = 12;

export interface SafeUser {
  id: string;
  email: string;
  /** 'user' | 'admin'. Still an allow-listed field — never the password hash. */
  role: UserRow['role'];
}

export type RegisterResult =
  | { ok: true; user: SafeUser }
  | { ok: false; error: 'email_taken' };

export function toSafeUser(row: Pick<UserRow, 'id' | 'email' | 'role'>): SafeUser {
  // Explicit allow-list — password_hash can never leak through here.
  return { id: row.id, email: row.email, role: row.role };
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function hashToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}

export async function registerUser(db: Db, email: string, password: string): Promise<RegisterResult> {
  const normalized = normalizeEmail(email);
  const passwordHash = await bcrypt.hash(password, BCRYPT_COST);
  try {
    const [row] = await db
      .insert(users)
      .values({ email: normalized, passwordHash })
      .returning({ id: users.id, email: users.email, role: users.role });
    return { ok: true, user: toSafeUser(row!) };
  } catch (err) {
    // Unique-violation on users.email → duplicate registration.
    if (isUniqueViolation(err)) {
      return { ok: false, error: 'email_taken' };
    }
    throw err;
  }
}

export type CredentialsResult =
  | { ok: true; user: SafeUser }
  | { ok: false; error: 'invalid_credentials' | 'account_suspended' };

/**
 * Checks an email and password. A SUSPENDED account (P2.5.2) is refused, but
 * only once the password is proven right: to anyone without it, a suspended
 * account looks exactly like any other failed sign-in.
 */
export async function verifyCredentials(db: Db, email: string, password: string): Promise<CredentialsResult> {
  const normalized = normalizeEmail(email);
  const row = await db.query.users.findFirst({ where: eq(users.email, normalized) });
  if (!row) {
    // Burn comparable time so response timing does not reveal whether the
    // email exists (bcrypt hash of an unused dummy password).
    await bcrypt.compare(password, '$2b$12$TxuoP8yfuRLg0kyzsYst4uBkuoF0347VYFVErOc1ZOdzBNnisauL.');
    return { ok: false, error: 'invalid_credentials' };
  }
  const valid = await bcrypt.compare(password, row.passwordHash);
  if (!valid) return { ok: false, error: 'invalid_credentials' };
  if (row.status !== 'active') return { ok: false, error: 'account_suspended' };
  return { ok: true, user: toSafeUser(row) };
}

export async function createSession(
  db: Db,
  userId: string,
  ttlDays: number,
): Promise<{ rawToken: string; expiresAt: Date }> {
  const rawToken = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000);
  await db.insert(sessions).values({
    userId,
    tokenHash: hashToken(rawToken),
    expiresAt,
  });
  return { rawToken, expiresAt };
}

/**
 * Returns the user for a valid, unexpired session token, or null.
 *
 * Only an ACTIVE account's session is valid (P2.5.2). Suspending an account
 * also ends its sessions; this check is what makes the suspension hold
 * regardless -- including for a session that a concurrent sign-in created
 * just as the suspension committed.
 *
 * Expiry is judged by the DATABASE's clock, the same clock that ends a
 * session (services/account-status-service). Judged by this server's clock, a
 * session ended at the database's "now" would still look valid to a server
 * whose clock runs even a millisecond behind -- so an immediate reactivation
 * could revive it.
 */
export async function getUserForToken(db: Db, rawToken: string): Promise<SafeUser | null> {
  const row = await db
    .select({ id: users.id, email: users.email, role: users.role })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(
      and(eq(sessions.tokenHash, hashToken(rawToken)), gt(sessions.expiresAt, sql`now()`), eq(users.status, 'active')),
    )
    .limit(1);
  return row[0] ? toSafeUser(row[0]) : null;
}

/** Deletes the session belonging to the given raw token (logout). */
export async function deleteSessionByToken(db: Db, rawToken: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.tokenHash, hashToken(rawToken)));
}

function isUniqueViolation(err: unknown): boolean {
  // Walks the cause chain: drizzle-orm wraps the underlying pg error.
  let current: unknown = err;
  for (let depth = 0; current && depth < 5; depth++) {
    if (typeof current === 'object' && (current as { code?: unknown }).code === '23505') {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
