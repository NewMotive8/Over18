import { Link } from 'react-router-dom';
import { MINIMUM_AGE } from '../lib/ageGate';
import { AdultsOnlyBadge } from '../legal/LegalPage';
import { LEGAL_DOCUMENTS } from '../legal/legalContent';

/**
 * The site footer.
 *
 * ── FOUR LINKS, NOT FIVE ─────────────────────────────────────────────────────
 *
 * The footer shows the short set a visitor actually scans for: Terms, Privacy,
 * Trust & Safety, Contact. Every document still exists and every route still
 * resolves -- this is a presentation decision about what belongs in a footer,
 * not a removal.
 *
 * TWO DOCUMENTS ARE REACHED BY A ROUTE RATHER THAN BY THIS LIST. `/cookies` is
 * live and `/adult-policy` is live; the latter is what "Trust & Safety" points
 * at, so the Adult / 18+ Policy is one click away under a plainer name. The
 * Cookie Policy is linked from the Privacy Policy's own text and from the
 * sibling nav on every legal page, which is where somebody looking for it
 * actually goes.
 *
 * ── A LINK STILL NEVER POINTS AT A ROUTE THAT DOES NOT EXIST ─────────────────
 *
 * The original contract survives the simplification: every entry below names a
 * document in `LEGAL_DOCUMENTS` by slug, and a test resolves each one. A label
 * can be chosen freely; a destination cannot be invented.
 */

export interface LegalPage {
  /** What the link says. */
  readonly label: string;
  /** The route it points at. */
  readonly path: string | null;
  /** False when the page has not been written and routed. */
  readonly available: boolean;
}

/** The slug each footer link points at, and the short label it carries. */
const FOOTER_LINKS: ReadonlyArray<{ label: string; slug: string }> = [
  { label: 'Terms', slug: 'terms' },
  { label: 'Privacy', slug: 'privacy' },
  { label: 'Trust & Safety', slug: 'adult-policy' },
  { label: 'Contact', slug: 'legal' },
];

/**
 * The visible footer links, resolved against the documents that exist.
 *
 * `available` is false for anything whose slug has no document, so a footer
 * entry pointing nowhere renders nothing rather than a dead link -- the same
 * rule this list has always enforced, now with labels chosen for the footer
 * rather than taken from each document's own title.
 */
export const REQUIRED_LEGAL_PAGES: readonly LegalPage[] = FOOTER_LINKS.map(({ label, slug }) => {
  const exists = LEGAL_DOCUMENTS.some((doc) => doc.slug === slug);
  return { label, path: exists ? `/${slug}` : null, available: exists };
});

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
