import { useCallback, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { PublicCharacter } from '@over18/shared';
import { useCharacters } from '../hooks/useCharacters';
import SwipeDeck, { type SwipeDeckHandle } from '../components/SwipeDeck';
import DiscoverActions from '../components/DiscoverActions';
import EmptyState from '../components/EmptyState';
import { DiscoverIcon, LikeIcon, SparkleIcon } from '../components/icons';
import type { SwipeDecision } from '../lib/swipe';

/**
 * Swipe discovery (US-19), preserved as a SECONDARY interaction under the v2
 * lobby (US-28). The Tinder-style deck is no longer the primary Discover
 * experience — the media-rich lobby is — but it remains fully available here at
 * /discover/swipe and reuses the exact US-19 deck components unchanged.
 */
function DeckSkeleton() {
  return (
    <div className="flex flex-1 min-h-0 flex-col gap-4" data-testid="discover-skeleton">
      <div className="relative min-h-[420px] flex-1 animate-pulse overflow-hidden rounded-3xl border border-zinc-800 bg-zinc-900">
        <div className="absolute inset-x-0 bottom-0 flex flex-col gap-2 p-5">
          <div className="h-7 w-1/2 rounded bg-zinc-800" />
          <div className="h-4 w-3/4 rounded bg-zinc-800" />
        </div>
      </div>
      <div className="flex items-center justify-center gap-6">
        <div className="h-14 w-14 animate-pulse rounded-full bg-zinc-900" />
        <div className="h-11 w-11 animate-pulse rounded-full bg-zinc-900" />
        <div className="h-14 w-14 animate-pulse rounded-full bg-zinc-900" />
      </div>
    </div>
  );
}

export default function SwipePage() {
  const { state, reload } = useCharacters();
  const navigate = useNavigate();
  const deckRef = useRef<SwipeDeckHandle>(null);

  const [index, setIndex] = useState(0);
  const [liked, setLiked] = useState<Set<string>>(() => new Set());
  const [feedback, setFeedback] = useState<string | null>(null);
  const feedbackTimer = useRef<number | null>(null);

  const characters = state.status === 'ready' ? state.characters : [];
  const current: PublicCharacter | undefined = characters[index];
  const next: PublicCharacter | undefined = characters[index + 1];

  const flash = useCallback((message: string) => {
    setFeedback(message);
    if (feedbackTimer.current) window.clearTimeout(feedbackTimer.current);
    feedbackTimer.current = window.setTimeout(() => setFeedback(null), 1100);
  }, []);

  const openProfile = useCallback(
    (character: PublicCharacter) => navigate(`/characters/${character.id}`),
    [navigate],
  );

  const handleDecision = useCallback(
    (decision: SwipeDecision, character: PublicCharacter) => {
      if (decision === 'like') {
        setLiked((prev) => {
          const nextSet = new Set(prev);
          nextSet.add(character.id);
          return nextSet;
        });
        flash(`Liked ${character.displayName}`);
      } else {
        flash(`Passed on ${character.displayName}`);
      }
      setIndex((i) => i + 1);
    },
    [flash],
  );

  const restart = useCallback(() => {
    setIndex(0);
    setFeedback(null);
  }, []);

  const backLink = (
    <Link
      to="/characters"
      className="inline-flex w-fit items-center gap-1 text-sm text-zinc-400 transition-colors hover:text-zinc-200"
    >
      <span aria-hidden>←</span> Back to lobby
    </Link>
  );

  const header = useMemo(
    () => (
      <header className="flex items-end justify-between">
        <div className="flex flex-col gap-0.5">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-rose-500">Swipe</span>
          <h2 className="text-xl font-semibold tracking-tight text-white">Quick discovery</h2>
        </div>
        {state.status === 'ready' && characters.length > 0 && current && (
          <span className="rounded-full border border-zinc-800 bg-zinc-900 px-2.5 py-1 text-[11px] font-medium text-zinc-400">
            {index + 1} / {characters.length}
          </span>
        )}
      </header>
    ),
    [state.status, characters.length, current, index],
  );

  if (state.status === 'loading') {
    return (
      <div className="flex flex-1 min-h-0 flex-col gap-3">
        {backLink}
        <DeckSkeleton />
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <div className="flex flex-1 min-h-0 flex-col justify-center gap-3">
        {backLink}
        <EmptyState
          icon={<SparkleIcon />}
          title="Couldn't load characters"
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
    );
  }

  if (characters.length === 0) {
    return (
      <div className="flex flex-1 min-h-0 flex-col justify-center gap-3">
        {backLink}
        <EmptyState
          icon={<DiscoverIcon />}
          title="No one's here yet"
          description="New characters are on their way. Check back soon."
          badge="Coming soon"
        />
      </div>
    );
  }

  if (!current) {
    const likedCount = liked.size;
    return (
      <div className="flex flex-1 min-h-0 flex-col justify-center gap-3">
        {backLink}
        <EmptyState
          icon={<LikeIcon />}
          title="You're all caught up"
          description={
            likedCount > 0
              ? `You liked ${likedCount} ${likedCount === 1 ? 'character' : 'characters'}. More are on the way.`
              : 'That’s everyone for now. More characters are on the way.'
          }
          action={
            <button
              type="button"
              onClick={restart}
              className="rounded-lg bg-rose-600 px-5 py-2 text-sm font-semibold text-white transition-colors hover:bg-rose-500"
            >
              Start over
            </button>
          }
        />
      </div>
    );
  }

  return (
    <div className="flex flex-1 min-h-0 flex-col gap-3">
      {backLink}
      {header}

      <div className="relative min-h-[420px] flex-1">
        <div className="absolute inset-0">
          <SwipeDeck
            ref={deckRef}
            current={current}
            next={next}
            onDecision={handleDecision}
            onOpen={openProfile}
          />
        </div>

        {feedback && (
          <div
            role="status"
            className="pointer-events-none absolute inset-x-0 top-3 z-10 mx-auto w-fit rounded-full bg-zinc-950/80 px-4 py-1.5 text-sm font-medium text-white backdrop-blur"
          >
            {feedback}
          </div>
        )}
      </div>

      <DiscoverActions
        onPass={() => deckRef.current?.pass()}
        onOpen={() => openProfile(current)}
        onLike={() => deckRef.current?.like()}
      />
    </div>
  );
}
