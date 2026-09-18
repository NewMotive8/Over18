import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import Fastify from 'fastify';
import { eq } from 'drizzle-orm';
import {
  ADMIN_PERMISSIONS,
  ADMIN_ROLE_PERMISSIONS,
  ADMIN_ROLES,
  type AdminPermission,
  type AdminRoleName,
} from '@over18/shared';
import { adminRoleGrants, auditLog, users } from '../db/schema.js';
import { SEED_CHARACTERS } from '../db/seed-data.js';
import { seedCharacters } from '../db/seed.js';
import adminAuditPlugin from '../plugins/admin-audit.js';
import { auditEntriesToCsv, recordAudit } from '../services/audit-service.js';
import { AdminRoleError, revokeAdminRole } from '../services/admin-permissions-service.js';
import {
  createTestContext,
  destroyTestContext,
  extractSessionCookie,
  migrateTestDb,
  truncateAll,
  type TestContext,
} from './helpers.js';

/**
 * PRD v1.2 §34 -- admin roles, permissions and the audit log (build step 0c).
 *
 * THREE APPS OVER ONE DATABASE, one per switch position, because the property
 * that matters most in this phase is that the switches are genuinely inert when
 * off: `dark` is production's defaults, `enforced` turns on permission checks,
 * `audited` turns on the generic admin-write hook.
 */

let dark: TestContext;
let enforced: TestContext;
let audited: TestContext;
let seq = 0;

beforeAll(async () => {
  migrateTestDb();
  dark = await createTestContext();
  enforced = await createTestContext({ adminPermissionsEnforced: true });
  audited = await createTestContext({ adminAuditEnabled: true });
});
afterAll(async () => {
  await destroyTestContext(dark);
  await destroyTestContext(enforced);
  await destroyTestContext(audited);
});
beforeEach(async () => {
  await truncateAll(dark);
});

type Cookies = Record<string, string>;
interface Account {
  id: string;
  email: string;
  cookies: Cookies;
}

async function account(kind: 'admin' | 'user', roles: AdminRoleName[] = []): Promise<Account> {
  const email = `access-${kind}-${process.pid}-${++seq}@example.com`;
  const res = await dark.app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email, password: 'admin-access-1' },
  });
  expect(res.statusCode).toBe(201);
  const cookie = extractSessionCookie(res)!;
  const [row] = await dark.db.select({ id: users.id }).from(users).where(eq(users.email, email));
  if (kind === 'admin') {
    await dark.db.update(users).set({ role: 'admin' }).where(eq(users.id, row!.id));
  }
  for (const role of roles) {
    await dark.db.insert(adminRoleGrants).values({ userId: row!.id, role });
  }
  return { id: row!.id, email, cookies: { [cookie.name]: cookie.value } };
}

const auditRows = () => dark.db.select().from(auditLog).orderBy(auditLog.id);

/* ------------------------------------------------------------------ *
 * The migrations
 * ------------------------------------------------------------------ */

describe('the admin roles migration', () => {
  it('defines exactly the six §34.1 roles, in the shared order', async () => {
    const { rows } = await dark.pool.query<{ v: string }>(
      'SELECT unnest(enum_range(NULL::admin_role))::text AS v',
    );
    expect(rows.map((r) => r.v)).toEqual([...ADMIN_ROLES]);
  });

  /**
   * The backfill is read FROM THE SHIPPED MIGRATION and executed, so this tests
   * the SQL production will run rather than a restatement of it.
   */
  it('backfills administrator for every existing admin, and only for admins -- idempotently', async () => {
    const admin = await account('admin');
    const user = await account('user');
    const migration = readFileSync(
      new URL('../../drizzle/0025_petite_roland_deschain.sql', import.meta.url),
      'utf8',
    );
    const backfill = migration.slice(migration.indexOf('INSERT INTO "admin_role_grants"'));
    expect(backfill).toContain('ON CONFLICT DO NOTHING');

    await dark.pool.query(backfill);
    await dark.pool.query(backfill); // a re-run must not fail or duplicate

    const grants = await dark.db.select().from(adminRoleGrants);
    expect(grants.map((g) => [g.userId, g.role])).toEqual([[admin.id, 'administrator']]);
    expect(grants.some((g) => g.userId === user.id)).toBe(false);
  });
});

