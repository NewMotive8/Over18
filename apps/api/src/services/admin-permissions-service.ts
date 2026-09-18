import { and, asc, eq, inArray } from 'drizzle-orm';
import {
  ADMIN_PERMISSIONS,
  ADMIN_ROLE_PERMISSIONS,
  type AdminAccessView,
  type AdminPermission,
  type AdminRoleName,
} from '@over18/shared';
import type { Db } from '../db/client.js';
import { adminRoleGrants, users } from '../db/schema.js';
import { recordAudit, type AuditActor } from './audit-service.js';
import type { SafeUser } from './auth-service.js';

/**
 * Admin roles and permissions (PRD v1.2 §34.1).
 *
 * STAFF IS STILL `users.role = 'admin'`. A grant refines what a staff member
 * may do once enforcement is on; it can never make an ordinary user staff, and
 * a non-staff user with a stray grant row holds no permissions at all.
 */

export class AdminRoleError extends Error {
  constructor(
    readonly code: 'not_staff' | 'last_administrator' | 'reason_required' | 'user_not_found',
    message: string,
  ) {
    super(message);
    this.name = 'AdminRoleError';
  }
}

export function permissionsForRoles(roles: readonly AdminRoleName[]): Set<AdminPermission> {
  const granted = new Set<AdminPermission>();
  for (const role of roles) for (const p of ADMIN_ROLE_PERMISSIONS[role]) granted.add(p);
  return granted;
}

export async function rolesForUser(
  db: Pick<Db, 'select'>,
  userId: string,
): Promise<AdminRoleName[]> {
  const rows = await db
    .select({ role: adminRoleGrants.role })
    .from(adminRoleGrants)
    .where(eq(adminRoleGrants.userId, userId))
    .orderBy(asc(adminRoleGrants.role));
  return rows.map((r) => r.role);
}

/**
 * What a staff member holds.
 *
 * `granted` is what their role rows say. `effective` is what the server will
 * actually let them do right now: with enforcement off that is every
 * permission, because `requirePermission` then admits any staff member. The
 * admin shell reads `effective`, so it never hides a section the server would
 * allow.
 */
export async function adminAccessFor(
  db: Db,
  user: SafeUser,
  options: { enforced: boolean; auditLogEnabled: boolean },
): Promise<AdminAccessView & { granted: Set<AdminPermission> }> {
  if (user.role !== 'admin') {
    return {
      roles: [],
      permissions: [],
      granted: new Set(),
      enforced: options.enforced,
      features: { auditLog: options.auditLogEnabled },
    };
  }
  const roles = await rolesForUser(db, user.id);
  const granted = permissionsForRoles(roles);
  const effective = options.enforced ? [...granted] : [...ADMIN_PERMISSIONS];
  return {
    roles,
    permissions: ADMIN_PERMISSIONS.filter((p) => effective.includes(p)),
    granted,
    enforced: options.enforced,
    features: { auditLog: options.auditLogEnabled },
  };
}

export interface StaffMemberView {
  userId: string;
  email: string;
  roles: AdminRoleName[];
}

export async function listStaff(db: Db): Promise<StaffMemberView[]> {
  const staff = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(eq(users.role, 'admin'))
    .orderBy(asc(users.email));
  if (staff.length === 0) return [];
  const grants = await db
    .select({ userId: adminRoleGrants.userId, role: adminRoleGrants.role })
    .from(adminRoleGrants)
    .where(
      inArray(
        adminRoleGrants.userId,
        staff.map((s) => s.id),
      ),
    )
    .orderBy(asc(adminRoleGrants.role));
  return staff.map((s) => ({
    userId: s.id,
    email: s.email,
    roles: grants.filter((g) => g.userId === s.id).map((g) => g.role),
  }));
}

interface RoleChange {
  actor: AuditActor;
  userId: string;
  role: AdminRoleName;
  reason: string;
  requestId?: string | null;
}

function requireReason(reason: string): string {
  const trimmed = reason.trim();
  if (!trimmed) {
    throw new AdminRoleError('reason_required', 'A reason is required to change a role.');
  }
  return trimmed;
}

async function requireStaff(db: Pick<Db, 'select'>, userId: string): Promise<void> {
  const [row] = await db
    .select({ role: users.role })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!row) throw new AdminRoleError('user_not_found', 'User not found.');
  if (row.role !== 'admin') {
    throw new AdminRoleError(
      'not_staff',
      'Roles can only be granted to staff. This user is not an administrator account.',
    );
  }
}

/**
 * Grants a role. Idempotent: granting a role already held changes nothing and
 * writes no audit row, because nothing happened.
 */
export async function grantAdminRole(db: Db, change: RoleChange): Promise<AdminRoleName[]> {
  const reason = requireReason(change.reason);
  return db.transaction(async (tx) => {
    await requireStaff(tx, change.userId);
    const before = await rolesForUser(tx, change.userId);
    if (before.includes(change.role)) return before;

    await tx
      .insert(adminRoleGrants)
      .values({ userId: change.userId, role: change.role, grantedBy: change.actor.userId })
      .onConflictDoNothing();
    const after = await rolesForUser(tx, change.userId);

    await recordAudit(tx, {
      actor: change.actor,
      action: 'admin.roles.grant',
      objectType: 'admin_role_grant',
      objectId: change.userId,
      before: { roles: before },
      after: { roles: after },
      reason,
      requestId: change.requestId ?? null,
      metadata: { role: change.role },
    });
    return after;
  });
}

/**
 * Revokes a role, and refuses to remove the last administrator.
 *
 * THE LAST-ADMINISTRATOR GUARD IS CHECKED UNDER A LOCK. Two administrators
 * revoking each other concurrently would otherwise each see one other
 * administrator remaining, both succeed, and leave nobody able to assign roles.
 * Locking every administrator grant row serialises those decisions.
 */
export async function revokeAdminRole(db: Db, change: RoleChange): Promise<AdminRoleName[]> {
  const reason = requireReason(change.reason);
  return db.transaction(async (tx) => {
    await requireStaff(tx, change.userId);
    const before = await rolesForUser(tx, change.userId);
    if (!before.includes(change.role)) return before;

    if (change.role === 'administrator') {
      const administrators = await tx
        .select({ userId: adminRoleGrants.userId })
        .from(adminRoleGrants)
        .innerJoin(users, eq(users.id, adminRoleGrants.userId))
        .where(and(eq(adminRoleGrants.role, 'administrator'), eq(users.role, 'admin')))
        // A fixed lock order, so two concurrent revocations queue behind each
        // other instead of deadlocking. The second then re-reads the set, sees
        // the first revocation, and is refused with a clean conflict.
        .orderBy(asc(adminRoleGrants.userId))
        .for('update', { of: adminRoleGrants });
      if (administrators.length <= 1) {
        throw new AdminRoleError(
          'last_administrator',
          'This is the last administrator. Grant administrator to someone else first.',
        );
      }
    }

    await tx
      .delete(adminRoleGrants)
      .where(and(eq(adminRoleGrants.userId, change.userId), eq(adminRoleGrants.role, change.role)));
    const after = await rolesForUser(tx, change.userId);

    await recordAudit(tx, {
      actor: change.actor,
      action: 'admin.roles.revoke',
      objectType: 'admin_role_grant',
      objectId: change.userId,
      before: { roles: before },
      after: { roles: after },
      reason,
      requestId: change.requestId ?? null,
      metadata: { role: change.role },
    });
    return after;
  });
}
