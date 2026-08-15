import { useCallback, useEffect, useState } from 'react';
import { API_URL, contentLibraryApi, type LibraryAssetView } from '../../lib/api';

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

function Tile({ a, onOpen, dense }: { a: LibraryAssetView; onOpen: () => void; dense?: boolean }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="w-full overflow-hidden rounded-lg border border-zinc-800 text-left transition-colors hover:border-zinc-700"
    >
      <div className={`${dense ? 'aspect-square' : 'aspect-[3/4]'} bg-zinc-900`}>
        {a.storageKey && a.mediaType === 'image' ? (
          <img src={`${API_URL}${a.storageKey}`} alt="" loading="lazy" className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full items-center justify-center text-xs uppercase tracking-wide text-zinc-600">
            {a.mediaType}
          </div>
        )}
      </div>
      <div className="space-y-0.5 px-2 py-1.5">
        <p className="truncate text-xs capitalize text-zinc-200">{a.characterName}</p>
        <div className="flex items-center gap-1.5">
          <span
            className={`rounded px-1 py-0.5 text-[10px] uppercase tracking-wide ${
              a.status === 'approved' ? 'bg-emerald-950 text-emerald-400' : 'bg-zinc-800 text-zinc-400'
            }`}
          >
            {a.status.replace('_', ' ')}
          </span>
          {a.isPrimary && (
            <span className="rounded bg-rose-950 px-1 py-0.5 text-[10px] uppercase tracking-wide text-rose-400">
              Primary
            </span>
          )}
        </div>
        <p className="text-[10px] text-zinc-600">
          {a.recencyBasis === 'approved' ? 'Approved' : 'Added'} {relative(a.recentAt)}
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

  return (
    <div className="mx-auto max-w-6xl">
      <h1 className="text-xl font-semibold text-white">Content Library</h1>
      <p className="mt-1 text-sm text-zinc-400">All content that has been through review.</p>

      {error && (
        <p role="alert" className="mt-4 rounded-md border border-rose-900 bg-rose-950/40 px-4 py-2 text-sm text-rose-300">
          {error}
        </p>
      )}

      {/* Recent first — always, never behind a filter. */}
      <section className="mt-6">
        <h2 className="text-sm font-medium text-zinc-200">Recently approved &amp; added</h2>
        {loading ? (
          <p className="mt-3 text-sm text-zinc-500">Loading…</p>
        ) : recent.length === 0 ? (
          <div className="mt-3 rounded-lg border border-dashed border-zinc-800 bg-zinc-900/40 px-6 py-8 text-center">
            <p className="text-sm text-zinc-300">Nothing new yet</p>
            <p className="mx-auto mt-1 max-w-sm text-sm text-zinc-500">
              Content appears here once it has been generated or approved. Everything already in the
              library is listed below.
            </p>
          </div>
        ) : (
          <ul className="mt-3 grid grid-cols-3 gap-3 sm:grid-cols-4 lg:grid-cols-6">
            {recent.map((a) => (
              <li key={`recent-${a.assetId}`}>
                <Tile a={a} dense onOpen={() => setSelected(a)} />
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
                <Tile a={a} onOpen={() => setSelected(a)} />
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
                  {selected.mediaType} · {selected.status.replace('_', ' ')}
                  {selected.isPrimary ? ' · Primary' : ''}
                </p>
              </div>
              <button type="button" onClick={() => setSelected(null)} className="text-sm text-zinc-400 hover:text-white">
                Close
              </button>
            </div>

            <div className="mt-3 overflow-hidden rounded bg-zinc-900">
              {selected.storageKey && selected.mediaType === 'video' ? (
                <video src={`${API_URL}${selected.storageKey}`} controls muted playsInline className="w-full" />
              ) : selected.storageKey ? (
                <img src={`${API_URL}${selected.storageKey}`} alt="" className="w-full" />
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
          </div>
        </div>
      )}
    </div>
  );
}
