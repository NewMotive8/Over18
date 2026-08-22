import { Link } from 'react-router-dom';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { PublicCharacter } from '@over18/shared';
import { API_URL, charactersApi, contentLibraryApi, type LibraryAssetView } from '../../lib/api';
import { TILE_MEDIA_CLASS, tileFrameClass } from '../../lib/mediaTile';

/**
 * US-100 — Content Library.
 *
 * The morning question this screen answers is "what changed?", so Recently
 * Approved / Added is the FIRST thing on the page and is never behind a filter.
 * The broader library sits underneath it.
 *
 * This is not the generation studio and not publishing: there is no generate,
 * regenerate, edit, category or publish control anywhere here.
 */

function relative(iso: string): string {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function Tile({ a, onOpen, dense }: { a: LibraryAssetView; onOpen: () => void; dense?: boolean }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="w-full overflow-hidden rounded-lg border border-zinc-800 text-left transition-colors hover:border-zinc-700"
    >
      {/* Fixed-ratio frame. Images and video are fitted IDENTICALLY — see
          TILE_MEDIA_CLASS for why this is contain rather than cover. */}
      <div className={tileFrameClass(dense)}>
        {a.previewUrl && a.mediaType === 'image' ? (
          <img src={`${API_URL}${a.previewUrl}`} alt="" loading="lazy" className={TILE_MEDIA_CLASS} />
        ) : a.previewUrl && a.mediaType === 'video' ? (
          <>
            <video
              src={`${API_URL}${a.previewUrl}`}
              muted
              playsInline
              preload="metadata"
              className={TILE_MEDIA_CLASS}
            />
            <span className="absolute bottom-1 right-1 rounded bg-black/70 px-1 py-0.5 text-[10px] uppercase tracking-wide text-zinc-200">
              video
            </span>
          </>
        ) : (
          <div className="flex h-full items-center justify-center text-xs uppercase tracking-wide text-zinc-600">
            {a.mediaType}
          </div>
        )}
      </div>
      <div className="space-y-0.5 px-2 py-1.5">
        <p className="truncate text-xs capitalize text-zinc-200">{a.characterName}</p>
        <div className="flex items-center gap-1.5">
          {/* Library items are approved by definition; never echo an upstream
              generation term such as "Generated" as a library status. */}
          <span className="rounded bg-emerald-950 px-1 py-0.5 text-[10px] uppercase tracking-wide text-emerald-400">
            Approved
          </span>
          {a.isPrimary && (
            <span className="rounded bg-rose-950 px-1 py-0.5 text-[10px] uppercase tracking-wide text-rose-400">
              Primary
            </span>
          )}
        </div>
        <p className="text-[10px] text-zinc-600">
          {a.recencyBasis === 'approved' ? 'Approved' : 'Added'} · {relative(a.recentAt)}
        </p>
      </div>
    </button>
  );
}

