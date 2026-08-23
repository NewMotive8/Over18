import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  adminDiscoveryApi,
  API_URL,
  ApiRequestError,
  type DiscoveryCategoryView,
  type TaggableAssetView,
} from '../../lib/api';
import { canMove, moveBy } from '../../admin/categoryBoard';
import ConfirmDialog from '../../admin/ConfirmDialog';
import PublishingTabs from '../../admin/PublishingTabs';
import { TILE_MEDIA_CLASS, tileFrameClass } from '../../lib/mediaTile';

/**
 * Admin → Categories & Publishing → Discovery (US-102.4).
 *
 * The keyword system behind the app's lower-page category strip. A discovery
 * category is a named set of keywords and its membership is a QUERY: every
 * approved clip carrying at least one of those keywords, computed live.
 *
 * THIS IS NOT THE APP CATEGORIES SCREEN. App Categories are editorial
 * collections an operator fills by hand and publishes to Home; these are
 * keyword queries over all content. The copy says so, because the two are
 * genuinely easy to confuse and they behave completely differently.
 *
 * REMOVING A CATEGORY REMOVES ONLY THE CATEGORY. The keywords survive, and so
 * does every clip carrying them. The delete dialog states it and the response
 * reports the counts.
 */

type Notice = { kind: 'error' | 'success'; text: string } | null;

function parseKeywords(raw: string): string[] {
  return raw
    .split(',')
    .map((term) => term.trim())
    .filter((term) => term.length > 0);
}

