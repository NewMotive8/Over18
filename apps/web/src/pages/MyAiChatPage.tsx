import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { MY_AI_MESSAGE_MAX_LENGTH, type MyAiCompanion, type MyAiMessage } from '@over18/shared';
import { ApiRequestError, myAiApi } from '../lib/api';
import { absoluteMediaUrl } from '../lib/media';
import { ChevronLeftIcon } from '../components/icons';

/**
 * Talking to a companion you made.
 *
 * ── SHE IS THE THREAD ───────────────────────────────────────────────────────
 *
 * There is no conversation id in this screen, because there is none in the
 * API: a companion belongs to exactly one account, so her id IS the
 * conversation. One fewer thing to own, and one fewer place for ownership to
 * be got wrong.
 *
 * ── SENDING IS SYNCHRONOUS ──────────────────────────────────────────────────
 *
 * Unlike making a picture, a reply comes back in a second or two, so the
 * request returns both messages and there is nothing to poll. What the screen
 * does do is show the sent message IMMEDIATELY, before the server confirms
 * it: a chat that swallows your words for two seconds feels broken, and the
 * only thing at risk is a line that gets replaced by the real one moments
 * later.
 */
export default function MyAiChatPage() {
  const { id = '' } = useParams();

  const [companion, setCompanion] = useState<MyAiCompanion | null>(null);
  const [messages, setMessages] = useState<MyAiMessage[] | null>(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);

  const live = useRef(true);
  const bottom = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  useEffect(() => {
    Promise.all([myAiApi.get(id), myAiApi.messages(id)])
      .then(([her, thread]) => {
        if (!live.current) return;
        setCompanion(her.companion);
        setMessages(thread.messages);
      })
      .catch((err) => {
        if (!live.current) return;
        if (err instanceof ApiRequestError && (err.status === 404 || err.status === 401)) {
          setMissing(true);
        } else {
          setNotice('We could not open this conversation.');
        }
      });
  }, [id]);

  /* The newest line is the one being read; keep it in view. */
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [messages, sending]);

  const send = async () => {
    const body = draft.trim();
    if (!body || sending) return;

    /*
     * Shown before the server has it. The id is a placeholder and is replaced
     * by the real row when the reply lands — nothing reads it in between.
     */
    const pending: MyAiMessage = {
      id: `pending-${Date.now()}`,
      sender: 'user',
      body,
      createdAt: new Date().toISOString(),
    };
    setMessages((prev) => [...(prev ?? []), pending]);
    setDraft('');
    setSending(true);
    setNotice(null);

    try {
      const { messages: pair } = await myAiApi.say(id, body);
      if (!live.current) return;
      setMessages((prev) => [...(prev ?? []).filter((m) => m.id !== pending.id), ...pair]);
    } catch (err) {
      if (!live.current) return;
      // Take the unsent line back out and give the words back, rather than
      // leaving something on screen that she never received.
      setMessages((prev) => (prev ?? []).filter((m) => m.id !== pending.id));
      setDraft(body);
      setNotice(
        err instanceof ApiRequestError ? err.message : 'She could not answer just now.',
      );
    } finally {
      if (live.current) setSending(false);
    }
  };

  if (missing) {
    return (
      <section className="flex flex-col items-center gap-4 py-16 text-center">
        <p className="text-sm text-zinc-400">She is not here.</p>
        <Link to="/my-ai" className="rounded-xl bg-rose-600 px-5 py-2.5 text-sm font-semibold text-white">
          Back to My AI
        </Link>
      </section>
    );
  }

  if (!companion || !messages) {
    return <div className="py-16 text-center text-sm text-zinc-500">Loading…</div>;
  }

  return (
    /* pb-28 reserves the composer's height so the last line can be scrolled
       clear of it rather than sitting underneath. */
    <section className="flex flex-col gap-4 pb-28">
      <div className="flex items-center gap-3">
        <Link
          to={`/my-ai/${id}`}
          aria-label={`Back to ${companion.name}`}
          className="text-zinc-400 transition-colors hover:text-zinc-200"
        >
          <ChevronLeftIcon className="h-5 w-5" />
        </Link>
        {companion.imageUrl ? (
          <img
            src={absoluteMediaUrl(companion.imageUrl)}
            alt=""
            className="h-10 w-10 rounded-full object-cover"
          />
        ) : (
          <span className="h-10 w-10 rounded-full bg-zinc-800" />
        )}
        <div>
          <p className="text-base font-semibold text-white">{companion.name}</p>
          <p className="text-xs text-zinc-500">Only you can see this</p>
        </div>
      </div>

      {notice && (
        <p
          role="alert"
          className="rounded-lg border border-rose-900 bg-rose-950/40 px-3 py-2 text-sm text-rose-200"
        >
          {notice}
        </p>
      )}

      {messages.length === 0 && !sending && (
        <p className="py-10 text-center text-sm text-zinc-500">
          Say hello to {companion.name}.
        </p>
      )}

      <div className="flex flex-col gap-3">
        {messages.map((message) => (
          <div
            key={message.id}
            className={message.sender === 'user' ? 'flex justify-end' : 'flex justify-start'}
          >
            <p
              className={`max-w-[80%] whitespace-pre-wrap rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
                message.sender === 'user'
                  ? 'rounded-br-md bg-rose-600 text-white'
                  : 'rounded-bl-md bg-zinc-800 text-zinc-100'
              }`}
            >
              {message.body}
            </p>
          </div>
        ))}

        {sending && (
          <div className="flex justify-start">
            <span className="flex items-center gap-1 rounded-2xl rounded-bl-md bg-zinc-800 px-4 py-3">
              {[0, 150, 300].map((delay) => (
                <span
                  key={delay}
                  style={{ animationDelay: `${delay}ms` }}
                  className="h-1.5 w-1.5 rounded-full bg-zinc-500 motion-safe:animate-bounce"
                />
              ))}
            </span>
          </div>
        )}
        <div ref={bottom} />
      </div>

      <div className="fixed inset-x-0 bottom-[calc(3.5rem+env(safe-area-inset-bottom))] z-20 mx-auto w-full max-w-lg lg:bottom-0">
        <div className="flex items-end gap-2 border-t border-zinc-800 bg-zinc-950/95 px-4 py-3 backdrop-blur">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value.slice(0, MY_AI_MESSAGE_MAX_LENGTH))}
            onKeyDown={(e) => {
              // Enter sends; Shift+Enter is a new line. On a phone the button
              // is what gets used, and the key handler costs nothing there.
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            rows={1}
            placeholder={`Message ${companion.name}`}
            aria-label={`Message ${companion.name}`}
            /* text-base: under 16px and iOS zooms the page in on focus. */
            className="max-h-32 min-h-[2.75rem] flex-1 resize-none rounded-2xl border border-zinc-700 bg-zinc-900 px-4 py-2.5 text-base text-white placeholder-zinc-600 outline-none focus:border-rose-500"
          />
          <button
            type="button"
            onClick={send}
            disabled={!draft.trim() || sending}
            className="rounded-2xl bg-rose-600 px-5 py-3 text-sm font-semibold text-white transition-colors hover:bg-rose-500 disabled:cursor-not-allowed disabled:bg-zinc-800 disabled:text-zinc-500"
          >
            Send
          </button>
        </div>
      </div>
    </section>
  );
}
