import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { MyAiCompanion, MyAiPhoto } from '@over18/shared';
import { ApiRequestError, myAiApi } from '../lib/api';
import { absoluteMediaUrl } from '../lib/media';
import CreatingPortrait from '../components/my-ai/CreatingPortrait';
import PhotoComposer from '../components/my-ai/PhotoComposer';
import { ChevronLeftIcon, TrashIcon } from '../components/icons';

/**
 * One companion, full screen, with everything that exists of her.
 *
 * ── WHY SHE HAS A PAGE AT ALL ───────────────────────────────────────────────
 *
 * My AI lists companions, one card each. Her photographs live here, because a
 * single feed mixing every picture of everybody buries a companion with one
 * portrait behind a companion with nine — and the actions that matter
 * (another photo, delete) are about HER, not about the list.
 *
 * ── POLLING STOPS ───────────────────────────────────────────────────────────
 *
 * A photograph takes the provider a minute or so. The page polls while any
 * one of them is unfinished, and stops: on completion, on failure, on
 * unmount, and after a bounded number of attempts. An unbounded poll against
 * a stuck job is a tab that heats a phone until it is closed.
 */

const POLL_INTERVAL_MS = 3_000;
const POLL_MAX_ATTEMPTS = 100;

export default function MyAiCompanionPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();

  const [companion, setCompanion] = useState<MyAiCompanion | null>(null);
  const [photos, setPhotos] = useState<MyAiPhoto[] | null>(null);
  const [missing, setMissing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const [starting, setStarting] = useState(false);
  const [deletingPhoto, setDeletingPhoto] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  /** Set on unmount so a poll in flight cannot update a dead component. */
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    const [her, gallery] = await Promise.all([myAiApi.get(id), myAiApi.photos(id)]);
    if (!live.current) return;
    setCompanion(her.companion);
    setPhotos(gallery.photos);
  }, [id]);

  useEffect(() => {
    load().catch((err) => {
      if (!live.current) return;
      if (err instanceof ApiRequestError && (err.status === 404 || err.status === 401)) {
        setMissing(true);
      } else {
        setNotice('We could not load her just now.');
      }
    });
  }, [load]);

  /** Poll while anything is still being made, and stop when nothing is. */
  useEffect(() => {
    if (!photos?.some((p) => p.status === 'generating')) return;

    let attempts = 0;
    let timer = 0;
    const tick = async () => {
      if (!live.current) return;
      attempts += 1;
      try {
        const { photos: next } = await myAiApi.photos(id);
        if (!live.current) return;
        setPhotos(next);
        if (!next.some((p) => p.status === 'generating')) return;
      } catch {
        // A blip between polls is not a failure; the attempt cap ends it.
      }
      if (attempts < POLL_MAX_ATTEMPTS && live.current) {
        timer = window.setTimeout(tick, POLL_INTERVAL_MS);
      }
    };
    timer = window.setTimeout(tick, POLL_INTERVAL_MS);
    return () => window.clearTimeout(timer);
  }, [id, photos]);

  const createPhoto = async (input: { prompt: string; style: string }) => {
    setStarting(true);
    setNotice(null);
    try {
      await myAiApi.createPhoto(id, input);
      // Re-read rather than splicing the new one in: the gallery's order is
      // the server's, and guessing it here is how the two drift apart.
      await load();
      setComposing(false);
    } catch (err) {
      setNotice(
        err instanceof ApiRequestError
          ? err.message
          : 'We could not start that photo. Please try again.',
      );
    } finally {
      setStarting(false);
    }
  };

  const removePhoto = async (photo: MyAiPhoto) => {
    setDeletingPhoto(photo.id);
    setNotice(null);
    try {
      await myAiApi.removePhoto(id, photo.id);
      setPhotos((prev) => (prev ?? []).filter((p) => p.id !== photo.id));
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 404) {
        setPhotos((prev) => (prev ?? []).filter((p) => p.id !== photo.id));
      } else {
        setNotice('We could not delete that photo. Please try again.');
      }
    } finally {
      setDeletingPhoto(null);
    }
  };

  const removeCompanion = async () => {
    try {
      await myAiApi.remove(id);
      navigate('/my-ai', { replace: true });
    } catch {
      setNotice('We could not delete her. Please try again.');
      setConfirmingDelete(false);
    }
  };

  if (missing) {
    return (
      <section className="flex flex-col items-center gap-4 py-16 text-center">
        <p className="text-sm text-zinc-400">She is not here.</p>
        <Link
          to="/my-ai"
          className="rounded-xl bg-rose-600 px-5 py-2.5 text-sm font-semibold text-white"
        >
          Back to My AI
        </Link>
      </section>
    );
  }

  if (!companion || !photos) {
    return <div className="py-16 text-center text-sm text-zinc-500">Loading…</div>;
  }

  const busy = photos.some((p) => p.status === 'generating');

  return (
    <section className="flex flex-col gap-4 pb-8">
      <div className="flex items-center gap-2">
        <Link
          to="/my-ai"
          className="flex items-center gap-1 text-sm font-medium text-zinc-400 transition-colors hover:text-zinc-200"
        >
          <ChevronLeftIcon className="h-4 w-4" />
          My AI
        </Link>
      </div>

      <div>
        <h2 className="text-2xl font-semibold text-white">{companion.name}</h2>
        <p className="text-sm text-zinc-400">{companion.age} years · only you can see her</p>
      </div>

      {notice && (
        <p
          role="alert"
          className="rounded-lg border border-rose-900 bg-rose-950/40 px-3 py-2 text-sm text-rose-200"
        >
          {notice}
        </p>
      )}

      {composing ? (
        <PhotoComposer
          name={companion.name}
          busy={starting}
          onCancel={() => setComposing(false)}
          onCreate={createPhoto}
        />
      ) : (
        <button
          type="button"
          onClick={() => setComposing(true)}
          disabled={busy}
          className="w-full rounded-xl bg-rose-600 px-5 py-3 text-sm font-semibold text-white transition-colors hover:bg-rose-500 disabled:cursor-not-allowed disabled:bg-zinc-800 disabled:text-zinc-500"
        >
          {busy ? 'A photo is being made…' : `New photo of ${companion.name}`}
        </button>
      )}

      {photos.length === 0 && (
        <p className="rounded-xl border border-zinc-800 bg-zinc-900/40 px-4 py-8 text-center text-sm text-zinc-500">
          She has no photos. Make her one.
        </p>
      )}

      <div className="flex flex-col gap-4">
        {photos.map((photo) => (
          <GalleryPhoto
            key={photo.id}
            photo={photo}
            name={companion.name}
            deleting={deletingPhoto === photo.id}
            onDelete={removePhoto}
          />
        ))}
      </div>

      <div className="mt-4 border-t border-zinc-800 pt-4">
        {confirmingDelete ? (
          <div className="flex flex-col gap-2 rounded-xl border border-rose-900 bg-rose-950/30 p-4 text-center">
            <p className="text-sm font-semibold text-zinc-100">Delete {companion.name}?</p>
            <p className="text-xs text-zinc-400">
              She and all {photos.length} of her photos go. This cannot be undone.
            </p>
            <div className="mt-1 flex gap-2">
              <button
                type="button"
                onClick={() => setConfirmingDelete(false)}
                className="flex-1 rounded-lg border border-zinc-700 px-3 py-2 text-xs font-semibold text-zinc-200"
              >
                Keep her
              </button>
              <button
                type="button"
                onClick={removeCompanion}
                className="flex-1 rounded-lg bg-rose-600 px-3 py-2 text-xs font-semibold text-white"
              >
                Delete
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setConfirmingDelete(true)}
            className="w-full rounded-xl border border-zinc-800 px-5 py-3 text-sm font-medium text-zinc-500 transition-colors hover:border-zinc-700 hover:text-zinc-300"
          >
            Delete {companion.name}
          </button>
        )}
      </div>
    </section>
  );
}