export default function DiscoveryCategoriesPage() {
  const [categories, setCategories] = useState<DiscoveryCategoryView[] | null>(null);
  const [assets, setAssets] = useState<TaggableAssetView[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [newName, setNewName] = useState('');
  const [newKeywords, setNewKeywords] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editKeywords, setEditKeywords] = useState('');
  const [editName, setEditName] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [taggingId, setTaggingId] = useState<string | null>(null);
  const [tagDraft, setTagDraft] = useState('');

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await adminDiscoveryApi.categories();
      setCategories(res.categories);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Couldn't load discovery categories.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(action: () => Promise<unknown>, failure: string, success?: string) {
    if (busy) return false;
    setBusy(true);
    setNotice(null);
    try {
      await action();
      if (success) setNotice({ kind: 'success', text: success });
      return true;
    } catch (err) {
      setNotice({ kind: 'error', text: err instanceof ApiRequestError ? err.message : failure });
      return false;
    } finally {
      setBusy(false);
    }
  }

  const deleting = useMemo(
    () => categories?.find((c) => c.id === confirmDeleteId) ?? null,
    [categories, confirmDeleteId],
  );

  async function create() {
    const name = newName.trim();
    if (!name) return;
    const ok = await run(
      async () => {
        await adminDiscoveryApi.create({ name, keywords: parseKeywords(newKeywords) });
        await load();
      },
      "Couldn't create that category.",
      `"${name}" created.`,
    );
    if (ok) {
      setNewName('');
      setNewKeywords('');
    }
  }

  async function saveEdit(category: DiscoveryCategoryView) {
    const ok = await run(
      async () => {
        if (editName.trim() && editName.trim() !== category.name) {
          await adminDiscoveryApi.update(category.id, { name: editName.trim() });
        }
        await adminDiscoveryApi.setKeywords(category.id, parseKeywords(editKeywords));
        await load();
      },
      "Couldn't save that category.",
      'Saved.',
    );
    if (ok) setEditingId(null);
  }

  async function toggleEnabled(category: DiscoveryCategoryView) {
    await run(
      async () => {
        await adminDiscoveryApi.update(category.id, { enabled: !category.enabled });
        await load();
      },
      "Couldn't change that category.",
      category.enabled
        ? `"${category.name}" is hidden from the app.`
        : `"${category.name}" is visible again.`,
    );
  }

  async function move(id: string, delta: number) {
    if (!categories) return;
    const next = moveBy(categories, id, delta).map((c) => c.id);
    await run(
      async () => {
        const res = await adminDiscoveryApi.order(next);
        setCategories(res.categories);
      },
      "Couldn't reorder.",
      'Order saved.',
    );
  }

  async function remove(category: DiscoveryCategoryView) {
    const ok = await run(
      async () => {
        const res = await adminDiscoveryApi.remove(category.id);
        setNotice({
          kind: 'success',
          text: `"${category.name}" removed. ${res.keywordsKept} keyword${
            res.keywordsKept === 1 ? '' : 's'
          } kept, and no content was changed.`,
        });
        await load();
      },
      "Couldn't remove that category.",
    );
    if (ok) setConfirmDeleteId(null);
  }

  async function loadAssets() {
    await run(async () => {
      const res = await adminDiscoveryApi.content();
      setAssets(res.assets);
    }, "Couldn't load content.");
  }

  async function saveTags(asset: TaggableAssetView) {
    const ok = await run(
      async () => {
        await adminDiscoveryApi.setAssetKeywords(asset.assetId, parseKeywords(tagDraft));
        const res = await adminDiscoveryApi.content();
        setAssets(res.assets);
        await load();
      },
      "Couldn't save those keywords.",
      'Keywords saved.',
    );
    if (ok) setTaggingId(null);
  }

  return (
    <div className="mx-auto w-full max-w-6xl px-4 pb-24 pt-6 sm:px-6">
      <header className="mb-4">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-neutral-500">
          Categories &amp; Publishing
        </p>
        <h1 className="mt-1 text-2xl font-semibold text-neutral-100 sm:text-3xl">
          Discovery categories
        </h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-neutral-400">
          The category strip under Search in the app. These are not App Categories — each one is a
          set of keywords, and it shows every approved clip carrying at least one of them. The first
          category in this list is the app&apos;s default.
        </p>
      </header>

      <PublishingTabs />

      {notice && (
        <div
          role="status"
          aria-live="polite"
          className={`mb-4 rounded-xl border px-4 py-3 text-sm ${
            notice.kind === 'error'
              ? 'border-red-500/40 bg-red-500/10 text-red-200'
              : 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200'
          }`}
        >
          {notice.text}
        </div>
      )}

      {loadError && (
        <div className="rounded-2xl border border-red-500/40 bg-red-500/10 p-6 text-sm text-red-200">
          <p className="font-medium">{loadError}</p>
          <button
            type="button"
            onClick={() => void load()}
            className="mt-3 rounded-lg border border-red-400/40 px-3 py-1.5 text-xs text-red-100 hover:bg-red-500/20"
          >
            Try again
          </button>
        </div>
      )}

      {!loadError && categories === null && (
        <div aria-busy="true" className="space-y-2">
          {[0, 1, 2].map((n) => (
            <div
              key={n}
              className="h-16 animate-pulse rounded-xl border border-neutral-800 bg-neutral-900/50"
            />
          ))}
          <span className="sr-only">Loading discovery categories…</span>
        </div>
      )}

      {!loadError && categories !== null && (
        <>
          <div className="mb-5 rounded-xl border border-neutral-800 bg-neutral-900/40 p-3">
            <h2 className="text-sm font-semibold text-neutral-200">New discovery category</h2>
            <div className="mt-2 flex flex-wrap gap-2">
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Name, e.g. Sexy"
                maxLength={60}
                className="w-48 rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 outline-none focus:border-neutral-400"
              />
              <input
                value={newKeywords}
                onChange={(e) => setNewKeywords(e.target.value)}
                placeholder="Keywords, comma separated: sexy, lingerie, seductive"
                className="min-w-0 flex-1 rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 outline-none focus:border-neutral-400"
              />
              <button
                type="button"
                onClick={() => void create()}
                disabled={busy || !newName.trim()}
                className="rounded-lg bg-neutral-100 px-3.5 py-2 text-sm font-medium text-neutral-900 hover:bg-white disabled:opacity-50"
              >
                Create
              </button>
            </div>
            <p className="mt-1.5 text-[11px] text-neutral-500">
              A clip matches if it carries <em>any</em> of the keywords.
            </p>
          </div>

          {categories.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-neutral-800 bg-neutral-900/30 p-8 text-center">
              <h3 className="text-base font-medium text-neutral-200">No discovery categories yet</h3>
              <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-neutral-400">
                The app&apos;s category strip is empty until you create one. Search still works
                without them.
              </p>
            </div>
          ) : (
            <ul className="space-y-2">
              {categories.map((category, index) => (
                <li
                  key={category.id}
                  className={`rounded-xl border bg-neutral-900/60 p-3 ${
                    category.enabled ? 'border-neutral-800' : 'border-neutral-800 opacity-60'
                  }`}
                >
                  <div className="flex flex-wrap items-start gap-3">
                    <span className="w-5 shrink-0 pt-1 text-center text-[11px] tabular-nums text-neutral-600">
                      {index + 1}
                    </span>
                    <div className="min-w-0 flex-1">
                      {editingId === category.id ? (
                        <div className="flex flex-wrap gap-2">
                          <input
                            value={editName}
                            onChange={(e) => setEditName(e.target.value)}
                            maxLength={60}
                            className="w-40 rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-1.5 text-sm text-neutral-100 outline-none focus:border-neutral-400"
                          />
                          <input
                            value={editKeywords}
                            onChange={(e) => setEditKeywords(e.target.value)}
                            placeholder="sexy, lingerie, seductive"
                            className="min-w-0 flex-1 rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-1.5 text-sm text-neutral-100 outline-none focus:border-neutral-400"
                          />
                          <button
                            type="button"
                            onClick={() => void saveEdit(category)}
                            disabled={busy}
                            className="rounded-md bg-neutral-100 px-3 py-1.5 text-xs font-medium text-neutral-900 hover:bg-white disabled:opacity-50"
                          >
                            Save
                          </button>
                          <button
                            type="button"
                            onClick={() => setEditingId(null)}
                            className="rounded-md border border-neutral-700 px-3 py-1.5 text-xs text-neutral-300 hover:bg-neutral-800"
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <>
                          <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-neutral-100">
                            {category.name}
                            {index === 0 && category.enabled && (
                              <span className="rounded-full bg-neutral-700/40 px-2 py-0.5 text-[10px] font-medium text-neutral-300">
                                Default
                              </span>
                            )}
                            {!category.enabled && (
                              <span className="rounded-full bg-neutral-700/40 px-2 py-0.5 text-[10px] font-medium text-neutral-400">
                                Hidden
                              </span>
                            )}
                          </p>
                          <p className="mt-1 flex flex-wrap gap-1">
                            {category.keywords.length === 0 ? (
                              <span className="text-[11px] text-amber-300/90">
                                No keywords — this category matches nothing.
                              </span>
                            ) : (
                              category.keywords.map((keyword) => (
                                <span
                                  key={keyword.id}
                                  className="rounded-full bg-white/5 px-2 py-0.5 text-[11px] text-neutral-300"
                                >
                                  {keyword.label}
                                </span>
                              ))
                            )}
                          </p>
                          <p className="mt-1 text-[11px] text-neutral-500">
                            {category.matchCount} approved clip
                            {category.matchCount === 1 ? '' : 's'} match right now
                          </p>
                        </>
                      )}
                    </div>

                    {editingId !== category.id && (
                      <div className="flex shrink-0 flex-wrap gap-1">
                        <button
                          type="button"
                          onClick={() => void move(category.id, -1)}
                          disabled={busy || !canMove(categories, category.id, -1)}
                          aria-label={`Move ${category.name} up`}
                          className="rounded-md border border-neutral-800 px-2 py-1 text-xs text-neutral-400 hover:bg-neutral-800 disabled:opacity-30"
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          onClick={() => void move(category.id, 1)}
                          disabled={busy || !canMove(categories, category.id, 1)}
                          aria-label={`Move ${category.name} down`}
                          className="rounded-md border border-neutral-800 px-2 py-1 text-xs text-neutral-400 hover:bg-neutral-800 disabled:opacity-30"
                        >
                          ↓
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setEditingId(category.id);
                            setEditName(category.name);
                            setEditKeywords(category.keywords.map((k) => k.label).join(', '));
                          }}
                          className="rounded-md border border-neutral-800 px-2.5 py-1 text-xs text-neutral-200 hover:bg-neutral-800"
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          onClick={() => void toggleEnabled(category)}
                          disabled={busy}
                          className="rounded-md border border-neutral-800 px-2.5 py-1 text-xs text-neutral-300 hover:bg-neutral-800 disabled:opacity-50"
                        >
                          {category.enabled ? 'Hide' : 'Show'}
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteId(category.id)}
                          disabled={busy}
                          className="rounded-md border border-neutral-800 px-2.5 py-1 text-xs text-red-300 hover:bg-red-500/10 disabled:opacity-50"
                        >
                          Remove
                        </button>
                      </div>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}

          {/* ---------------- content keywords ---------------- */}
          <section className="mt-8">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-sm font-semibold text-neutral-200">Content keywords</h2>
                <p className="mt-0.5 text-xs text-neutral-500">
                  Keywords on individual clips. Tagging never changes the content itself — but a
                  keyword used by a visible category puts the clip on the app&apos;s strip, so it is
                  a distribution choice.
                </p>
              </div>
              <button
                type="button"
                onClick={() => (assets ? setAssets(null) : void loadAssets())}
                disabled={busy}
                className="rounded-lg border border-neutral-700 px-3 py-1.5 text-xs text-neutral-300 hover:bg-neutral-800 disabled:opacity-50"
              >
                {assets ? 'Close' : 'Tag content'}
              </button>
            </div>

            {assets && (
              <ul className="space-y-2">
                {assets.map((asset) => (
                  <li
                    key={asset.assetId}
                    className="flex flex-wrap items-center gap-3 rounded-xl border border-neutral-800 bg-neutral-900/60 p-2.5"
                  >
                    <div className="w-16 shrink-0">
                      <div className={tileFrameClass(true)}>
                        {asset.previewUrl ? (
                          asset.mediaType === 'video' ? (
                            <video
                              src={`${API_URL}${asset.previewUrl}`}
                              muted
                              preload="metadata"
                              className={TILE_MEDIA_CLASS}
                            />
                          ) : (
                            <img
                              src={`${API_URL}${asset.previewUrl}`}
                              alt=""
                              loading="lazy"
                              className={TILE_MEDIA_CLASS}
                            />
                          )
                        ) : null}
                      </div>
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm text-neutral-200">{asset.characterName}</p>
                      {taggingId === asset.assetId ? (
                        <div className="mt-1.5 flex flex-wrap gap-2">
                          <input
                            value={tagDraft}
                            onChange={(e) => setTagDraft(e.target.value)}
                            placeholder="sexy, lingerie"
                            className="min-w-0 flex-1 rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-1.5 text-sm text-neutral-100 outline-none focus:border-neutral-400"
                          />
                          <button
                            type="button"
                            onClick={() => void saveTags(asset)}
                            disabled={busy}
                            className="rounded-md bg-neutral-100 px-3 py-1.5 text-xs font-medium text-neutral-900 hover:bg-white disabled:opacity-50"
                          >
                            Save
                          </button>
                          <button
                            type="button"
                            onClick={() => setTaggingId(null)}
                            className="rounded-md border border-neutral-700 px-3 py-1.5 text-xs text-neutral-300 hover:bg-neutral-800"
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <p className="mt-1 flex flex-wrap gap-1">
                          {asset.keywords.length === 0 ? (
                            <span className="text-[11px] text-neutral-500">No keywords</span>
                          ) : (
                            asset.keywords.map((keyword) => (
                              <span
                                key={keyword.id}
                                className="rounded-full bg-white/5 px-2 py-0.5 text-[11px] text-neutral-300"
                              >
                                {keyword.label}
                              </span>
                            ))
                          )}
                        </p>
                      )}
                    </div>
                    {taggingId !== asset.assetId && (
                      <button
                        type="button"
                        onClick={() => {
                          setTaggingId(asset.assetId);
                          setTagDraft(asset.keywords.map((k) => k.label).join(', '));
                        }}
                        className="shrink-0 rounded-md border border-neutral-800 px-2.5 py-1 text-xs text-neutral-200 hover:bg-neutral-800"
                      >
                        Edit keywords
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}

      {deleting && (
        <ConfirmDialog
          open
          tone="danger"
          title={`Remove "${deleting.name}"?`}
          body="The category disappears from the app's strip. Its keywords are kept, every clip carrying them is untouched, and no content is deleted or changed."
          confirmLabel="Remove category"
          cancelLabel="Keep it"
          busy={busy}
          onCancel={() => setConfirmDeleteId(null)}
          onConfirm={() => void remove(deleting)}
        />
      )}
    </div>
  );
}
