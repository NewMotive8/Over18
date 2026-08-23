import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  discoveryApi,
  homeApi,
  type PublicClip,
  type PublicDiscoveryCategory,
  type PublicHome,
} from '../lib/api';
import {
  defaultCategorySlug,
  homeSections,
  resultsLabel,
  type DiscoveryView,
} from '../lib/homeContent';
import LobbyTopBar from '../components/lobby/LobbyTopBar';
import HeroCarousel from '../components/lobby/HeroCarousel';
import HomeBannerSlot from '../components/lobby/HomeBannerSlot';
import CharacterRail from '../components/lobby/CharacterRail';
import ClipRail from '../components/lobby/ClipRail';
import DiscoveryStrip from '../components/lobby/DiscoveryStrip';
import FeedView from '../components/lobby/FeedView';
import CommunityPromoCard from '../components/lobby/CommunityPromoCard';
import ClipMedia from '../components/lobby/ClipMedia';
import EmptyState from '../components/EmptyState';
import { DiscoverIcon, SearchIcon, SparkleIcon } from '../components/icons';

/**
 * Home (US-102.4).
 *
 * EVERYTHING ON THIS PAGE IS CMS-CONTROLLED NOW. It used to invent its own
 * content — a hard-coded twelve-entry category list starting with "All",
 * category membership derived from `index + displayName.length`, NEW/HOT badges
 * from `index % 4`, and a hard-coded promo hero. An operator could change
 * nothing about what the app showed. The page now renders exactly what
 * `/api/home` composes, and nothing else.
 *
 * THE PAGE HAS TWO HALVES, AND THEY ARE DIFFERENT SYSTEMS.
 *
 *   ABOVE: Home. Hero, then Play with Me, then Recently Added, then the
 *   published App CMS Categories in the operator's Home order, with the two
 *   banner slots placed around the Search section.
 *
 *   BELOW: Discovery. "Over18 AI Companions", Search, and the keyword-driven
 *   category strip over all content. Those pills are NOT App Categories — they
 *   are keyword queries, and selecting one never touches the rails above.
 *
 * SEARCH AND CATEGORIES STAY SEPARATE. They are two independent filters on one
 * result set: selecting a category does not clear the query and searching does
 * not clear the category. The server applies both the same way.
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
  const [categories, setCategories] = useState<PublicDiscoveryCategory[]>([]);
  const [attempt, setAttempt] = useState(0);

  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [clips, setClips] = useState<PublicClip[]>([]);
  const [total, setTotal] = useState(0);
  const [view, setView] = useState<DiscoveryView>('grid');
  const searchRef = useRef<HTMLInputElement>(null);

  /* ---------------- Home + the discovery strip ---------------- */

  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    Promise.all([homeApi.get(), discoveryApi.categories()])
      .then(([homePayload, strip]) => {
        if (cancelled) return;
        setHome(homePayload);
        setCategories(strip.categories);
        // The first pill is the default. WHICH one that is comes from the
        // operator's ordering, not from a name this page knows.
        setActiveCategory((current) => current ?? defaultCategorySlug(strip.categories));
        setStatus('ready');
      })
      .catch(() => !cancelled && setStatus('error'));
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  /* ---------------- Discovery results ---------------- */

  useEffect(() => {
    let cancelled = false;
    discoveryApi
      .clips({ category: activeCategory, q: query })
      .then((res) => {
        if (cancelled) return;
        setClips(res.clips);
        setTotal(res.total);
      })
      .catch(() => {
        if (cancelled) return;
        setClips([]);
        setTotal(0);
      });
    return () => {
      cancelled = true;
    };
  }, [activeCategory, query, attempt]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  const sections = useMemo(() => (home ? homeSections(home) : []), [home]);
  const activeCategoryName = useMemo(
    () => categories.find((c) => c.slug === activeCategory)?.name ?? null,
    [categories, activeCategory],
  );

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
      <LobbyTopBar />

      <div className="flex flex-col gap-6 pb-8 pt-3">
        {/* ── Home: composed entirely from published CMS configuration ── */}
        <HeroCarousel clips={home.hero} />

        {sections.map((section) => {
          if (section.kind === 'play_with_me') {
            return (
              <CharacterRail
                key={section.key}
                title={section.title}
                characters={home.playWithMe}
                action={{ label: 'Swipe mode', to: '/discover/swipe' }}
              />
            );
          }
          if (section.kind === 'recently_added') {
            return (
              <CharacterRail
                key={section.key}
                title={section.title}
                characters={home.recentlyAdded}
              />
            );
          }
          return <ClipRail key={section.key} rail={section.rail!} />;
        })}

        {/* Slot one: immediately before the Search section. */}
        <HomeBannerSlot banners={home.banners.before_search} label="Featured" />

        {/* ── Discovery: a different system, over all content ── */}
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

          <DiscoveryStrip
            categories={categories}
            active={activeCategory}
            onSelect={setActiveCategory}
          />

          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-zinc-500">{resultsLabel(total, query, activeCategoryName)}</p>
            <button
              type="button"
              onClick={() => setView('feed')}
              disabled={clips.length === 0}
              className="rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-semibold text-zinc-300 transition-colors hover:text-white disabled:opacity-40"
            >
              Feed view
            </button>
          </div>
        </section>

        {/* Results grid, with the separate Get 20 For Free card mixed in. */}
        <div className="px-4">
          {clips.length === 0 ? (
            <EmptyState
              icon={<DiscoverIcon />}
              title="Nothing matches"
              description="Try a different category or clear your search."
              action={
                <button
                  type="button"
                  onClick={() => {
                    setQuery('');
                    setActiveCategory(defaultCategorySlug(categories));
                  }}
                  className="rounded-lg bg-rose-600 px-5 py-2 text-sm font-semibold text-white transition-colors hover:bg-rose-500"
                >
                  Clear filters
                </button>
              }
            />
          ) : (
            <div className="grid grid-cols-2 gap-3">
              {clips.slice(0, 2).map((clip) => (
                <ClipTile key={clip.id} clip={clip} />
              ))}
              {/* Unchanged and separate from the CMS banner slots, per the ticket. */}
              <CommunityPromoCard />
              {clips.slice(2).map((clip) => (
                <ClipTile key={clip.id} clip={clip} />
              ))}
            </div>
          )}
        </div>

        {/* Slot two: below the search results, above the footer. */}
        <HomeBannerSlot banners={home.banners.below_results} label="More from Over18" />
      </div>

      {view === 'feed' && <FeedView clips={clips} onClose={() => setView('grid')} />}
    </div>
  );
}

/** One discovery result. Opens the character it belongs to. */
function ClipTile({ clip }: { clip: PublicClip }) {
  return (
    <Link
      to={`/characters/${clip.characterId}`}
      aria-label={`Open ${clip.characterName}`}
      className="relative block aspect-[3/4] w-full overflow-hidden rounded-2xl border border-white/5 bg-zinc-900"
    >
      <ClipMedia clip={clip} />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-zinc-950 to-transparent" />
      <span className="absolute inset-x-0 bottom-0 block truncate p-3 text-base font-bold text-white drop-shadow">
        {clip.characterName}
      </span>
    </Link>
  );
}
