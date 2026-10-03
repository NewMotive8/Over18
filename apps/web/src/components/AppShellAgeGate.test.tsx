import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import AppShell from './AppShell';
import { AGE_CONFIRMED_KEY } from '../lib/ageGate';

/**
 * THE CLAIM THIS FILE EXISTS TO CHECK: that the gate withholds the application
 * rather than covering it.
 *
 * A modal over the page would leave the page mounted beneath, its markup in the
 * document and readable by anyone who looks past the overlay. These tests
 * render the real shell around a stand-in page and assert that the page is
 * absent from the output entirely until the browser holds a confirmation.
 */

function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: () => null,
    length: 0,
  };
}

/** A stand-in for whatever adult surface the route would have rendered. */
const SENTINEL = 'EXPLICIT-CONTENT-SENTINEL';

function shellAt(path: string) {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route element={<AppShell />}>
          <Route path="/characters" element={<p>{SENTINEL}</p>} />
          <Route path="/characters/:id" element={<p>{SENTINEL}</p>} />
          <Route path="/login" element={<p>{SENTINEL}</p>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('before the age is confirmed', () => {
  /**
   * EVERY ROUTE, NOT A LIST OF ADULT ONES. A list is a thing to forget to add
   * to; a deep link to a character page is exactly the arrival that a
   * route-by-route gate would miss.
   */
  it.each(['/characters', '/characters/some-id', '/login'])(
    'renders the gate instead of the page at %s',
    (path) => {
      vi.stubGlobal('localStorage', fakeStorage());

      const html = shellAt(path);

      expect(html).toContain('18+ only');
      // THE POINT: the page is not merely hidden, it is not in the document.
      expect(html).not.toContain(SENTINEL);
    },
  );

  it('renders none of the shell chrome either', () => {
    vi.stubGlobal('localStorage', fakeStorage());

    const html = shellAt('/characters');

    // No primary navigation to tab into, and no footer behind the gate.
    expect(html).not.toContain('aria-label="Primary"');
    expect(html).not.toContain('Legal and safety');
    expect(html).not.toContain('<main');
  });

  it('asks again when the stored confirmation has expired', () => {
    const longAgo = Date.now() - 400 * 24 * 60 * 60 * 1000;
    vi.stubGlobal('localStorage', fakeStorage({ [AGE_CONFIRMED_KEY]: String(longAgo) }));

    const html = shellAt('/characters');

    expect(html).toContain('18+ only');
    expect(html).not.toContain(SENTINEL);
  });

  /** Storage that refuses means ask, never means assume. */
  it('asks when storage cannot be read at all', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied');
      },
    });

    expect(shellAt('/characters')).toContain('18+ only');
  });
});

describe('once the age is confirmed', () => {
  it('renders the page, the navigation and the footer', () => {
    vi.stubGlobal('localStorage', fakeStorage({ [AGE_CONFIRMED_KEY]: String(Date.now()) }));

    const html = shellAt('/characters');

    expect(html).toContain(SENTINEL);
    expect(html).toContain('aria-label="Primary"');
    expect(html).toContain('18+ — this site contains sexually explicit material');
    expect(html).not.toContain('18+ only');
  });

  /**
   * NO REDIRECT, SO NO LOOP. The gate is a different render of the same route,
   * which is why the address someone arrived at is the address they are still
   * on afterwards -- nothing to bounce against `RequireAuth` or the router.
   */
  it('keeps the visitor on the address they arrived at', () => {
    vi.stubGlobal('localStorage', fakeStorage({ [AGE_CONFIRMED_KEY]: String(Date.now()) }));

    expect(shellAt('/characters/some-id')).toContain(SENTINEL);
  });
});
