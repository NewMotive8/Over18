import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import SiteFooter, { REQUIRED_LEGAL_PAGES, availableLegalPages, type LegalPage } from './SiteFooter';

const render = (pages?: readonly LegalPage[], year?: number) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <SiteFooter {...(pages ? { pages } : {})} {...(year ? { year } : {})} />
    </MemoryRouter>,
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
 * THE GAP, HELD OPEN DELIBERATELY.
 *
 * Every required page is currently missing, and the footer's contract is that a
 * missing page is never linked. A link saying "Terms of Service" asserts that
 * terms exist; a 404 behind it tells the visitor otherwise one click later.
 */
describe('legal links', () => {
  it('declares every page an adult site of this kind needs', () => {
    expect(REQUIRED_LEGAL_PAGES.map((p) => p.label)).toEqual([
      'Terms of Service',
      'Privacy Policy',
      'Cookie Policy',
      'AI & content disclosure',
      'Safety & reporting',
      'Contact',
    ]);
  });

  it('has none of them yet', () => {
    expect(availableLegalPages()).toEqual([]);
  });

  it('renders no link, and no nav, while none exist', () => {
    const html = render();
    expect(html).not.toContain('<a');
    expect(html).not.toContain('Legal and safety');
    for (const page of REQUIRED_LEGAL_PAGES) {
      expect(html).not.toContain(page.label);
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
