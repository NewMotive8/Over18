import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import SiteFooter, { REQUIRED_LEGAL_PAGES, availableLegalPages, type LegalPage } from './SiteFooter';

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
 * THE GAP, NOW CLOSED.
 *
 * These three assertions used to pin the opposite: that every required page was
 * missing and that the footer therefore linked none of them. The pages are
 * written and routed, so they now pin the other half of the same contract —
 * every declared page exists, has a route, and is reachable from the footer.
 * The rule itself never changed: a page is linked exactly when it exists.
 */
describe('legal links', () => {
  it('declares every page an adult site of this kind needs', () => {
    expect(REQUIRED_LEGAL_PAGES.map((p) => p.label)).toEqual([
      'Privacy Policy',
      'Terms & Conditions',
      'Adult / 18+ Policy',
      'Cookie Policy',
      'Contact / Legal',
    ]);
  });

  it('has all of them, each with a route', () => {
    expect(availableLegalPages()).toHaveLength(REQUIRED_LEGAL_PAGES.length);
    for (const page of availableLegalPages()) {
      expect(page.available, page.label).toBe(true);
      expect(page.path, page.label).toMatch(/^\/[a-z-]+$/);
    }
  });

  it('renders every one of them as a working link', () => {
    const html = render();
    expect(html).toContain('Legal and safety');
    for (const page of REQUIRED_LEGAL_PAGES) {
      expect(html, page.label).toContain(`href="${page.path}"`);
      expect(html, page.label).toContain(page.label);
    }
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