describe('the audit log is append-only in the database itself', () => {
  const entry = {
    actor: { userId: null, email: 'ops@example.com' },
    action: 'test.write',
    objectType: 'test',
  };

  it('refuses UPDATE', async () => {
    await recordAudit(dark.db, entry);
    await expect(dark.pool.query(`UPDATE audit_log SET action = 'forged'`)).rejects.toThrow(
      /append-only/,
    );
    expect((await auditRows())[0]!.action).toBe('test.write');
  });

  it('refuses DELETE', async () => {
    await recordAudit(dark.db, entry);
    await expect(dark.pool.query('DELETE FROM audit_log')).rejects.toThrow(/append-only/);
    expect(await auditRows()).toHaveLength(1);
  });

  it('still lets a user be deleted -- the actor is not a foreign key -- and keeps the entry', async () => {
    const admin = await account('admin');
    await recordAudit(dark.db, { ...entry, actor: { userId: admin.id, email: admin.email } });
    await dark.db.delete(users).where(eq(users.id, admin.id));
    const [row] = await auditRows();
    expect(row!.actorUserId).toBe(admin.id);
    expect(row!.actorEmail).toBe(admin.email);
  });
});

/* ------------------------------------------------------------------ *
 * Permissions -- dark
 * ------------------------------------------------------------------ */

const GATED: ReadonlyArray<{ url: string; permission: AdminPermission }> = [
  { url: '/admin/audit', permission: 'audit.read' },
  { url: '/admin/audit/export.csv', permission: 'audit.export' },
  { url: '/admin/roles', permission: 'roles.manage' },
];

describe('with enforcement OFF, requirePermission is exactly requireAdmin', () => {
  it('refuses anonymous callers with 401 and ordinary users with 403', async () => {
    const user = await account('user');
    for (const { url } of [...GATED, { url: '/admin/me/access' }]) {
      expect((await dark.app.inject({ method: 'GET', url })).statusCode).toBe(401);
      expect((await dark.app.inject({ method: 'GET', url, cookies: user.cookies })).statusCode).toBe(
        403,
      );
    }
  });

  it('admits a staff member who holds NO role at all', async () => {
    const admin = await account('admin');
    for (const { url } of GATED) {
      expect((await dark.app.inject({ method: 'GET', url, cookies: admin.cookies })).statusCode).toBe(
        200,
      );
    }
  });

  it('reports every permission as effective, so the admin shell hides nothing', async () => {
    const admin = await account('admin');
    const res = await dark.app.inject({ method: 'GET', url: '/admin/me/access', cookies: admin.cookies });
    expect(res.json()).toEqual({
      roles: [],
      permissions: [...ADMIN_PERMISSIONS],
      enforced: false,
      features: { auditLog: false },
    });
  });

  it('never gives a non-staff user a permission, even with a stray grant row', async () => {
    const user = await account('user', ['administrator']);
    for (const ctx of [dark, enforced]) {
      expect(
        (await ctx.app.inject({ method: 'GET', url: '/admin/audit', cookies: user.cookies })).statusCode,
      ).toBe(403);
    }
  });
});

/* ------------------------------------------------------------------ *
 * Permissions -- enforced
 * ------------------------------------------------------------------ */

