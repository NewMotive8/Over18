import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import MobileNavigation from './MobileNavigation';

function renderAt(path: string): string {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[path]}>
      <MobileNavigation />
    </MemoryRouter>,
  );
}

describe('MobileNavigation', () => {
  it('renders all three primary destinations with an accessible nav label', () => {
    const html = renderAt('/characters');
    expect(html).toContain('aria-label="Primary"');
    expect(html).toContain('Discover');
    expect(html).toContain('Go Steady');
    expect(html).toContain('Profile');
    // links point at the canonical routes
    expect(html).toContain('href="/characters"');
    expect(html).toContain('href="/go-steady"');
    expect(html).toContain('href="/profile"');
  });

  it('marks the active destination with aria-current on the lobby', () => {
    expect(renderAt('/characters')).toContain('aria-current="page"');
    // active on a character detail route too (Discover subtree)
    expect(renderAt('/characters/xyz')).toContain('aria-current="page"');
  });

  it('exposes exactly one active tab per primary route', () => {
    for (const path of ['/characters', '/go-steady', '/profile']) {
      const count = (renderAt(path).match(/aria-current="page"/g) ?? []).length;
      expect(count).toBe(1);
    }
  });

  it('marks no tab active outside the primary destinations', () => {
    expect(renderAt('/subscription')).not.toContain('aria-current="page"');
  });
});
