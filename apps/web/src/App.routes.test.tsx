import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import App from './App';
import { AuthProvider } from './auth/AuthContext';

/**
 * Route-level smoke tests (US-18) via static rendering. Effects don't run under
 * renderToStaticMarkup, so no network is hit — pages render their initial
 * (loading/empty) state inside the persistent AppShell.
 */
function renderApp(path: string): string {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <App />
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe('app shell + routes', () => {
  it('wraps Discover in the shell with persistent primary navigation', () => {
    const html = renderApp('/characters');
    expect(html).toContain('Over'); // brand
    expect(html).toContain('aria-label="Primary"'); // persistent nav
    expect(html).toContain('Go Steady');
    expect(html).toContain('Profile');
    expect(html).toContain('Discover');
  });

  it('renders the Go Steady future-state', () => {
    const html = renderApp('/go-steady');
    expect(html).toContain('Go Steady');
    expect(html).toContain('closer connections');
  });

  it('renders the Profile/Account destination', () => {
    const html = renderApp('/profile');
    expect(html).toContain('Profile');
    expect(html).toContain('Membership');
  });

  /**
   * P9: the client now calls the server, so the first render shows nothing
   * commercial rather than a "pending" notice. What these guard is unchanged --
   * no price, balance or plan is ever invented in the browser.
   */
  it('invents no plan, price or balance on the subscription screen before the server answers', () => {
    const html = renderApp('/subscription');
    expect(html).toContain('Choose your experience');
    expect(html).not.toContain('Pricing will be shown when plans launch');
    expect(html).not.toContain('18 Credits');
    expect(html).not.toContain('Premium enrollment coming soon');
    expect(html).not.toMatch(/\$\d/);
  });

  it('does not render fabricated balance or activity on the customer Credits screen', () => {
    // Customers are told "Credits"; the original path still resolves (P8.1).
    for (const path of ['/credits', '/wallet']) {
      const html = renderApp(path);
      expect(html, path).toContain('Credits');
      expect(html, path).not.toContain('18 Credits');
      expect(html, path).not.toMatch(/Wallet|wallet activity/i);
    }
  });

  it('claims no plan on the profile before the server answers', () => {
    const html = renderApp('/profile');
    expect(html).toContain('Membership');
    expect(html).not.toContain('Free plan');
    expect(html).not.toContain('Premium plan');
    expect(html).not.toContain(' Credits');
  });

  it('keeps the character-profile route mounted inside the shell (no crash)', () => {
    const html = renderApp('/characters/some-character-id');
    // US-29: the profile is immersive (its own top controls), so the shell brand
    // bar is intentionally hidden — the persistent primary nav still frames it,
    // and the page mounts to its loading state.
    expect(html).toContain('aria-label="Primary"');
    expect(html).toContain('Back to lobby');
  });

  it('shows a safe not-found fallback for unknown routes (never crashes)', () => {
    const html = renderApp('/a-route-that-does-not-exist');
    expect(html).toContain('Page not found');
    expect(html).toContain('Back to Discover');
  });
});
