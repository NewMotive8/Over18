import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AuditEntryView } from '@over18/shared';
import { AuditTable } from './AdminAuditPage';

/**
 * PRD v1.2 §34.2 -- the audit table renders what was recorded and never implies
 * a value the writer did not know.
 */

const entry = (over: Partial<AuditEntryView> = {}): AuditEntryView => ({
  id: 1,
  occurredAt: '2026-09-17T10:00:00.000Z',
  actorUserId: 'u1',
  actorEmail: 'boss@example.com',
  action: 'admin.roles.grant',
  objectType: 'admin_role_grant',
  objectId: 'user-42',
  before: { roles: [] },
  after: { roles: ['support'] },
  reason: 'Joins support rota',
  requestId: 'req-1',
  metadata: {},
  ...over,
});

describe('the audit table', () => {
  it('shows who, what, the real before and after, and why', () => {
    const html = renderToStaticMarkup(<AuditTable entries={[entry()]} />);
    expect(html).toContain('boss@example.com');
    expect(html).toContain('admin.roles.grant');
    expect(html).toContain('user-42');
    expect(html).toContain('{&quot;roles&quot;:[]}');
    expect(html).toContain('{&quot;roles&quot;:[&quot;support&quot;]}');
    expect(html).toContain('Joins support rota');
  });

  it('shows an em dash, not an empty value, where before/after/reason were unknown', () => {
    const html = renderToStaticMarkup(
      <AuditTable
        entries={[entry({ before: null, after: null, reason: null, action: 'POST /admin/app-categories' })]}
      />,
    );
    expect(html.match(/—/g)?.length).toBe(3);
  });

  it('falls back to the actor id, then to system, when no email was captured', () => {
    expect(renderToStaticMarkup(<AuditTable entries={[entry({ actorEmail: null })]} />)).toContain('u1');
    expect(
      renderToStaticMarkup(<AuditTable entries={[entry({ actorEmail: null, actorUserId: null })]} />),
    ).toContain('system');
  });

  it('offers no edit or delete control -- the log is append-only', () => {
    const html = renderToStaticMarkup(<AuditTable entries={[entry(), entry({ id: 2 })]} />);
    expect(html.match(/data-testid="audit-row"/g)?.length).toBe(2);
    expect(html).not.toMatch(/<button|<input|delete|edit/i);
  });

  it('says so plainly when there is nothing yet', () => {
    expect(renderToStaticMarkup(<AuditTable entries={[]} />)).toContain('No audit entries yet.');
  });
});