export default function ContentLibraryPage() {
  const [recent, setRecent] = useState<LibraryAssetView[]>([]);
  const [assets, setAssets] = useState<LibraryAssetView[]>([]);
  const [mediaType, setMediaType] = useState<'image' | 'video' | undefined>(undefined);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<LibraryAssetView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Manual upload. characterId is REQUIRED: a library asset cannot exist
  // without a character, so the operator picks one — nothing is inferred.
  const fileRef = useRef<HTMLInputElement>(null);
  const [characters, setCharacters] = useState<PublicCharacter[]>([]);
  const [uploadCharacterId, setUploadCharacterId] = useState('');
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadNotice, setUploadNotice] = useState<string | null>(null);

  // Delete: two-step confirmation, reset whenever a different asset is opened.
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await contentLibraryApi.list({ mediaType, search: search || undefined });
      setRecent(data.recent);
      setAssets(data.assets);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the content library.');
    } finally {
      setLoading(false);
    }
  }, [mediaType, search]);

  useEffect(() => {
    void load();
  }, [load]);

  // Character choices for the upload target, from the existing public endpoint.
  useEffect(() => {
    charactersApi
      .list()
      .then((list) => {
        setCharacters(list);
        setUploadCharacterId((current) => current || (list[0]?.id ?? ''));
      })
      .catch(() => setCharacters([]));
  }, []);

  // Closing or switching assets must never leave a primed confirmation behind.
  const openAsset = useCallback((a: LibraryAssetView | null) => {
    setSelected(a);
    setConfirmingDelete(false);
    setDeleteError(null);
  }, []);

  const onDelete = useCallback(
    async (assetId: string) => {
      setDeleting(true);
      setDeleteError(null);
      try {
        await contentLibraryApi.remove(assetId);
        openAsset(null); // close the modal
        await load(); // refresh in place — no page reload
      } catch (err) {
        setDeleteError(err instanceof Error ? err.message : 'Could not delete this asset.');
      } finally {
        setDeleting(false);
      }
    },
    [load, openAsset],
  );

  const onFilePicked = useCallback(
    async (file: File | undefined) => {
      if (!file || !uploadCharacterId) return;
      setUploading(true);
      setUploadError(null);
      setUploadNotice(null);
      try {
        await contentLibraryApi.upload(file, uploadCharacterId);
        // The upload does NOT appear here: it lands in Review, like generated
        // content, and reaches the Library when it is approved. Saying so
        // explicitly matters — otherwise the file looks like it vanished.
        setUploadNotice('Uploaded to Review. It joins the Library once approved.');
        await load();
      } catch (err) {
        setUploadError(err instanceof Error ? err.message : 'Upload failed.');
      } finally {
        setUploading(false);
        if (fileRef.current) fileRef.current.value = ''; // allow re-picking the same file
      }
    },
    [uploadCharacterId, load],
  );

  return (
    <div className="mx-auto max-w-6xl">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-white">Content Library</h1>
          <p className="mt-1 text-sm text-zinc-400">
            Approved content, ready for categories and publishing. Uploads go to Review first.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label htmlFor="upload-character" className="sr-only">
            Upload to character
          </label>
          <select
            id="upload-character"
            value={uploadCharacterId}
            onChange={(e) => setUploadCharacterId(e.target.value)}
            className="rounded-md border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-200"
          >
            {characters.map((c) => (
              <option key={c.id} value={c.id}>
                {c.displayName}
              </option>
            ))}
          </select>
          <input
            ref={fileRef}
            type="file"
            accept="image/jpeg,image/png,image/webp,video/mp4,video/webm,video/quicktime"
            onChange={(e) => void onFilePicked(e.target.files?.[0])}
            className="hidden"
          />
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={uploading || !uploadCharacterId}
            className="rounded-md bg-rose-600 px-3 py-1.5 text-sm font-semibold text-white transition-colors hover:bg-rose-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {uploading ? 'Uploading…' : 'Upload'}
          </button>
        </div>
      </div>

      {uploadNotice && (
        <p className="mt-3 rounded-md border border-emerald-900 bg-emerald-950/30 px-4 py-2 text-sm text-emerald-300">
          {uploadNotice}{' '}
          <Link to="/admin/content/review" className="underline">
            Open Review
          </Link>
        </p>
      )}

      {uploadError && (
        <p
          role="alert"
          className="mt-4 rounded-md border border-rose-900 bg-rose-950/40 px-4 py-2 text-sm text-rose-300"
        >
          {uploadError}
        </p>
      )}

      {error && (
        <p role="alert" className="mt-4 rounded-md border border-rose-900 bg-rose-950/40 px-4 py-2 text-sm text-rose-300">
          {error}
        </p>
      )}

      {/* Recent first — always, never behind a filter. */}
      <section className="mt-6">
        <h2 className="text-sm font-medium text-zinc-200">Recently Added</h2>
        {loading ? (
          <p className="mt-3 text-sm text-zinc-500">Loading…</p>
        ) : recent.length === 0 ? (
          <div className="mt-3 rounded-lg border border-dashed border-zinc-800 bg-zinc-900/40 px-6 py-8 text-center">
            <p className="text-sm text-zinc-300">Nothing new yet</p>
            <p className="mx-auto mt-1 max-w-sm text-sm text-zinc-500">
              Content appears here once it is approved in Review. Everything already in the library
              is listed below.
            </p>
          </div>
        ) : (
          <ul className="mt-3 grid grid-cols-3 gap-3 sm:grid-cols-4 lg:grid-cols-6">
            {recent.map((a) => (
              <li key={`recent-${a.assetId}`}>
                <Tile a={a} dense onOpen={() => openAsset(a)} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mt-10">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-medium text-zinc-200">All content</h2>
          <div className="flex items-center gap-2">
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search character"
              aria-label="Search by character"
              className="rounded-md border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-200 placeholder:text-zinc-600"
            />
            {(['image', 'video'] as const).map((t) => (
              <button
                key={t}
                type="button"
                aria-pressed={mediaType === t}
                onClick={() => setMediaType(mediaType === t ? undefined : t)}
                className={`rounded-md px-3 py-1.5 text-sm capitalize ${
                  mediaType === t ? 'bg-zinc-800 text-white' : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                {t}
              </button>
            ))}
          </div>
        </div>

        {loading ? (
          <p className="mt-4 text-sm text-zinc-500">Loading…</p>
        ) : assets.length === 0 ? (
          <p className="mt-4 rounded-lg border border-dashed border-zinc-800 bg-zinc-900/40 px-6 py-8 text-center text-sm text-zinc-500">
            No content matches this view.
          </p>
        ) : (
          <ul className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-5">
            {assets.map((a) => (
              <li key={a.assetId}>
                <Tile a={a} onOpen={() => openAsset(a)} />
              </li>
            ))}
          </ul>
        )}
      </section>

      {selected && (
        <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/70 p-6">
          <div className="max-h-full w-full max-w-lg overflow-y-auto rounded-lg border border-zinc-800 bg-zinc-950 p-5">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-sm font-medium capitalize text-white">{selected.characterName}</p>
                <p className="text-xs text-zinc-500">
                  {selected.mediaType} · Approved{selected.isPrimary ? ' · Primary' : ''}
                </p>
              </div>
              <button type="button" onClick={() => openAsset(null)} className="text-sm text-zinc-400 hover:text-white">
                Close
              </button>
            </div>

            <div className="mt-3 overflow-hidden rounded bg-zinc-900">
              {selected.previewUrl && selected.mediaType === 'video' ? (
                <video src={`${API_URL}${selected.previewUrl}`} controls muted playsInline className="w-full" />
              ) : selected.previewUrl ? (
                <img src={`${API_URL}${selected.previewUrl}`} alt="" className="w-full" />
              ) : null}
            </div>

            <dl className="mt-4 space-y-1 text-xs text-zinc-400">
              <div className="flex justify-between gap-2">
                <dt>Added</dt>
                <dd className="text-zinc-300">{new Date(selected.createdAt).toLocaleString()}</dd>
              </div>
              {selected.approvedAt && (
                <div className="flex justify-between gap-2">
                  <dt>Approved</dt>
                  <dd className="text-zinc-300">{new Date(selected.approvedAt).toLocaleString()}</dd>
                </div>
              )}
              <div className="flex justify-between gap-2">
                <dt>Rating</dt>
                <dd className="text-zinc-300">{selected.contentRating}</dd>
              </div>
              {selected.provenance.provider && (
                <div className="flex justify-between gap-2">
                  <dt>Source</dt>
                  <dd className="truncate text-zinc-300">
                    {selected.provenance.provider} · {selected.provenance.model}
                  </dd>
                </div>
              )}
            </dl>

            {/* Delete lives in the detail view, not the tile: the tile is
                already a <button> and nesting one inside it is invalid HTML.
                Two-step confirmation, inline rather than window.confirm so it
                never blocks the page. */}
            <div className="mt-5 flex items-center justify-between gap-3 border-t border-zinc-800 pt-3">
              {deleteError ? (
                <p role="alert" className="text-xs text-rose-300">
                  {deleteError}
                </p>
              ) : (
                <p className="text-xs text-zinc-500">
                  {confirmingDelete ? 'This permanently removes the record and its file.' : ''}
                </p>
              )}
              {confirmingDelete ? (
                <div className="flex shrink-0 items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setConfirmingDelete(false)}
                    disabled={deleting}
                    className="rounded-md px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => void onDelete(selected.assetId)}
                    disabled={deleting}
                    className="rounded-md bg-rose-700 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-rose-600 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {deleting ? 'Deleting…' : 'Confirm delete'}
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    setDeleteError(null);
                    setConfirmingDelete(true);
                  }}
                  className="shrink-0 rounded-md border border-rose-900 px-3 py-1.5 text-xs font-semibold text-rose-300 transition-colors hover:bg-rose-950/50"
                >
                  Delete
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
