import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { MyAiCompanion, MyAiDraft } from '@over18/shared';
import { ApiRequestError, myAiApi } from '../lib/api';
import { MyAiSignInRequired } from '../lib/myAiDraft';
import { absoluteMediaUrl } from '../lib/media';
import { useAuth } from '../auth/AuthContext';
import CreateFlow from '../components/my-ai/CreateFlow';
import PageHeader from '../components/PageHeader';
import { MyAiIcon } from '../components/icons';
import CreatingPortrait from '../components/my-ai/CreatingPortrait';

/**
 * My AI — where a user builds and keeps their own companion.
 *
 * ── WHAT THE ROUTE SHOWS ────────────────────────────────────────────────────
 *
 * Nothing created yet  -> the five-step flow, immediately. A first visit should
 *                         be the thing itself, not a poster advertising it.
 * One or more created  -> the companions they own, with a way to make another.
 *
 * ── SIGNED OUT ──────────────────────────────────────────────────────────────
 *
 * The flow is still shown and still playable. Making choices costs nothing and
 * reveals nothing, and a visitor who has designed someone has a far better
 * reason to register than one who was bounced to a login screen by a tab. The
 * server is the boundary, not this page: creating her needs a session and says
 * so at the moment it matters.
 *
 * ── WAITING ─────────────────────────────────────────────────────────────────
 *
 * Creation returns at once with `generating`; the drawing takes the provider
 * the better part of a minute. So the page polls, and it STOPS polling — on
 * success, on failure, on unmount, and after a bounded number of attempts.
 * An unbounded poll against a stuck job is a tab that heats a phone until it
 * is closed.
 */

/** Poll every 3s for up to 3 minutes — comfortably longer than a good run. */
const POLL_INTERVAL_MS = 3_000;
const POLL_MAX_ATTEMPTS = 60;

/**
 * One companion, filling the screen.
 *
 * ── WHY FULL-BLEED AND NOT A GRID ───────────────────────────────────────────
 *
 * A two-up grid of 150px thumbnails shows you that you have companions. It
 * does not show you the companions. These pictures took a minute each to make
 * and are the entire point of the feature, so they get the width of the
 * phone and are scrolled through one at a time.
 *
 * THE WHOLE CARD IS THE LINK. Delete and "new photo" live on her own page,
 * one tap away, rather than crowding a picture with controls — which also
 * means nothing here can be tapped by accident while scrolling past.
 */
function CompanionCard({ companion }: { companion: MyAiCompanion }) {
  return (
    <Link
      to={`/my-ai/${companion.id}`}
      className="relative block overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900"
    >
      <div className="relative aspect-[3/4] w-full">
        {companion.imageUrl ? (
          /*
           * `absoluteMediaUrl`, NOT the bare path — where the first finished
           * companion came out as a broken-image icon. The API answers on its
           * own host; `/api/my-ai/:id/image` asked of the WEB host reaches a
           * static server that returns index.html, so the browser got HTML
           * where it wanted a JPEG. The session cookie still rides along: it
           * is SameSite=None; Secure, so a cross-origin <img> carries it.
           */
          <img
            src={absoluteMediaUrl(companion.imageUrl)}
            alt={companion.name}
            loading="lazy"
            decoding="async"
            className="h-full w-full object-cover"
          />
        ) : companion.status === 'failed' ? (
          <div className="flex h-full w-full items-center justify-center text-sm text-zinc-500">
            Couldn&apos;t be drawn
          </div>
        ) : (
          <CreatingPortrait />
        )}

        <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 via-black/40 to-transparent px-4 pb-5 pt-20">
          <p className="text-2xl font-semibold text-white">{companion.name}</p>
          <p className="text-sm text-zinc-300">{companion.age} years</p>
        </div>
      </div>
    </Link>
  );
}

