import { useCallback, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { PublicPlayWithMeCard } from '../lib/api';
import { usePlayWithMe } from '../hooks/usePlayWithMe';
import { useFavourites } from '../hooks/useFavourites';
import { heartAction, swipeAction } from '../lib/favourites';
import SwipeDeck, { type SwipeDeckHandle } from '../components/SwipeDeck';
import DiscoverActions from '../components/DiscoverActions';
import EmptyState from '../components/EmptyState';
import { DiscoverIcon, LikeIcon, SparkleIcon } from '../components/icons';
import type { SwipeDecision } from '../lib/swipe';

/**
 * Swipe discovery — the Tinder-style deck, kept as a secondary interaction
 * under the v2 lobby and reached from the Play with me rail.
 *
 * ── ONE POPULATION, SHARED WITH HOME ─────────────────────────────────────────
 *
 * The deck is `usePlayWithMe`, which reads `/api/play-with-me` — the SAME
 * `listPlayWithMe` that composes `home.playWithMe`. It used to be
 * `useCharacters` (`/api/characters`), which is every active character
 * regardless of what she has published, so the deck contained people the rail
 * had already dropped and the client dressed them in whatever media it could
 * find. Home and Swipe now cannot disagree, because there is one list.
 *
 * ── SWIPE, HEART, AND WHAT EACH ONE MEANS ────────────────────────────────────
 *
 *   left / pass   → move on. Writes nothing. Never touches a favourite.
 *   right / like  → save her, then move on. Already saved stays saved.
 *   heart tap     → toggle the saved state, IN PLACE. The only way to remove.
 *   tap the card  → open her profile.
 *
 * The mapping from a gesture to a stored change is `swipeAction` /
 * `heartAction` in `lib/favourites`, not an `if` in a handler here, so "a right
 * swipe never removes a favourite" is a function with a truth table a node test
 * can read.
 *
 * ── SIGNED OUT STILL BROWSES ─────────────────────────────────────────────────
 *
 * Swipe is a public route. Without an account the deck works, the profile opens
 * and passing works; the heart is simply unavailable, and a right swipe says so
 * rather than pretending to save. That is why `useFavourites` reports
 * 'signed-out' as a state distinct from an error.
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
  const { state, reload } = usePlayWithMe();
  const favourites = useFavourites();
  const navigate = useNavigate();
  const deckRef = useRef<SwipeDeckHandle>(null);

  const [index, setIndex] = useState(0);
  const [feedback, setFeedback] = useState<string | null>(null);
  const feedbackTimer = useRef<number | null>(null);

  const characters = state.status === 'ready' ? state.characters : [];
  const current: PublicPlayWithMeCard | undefined = characters[index];
  const next: PublicPlayWithMeCard | undefined = characters[index + 1];
  const signedOut = favourites.status === 'signed-out';
  const currentFavourited = current ? favourites.favourited.has(current.id) : false;
  /**
   * The heart is inert until the persisted set has actually arrived.
   *
   * Before then `favourited` is an empty set, so every heart would read as
   * outline — a state that happens to be wrong for anyone already saved. The
   * fill must never be a guess, so the control does not invite a tap it cannot
   * yet answer honestly. Swiping is unaffected; only the heart waits.
   */
  const heartUnavailable = signedOut || favourites.status === 'loading';

  const flash = useCallback((message: string) => {
    setFeedback(message);
    if (feedbackTimer.current) window.clearTimeout(feedbackTimer.current);
    feedbackTimer.current = window.setTimeout(() => setFeedback(null), 1400);
  }, []);

  const openProfile = useCallback(
    (character: PublicPlayWithMeCard) => navigate(`/characters/${character.id}`),
    [navigate],
  );

  /**
   * A completed swipe.
   *
   * The deck advances EITHER WAY and immediately — the save is not something a
   * user should wait on, and a failed save must not strand them on a card they
   * have already flung. The message that follows reports what actually
   * happened, so a signed-out right swipe says "sign in", not "liked".
   */
  const handleDecision = useCallback(
    (decision: SwipeDecision, character: PublicPlayWithMeCard) => {
      const action = swipeAction(decision, favourites.favourited.has(character.id));
      setIndex((i) => i + 1);

      if (decision === 'pass') {
        flash(`Passed on ${character.displayName}`);
        return;
      }
      void favourites.run(character.id, action).then((outcome) => {
        if (outcome === 'signed-out') flash('Sign in to save Favourites');
        else if (outcome === 'failed') flash(`Couldn't save ${character.displayName}`);
        // 'unchanged' is a right swipe on someone already saved: she stays
        // saved, and saying so is more honest than a second "Saved!".
        else if (outcome === 'unchanged') flash(`${character.displayName} is in Favourites`);
        else flash(`Saved ${character.displayName} to Favourites`);
      });
    },
    [favourites, flash],
  );

  /** The heart. Toggles the stored state and stays on the card. */
  const toggleFavourite = useCallback(() => {
    if (!current) return;
    const character = current;
    void favourites
      .run(character.id, heartAction(favourites.favourited.has(character.id)))
      .then((outcome) => {
        if (outcome === 'signed-out') flash('Sign in to save Favourites');
        else if (outcome === 'failed') flash('Something went wrong');
        else if (outcome === 'removed') flash(`Removed ${character.displayName} from Favourites`);
        else flash(`Saved ${character.displayName} to Favourites`);
      });
  }, [current, favourites, flash]);

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

  /**
   * NOTHING PUBLISHED MEANS AN EMPTY DECK, and that is the correct answer.
   * The old page could not reach this state honestly: `/api/characters` returned
   * everyone, so the deck was never empty and never truthful.
   */
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
    const savedCount = favourites.favourited.size;
    return (
      <div className="flex flex-1 min-h-0 flex-col justify-center gap-3">
        {backLink}
        <EmptyState
          icon={<LikeIcon />}
          title="You're all caught up"
          description={
            savedCount > 0
              ? `You have ${savedCount} ${savedCount === 1 ? 'character' : 'characters'} in Favourites. More are on the way.`
              : 'That’s everyone for now. More characters are on the way.'
          }
          action={
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={restart}
                className="rounded-lg bg-rose-600 px-5 py-2 text-sm font-semibold text-white transition-colors hover:bg-rose-500"
              >
                Start over
              </button>
              {savedCount > 0 && (
                <Link
                  to="/favourites"
                  className="rounded-lg border border-zinc-700 px-5 py-2 text-sm font-semibold text-zinc-200 transition-colors hover:border-zinc-500"
                >
                  Favourites
                </Link>
              )}
            </div>
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
        onToggleFavourite={toggleFavourite}
        favourited={currentFavourited}
        favouriteDisabled={heartUnavailable}
      />

      {signedOut && (
        <p className="text-center text-xs text-zinc-500">
          <Link to="/login" className="font-semibold text-rose-400 hover:text-rose-300">
            Sign in
          </Link>{' '}
          to save characters to Favourites.
        </p>
      )}
    </div>
  );
}
