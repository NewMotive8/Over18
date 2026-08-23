import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  homeApi,
  type PublicCategoryPill,
  type PublicCharacterCard,
  type PublicHome,
} from '../lib/api';
import { homeSections } from '../lib/homeContent';
import LobbyTopBar from '../components/lobby/LobbyTopBar';
import HeroCarousel from '../components/lobby/HeroCarousel';
import HomeBannerSlot from '../components/lobby/HomeBannerSlot';
import PlayWithMeCarousel from '../components/lobby/PlayWithMeCarousel';
import PersonaGridCard from '../components/lobby/PersonaGridCard';
import CategoryPills from '../components/lobby/CategoryPills';
import ClipRail from '../components/lobby/ClipRail';
import CommunityPromoCard from '../components/lobby/CommunityPromoCard';
import EmptyState from '../components/EmptyState';
import { DiscoverIcon, FilterIcon, SearchIcon, SparkleIcon } from '../components/icons';

/**
 * Home.
 *
 * PRESENTATION IS THE ORIGINAL DESIGN; CONTENT IS THE CMS. The layout, the
 * components and their styling are the ones this product shipped: header, Hero
 * carousel, the Play with me rail, "Over18 AI Companions", the search box, the
 * horizontal category pills and the character-card grid. None of that is
 * redesigned here.
 *
 * WHAT CHANGED IS WHERE THE CONTENT COMES FROM. The page used to invent it —
 * a hard-coded twelve-entry category list, category membership derived from
 * `index + displayName.length`, NEW/HOT badges from `index % 4`, and a
 * hard-coded promo hero. An operator could change none of it. Every rail,
 * pill, chip and card now comes from what an operator published.
 *
 * ONE EDITORIAL CATEGORY SYSTEM. The pills are App Categories — the same ones
 * merchandised in Admin, in the operator's own order. A category holds clips;
 * this page shows characters, so selecting a pill asks the server for the
 * characters with at least one publicly reachable clip in that category.
 * Discovery categories are not exposed here: they remain the keyword index
 * behind free-text matching and future automatic tagging.
 *
 * "ALL" IS THE DEFAULT AND MEANS NO FILTER. Nothing is auto-selected. That is
 * deliberate: pre-selecting the first pill made every search return nothing
 * whenever that category happened to be empty, which looked exactly like a
 * broken search box.
 */

function LobbySkeleton() {
  return (
    <div className="flex flex-col gap-6 pb-8 pt-3" data-testid="lobby-skeleton">
      <div className="aspect-[16/11] w-full animate-pulse bg-zinc-900" />
      <div className="flex gap-3 overflow-hidden px-4">
        {Array.from({ length: 3 }, (_, i) => (
          <div key={i} className="aspect-[3/4] w-40 shrink-0 animate-pulse rounded-2xl bg-zinc-900" />
        ))}
      </div>
      <span className="sr-only">Loading Home…</span>
    </div>
  );
}

type Status = 'loading' | 'ready' | 'error';