export default function MyAiPage() {
  const { user } = useAuth();
  const [companions, setCompanions] = useState<MyAiCompanion[] | null>(null);
  const [pending, setPending] = useState<MyAiCompanion | null>(null);
  const [creatingAnother, setCreatingAnother] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  /** Set on unmount so a poll in flight cannot update a dead component. */
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    myAiApi
      .list()
      .then((res) => {
        if (!cancelled) setCompanions(res.companions);
      })
      .catch((err) => {
        if (cancelled) return;
        /*
         * ONLY WARN SOMEONE WHO MIGHT HAVE LOST SIGHT OF SOMETHING.
         *
         * "We could not load your companions" reads as *something has happened
         * to my things*. For most people landing here that is a false alarm
         * about a problem they cannot act on:
         *
         *   401 — signed out, so they own nothing to load.
         *   404 — the endpoint is not deployed in this environment at all.
         *         Nothing is wrong with THEIR data; the feature is half-built.
         *
         * Both of those lead to the same place as having no companions — the
         * flow — so they are shown the flow and nothing else. The warning is
         * kept for the one case it actually describes: a signed-in user whose
         * list genuinely failed to load, who may well have companions that are
         * not on screen and deserves to know why.
         */
        const status = err instanceof ApiRequestError ? err.status : 0;
        if (user && status !== 401 && status !== 404) {
          setNotice('We could not load your companions just now.');
        }
        setCompanions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [user?.id]);

  const poll = useCallback((id: string) => {
    let attempts = 0;
    const tick = async () => {
      if (!live.current) return;
      attempts += 1;
      try {
        const { companion } = await myAiApi.get(id);
        if (!live.current) return;
        setPending(companion);
        if (companion.status === 'ready') {
          setCompanions((prev) => [companion, ...(prev ?? []).filter((c) => c.id !== companion.id)]);
          setPending(null);
          return;
        }
        if (companion.status === 'failed') return;
      } catch {
        // A blip between polls is not a failure; the attempt cap ends it.
      }
      if (attempts < POLL_MAX_ATTEMPTS && live.current) {
        window.setTimeout(tick, POLL_INTERVAL_MS);
      }
    };
    window.setTimeout(tick, POLL_INTERVAL_MS);
  }, []);

  const submit = async (draft: MyAiDraft) => {
    try {
      const { companion } = await myAiApi.create(draft);
      setPending(companion);
      setCreatingAnother(false);
      poll(companion.id);
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 401) {
        throw new MyAiSignInRequired();
      }
      throw err;
    }
  };

  /* ---------------------------------------------------------------- *
   * Waiting for the provider
   * ---------------------------------------------------------------- */
  if (pending) {
    const failed = pending.status === 'failed';
    return (
      <section className="flex flex-col gap-5">
        <PageHeader
          eyebrow="My AI"
          title={failed ? 'That did not work' : `Creating ${pending.name}`}
          subtitle={
            failed
              ? /*
                 * NOT "nothing was charged", which we cannot promise. Some
                 * failures happen after the provider has already drawn her —
                 * the first live creation failed on the download, with the
                 * picture sitting finished at the other end. Telling someone
                 * their money is safe when it may not be is worse than saying
                 * nothing about it.
                 */
                'She was not created. You can try again.'
              : 'This takes about a minute. You can leave this screen — she will be here when you come back.'
          }
        />
        <div className="mx-auto w-full max-w-[16rem]">
          <CompanionCard companion={pending} />
        </div>
        <button
          type="button"
          onClick={() => {
            setPending(null);
            setCreatingAnother(failed);
          }}
          className="w-full rounded-xl border border-zinc-700 px-5 py-3 text-sm font-semibold text-zinc-200 transition-colors hover:border-zinc-600"
        >
          {failed ? 'Start again' : 'Back to My AI'}
        </button>
      </section>
    );
  }

  /* ---------------------------------------------------------------- *
   * Still loading the list — render nothing rather than flashing the
   * wizard at someone who already has companions.
   * ---------------------------------------------------------------- */
  if (companions === null) {
    return <div className="py-16 text-center text-sm text-zinc-500">Loading…</div>;
  }

  /* ---------------------------------------------------------------- *
   * Nothing yet (or making another) — the flow itself
   * ---------------------------------------------------------------- */
  if (companions.length === 0 || creatingAnother) {
    return (
      <section className="flex flex-col gap-4">
        {notice && (
          <p className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-xs text-zinc-400">
            {notice}
          </p>
        )}
        {creatingAnother && (
          <button
            type="button"
            onClick={() => setCreatingAnother(false)}
            className="self-start text-xs font-medium text-zinc-400 transition-colors hover:text-zinc-200"
          >
            ← My companions
          </button>
        )}
        <CreateFlow onSubmit={submit} />
      </section>
    );
  }

  /* ---------------------------------------------------------------- *
   * Her, and any others
   * ---------------------------------------------------------------- */
  return (
    <section className="flex flex-col gap-5">
      <PageHeader
        eyebrow="My AI"
        title="Your companions"
        subtitle="Only you can see these. Tap one for her photos."
      />

      {notice && (
        <p className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-xs text-zinc-400">
          {notice}
        </p>
      )}

      {/* At the TOP, where the screenshot puts it: making another is the
          thing people come back for, and burying it under a scroll of
          full-height cards hides it behind however many they already have. */}
      <button
        type="button"
        onClick={() => setCreatingAnother(true)}
        className="flex items-center justify-center gap-2 rounded-xl bg-rose-600 px-5 py-4 text-base font-semibold text-white transition-colors hover:bg-rose-500"
      >
        <MyAiIcon className="h-5 w-5" />
        Create new AI
      </button>

      <div className="flex flex-col gap-5">
        {companions.map((companion) => (
          <CompanionCard key={companion.id} companion={companion} />
        ))}
      </div>

      <Link to="/characters" className="text-center text-sm text-zinc-400 transition-colors hover:text-zinc-200">
        Browse everyone else
      </Link>
    </section>
  );
}
