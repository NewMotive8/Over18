import { Link } from 'react-router-dom';
import { DRAFT_NOTICE, LEGAL_DOCUMENTS, type LegalDocument } from './legalContent';

/**
 * One legal document, rendered.
 *
 * ── WHY THESE PAGES SIT OUTSIDE THE APP SHELL ────────────────────────────────
 *
 * `AppShell` renders the age gate INSTEAD OF its outlet until a visitor
 * confirms they are 18 — which is right for every screen that carries adult
 * content, and wrong for these. A privacy policy behind an adult warning cannot
 * be read by the person most likely to need it: somebody deciding whether to
 * enter, somebody under 18 looking for how to report, or a regulator.
 *
 * So these routes are declared outside the shell with this layout instead.
 * Nothing about the gate changes -- no branch, no exception list, no new
 * condition in `AppShell`. The gate still guards every route it guarded
 * before, and these pages simply never enter it. They carry no adult content
 * to withhold.
 *
 * A PURE RENDER, like every other component here: the text is data in
 * `legalContent`, so this file holds the page furniture and nothing else, and
 * the node test environment can assert the markup without a DOM.
 */

/** The 18+ designation. Our own words, never a borrowed badge. */
export function AdultsOnlyBadge({ className = '' }: { className?: string }) {
  return (
    <span
      className={`inline-flex items-center gap-2 rounded-full border border-rose-500/50 bg-rose-500/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-rose-300 ${className}`}
    >
      <span className="text-sm font-bold">18+</span>
      <span aria-hidden="true" className="text-rose-500/60">
        |
      </span>
      Adults Only
    </span>
  );
}

export default function LegalPage({ document: doc }: { document: LegalDocument }) {
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-3xl flex-col bg-zinc-950 text-zinc-100">
      <header className="sticky top-0 z-10 flex items-center justify-between gap-4 border-b border-zinc-800 bg-zinc-950/90 px-4 py-3 backdrop-blur pt-[max(0.75rem,env(safe-area-inset-top))]">
        <Link
          to="/"
          aria-label="Over18 — back to the site"
          className="text-lg font-semibold tracking-tight text-white transition-opacity hover:opacity-80"
        >
          Over<span className="text-rose-500">18</span>
        </Link>
        <Link to="/" className="text-xs font-medium text-rose-400 transition hover:text-rose-300">
          ← Back to the site
        </Link>
      </header>

      <main className="flex flex-1 flex-col gap-6 px-4 pb-16 pt-6">
        <div className="flex flex-col gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-rose-500">
            {doc.eyebrow}
          </span>
          <h1 className="text-2xl font-semibold tracking-tight text-white">{doc.title}</h1>
          <p className="text-sm text-zinc-400">{doc.summary}</p>
        </div>

        {/* The draft status, stated before the text rather than in a footnote. */}
        <p
          role="note"
          className="rounded-2xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-xs leading-relaxed text-amber-200"
        >
          {DRAFT_NOTICE}
        </p>

        {doc.sections.map((section) => (
          <section key={section.heading} className="flex flex-col gap-2">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-300">
              {section.heading}
            </h2>
            {section.paragraphs?.map((text) => (
              <p key={text} className="text-sm leading-relaxed text-zinc-400">
                {text}
              </p>
            ))}
            {section.bullets && (
              <ul className="flex list-disc flex-col gap-1.5 pl-5 text-sm leading-relaxed text-zinc-400 marker:text-zinc-600">
                {section.bullets.map((text) => (
                  <li key={text}>{text}</li>
                ))}
              </ul>
            )}
          </section>
        ))}
      </main>

      <footer className="border-t border-zinc-800 px-4 py-8">
        <div className="flex flex-col gap-4">
          <AdultsOnlyBadge className="self-start" />
          <nav aria-label="Legal and safety">
            <ul className="flex flex-wrap gap-x-4 gap-y-2 text-xs text-zinc-500">
              {LEGAL_DOCUMENTS.map((other) => (
                <li key={other.slug}>
                  <Link
                    to={`/${other.slug}`}
                    aria-current={other.slug === doc.slug ? 'page' : undefined}
                    className={
                      other.slug === doc.slug
                        ? 'text-zinc-300'
                        : 'transition hover:text-zinc-300'
                    }
                  >
                    {other.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
          <p className="text-xs text-zinc-600">
            Every character on Over18 is fictional and AI-generated. No real person is depicted.
          </p>
        </div>
      </footer>
    </div>
  );
}
