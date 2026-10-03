import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import App from '../App';
import { AuthProvider } from '../auth/AuthContext';
import LegalPage from './LegalPage';
import {
  LEGAL_DOCUMENTS,
  REPLACE_MARKER,
  legalDocument,
  outstandingPlaceholders,
  placeholder,
} from './legalContent';
import { AGE_CONFIRMED_KEY } from '../lib/ageGate';

/**
 * The legal and compliance pages.
 *
 * Two things are worth pinning here and neither is the prose. First, that the
 * pages are reachable by somebody who has NOT confirmed their age and is NOT
 * signed in -- which is the whole reason they live outside the shell. Second,
 * that every unknown is visibly marked, because a draft that quietly invents a
 * company number is worse than one that is obviously unfinished.
 */

/**
 * Static markup escapes `&`, so a label like "Terms & Conditions" arrives as
 * "Terms &amp; Conditions". These tests are about the words a person reads, not
 * the entities, so the handful that matter are decoded before comparison.
 */
const decode = (html: string) =>
  html.replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/&quot;/g, '"');

const renderApp = (path: string) =>
  decode(
    renderToStaticMarkup(
      <MemoryRouter initialEntries={[path]}>
        <AuthProvider>
          <App />
        </AuthProvider>
      </MemoryRouter>,
    ),
  );

const renderDoc = (slug: string) =>
  decode(
    renderToStaticMarkup(
      <MemoryRouter>
        <Routes>
          <Route path="/" element={<LegalPage document={legalDocument(slug)!} />} />
        </Routes>
      </MemoryRouter>,
    ),
  );

function storageWithoutConfirmation() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: () => null,
    length: 0,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('every document is routed and renders', () => {
  it('covers the five the brief asked for', () => {
    expect(LEGAL_DOCUMENTS.map((d) => d.slug)).toEqual([
      'privacy',
      'terms',
      'adult-policy',
      'cookies',
      'legal',
    ]);
  });

  it.each(LEGAL_DOCUMENTS.map((d) => [d.slug, d.title] as const))(
    '/%s renders "%s"',
    (slug, title) => {
      vi.stubGlobal('localStorage', storageWithoutConfirmation());
      const html = renderApp(`/${slug}`);
      expect(html).toContain(title);
    },
  );

  /**
   * The brief named /contact or /legal, so /contact must not be a dead end.
   *
   * It is a `<Navigate>`, which renders nothing on a static pass and performs
   * the redirect in a browser -- so what is asserted here is that the path is
   * ROUTED rather than falling through to the not-found page.
   */
  it('/contact is routed as a redirect, not a 404', () => {
    vi.stubGlobal('localStorage', storageWithoutConfirmation());
    const html = renderApp('/contact');
    expect(html).not.toContain('Page not found');
    expect(html).toBe('');
  });

  it('each page carries every one of its sections', () => {
    for (const doc of LEGAL_DOCUMENTS) {
      const html = renderDoc(doc.slug);
      for (const section of doc.sections) {
        expect(html, `${doc.slug}: ${section.heading}`).toContain(section.heading);
      }
    }
  });
});

/**
 * THE POINT OF PUTTING THEM OUTSIDE THE SHELL.
 *
 * An unconfirmed visitor sees the age gate on every other route. If these pages
 * were inside it, the privacy policy would be unreadable by exactly the people
 * most likely to want it.
 */
describe('reachable without confirming an age and without an account', () => {
  it.each(LEGAL_DOCUMENTS.map((d) => d.slug))(
    '/%s renders for a visitor who has not confirmed their age',
    (slug) => {
      vi.stubGlobal('localStorage', storageWithoutConfirmation());

      const html = renderApp(`/${slug}`);

      expect(html).not.toContain('18+ only');
      expect(html).not.toContain('I am 18 or over');
      expect(html).toContain(legalDocument(slug)!.title);
    },
  );

  /** And the gate still guards everything else for that same visitor. */
  it('still shows the gate on an ordinary route', () => {
    vi.stubGlobal('localStorage', storageWithoutConfirmation());
    expect(renderApp('/characters')).toContain('18+ only');
  });

  it('renders the same for a confirmed visitor', () => {
    vi.stubGlobal('localStorage', {
      ...storageWithoutConfirmation(),
      getItem: (k: string) => (k === AGE_CONFIRMED_KEY ? String(Date.now()) : null),
    });
    expect(renderApp('/privacy')).toContain('Privacy Policy');
  });
});

