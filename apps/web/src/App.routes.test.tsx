import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import App from './App';
import { AuthProvider } from './auth/AuthContext';
import { AGE_CONFIRMED_KEY } from './lib/ageGate';

/**
 * Route-level smoke tests (US-18) via static rendering. Effects don't run under
 * renderToStaticMarkup, so no network is hit — pages render their initial
 * (loading/empty) state inside the persistent AppShell.
 *
 * THE AGE IS CONFIRMED BEFORE EACH, because the shell now renders the age gate
 * INSTEAD OF its outlet until a visitor says they are 18 or over. These tests
 * are about routing, and a browser that has already answered is the state in
 * which routing is the thing under test. That the gate blocks every route when
 * the answer is missing is asserted in `AppShellAgeGate.test.tsx`, where it is
 * the subject rather than a precondition.
 */
beforeEach(() => {
  const map = new Map<string, string>([[AGE_CONFIRMED_KEY, String(Date.now())]]);
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: () => null,
    length: 0,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

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
    expect(html).toContain('Premium');
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
