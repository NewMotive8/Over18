import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { ConversationSummary } from '@over18/shared';
import { ApiRequestError, conversationsApi } from '../lib/api';

type ChatState =
  | { status: 'loading' }
  | { status: 'not-found' }
  | { status: 'error' }
  | { status: 'ready'; conversation: ConversationSummary };

/**
 * Conversation shell (US-06): loads the real, persisted conversation and
 * shows who you're talking to. The message thread itself arrives in a
 * later story — the body says so explicitly rather than pretending.
 */
export default function ChatPage() {
  const { conversationId } = useParams<{ conversationId: string }>();
  const [state, setState] = useState<ChatState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [imageFailed, setImageFailed] = useState(false);

  useEffect(() => {
    if (!conversationId) return;
    let cancelled = false;
    setState({ status: 'loading' });
    conversationsApi
      .get(conversationId)
      .then((conversation) => !cancelled && setState({ status: 'ready', conversation }))
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
  }, [conversationId, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  if (state.status === 'loading') {
    return (
      <div className="flex flex-col gap-4" aria-busy>
        <div className="flex animate-pulse items-center gap-3">
          <div className="h-12 w-12 rounded-full bg-zinc-800" />
          <div className="h-5 w-32 rounded bg-zinc-800" />
        </div>
        <div className="h-40 animate-pulse rounded-2xl bg-zinc-900" />
      </div>
    );
  }

  if (state.status === 'not-found') {
    return (
      <div className="flex flex-col items-center gap-3 rounded-2xl border border-zinc-800 bg-zinc-900/60 px-6 py-14 text-center">
        <span aria-hidden className="text-3xl">
          ☾
        </span>
        <div>
          <p className="font-medium">Conversation not found</p>
          <p className="mt-1 text-sm text-zinc-400">
            It may belong to another account. Pick a character to start your own.
          </p>
        </div>
        <Link
          to="/characters"
          className="rounded-lg bg-rose-600 px-5 py-2 text-sm font-semibold text-white transition-colors hover:bg-rose-500"
        >
          Browse characters
        </Link>
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <div className="flex flex-col items-center gap-4 rounded-2xl border border-zinc-800 bg-zinc-900/60 px-6 py-14 text-center">
        <span aria-hidden className="text-3xl">
          ⚠
        </span>
        <div>
          <p className="font-medium">Couldn't load this conversation</p>
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
    );
  }

  const { character } = state.conversation;
  const showImage = character.profileImage && !imageFailed;

  return (
    <section className="flex h-full flex-col gap-4">
      <header className="flex items-center gap-3 border-b border-zinc-800 pb-3">
        <Link
          to={`/characters/${character.id}`}
          aria-label={`View ${character.displayName}'s profile`}
          className="flex items-center gap-3"
        >
          {showImage ? (
            <img
              src={character.profileImage!}
              alt=""
              onError={() => setImageFailed(true)}
              className="h-12 w-12 rounded-full border border-zinc-700 object-cover"
            />
          ) : (
            <div className="flex h-12 w-12 items-center justify-center rounded-full border border-zinc-700 bg-gradient-to-br from-zinc-800 to-zinc-900 text-lg font-semibold text-rose-500/70">
              {character.displayName.charAt(0)}
            </div>
          )}
          <div>
            <h2 className="font-semibold leading-tight">{character.displayName}</h2>
            <p className="text-xs text-zinc-500">Tap to view profile</p>
          </div>
        </Link>
      </header>

      <div className="flex flex-1 flex-col items-center justify-center gap-2 py-10 text-center">
        <p className="text-sm text-zinc-400">
          Your conversation with {character.displayName} is ready.
        </p>
        <p className="rounded-full border border-zinc-800 px-3 py-1 text-xs text-zinc-500">
          Messaging arrives in a later story
        </p>
      </div>
    </section>
  );
}
