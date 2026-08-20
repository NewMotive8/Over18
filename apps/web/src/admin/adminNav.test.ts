import { describe, expect, it } from 'vitest';
import { ADMIN_DESTINATIONS, activeAdminDestination, adminDestination } from './adminNav';

describe('US-99 admin navigation model', () => {
  it('exposes the Epic 11 content-operations areas', () => {
    expect(ADMIN_DESTINATIONS.map((d) => d.key)).toEqual([
      'review',
      'library',
      'characters',
      'settings',
      'publishing',
      'generation',
    ]);
    expect(ADMIN_DESTINATIONS.every((d) => d.path.startsWith('/admin/'))).toBe(true);
  });

  it('does not pretend unimplemented areas work', () => {
    // Every area names the ticket that delivers it, and only areas that are
    // genuinely built may claim 'available'. Review (US-106), Library (US-100)
    // and now Characters (US-101) are built; the rest must still declare
    // themselves unbuilt rather than presenting dead links as features.
    for (const dest of ADMIN_DESTINATIONS) {
      expect(dest.owner).toMatch(/US-\d{3}/);
    }
    for (const key of ['review', 'library', 'characters', 'settings'] as const) {
      expect(adminDestination(key).status).toBe('available');
    }
    for (const key of ['publishing', 'generation'] as const) {
      expect(adminDestination(key).status).toBe('not-implemented');
    }
  });

  it('marks the current location', () => {
    expect(activeAdminDestination('/admin/characters')).toBe('characters');
    expect(activeAdminDestination('/admin/publishing')).toBe('publishing');
    expect(activeAdminDestination('/admin/settings/content-requirements')).toBe('settings');
  });

  it('prefers the longest matching prefix', () => {
    // /admin/content/review must select Review, not Content Library.
    expect(activeAdminDestination('/admin/content/review')).toBe('review');
    expect(activeAdminDestination('/admin/content/library')).toBe('library');
  });

  it('matches nested future routes', () => {
    expect(activeAdminDestination('/admin/characters/abc-123')).toBe('characters');
    expect(activeAdminDestination('/admin/characters/abc-123/identity')).toBe('characters');
  });

  it('treats the admin home as no destination', () => {
    expect(activeAdminDestination('/admin')).toBeNull();
  });

  it('does not claim consumer routes', () => {
    for (const path of ['/characters', '/go-steady', '/profile', '/chat/1']) {
      expect(activeAdminDestination(path)).toBeNull();
    }
  });

  it('resolves a destination by key', () => {
    expect(adminDestination('review').path).toBe('/admin/content/review');
  });
});
