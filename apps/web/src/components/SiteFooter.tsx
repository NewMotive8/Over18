import { Link } from 'react-router-dom';
import { MINIMUM_AGE } from '../lib/ageGate';
import { AdultsOnlyBadge } from '../legal/LegalPage';
import { LEGAL_DOCUMENTS } from '../legal/legalContent';

/**
 * The site footer.
 *
 * ── IT LINKS TO PAGES THAT EXIST, AND TO NO OTHERS ───────────────────────────
 *
 * A footer full of Terms / Privacy / Cookies links is the normal shape, and
 * writing that shape here would have meant either inventing the pages or
 * linking to routes that 404. Both are worse than an honest gap: a link to
 * "Terms of Service" tells a visitor that terms exist and have been agreed,
 * and a 404 behind it tells them so for exactly as long as it takes to click.
 *
 * So the pages are DECLARED rather than linked, in `REQUIRED_LEGAL_PAGES`, and
 * only the ones marked available are rendered. The list is the gap, in code:
 * when a page is written, its entry flips to `available: true` with its route,
 * one line, and the footer picks it up. The test asserts both halves -- that an
 * unavailable page is never rendered, and that an available one is.
 */

export interface LegalPage {
  /** What the link would say. */
  readonly label: string;
  /** The route, once the page exists. */
  readonly path: string | null;
  /** False until the page has actually been written and routed. */
  readonly available: boolean;
}

/**
 * The pages an adult site of this kind needs, and whether we have them.
 *
 * NOW WRITTEN AND ROUTED, which is what this list was built to wait for. Each
 * entry is derived from `LEGAL_DOCUMENTS` rather than restated here, so a
 * document and its footer link cannot drift apart: adding one adds its link,
 * and a link can never point at a route that does not exist.
 *
 * The documents themselves are drafts carrying marked placeholders — see
 * `legal/legalContent.ts`. The footer links to them regardless, because the
 * alternative is a site with no reachable privacy policy at all.
 */
export const REQUIRED_LEGAL_PAGES: readonly LegalPage[] = LEGAL_DOCUMENTS.map((doc) => ({
  label: doc.label,
  path: `/${doc.slug}`,
  available: true,
}));

/** The ones with somewhere to point. */
export function availableLegalPages(
  pages: readonly LegalPage[] = REQUIRED_LEGAL_PAGES,
): readonly LegalPage[] {
  return pages.filter((page) => page.available && page.path !== null);
}

export default function SiteFooter({
  pages = REQUIRED_LEGAL_PAGES,
  year = new Date().getFullYear(),
}: {
  pages?: readonly LegalPage[];
  year?: number;
}) {
  const links = availableLegalPages(pages);

  return (
    <footer className="mt-10 border-t border-zinc-800 px-4 py-8 text-xs leading-relaxed text-zinc-500">
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-sm font-semibold tracking-tight text-zinc-300">
            Over<span className="text-rose-500">18</span>
          </p>
          {/* OUR OWN DESIGNATION, not a borrowed badge. No regulator, no
              certification body and no payment network is implied here, because
              we hold no mark from any of them. */}
          <AdultsOnlyBadge />
        </div>

        {/* The notice, stated once and stated plainly. */}
        <p className="font-medium text-zinc-400">
          {MINIMUM_AGE}+ — this site contains sexually explicit material intended for adults only.
        </p>

        {/*
          THE AI DISCLOSURE IS A STATEMENT OF FACT, NOT A LEGAL TERM. What the
          characters are is something this codebase knows for certain, and
          saying it is owed to anyone looking at them. It commits us to nothing
          and so needs nobody's approval.
        */}
        <p>
          Every character is fictional and AI-generated. Images, voices and conversations are
          synthetic — no real person is depicted, and no exchange here is with a human being.
        </p>

        {links.length > 0 && (
          <nav aria-label="Legal and safety">
            <ul className="flex flex-wrap gap-x-4 gap-y-2">
              {links.map((page) => (
                <li key={page.label}>
                  <Link to={page.path as string} className="transition hover:text-zinc-300">
                    {page.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        )}

        <p className="text-zinc-600">© {year} Over18</p>
      </div>
    </footer>
  );
}
