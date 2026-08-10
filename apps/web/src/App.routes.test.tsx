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

  it('renders the Subscription placeholder without any real payment surface', () => {
    const html = renderApp('/subscription');
    expect(html).toContain('Go Premium');
    expect(html).toContain('Payments are not enabled');
    // placeholder subscribe control is disabled (no billing)
    expect(html).toContain('disabled');
  });

  it('keeps the character-profile route mounted inside the shell (no crash)', () => {
    const html = renderApp('/characters/some-character-id');
    expect(html).toContain('Over'); // shell present, page mounted
    expect(html).toContain('aria-label="Primary"');
  });

  it('shows a safe not-found fallback for unknown routes (never crashes)', () => {
    const html = renderApp('/a-route-that-does-not-exist');
    expect(html).toContain('Page not found');
    expect(html).toContain('Back to Discover');
  });
});
