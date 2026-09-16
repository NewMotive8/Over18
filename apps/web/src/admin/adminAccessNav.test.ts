import { describe, expect, it } from 'vitest';
import { ADMIN_PERMISSIONS, type AdminAccessView } from '@over18/shared';
import {
  ADMIN_DESTINATIONS,
  GATED_ADMIN_DESTINATIONS,
  activeAdminDestination,
  visibleAdminDestinations,
} from './adminNav';

/**
 * PRD v1.2 §34 -- the admin navigation stays EXACTLY as it is unless the
 * server positively says a gated section applies to this operator.
 */

const access = (over: Partial<AdminAccessView> = {}): AdminAccessView => ({
  roles: [],
  permissions: [...ADMIN_PERMISSIONS],
  enforced: false,
  features: { auditLog: false },
  ...over,
});

const keys = (list: ReadonlyArray<{ key: string }>) => list.map((d) => d.key);
const SIX = keys(ADMIN_DESTINATIONS);

describe('gated admin navigation', () => {
  it('shows exactly the six ungated areas while access is unknown or failed', () => {
    expect(keys(visibleAdminDestinations(null))).toEqual(SIX);
  });

  it('keeps Audit hidden while the audit switch is off -- production defaults', () => {
    expect(keys(visibleAdminDestinations(access()))).toEqual(SIX);
  });

  it('keeps Audit hidden from an operator without audit.read, even with the switch on', () => {
    const view = access({ enforced: true, permissions: ['economy.manage'], features: { auditLog: true } });
    expect(keys(visibleAdminDestinations(view))).toEqual(SIX);
  });

  it('shows Audit only with BOTH the permission and the switch, after the six', () => {
    const view = access({ features: { auditLog: true } });
    expect(keys(visibleAdminDestinations(view))).toEqual([...SIX, 'audit']);
  });

  it('never adds a gated key to the ungated list the admin home renders', () => {
    for (const gated of GATED_ADMIN_DESTINATIONS) expect(SIX).not.toContain(gated.key);
  });

  it('marks Audit active on its own path without disturbing the others', () => {
    expect(activeAdminDestination('/admin/audit')).toBe('audit');
    expect(activeAdminDestination('/admin/characters')).toBe('characters');
    expect(activeAdminDestination('/admin')).toBeNull();
  });
});