describe('every page offers a way back and the other documents', () => {
  it.each(LEGAL_DOCUMENTS.map((d) => d.slug))('/%s links home and to its siblings', (slug) => {
    const html = renderDoc(slug);
    expect(html).toContain('Back to the site');
    expect(html).toContain('href="/"');
    for (const other of LEGAL_DOCUMENTS) {
      expect(html, other.slug).toContain(`href="/${other.slug}"`);
    }
  });

  it('marks the page you are on', () => {
    expect(renderDoc('privacy')).toContain('aria-current="page"');
  });
});

/**
 * NOTHING IS QUIETLY INVENTED.
 *
 * The draft's honesty is the testable part: unknowns carry a marker loud enough
 * to fail review, and no registration number, licence, regulator or certification
 * is named anywhere.
 */
describe('placeholders are visible, and nothing is fabricated', () => {
  it('marks every unknown with the replacement marker', () => {
    const outstanding = outstandingPlaceholders();
    expect(outstanding.length).toBeGreaterThan(0);
    for (const label of outstanding) {
      expect(placeholder(label)).toContain(REPLACE_MARKER);
    }
  });

  it('shows the draft notice on every page, before the text', () => {
    for (const doc of LEGAL_DOCUMENTS) {
      const html = renderDoc(doc.slug);
      expect(html, doc.slug).toContain(REPLACE_MARKER);
      expect(html, doc.slug).toContain('role="note"');
    }
  });

  it('names no registration number, licence, regulator or certification', () => {
    for (const doc of LEGAL_DOCUMENTS) {
      const html = renderDoc(doc.slug);
      // Any such string must be inside a bracketed placeholder, never standing alone.
      const bare = html.replace(/\[[^\]]*REPLACE BEFORE PRODUCTION\]/g, '');
      expect(bare, doc.slug).not.toMatch(/\b(?:Ltd|Limited|LLC|GmbH|Inc\.)\b/);
      expect(bare, doc.slug).not.toMatch(/\b(?:RTA|ASACP|ICO|FTC|GDPR-certified)\b/);
      expect(bare, doc.slug).not.toMatch(/company number|registration number \d|VAT \d/i);
      expect(bare, doc.slug).not.toMatch(/\bcertified\b|\blicensed\b|\bcompliant\b/i);
    }
  });

  /** A real email address would be a commitment nobody has made. */
  it('publishes no concrete email address', () => {
    for (const doc of LEGAL_DOCUMENTS) {
      expect(renderDoc(doc.slug), doc.slug).not.toMatch(/[a-z0-9._%-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
    }
  });
});

/** The cookie document is the one that must match the code, not a template. */
describe('the cookie policy describes this application', () => {
  const html = () => renderDoc('cookies');

  it('names the two cookies the application actually sets', () => {
    expect(html()).toContain('over18_session');
    expect(html()).toContain('o18_seen');
  });

  it('names the browser-storage keys the application actually writes', () => {
    for (const key of [
      'over18.ageConfirmedAt',
      'over18.lastCharacterId',
      'over18.credits.pendingPayment',
      'over18.credits.pendingUnlock',
    ]) {
      expect(html(), key).toContain(key);
    }
  });

  it('claims no advertising or third-party tracking', () => {
    const text = html();
    expect(text).toContain('No advertising cookies');
    expect(text).toContain('No third-party tracking cookies');
  });
});

describe('the adult policy states the rules that have no exceptions', () => {
  const html = () => renderDoc('adult-policy');

  it('prohibits sexual content involving minors and non-consent', () => {
    expect(html()).toContain('Sexual content involving minors');
    expect(html()).toContain('non-consent');
  });

  it('says plainly what the age check is and is not', () => {
    expect(html()).toContain('self-declared');
    expect(html()).toContain('not identity verification');
  });

  it('gives a way to report', () => {
    expect(html()).toContain('Reporting contact email');
  });
});

/** The terms must not describe a flow the product does not have. */
describe('the terms describe only what exists', () => {
  it('states that there is no in-product cancellation or refund', () => {
    const html = renderDoc('terms');
    expect(html).toContain('does not currently provide a way to cancel a subscription');
  });
});
