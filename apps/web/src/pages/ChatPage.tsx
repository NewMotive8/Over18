import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  detectMediaRequest,
  MESSAGE_MAX_LENGTH,
  type ChatMessage,
  type ConversationSummary,
} from '@over18/shared';
import { ApiRequestError, conversationsApi, messagesApi } from '../lib/api';
import { createChatSendController, IDLE_SEND_STATE, type ChatSendState } from '../lib/chatSend';
import { createScrollFollower } from '../lib/chatScroll';
import { createViewportAnchor, type ViewportAnchor } from '../lib/chatViewport';
import MessageMedia from '../components/MessageMedia';

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
  const [sendError, setSendError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // Follow-the-bottom policy (lib/chatScroll.ts). A ref, not state: scrolling
  // must never trigger a re-render of the conversation.
  const follower = useRef(createScrollFollower()).current;

  // Optimistic send + delayed typing indicator. `pending` is held OUTSIDE
  // `messages` on purpose: `messages` only ever contains server-persisted
  // rows, so when the response arrives the canonical userMessage is appended
  // and the optimistic one is dropped in the same render — the bubble can
  // never duplicate. See lib/chatSend.ts for the timing rules.
  const [send, setSend] = useState<ChatSendState>(IDLE_SEND_STATE);
  const { pending, showTyping, sending } = send;

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

  /**
   * Keeps the conversation pinned to its newest content.
   *
   * The previous version scrolled `listRef` itself. Measured in Chromium, that
   * element is not a scroll container at all (scrollHeight === clientHeight),
   * so the call moved nothing and the follower always read "at the bottom"
   * while the real scroller — the document — sat over a thousand pixels away.
   * chatViewport resolves whatever actually scrolls and drives that instead.
   */
  const anchor = useRef<ViewportAnchor | null>(null);
  if (anchor.current === null) {
    anchor.current = createViewportAnchor({
      getList: () => listRef.current,
      shouldFollow: () => follower.shouldAutoScroll(),
      onScroll: (metrics) => follower.handleScroll(metrics),
    });
  }

  // Bind once the list exists (i.e. once the conversation has rendered), and
  // tear every listener down on unmount.
  useEffect(() => {
    if (state.status !== 'ready') return;
    const current = anchor.current!;
    current.attach();
    current.pin();
    return () => current.dispose();
  }, [state.status, conversationId]);

  // One effect, one mechanism: content changes re-pin through the same guarded
  // path as resizes, so nothing competes to move the viewport.
  useEffect(() => {
    anchor.current?.pin();
  }, [messages.length, pending, showTyping]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  // US-14: one send path shared by the form and the Retry button. On failure
  // the optimistic message stays visible and Retry re-sends that exact content
  // — the server's atomic transaction guarantees the failed attempt persisted
  // no user (or character) message, so no duplicates arise.
  const controller = useMemo(
    () =>
      createChatSendController({
        // POC media trigger. Detection is a pure function over the text the
        // user just typed (lib: @over18/shared detectMediaRequest) and only
        // ever decides the TYPE asked for — the server still chooses the
        // asset, and ignores this entirely unless CHAT_MEDIA_ENABLED is on.
        // Undefined for ordinary messages, so the request is byte-identical
        // to before. chatSend.ts is untouched: the 2s/5s timing and the
        // scroll anchor never see this.
        send: (content: string) =>
          messagesApi.send(conversationId!, content, detectMediaRequest(content) ?? undefined),
        onState: setSend,
        onResult: (result) => {
          // The canonical rows replace the optimistic bubble in one render.
          setMessages((prev) => [...prev, result.userMessage, result.characterMessage]);
        },
        onError: (err) => {
          // Prefer the API's understandable message (timeout / unavailable /
          // not-configured); fall back for a network error with no response.
          setSendError(
            err instanceof ApiRequestError
              ? err.message
              : "Couldn't reach the server. Check your connection and try again.",
          );
        },
      }),
    [conversationId],
  );

  // No timer may outlive the screen, or a superseded conversation.
  useEffect(() => () => controller.dispose(), [controller]);

  const sendContent = useCallback(
    async (content: string) => {
      if (!content || !conversationId) return;
      setSendError(null);
      await controller.send(content);
    },
    [conversationId, controller],
  );

  async function handleSend(event: FormEvent) {
    event.preventDefault();
    if (sending) return;
    const content = draft.trim();
    if (!content) return;
    setDraft(''); // composer clears immediately; `pending` now holds the text
    follower.resume(); // sending is an explicit "take me to the newest message"
    await sendContent(content);
  }

  // Retry re-sends the preserved pending message — no retyping required.
  const retrySend = useCallback(() => {
    if (sending || !pending) return;
    void sendContent(pending);
  }, [sending, pending, sendContent]);

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

      {/* No onScroll here on purpose. This element does not scroll (measured:
          scrollHeight === clientHeight), so its scroll handler never fired and
          the metrics it would report always read as "at the bottom". The
          listener now lives on the element that really scrolls — see
          chatViewport.createViewportAnchor. */}
      <div ref={listRef} className="flex-1 overflow-y-auto py-4">
        {messages.length === 0 && pending === null ? (
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
                {/* Attached media is part of the SAME message, so it is
                    revealed by the same transition as the text — the existing
                    2s/5s timing needs no change. The bubble itself is
                    unchanged; this only adds a child when media is present. */}
                {message.media && (
                  <div className="mt-1.5">
                    <MessageMedia media={message.media} characterName={character.displayName} />
                  </div>
                )}
              </li>
            ))}
            {pending !== null && (
              <li className="max-w-[80%] self-end rounded-2xl rounded-br-md bg-rose-600 px-3.5 py-2 text-sm leading-relaxed text-white">
                {pending}
              </li>
            )}
            {showTyping && (
              /* The SAME indicator element as before — same bubble, position and
                 aria-live — with the ellipsis replaced by three animating dots.
                 Tailwind's animate-bounce is already used elsewhere in the app,
                 so this needs no new CSS or keyframes. The label stays for
                 screen readers, which get no benefit from motion. */
              <li
                aria-live="polite"
                aria-label={`${character.displayName} is typing`}
                className="flex max-w-[80%] items-center gap-2 self-start rounded-2xl rounded-bl-md bg-zinc-800/70 px-3.5 py-2 text-sm italic text-zinc-400"
              >
                <span>{character.displayName} is typing</span>
                <span aria-hidden className="flex items-end gap-1 pb-0.5">
                  {[0, 150, 300].map((delay) => (
                    <span
                      key={delay}
                      className="inline-block h-1.5 w-1.5 animate-bounce rounded-full bg-zinc-400"
                      style={{ animationDelay: `${delay}ms` }}
                    />
                  ))}
                </span>
              </li>
            )}
          </ul>
        )}
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
            disabled={sending || pending === null}
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
