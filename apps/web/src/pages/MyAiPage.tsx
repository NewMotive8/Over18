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
 * How long this has been going, counting up.
 *
 * Deliberately elapsed time and NOT a progress bar: OhAPI reports no progress,
 * only `generating` and then `ready`, so a bar would be a number we invented.
 * A clock that is visibly moving says "still working" just as well and does
 * not claim to know how far along she is.
 */
function ElapsedSeconds() {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setSeconds((s) => s + 1), 1_000);
    return () => window.clearInterval(id);
  }, []);
  return <>{seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`}</>;
}

/**
 * The minute she takes to draw, made visible.
 *
 * A still "Drawing her…" on a dark rectangle is indistinguishable from a
 * screen that has stopped working — which is exactly what it must not look
 * like while the provider is busy and the clock is running. Three independent
 * signs of life instead: the frame breathes, a sweep of light crosses it, and
 * the seconds count up.
 */
function CreatingPortrait() {
  return (
    <div className="absolute inset-0 overflow-hidden bg-zinc-900">
      <div className="absolute inset-0 animate-pulse bg-gradient-to-br from-zinc-800 via-zinc-900 to-zinc-800" />
      {/* motion-safe: a sweep is decoration, and nobody who asked their
          machine for less motion needs it to know something is happening. */}
      <span className="pointer-events-none absolute inset-y-0 left-0 w-full bg-gradient-to-r from-transparent via-white/10 to-transparent motion-safe:animate-shimmer" />
      <div className="relative flex h-full w-full flex-col items-center justify-center gap-3 px-4 text-center">
        <span
          aria-hidden="true"
          className="h-9 w-9 animate-spin rounded-full border-2 border-zinc-700 border-t-rose-500"
        />
        <span className="text-sm font-medium text-zinc-200">Creating…</span>
        <span className="text-xs tabular-nums text-zinc-500">
          <ElapsedSeconds />
        </span>
      </div>
    </div>
  );
}

function CompanionCard({ companion }: { companion: MyAiCompanion }) {
  return (
    <div className="overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/40">
      <div className="relative aspect-[3/4] w-full bg-zinc-900">
        {companion.imageUrl ? (
          /*
           * `absoluteMediaUrl`, NOT the bare path — and this is where the
           * first finished companion came out as a broken-image icon.
           *
           * The API answers on its own host in every deployed environment.
           * `/api/my-ai/:id/image` asked of the WEB host reaches a static
           * server that has no such route, so the browser got HTML where it
           * wanted a JPEG. Every other image in this app goes through the
           * same helper for the same reason.
           *
           * The session cookie still rides along: it is set SameSite=None;
           * Secure, so a cross-origin <img> carries it and the route can
           * still check that she is yours.
           */
          <img
            src={absoluteMediaUrl(companion.imageUrl)}
            alt={`${companion.name}`}
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
        <span className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 to-transparent px-3 pb-2 pt-8 text-sm font-semibold text-white">
          {companion.name} <span className="font-normal text-zinc-300">· {companion.age}</span>
        </span>
      </div>
    </div>
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
        subtitle="Only you can see these."
      />

      <div className="grid grid-cols-2 gap-3">
        {companions.map((companion) => (
          <CompanionCard key={companion.id} companion={companion} />
        ))}
      </div>

      <button
        type="button"
        onClick={() => setCreatingAnother(true)}
        className="flex items-center justify-center gap-2 rounded-xl bg-rose-600 px-5 py-3 text-sm font-semibold text-white transition-colors hover:bg-rose-500"
      >
        <MyAiIcon className="h-4 w-4" />
        Create another
      </button>

      <Link to="/characters" className="text-center text-sm text-zinc-400 transition-colors hover:text-zinc-200">
        Browse everyone else
      </Link>
    </section>
  );
}