/**
 * One photograph, full width, with the request that produced it.
 *
 * The prompt is shown because a gallery of a dozen pictures with no record of
 * what was asked for is a gallery nobody can navigate — and because it is the
 * fastest way to ask for another one like it.
 */
function GalleryPhoto({
  photo,
  name,
  deleting,
  onDelete,
}: {
  photo: MyAiPhoto;
  name: string;
  deleting: boolean;
  onDelete: (photo: MyAiPhoto) => void;
}) {
  const [confirming, setConfirming] = useState(false);

  return (
    <figure className="overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900/40">
      <div className="relative aspect-[3/4] w-full bg-zinc-900">
        {photo.url ? (
          <img
            src={absoluteMediaUrl(photo.url)}
            alt={photo.prompt || name}
            loading="lazy"
            decoding="async"
            className="h-full w-full object-cover"
          />
        ) : photo.status === 'failed' ? (
          <div className="flex h-full w-full items-center justify-center px-6 text-center text-sm text-zinc-500">
            That photo could not be made.
          </div>
        ) : (
          <CreatingPortrait />
        )}

        {!confirming && (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            aria-label={`Delete this photo of ${name}`}
            className="absolute right-2 top-2 z-10 rounded-full bg-black/60 p-2 text-zinc-300 backdrop-blur transition-colors hover:bg-black/80 hover:text-white"
          >
            <TrashIcon className="h-4 w-4" />
          </button>
        )}

        {confirming && (
          <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-black/85 px-6 text-center">
            <p className="text-sm font-semibold text-zinc-100">Delete this photo?</p>
            <p className="text-xs text-zinc-400">
              {photo.isReference
                ? `Her original picture. ${name} stays, and you can still make new photos of her.`
                : 'This cannot be undone.'}
            </p>
            <div className="flex w-full max-w-[12rem] flex-col gap-2">
              <button
                type="button"
                disabled={deleting}
                onClick={() => onDelete(photo)}
                className="rounded-lg bg-rose-600 px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-rose-500 disabled:bg-zinc-700"
              >
                {deleting ? 'Deleting…' : 'Delete'}
              </button>
              <button
                type="button"
                disabled={deleting}
                onClick={() => setConfirming(false)}
                className="rounded-lg border border-zinc-700 px-3 py-2 text-xs font-semibold text-zinc-200"
              >
                Keep it
              </button>
            </div>
          </div>
        )}
      </div>

      <figcaption className="px-4 py-3 text-xs leading-relaxed text-zinc-500">
        {photo.isReference ? 'Her original picture' : photo.prompt}
      </figcaption>
    </figure>
  );
}
