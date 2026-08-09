import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { MESSAGE_MAX_LENGTH, type ChatMessage, type ConversationSummary } from '@over18/shared';
import { ApiRequestError, conversationsApi, messagesApi } from '../lib/api';

type ChatState =
  | { status: 'loading' }
  | { status: 'not-found' }
  | { status: 'error' }
  | { status: 'ready'; conversation: ConversationSummary };

/**
 * Basic chat interface (US-07): persisted message history, send box,
 * differentiated bubbles, "{Character} is typing…" while waiting for the
 * reply, and error handling that never loses the user's draft.
 */
export default function ChatPage() {
  const { conversationId } = useParams<{ conversationId: string }>();
  const [state, setState] = useState<ChatState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [imageFailed, setImageFailed] = useState(false);

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Load the conversation and its full history together.
  useEffect(() => {
    if (!conversationId) return;
    let cancelled = false;
    setState({ status: 'loading' });
    Promise.all([conversationsApi.get(conversationId), messagesApi.list(conversationId)])
      .then(([conversation, history]) => {
        if (cancelled) return;
        setMessages(history);
        setState({ status: 'ready', conversation });
      })
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

  // Keep the newest message (or typing indicator) in view.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages.length, sending]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  // US-14: one send path shared by the form and the Retry button. On failure
  // nothing is appended and the draft is preserved, so a retry re-sends the
  // exact same content — the server's atomic transaction guarantees the failed
  // attempt persisted no user (or character) message, so no duplicates arise.
  const sendContent = useCallback(
    async (content: string) => {
      if (!content || !conversationId) return;
      setSending(true);
      setSendError(null);
      try {
        const result = await messagesApi.send(conversationId, content);
        setMessages((prev) => [...prev, result.userMessage, result.characterMessage]);
        setDraft(''); // clear only on success — errors keep the draft for retry
      } catch (err) {
        // Prefer the API's understandable message (timeout / unavailable /
        // not-configured); fall back for a network error with no response.
        setSendError(
          err instanceof ApiRequestError
            ? err.message
            : "Couldn't reach the server. Check your connection and try again.",
        );
      } finally {
        setSending(false);
      }
    },
    [conversationId],
  );

  async function handleSend(event: FormEvent) {
    event.preventDefault();
    if (sending) return;
    await sendContent(draft.trim());
  }

  // Retry re-sends the preserved draft — no retyping required.
  const retrySend = useCallback(() => {
    if (sending) return;
    void sendContent(draft.trim());
  }, [sending, draft, sendContent]);

  if (state.status === 'loading') {
    return (
      <div className="flex flex-col gap-4" aria-busy>
        <div className="flex animate-pulse items-center gap-3">
          <div className="h-12 w-12 rounded-full bg-zinc-800" />
          <div className="h-5 w-32 rounded bg-zinc-800" />
        </div>
        <div className="flex flex-col gap-3">
          <div className="h-10 w-3/5 animate-pulse self-start rounded-2xl bg-zinc-900" />
          <div className="h-10 w-1/2 animate-pulse self-end rounded-2xl bg-zinc-900" />
          <div className="h-10 w-2/3 animate-pulse self-start rounded-2xl bg-zinc-900" />
        </div>
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
    <section className="flex h-full min-h-[60vh] flex-col">
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

      <div className="flex-1 overflow-y-auto py-4">
        {messages.length === 0 && !sending ? (
          <div className="flex flex-col items-center gap-2 py-10 text-center">
            <p className="text-sm text-zinc-400">
              This is the beginning of your conversation with {character.displayName}.
            </p>
            <p className="text-xs text-zinc-500">Say hi — she's waiting.</p>
          </div>
        ) : (
          <ul className="flex flex-col gap-2">
            {messages.map((message) => (
              <li
                key={message.id}
                className={`max-w-[80%] rounded-2xl px-3.5 py-2 text-sm leading-relaxed ${
                  message.sender === 'user'
                    ? 'self-end rounded-br-md bg-rose-600 text-white'
                    : 'self-start rounded-bl-md bg-zinc-800 text-zinc-100'
                }`}
              >
                {message.content}
              </li>
            ))}
            {sending && (
              <li
                aria-live="polite"
                className="max-w-[80%] self-start rounded-2xl rounded-bl-md bg-zinc-800/70 px-3.5 py-2 text-sm italic text-zinc-400"
              >
                {character.displayName} is typing…
              </li>
            )}
          </ul>
        )}
        <div ref={bottomRef} />
      </div>

      {sendError && (
        <div
          role="alert"
          className="mb-2 flex items-center justify-between gap-3 rounded-lg border border-red-900 bg-red-950/60 px-3 py-2 text-sm text-red-300"
        >
          <span>{sendError}</span>
          <button
            type="button"
            onClick={retrySend}
            disabled={sending || draft.trim().length === 0}
            className="shrink-0 rounded-md bg-red-800/70 px-3 py-1 text-xs font-semibold text-red-50 transition-colors hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {sending ? 'Retrying…' : 'Retry'}
          </button>
        </div>
      )}

      <form onSubmit={handleSend} className="flex items-end gap-2 border-t border-zinc-800 pt-3">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              e.currentTarget.form?.requestSubmit();
            }
          }}
          rows={1}
          maxLength={MESSAGE_MAX_LENGTH}
          placeholder={`Message ${character.displayName}…`}
          disabled={sending}
          className="max-h-32 min-h-11 flex-1 resize-none rounded-xl border border-zinc-700 bg-zinc-900 px-3.5 py-2.5 text-sm text-zinc-100 placeholder-zinc-500 outline-none focus:border-rose-500 disabled:opacity-60"
        />
        <button
          type="submit"
          disabled={sending || draft.trim().length === 0}
          aria-label="Send message"
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-rose-600 text-lg text-white transition-colors hover:bg-rose-500 disabled:cursor-not-allowed disabled:opacity-40"
        >
          ➤
        </button>
      </form>
    </section>
  );
}