describe('with enforcement ON, each role holds exactly its §34.1 permissions', () => {
  it('matches the permission matrix for every role and every gated route', async () => {
    for (const role of ADMIN_ROLES) {
      const staff = await account('admin', [role]);
      for (const { url, permission } of GATED) {
        const res = await enforced.app.inject({ method: 'GET', url, cookies: staff.cookies });
        const allowed = ADMIN_ROLE_PERMISSIONS[role].includes(permission);
        expect({ role, url, status: res.statusCode }).toEqual({
          role,
          url,
          status: allowed ? 200 : 403,
        });
        if (!allowed) expect(res.json()).toMatchObject({ error: 'forbidden', permission });
      }
    }
  });

  it('gives a staff member with no grant no permissions -- there is no implicit fallback', async () => {
    const admin = await account('admin');
    const res = await enforced.app.inject({ method: 'GET', url: '/admin/me/access', cookies: admin.cookies });
    expect(res.json()).toMatchObject({ roles: [], permissions: [], enforced: true });
    expect(
      (await enforced.app.inject({ method: 'GET', url: '/admin/audit', cookies: admin.cookies })).statusCode,
    ).toBe(403);
  });

  /**
   * THE RETROFIT DID NOT HAPPEN, deliberately. P0 moves no existing route onto
   * permissions, so switching enforcement on cannot lock anyone out of a screen
   * they use today.
   */
  it('leaves every EXISTING admin route on requireAdmin', async () => {
    const admin = await account('admin');
    for (const url of ['/admin/home', '/admin/app-categories', '/admin/settings/content-requirements']) {
      const res = await enforced.app.inject({ method: 'GET', url, cookies: admin.cookies });
      expect({ url, status: res.statusCode }).toEqual({ url, status: 200 });
    }
  });

  it('agrees with the shared role map: only administrator manages roles or reads the audit log', () => {
    for (const role of ADMIN_ROLES) {
      const perms = ADMIN_ROLE_PERMISSIONS[role];
      const privileged = perms.some((p) => p === 'roles.manage' || p.startsWith('audit.'));
      expect({ role, privileged }).toEqual({ role, privileged: role === 'administrator' });
    }
    expect([...ADMIN_ROLE_PERMISSIONS.administrator]).toEqual([...ADMIN_PERMISSIONS]);
    // §34.1 "Cannot" columns, checked explicitly rather than implied.
    expect(ADMIN_ROLE_PERMISSIONS.economy_editor).not.toContain('access.manage');
    expect(ADMIN_ROLE_PERMISSIONS.economy_editor).not.toContain('promotions.manage');
    expect(ADMIN_ROLE_PERMISSIONS.economy_editor).not.toContain('users.credits.adjust');
    expect(ADMIN_ROLE_PERMISSIONS.content_editor).not.toContain('economy.manage');
    expect(ADMIN_ROLE_PERMISSIONS.content_editor).not.toContain('promotions.manage');
    expect(ADMIN_ROLE_PERMISSIONS.marketing).not.toContain('economy.manage');
    expect(ADMIN_ROLE_PERMISSIONS.marketing).not.toContain('access.manage');
    expect(ADMIN_ROLE_PERMISSIONS.support).not.toContain('economy.manage');
    expect(ADMIN_ROLE_PERMISSIONS.support).not.toContain('access.manage');
    expect(ADMIN_ROLE_PERMISSIONS.analyst.every((p) => p.startsWith('analytics.'))).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * Role changes
 * ------------------------------------------------------------------ */

describe('granting and revoking roles', () => {
  const change = (
    ctx: TestContext,
    actor: Account,
    target: string,
    role: string,
    verb: 'grant' | 'revoke',
    payload: unknown = { reason: 'Test change' },
  ) =>
    ctx.app.inject({
      method: 'POST',
      url: `/admin/roles/${target}/${role}/${verb}`,
      cookies: actor.cookies,
      payload: payload as Record<string, unknown>,
    });

  it('grants a role and records WHO, the real before and after, and WHY -- in one row', async () => {
    const boss = await account('admin', ['administrator']);
    const staff = await account('admin');
    const res = await change(enforced, boss, staff.id, 'support', 'grant', { reason: 'Joins support rota' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ userId: staff.id, roles: ['support'] });

    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorUserId: boss.id,
      actorEmail: boss.email,
      action: 'admin.roles.grant',
      objectType: 'admin_role_grant',
      objectId: staff.id,
      before: { roles: [] },
      after: { roles: ['support'] },
      reason: 'Joins support rota',
      metadata: { role: 'support' },
    });
  });

  it('is idempotent: re-granting changes nothing and writes no second entry', async () => {
    const boss = await account('admin', ['administrator']);
    const staff = await account('admin');
    await change(enforced, boss, staff.id, 'analyst', 'grant');
    const again = await change(enforced, boss, staff.id, 'analyst', 'grant');
    expect(again.json()).toEqual({ userId: staff.id, roles: ['analyst'] });
    expect(await auditRows()).toHaveLength(1);
  });

  it('audits a role change even with the generic hook OFF', async () => {
    const boss = await account('admin');
    const staff = await account('admin');
    expect((await change(dark, boss, staff.id, 'marketing', 'grant')).statusCode).toBe(200);
    expect((await auditRows()).map((r) => r.action)).toEqual(['admin.roles.grant']);
  });

  it('is not logged TWICE when the generic hook is ON', async () => {
    const boss = await account('admin');
    const staff = await account('admin');
    expect((await change(audited, boss, staff.id, 'marketing', 'grant')).statusCode).toBe(200);
    expect((await auditRows()).map((r) => r.action)).toEqual(['admin.roles.grant']);
  });

  it('requires a reason, refuses non-staff, unknown users and unknown roles -- and records nothing', async () => {
    const boss = await account('admin', ['administrator']);
    const user = await account('user');
    const staff = await account('admin');

    expect((await change(enforced, boss, staff.id, 'support', 'grant', {})).statusCode).toBe(400);
    const blank = await change(enforced, boss, staff.id, 'support', 'grant', { reason: '   ' });
    expect(blank.statusCode).toBe(400);
    expect(blank.json().error).toBe('reason_required');

    const notStaff = await change(enforced, boss, user.id, 'support', 'grant');
    expect(notStaff.statusCode).toBe(400);
    expect(notStaff.json().error).toBe('not_staff');

    const missing = await change(enforced, boss, '00000000-0000-4000-8000-000000000000', 'support', 'grant');
    expect(missing.statusCode).toBe(404);

    const badRole = await change(enforced, boss, staff.id, 'superuser', 'grant');
    expect(badRole.statusCode).toBe(400);
    expect(badRole.json().error).toBe('invalid_role');

    expect(await auditRows()).toHaveLength(0);
    expect(await dark.db.select().from(adminRoleGrants).where(eq(adminRoleGrants.userId, staff.id))).toEqual([]);
  });

  it('refuses to revoke the LAST administrator', async () => {
    const boss = await account('admin', ['administrator']);
    const res = await change(enforced, boss, boss.id, 'administrator', 'revoke');
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('last_administrator');
    expect(await auditRows()).toHaveLength(0);
  });

  it('revokes an administrator while another remains, and audits it', async () => {
    const a = await account('admin', ['administrator']);
    const b = await account('admin', ['administrator']);
    const res = await change(enforced, a, b.id, 'administrator', 'revoke', { reason: 'Left the team' });
    expect(res.statusCode).toBe(200);
    expect(res.json().roles).toEqual([]);
    expect(await auditRows()).toMatchObject([
      { action: 'admin.roles.revoke', before: { roles: ['administrator'] }, after: { roles: [] } },
    ]);
  });

  /**
   * Two administrators revoking each other at the same instant must not leave
   * the system with none. Exactly one wins.
   *
   * Over HTTP the loser is refused one of two ways, both correct, depending on
   * timing: 409 if it reached the lock while its own grant still existed, or 403
   * if the winner's revocation had already committed by the time it was
   * authorised. What must never vary is the outcome: one administrator left.
   */
  it('never lets two concurrent revocations remove every administrator (HTTP)', async () => {
    for (let round = 0; round < 5; round += 1) {
      await truncateAll(dark);
      const a = await account('admin', ['administrator']);
      const b = await account('admin', ['administrator']);
      const results = await Promise.all([
        change(enforced, a, b.id, 'administrator', 'revoke'),
        change(enforced, b, a.id, 'administrator', 'revoke'),
      ]);
      const statuses = results.map((r) => r.statusCode).sort();
      expect(statuses[0]).toBe(200);
      expect([403, 409]).toContain(statuses[1]);
      const remaining = await dark.db
        .select()
        .from(adminRoleGrants)
        .where(eq(adminRoleGrants.role, 'administrator'));
      expect(remaining).toHaveLength(1);
    }
  });

  /**
   * The same race WITHOUT authorisation in front of it, so both calls always
   * reach the lock. This is the test of the lock itself: without the ordered
   * FOR UPDATE, both would see a second administrator and both would succeed.
   */
  it('serialises concurrent last-administrator checks under the lock (service)', async () => {
    for (let round = 0; round < 5; round += 1) {
      await truncateAll(dark);
      const a = await account('admin', ['administrator']);
      const b = await account('admin', ['administrator']);
      const revoke = (actor: Account, target: Account) =>
        revokeAdminRole(dark.db, {
          actor: { userId: actor.id, email: actor.email },
          userId: target.id,
          role: 'administrator',
          reason: 'race',
        });
      const settled = await Promise.allSettled([revoke(a, b), revoke(b, a)]);
      expect(settled.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const rejected = settled.find((r) => r.status === 'rejected') as PromiseRejectedResult;
      expect(rejected.reason).toBeInstanceOf(AdminRoleError);
      expect((rejected.reason as AdminRoleError).code).toBe('last_administrator');
      expect(
        await dark.db.select().from(adminRoleGrants).where(eq(adminRoleGrants.role, 'administrator')),
      ).toHaveLength(1);
      expect((await auditRows()).map((r) => r.action)).toEqual(['admin.roles.revoke']);
    }
  });

  it('lists staff with their roles for an administrator', async () => {
    const boss = await account('admin', ['administrator']);
    await account('user');
    const res = await enforced.app.inject({ method: 'GET', url: '/admin/roles', cookies: boss.cookies });
    expect(res.json()).toEqual({
      roles: [...ADMIN_ROLES],
      staff: [{ userId: boss.id, email: boss.email, roles: ['administrator'] }],
    });
  });
});

/* ------------------------------------------------------------------ *
 * The generic admin-write hook
 * ------------------------------------------------------------------ */

describe('the admin-write audit hook', () => {
  const createCategory = (ctx: TestContext, cookies: Cookies, name: string) =>
    ctx.app.inject({ method: 'POST', url: '/admin/app-categories', cookies, payload: { name } });

  it('records NOTHING while switched off', async () => {
    const admin = await account('admin');
    expect((await createCategory(dark, admin.cookies, `Dark ${seq}`)).statusCode).toBe(201);
    expect(await auditRows()).toEqual([]);
  });

  it('records one entry per successful admin write: actor, route PATTERN, ids, status', async () => {
    const admin = await account('admin');
    const created = await createCategory(audited, admin.cookies, 'Secret Campaign Name');
    expect(created.statusCode).toBe(201);
    const categoryId = created.json().id as string;

    const published = await audited.app.inject({
      method: 'PATCH',
      url: `/admin/home/categories/${categoryId}`,
      cookies: admin.cookies,
      payload: { homePublished: true },
    });
    expect(published.statusCode).toBe(200);

    const rows = await auditRows();
    expect(rows.map((r) => r.action)).toEqual([
      'POST /admin/app-categories',
      'PATCH /admin/home/categories/:categoryId',
    ]);
    expect(rows[0]).toMatchObject({
      actorUserId: admin.id,
      actorEmail: admin.email,
      objectType: 'admin_route',
      objectId: null,
      before: null,
      after: null,
      metadata: { statusCode: 201 },
    });
    expect(rows[1]).toMatchObject({ objectId: categoryId, metadata: { params: { categoryId } } });
    expect(rows[1]!.requestId).toBeTruthy();
  });

  it('never stores a request body', async () => {
    const admin = await account('admin');
    await createCategory(audited, admin.cookies, 'Secret Campaign Name');
    expect(JSON.stringify(await auditRows())).not.toContain('Secret Campaign Name');
  });

  it('does not record reads, refused writes, non-staff attempts, or non-admin routes', async () => {
    const admin = await account('admin');
    const user = await account('user');
    await seedCharacters(dark.db);
    const luna = SEED_CHARACTERS.find((c) => c.name === 'luna')!;

    await audited.app.inject({ method: 'GET', url: '/admin/app-categories', cookies: admin.cookies });
    expect((await audited.app.inject({ method: 'POST', url: '/admin/app-categories', cookies: admin.cookies, payload: {} })).statusCode).toBe(400);
    expect((await createCategory(audited, user.cookies, 'Not staff')).statusCode).toBe(403);
    expect(
      (await audited.app.inject({ method: 'PUT', url: `/api/favourites/${luna.id}`, cookies: user.cookies })).statusCode,
    ).toBeLessThan(300);

    expect(await auditRows()).toEqual([]);
  });

  it('can never fail the operator action it describes', async () => {
    const app = Fastify();
    app.decorateRequest('currentUser', null);
    app.addHook('preHandler', async (request) => {
      request.currentUser = { id: '00000000-0000-4000-8000-000000000001', email: 'ops@example.com', role: 'admin' };
    });
    const brokenDb = {
      insert: () => {
        throw new Error('database unavailable');
      },
    } as unknown as TestContext['db'];
    await app.register(adminAuditPlugin, { db: brokenDb, enabled: true });
    app.post('/admin/thing', async () => ({ ok: true }));

    const res = await app.inject({ method: 'POST', url: '/admin/thing' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    await app.close();
  });
});

/* ------------------------------------------------------------------ *
 * Reading and exporting the log
 * ------------------------------------------------------------------ */

describe('reading the audit log', () => {
  async function seedEntries(n: number, objectType = 'thing') {
    for (let i = 0; i < n; i += 1) {
      await recordAudit(dark.db, {
        actor: { userId: null, email: 'ops@example.com' },
        action: `write.${i}`,
        objectType,
      });
    }
  }

  it('pages newest first with a cursor that neither skips nor repeats', async () => {
    const admin = await account('admin');
    await seedEntries(7);
    const seen: string[] = [];
    let cursor: number | null = null;
    do {
      const url: string = `/admin/audit?limit=3${cursor ? `&before=${cursor}` : ''}`;
      const page = (await dark.app.inject({ method: 'GET', url, cookies: admin.cookies })).json();
      seen.push(...page.entries.map((e: { action: string }) => e.action));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toEqual(['write.6', 'write.5', 'write.4', 'write.3', 'write.2', 'write.1', 'write.0']);
  });

  it('filters by object type and actor', async () => {
    const admin = await account('admin');
    await seedEntries(2, 'plan');
    await seedEntries(3, 'pack');
    await recordAudit(dark.db, { actor: { userId: admin.id, email: admin.email }, action: 'mine', objectType: 'pack' });
    const byType = (await dark.app.inject({ method: 'GET', url: '/admin/audit?objectType=plan', cookies: admin.cookies })).json();
    expect(byType.entries).toHaveLength(2);
    const byActor = (
      await dark.app.inject({ method: 'GET', url: `/admin/audit?actorUserId=${admin.id}`, cookies: admin.cookies })
    ).json();
    expect(byActor.entries.map((e: { action: string }) => e.action)).toEqual(['mine']);
  });

  it('rejects a malformed query instead of guessing', async () => {
    const admin = await account('admin');
    for (const qs of ['before=abc', 'before=0', 'limit=x', 'actorUserId=not-a-uuid']) {
      const res = await dark.app.inject({ method: 'GET', url: `/admin/audit?${qs}`, cookies: admin.cookies });
      expect({ qs, status: res.statusCode }).toEqual({ qs, status: 400 });
    }
  });

  it('exports CSV privately, as an attachment', async () => {
    const admin = await account('admin');
    await seedEntries(2);
    const res = await dark.app.inject({ method: 'GET', url: '/admin/audit/export.csv', cookies: admin.cookies });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.headers['cache-control']).toBe('private, no-store');
    const lines = res.payload.trim().split('\r\n');
    expect(lines[0]).toBe(
      'id,occurredAt,actorUserId,actorEmail,action,objectType,objectId,before,after,reason,requestId,metadata',
    );
    expect(lines).toHaveLength(3);
  });

  it('escapes CSV cells and neutralises spreadsheet formulas', () => {
    const csv = auditEntriesToCsv([
      {
        id: 1,
        occurredAt: '2026-09-17T00:00:00.000Z',
        actorUserId: null,
        actorEmail: '=HYPERLINK("http://evil")',
        action: 'a,"b"\nc',
        objectType: '+cmd',
        objectId: null,
        before: { price: 10 },
        after: null,
        reason: '@SUM(A1)',
        requestId: null,
        metadata: {},
      },
    ]);
    const row = csv.split('\r\n')[1]!;
    expect(row).toContain(`"'=HYPERLINK(""http://evil"")"`);
    expect(csv).toContain('"a,""b""\nc"');
    expect(row).toContain("'+cmd");
    expect(csv).toContain("'@SUM(A1)");
    expect(csv).toContain('"{""price"":10}"');
  });
});
