import { useCallback, useEffect, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import type { PublicCharacter } from '@over18/shared';
import { ApiRequestError, charactersApi, conversationsApi } from '../lib/api';
import { useAuth } from '../auth/AuthContext';

type ProfileState =
  | { status: 'loading' }
  | { status: 'not-found' }
  | { status: 'error' }
  | { status: 'ready'; character: PublicCharacter };

/**
 * Character profile (US-05). Start Chat (US-06) creates or reopens the
 * conversation with this character via the API, then navigates to it.
 * Logged-out users are sent to login and returned here afterwards.
 */
export default function CharacterDetailPage() {
  const { characterId } = useParams<{ characterId: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const { status: authStatus } = useAuth();
  const [state, setState] = useState<ProfileState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [imageFailed, setImageFailed] = useState(false);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  const startChat = useCallback(
    async (character: PublicCharacter) => {
      if (authStatus !== 'authenticated') {
        // Log in first, then come back to this profile to continue.
        navigate('/login', { state: { from: location.pathname } });
        return;
      }
      setStarting(true);
      setStartError(null);
      try {
        const conversation = await conversationsApi.start(character.id);
        navigate(`/chat/${conversation.id}`);
      } catch {
        setStartError("Couldn't start the conversation. Please try again.");
        setStarting(false);
      }
    },
    [authStatus, navigate, location.pathname],
  );

  useEffect(() => {
    if (!characterId) return;
    let cancelled = false;
    setState({ status: 'loading' });
    charactersApi
      .get(characterId)
      .then((character) => !cancelled && setState({ status: 'ready', character }))
      .catch((err) => {
        if (cancelled) return;
        setState(
          err instanceof ApiRequestError && err.status === 404
            ? { status: 'not-found' }
            : { status: 'error' },
        );
      });
    return () => {
      cancelled = true;
    };
  }, [characterId, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  const backLink = (
    <Link
      to="/characters"
      className="inline-flex items-center gap-1 text-sm text-zinc-400 transition-colors hover:text-zinc-200"
    >
      <span aria-hidden>←</span> All characters
    </Link>
  );

  if (state.status === 'loading') {
    return (
      <section className="flex flex-col gap-4" aria-busy>
        {backLink}
        <div className="animate-pulse overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900">
          <div className="aspect-[4/5] w-full bg-zinc-800" />
          <div className="flex flex-col gap-3 p-4">
            <div className="h-6 w-1/3 rounded bg-zinc-800" />
            <div className="h-4 w-full rounded bg-zinc-800" />
            <div className="h-4 w-2/3 rounded bg-zinc-800" />
          </div>
        </div>
      </section>
    );
  }

  if (state.status === 'not-found') {
    return (
      <section className="flex flex-col gap-4">
        {backLink}
        <div className="flex flex-col items-center gap-3 rounded-2xl border border-zinc-800 bg-zinc-900/60 px-6 py-14 text-center">
          <span aria-hidden className="text-3xl">
            ☾
          </span>
          <div>
            <p className="font-medium">This character isn't available</p>
            <p className="mt-1 text-sm text-zinc-400">
              They may have been retired. Plenty of others would love to meet you.
            </p>
          </div>
          <Link
            to="/characters"
            className="rounded-lg bg-rose-600 px-5 py-2 text-sm font-semibold text-white transition-colors hover:bg-rose-500"
          >
            Browse characters
          </Link>
        </div>
      </section>
    );
  }

  if (state.status === 'error') {
    return (
      <section className="flex flex-col gap-4">
        {backLink}
        <div className="flex flex-col items-center gap-4 rounded-2xl border border-zinc-800 bg-zinc-900/60 px-6 py-14 text-center">
          <span aria-hidden className="text-3xl">
            ⚠
          </span>
          <div>
            <p className="font-medium">Couldn't load this profile</p>
            <p className="mt-1 text-sm text-zinc-400">Check your connection and try again.</p>
          </div>
          <button
            type="button"
            onClick={retry}
            className="rounded-lg bg-rose-600 px-5 py-2 text-sm font-semibold text-white transition-colors hover:bg-rose-500"
          >
            Retry
          </button>
        </div>
      </section>
    );
  }

  const { character } = state;
  const showImage = character.profileImage && !imageFailed;

  return (
    <section className="flex flex-col gap-4 pb-24">
      {backLink}

      <div className="relative overflow-hidden rounded-2xl border border-zinc-800">
        <div className="aspect-[4/5] w-full">
          {showImage ? (
            <img
              src={character.profileImage!}
              alt={character.displayName}
              onError={() => setImageFailed(true)}
              className="h-full w-full object-cover"
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-zinc-800 to-zinc-900 text-8xl font-semibold text-rose-500/70">
              {character.displayName.charAt(0)}
            </div>
          )}
        </div>
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-zinc-950 via-zinc-950/50 to-transparent" />
        <div className="absolute inset-x-0 bottom-0 p-4">
          <h2 className="text-2xl font-bold text-white">{character.displayName}</h2>
          <p className="mt-1 text-sm leading-snug text-zinc-300">{character.shortBio}</p>
        </div>
      </div>

      <div className="flex flex-col gap-4">
        <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
            Personality
          </h3>
          <p className="mt-2 text-sm leading-relaxed text-zinc-300">{character.personality}</p>
        </div>

        {character.interests.length > 0 && (
          <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
              Interests
            </h3>
            <ul className="mt-2 flex flex-wrap gap-2">
              {character.interests.map((interest) => (
                <li
                  key={interest}
                  className="rounded-full border border-zinc-700 bg-zinc-800/80 px-3 py-1 text-xs text-zinc-300"
                >
                  {interest}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
            Conversation style
          </h3>
          <p className="mt-2 text-sm leading-relaxed text-zinc-300">{character.conversationStyle}</p>
        </div>
      </div>

      {/* Sticky CTA above the bottom nav so it's always in thumb's reach */}
      <div className="fixed inset-x-0 bottom-14 z-10 mx-auto w-full max-w-lg px-4 pb-2">
        {startError && (
          <p role="alert" className="mb-2 rounded-lg border border-red-900 bg-red-950/90 px-3 py-2 text-center text-sm text-red-300">
            {startError}
          </p>
        )}
        <button
          type="button"
          onClick={() => startChat(character)}
          disabled={starting}
          className="w-full rounded-xl bg-rose-600 py-3 text-sm font-semibold text-white shadow-lg shadow-rose-950/40 transition-colors hover:bg-rose-500 active:bg-rose-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {starting ? 'Starting…' : `Start chatting with ${character.displayName}`}
        </button>
      </div>
    </section>
  );
}