export default function LobbyPage() {
  const [status, setStatus] = useState<Status>('loading');
  const [home, setHome] = useState<PublicHome | null>(null);
  const [categories, setCategories] = useState<PublicCategoryPill[]>([]);
  const [attempt, setAttempt] = useState(0);

  /** null is "All" — no category filter. Nothing is auto-selected. */
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  /** The original Advanced-filters toggle, restored from DiscoverySearch. */
  const [showFilters, setShowFilters] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PublicCharacterCard[]>([]);
  const searchRef = useRef<HTMLInputElement>(null);

  const focusSearch = useCallback(() => {
    searchRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    searchRef.current?.focus();
  }, []);

  /* ---------------- Home + the category pills ---------------- */

  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    Promise.all([homeApi.get(), homeApi.categories()])
      .then(([homePayload, pills]) => {
        if (cancelled) return;
        setHome(homePayload);
        setCategories(pills.categories);
        setStatus('ready');
      })
      .catch(() => !cancelled && setStatus('error'));
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  /* ---------------- The character grid ---------------- */

  useEffect(() => {
    let cancelled = false;
    homeApi
      .browse({ category: activeCategory, q: query })
      .then((res) => !cancelled && setResults(res.characters))
      .catch(() => !cancelled && setResults([]));
    return () => {
      cancelled = true;
    };
  }, [activeCategory, query, attempt]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  const sections = useMemo(() => (home ? homeSections(home) : []), [home]);

  if (status === 'loading') {
    return (
      <div className="flex flex-1 flex-col">
        <LobbyTopBar />
        <LobbySkeleton />
      </div>
    );
  }

  if (status === 'error' || !home) {
    return (
      <div className="flex flex-1 flex-col">
        <LobbyTopBar />
        <div className="flex flex-1 flex-col justify-center px-4">
          <EmptyState
            icon={<SparkleIcon />}
            title="Couldn't load the lobby"
            description="Something went wrong on our side. Check your connection and try again."
            action={
              <button
                type="button"
                onClick={reload}
                className="rounded-lg bg-rose-600 px-5 py-2 text-sm font-semibold text-white transition-colors hover:bg-rose-500"
              >
                Retry
              </button>
            }
          />
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col">
      <LobbyTopBar onSearch={focusSearch} />

      <div className="flex flex-col gap-6 pb-8 pt-3">
        {/* ── Home: composed entirely from published CMS configuration ── */}
        <HeroCarousel clips={home.hero} />

        {sections.map((section) => {
          if (section.kind === 'play_with_me') {
            return <PlayWithMeCarousel key={section.key} characters={home.playWithMe} />;
          }
          // RECENTLY ADDED IS NOT RENDERED PUBLICLY. The approved lobby design
          // has no such rail, and this page must not introduce public sections
          // the design does not have. The CMS feature is untouched: the server
          // still composes it, `/api/home` still carries it, and the Home
          // composer still curates it — it simply has no public surface yet.
          if (section.kind === 'recently_added') return null;
          return <ClipRail key={section.key} rail={section.rail!} />;
        })}

        {/* Slot one: immediately before the Search section. */}
        <HomeBannerSlot banners={home.banners.before_search} label="Featured" />

        {/* ── Over18 AI Companions: heading, search, pills ── */}
        <section aria-label="Discover companions" className="flex flex-col gap-3 px-4">
          <h2 className="text-center text-xl font-black tracking-tight text-white">
            Over18 <span className="text-rose-500">AI Companions</span>
          </h2>

          <div className="relative">
            <input
              ref={searchRef}
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search companions by name…"
              aria-label="Search companions"
              className="w-full rounded-full border border-white/10 bg-white/5 py-3 pl-5 pr-12 text-sm text-white placeholder:text-zinc-500 focus:border-rose-500/60 focus:outline-none"
            />
            <span className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-zinc-400">
              <SearchIcon className="h-5 w-5" />
            </span>
          </div>

          <CategoryPills
            categories={categories}
            active={activeCategory}
            onSelect={setActiveCategory}
            size="sm"
            leading={
              <button
                type="button"
                onClick={() => setShowFilters((v) => !v)}
                aria-label="Advanced filters"
                aria-expanded={showFilters}
                className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border transition-colors ${
                  showFilters
                    ? 'border-rose-500/60 bg-rose-500/15 text-rose-300'
                    : 'border-white/10 bg-white/5 text-zinc-300 hover:text-white'
                }`}
              >
                <FilterIcon className="h-[18px] w-[18px]" />
              </button>
            }
          />

          {showFilters && (
            <div className="rounded-2xl border border-white/10 bg-zinc-900/70 p-3 text-xs text-zinc-400">
              <p className="font-semibold text-zinc-300">Advanced filters</p>
              <p className="mt-1">
                Refine by body type, personality and availability. Full filtering arrives in a later
                release — categories and search are live now.
              </p>
            </div>
          )}
        </section>

        {/* Results grid, with the separate Get 20 For Free card mixed in. */}
        <div className="px-4">
          {results.length === 0 ? (
            <EmptyState
              icon={<DiscoverIcon />}
              title="No companions match"
              description="Try a different category or clear your search."
              action={
                <button
                  type="button"
                  onClick={() => {
                    setQuery('');
                    setActiveCategory(null);
                  }}
                  className="rounded-lg bg-rose-600 px-5 py-2 text-sm font-semibold text-white transition-colors hover:bg-rose-500"
                >
                  Clear filters
                </button>
              }
            />
          ) : (
            <div className="grid grid-cols-2 gap-3">
              {results.slice(0, 2).map((character, index) => (
                <PersonaGridCard key={character.id} character={character} index={index} />
              ))}
              {/* Unchanged and separate from the CMS banner slots. */}
              <CommunityPromoCard />
              {results.slice(2).map((character, index) => (
                <PersonaGridCard key={character.id} character={character} index={index + 2} />
              ))}
            </div>
          )}
        </div>

        {/* Slot two: below the search results, above the footer. */}
        <HomeBannerSlot banners={home.banners.below_results} label="More from Over18" />
      </div>
    </div>
  );
}
