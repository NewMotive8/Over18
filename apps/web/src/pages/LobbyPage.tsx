import { useMemo, useRef, useState, type ReactNode } from 'react';
import { useCharacters } from '../hooks/useCharacters';
import { CATEGORIES, buildHeroSlides, personaTags, type Category } from '../lib/lobbyContent';
import LobbyTopBar from '../components/lobby/LobbyTopBar';
import CategoryPills from '../components/lobby/CategoryPills';
import HeroCarousel from '../components/lobby/HeroCarousel';
import PlayWithMeCarousel from '../components/lobby/PlayWithMeCarousel';
import DiscoverySearch from '../components/lobby/DiscoverySearch';
import PersonaGridCard from '../components/lobby/PersonaGridCard';
import CommunityPromoCard from '../components/lobby/CommunityPromoCard';
import EmptyState from '../components/EmptyState';
import { DiscoverIcon, SparkleIcon } from '../components/icons';

/** Lobby loading placeholder: shimmer hero + rail, so the page never flashes empty. */
function LobbySkeleton() {
  return (
    <div className="flex flex-col gap-6 pb-8 pt-3" data-testid="lobby-skeleton">
      <div className="px-4">
        <div className="h-8 w-2/3 animate-pulse rounded-full bg-zinc-900" />
      </div>
      <div className="aspect-[16/11] w-full animate-pulse bg-zinc-900" />
      <div className="flex gap-3 overflow-hidden px-4">
        {Array.from({ length: 3 }, (_, i) => (
          <div key={i} className="aspect-[3/4] w-40 shrink-0 animate-pulse rounded-2xl bg-zinc-900" />
        ))}
      </div>
    </div>
  );
}

export default function LobbyPage() {
  const { state, reload } = useCharacters();
  const [category, setCategory] = useState<Category>('All');
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  const characters = state.status === 'ready' ? state.characters : [];
  const heroSlides = useMemo(() => buildHeroSlides(characters), [characters]);

  // The category pills + search filter the discovery GRID (the results surface);
  // the hero and "Play with me" rails stay curated/featured.
  const gridPersonas = useMemo(() => {
    const q = query.trim().toLowerCase();
    return characters
      .map((character, index) => ({ character, index }))
      .filter(({ character, index }) => {
        const inCategory = category === 'All' || personaTags(character, index).includes(category);
        const inQuery = q.length === 0 || character.displayName.toLowerCase().includes(q);
        return inCategory && inQuery;
      });
  }, [characters, category, query]);

  const focusSearch = () => {
    searchRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    searchRef.current?.focus({ preventScroll: true });
  };

  // ── Loading ─────────────────────────────────────────────────────────────
  if (state.status === 'loading') {
    return (
      <div className="flex flex-1 flex-col">
        <LobbyTopBar onSearch={focusSearch} />
        <LobbySkeleton />
      </div>
    );
  }

  // ── Error ───────────────────────────────────────────────────────────────
  if (state.status === 'error') {
    return (
      <div className="flex flex-1 flex-col">
        <LobbyTopBar onSearch={focusSearch} />
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

  // ── Empty (no characters at all) ─────────────────────────────────────────
  if (characters.length === 0) {
    return (
      <div className="flex flex-1 flex-col">
        <LobbyTopBar onSearch={focusSearch} />
        <div className="flex flex-1 flex-col justify-center px-4">
          <EmptyState
            icon={<DiscoverIcon />}
            title="No companions yet"
            description="New companions are on their way. Check back soon."
            badge="Coming soon"
          />
        </div>
      </div>
    );
  }

  // ── Ready ────────────────────────────────────────────────────────────────
  const gridNodes = gridPersonas.map(({ character, index }) => (
    <PersonaGridCard key={character.id} character={character} index={index} />
  ));
  // Mix in the community promo card to prove the feed hosts multiple card types.
  const withPromo: ReactNode[] = [...gridNodes];
  withPromo.splice(Math.min(2, withPromo.length), 0, <CommunityPromoCard key="community-promo" />);

  return (
    <div className="flex flex-1 flex-col">
      <LobbyTopBar onSearch={focusSearch} />

      <div className="flex flex-col gap-6 pb-8 pt-3">
        {/* Initial filter tabs */}
        <div className="px-4">
          <CategoryPills categories={CATEGORIES} active={category} onSelect={setCategory} />
        </div>

        <HeroCarousel slides={heroSlides} />

        <PlayWithMeCarousel characters={characters} />

        {/* Scrolled Discovery & Search hub */}
        <DiscoverySearch
          ref={searchRef}
          query={query}
          onQueryChange={setQuery}
          active={category}
          onSelectCategory={setCategory}
        />

        {/* Two-column discovery grid with mixed card types */}
        <div className="px-4">
          {gridPersonas.length === 0 ? (
            <EmptyState
              icon={<DiscoverIcon />}
              title="No companions match"
              description="Try a different category or clear your search."
              action={
                <button
                  type="button"
                  onClick={() => {
                    setCategory('All');
                    setQuery('');
                  }}
                  className="rounded-lg bg-rose-600 px-5 py-2 text-sm font-semibold text-white transition-colors hover:bg-rose-500"
                >
                  Clear filters
                </button>
              }
            />
          ) : (
            <div className="grid grid-cols-2 gap-3">{withPromo}</div>
          )}
        </div>
      </div>
    </div>
  );
}
