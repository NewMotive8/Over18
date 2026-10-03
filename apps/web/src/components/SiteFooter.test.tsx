import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import SiteFooter, { REQUIRED_LEGAL_PAGES, availableLegalPages, type LegalPage } from './SiteFooter';
import { legalDocument } from '../legal/legalContent';

/** Static markup escapes `&`; these assertions are about the words, not entities. */
const decode = (html: string) => html.replace(/&amp;/g, '&').replace(/&#x27;/g, "'");

const render = (pages?: readonly LegalPage[], year?: number) =>
  decode(
    renderToStaticMarkup(
      <MemoryRouter>
        <SiteFooter {...(pages ? { pages } : {})} {...(year ? { year } : {})} />
      </MemoryRouter>,
    ),
  );

describe('what the footer always says', () => {
  it('carries the 18+ notice', () => {
    const html = render();
    expect(html).toContain('18+');
    expect(html).toContain('sexually explicit material intended for adults only');
  });

  it('discloses that every character is AI-generated', () => {
    const html = render();
    expect(html).toContain('fictional and AI-generated');
    expect(html).toContain('no real person is depicted');
  });

  it('carries the brand and the year', () => {
    const html = render(undefined, 2026);
    expect(html).toContain('Over');
    expect(html).toContain('© 2026 Over18');
  });

  /**
   * NO INVENTED ENTITY. A footer is where a company name and address normally
   * sit, and this product has not told us either. Naming one would be a legal
   * claim made up by a renderer.
   */
  it('names no company, address or registration', () => {
    const html = render();
    expect(html).not.toMatch(/Ltd|Limited|LLC|GmbH|Inc\./);
    expect(html).not.toMatch(/registered|company number|VAT/i);
  });
});

/**
 * THE SHORT SET.
 *
 * The footer shows the four links a visitor scans for, under plain names. Every
 * document still exists and every route still resolves — the Cookie Policy and
 * the Adult / 18+ Policy are reached by route and by the sibling nav on each
 * legal page, and "Trust & Safety" is the Adult / 18+ Policy under a plainer
 * name. These tests pin what is VISIBLE; `legal/legal.test.tsx` pins that every
 * document is still routed and reachable.
 */
describe('legal links', () => {
  it('shows exactly four, in order', () => {
    expect(REQUIRED_LEGAL_PAGES.map((p) => p.label)).toEqual([
      'Terms',
      'Privacy',
      'Trust & Safety',
      'Contact',
    ]);
  });

  it('points each one at the right document', () => {
    expect(REQUIRED_LEGAL_PAGES.map((p) => p.path)).toEqual([
      '/terms',
      '/privacy',
      '/adult-policy',
      '/legal',
    ]);
  });

  it('has all four available, each with a route', () => {
    expect(availableLegalPages()).toHaveLength(4);
    for (const page of availableLegalPages()) {
      expect(page.available, page.label).toBe(true);
      expect(page.path, page.label).toMatch(/^\/[a-z-]+$/);
    }
  });

  /** A label may be chosen freely; a destination may not be invented. */
  it('points every link at a document that actually exists', () => {
    for (const page of REQUIRED_LEGAL_PAGES) {
      const slug = (page.path ?? '').replace('/', '');
      expect(legalDocument(slug), page.label).toBeDefined();
    }
  });

  it('renders all four as working links', () => {
    const html = render();
    expect(html).toContain('Legal and safety');
    for (const page of REQUIRED_LEGAL_PAGES) {
      expect(html, page.label).toContain(`href="${page.path}"`);
      expect(html, page.label).toContain(page.label);
    }
  });

  /**
   * NOT SHOWN, AND NOT GONE. Neither appears as its own footer link; both are
   * still routed, which `legal/legal.test.tsx` asserts.
   */
  it('shows no separate Cookie Policy or Adult / 18+ Policy link', () => {
    const html = render();
    expect(html).not.toContain('Cookie Policy');
    expect(html).not.toContain('Adult / 18+ Policy');
    expect(html).not.toContain('href="/cookies"');
  });

  /** And the other half of the contract: a page that exists IS linked. */
  it('renders a page once it exists', () => {
    const html = render([
      { label: 'Terms of Service', path: '/legal/terms', available: true },
      { label: 'Privacy Policy', path: null, available: false },
    ]);
    expect(html).toContain('href="/legal/terms"');
    expect(html).toContain('Terms of Service');
    expect(html).toContain('Legal and safety');
    expect(html).not.toContain('Privacy Policy');
  });

  /** Marked available but pointing nowhere is still nowhere. */
  it('refuses to link a page marked available with no route', () => {
    const html = render([{ label: 'Terms of Service', path: null, available: true }]);
    expect(html).not.toContain('<a');
    expect(html).not.toContain('Terms of Service');
  });
});

/**
 * NO UNSUPPORTED CLAIMS. No certification badge, no "compliant", no promise
 * about verification -- none of which anyone has established.
 */
describe('claims it must not make', () => {
  it.each([
    'verified',
    'certified',
    'compliant',
    'RTA',
    'ASACP',
    'age-verified',
    'GDPR',
    'secure',
  ])('never claims %s', (claim) => {
    expect(render().toLowerCase()).not.toContain(claim.toLowerCase());
  });
});
