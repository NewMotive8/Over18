import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  ApiRequestError,
  adminCharactersApi,
  type AdminCharacterListItem,
  type AdminCharacterView,
} from '../../lib/api';

/**
 * US-101 / Phase 1 — Characters catalogue.
 *
 * Creating a character takes a NAME and ONE IMAGE. That is the whole form.
 * Everything else — persona, more references, further identity versions — is
 * done afterwards on her own page, where Autofill can write a first draft of
 * the persona in one click. Demanding five paragraphs of prose before a
 * character can exist is what made this screen unusable.
 *
 * Readiness is stated in WORDS on every row, not implied by a colour, because
 * "why can't this character generate anything yet" is the question this screen
 * exists to answer. Identity management only — nothing here reviews or
 * approves generated content; that is the Review queue.
 */

/** Derives a valid slug from what the operator typed, so they never meet the regex. */
export function slugify(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

export function readinessOf(character: AdminCharacterListItem): string {
  if (character.identityVersionCount === 0) return 'No visual identity yet';
  if (character.activeIdentityVersion === null) return 'Identity drafted, none active';
  if (character.primaryReferenceCount === 0) return `v${character.activeIdentityVersion} active · no primary references`;
  return `v${character.activeIdentityVersion} active · ${character.primaryReferenceCount} primary reference${
    character.primaryReferenceCount === 1 ? '' : 's'
  }`;
}

/**
 * Says, in words, that the persona still needs writing. Separate from visual
 * readiness because they are different blockers with different fixes: one is
 * solved on the identity section, the other by writing (or generating) text.
 */
export function profileNoteOf(character: AdminCharacterView): string | null {
  if (character.profileComplete) return null;
  const n = character.missingProfileFields.length;
  return n === 0 ? 'Profile incomplete' : `Profile incomplete — ${n} field${n === 1 ? '' : 's'} to fill`;
}

export default function AdminCharactersPage() {
  const navigate = useNavigate();
  const [characters, setCharacters] = useState<AdminCharacterListItem[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [displayName, setDisplayName] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    setLoadError(null);
    adminCharactersApi
      .list()
      .then(setCharacters)
      .catch(() => setLoadError("Couldn't load characters."));
  }, []);

  useEffect(load, [load]);

  async function handleCreate(event: FormEvent) {
    event.preventDefault();
    if (saving) return;
    if (!file) {
      setSaveError('Choose an image of her first.');
      return;
    }
    const name = slugify(displayName);
    if (name.length < 2) {
      setSaveError('Enter a name with at least two letters or numbers.');
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      // The image becomes her primary reference on visual identity v1 —
      // one file, stored once, no copy made to fill profile_image.
      const created = await adminCharactersApi.quickCreate({
        name,
        displayName: displayName.trim(),
        file,
      });
      setDisplayName('');
      setFile(null);
      setCreating(false);
      // Straight to her page: the persona is the next thing to do, and that is
      // where Autofill lives.
      navigate(`/admin/characters/${created.character.id}`);
    } catch (error) {
      setSaveError(
        error instanceof ApiRequestError ? error.message : "Couldn't create the character.",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <header className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-white">Characters</h1>
          <p className="mt-1 text-sm text-zinc-400">
            Create characters, manage their visual identity and choose the primary references
            generation will use.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setCreating((open) => !open)}
          className="shrink-0 rounded-lg bg-rose-600 px-4 py-2 text-sm font-medium text-white hover:bg-rose-500"
        >
          {creating ? 'Cancel' : 'Create character'}
        </button>
      </header>

      {creating && (
        <form
          onSubmit={handleCreate}
          className="mb-8 space-y-4 rounded-lg border border-zinc-800 bg-zinc-900/40 p-4"
        >
          <h2 className="text-sm font-medium text-zinc-200">New character</h2>
          <p className="text-xs text-zinc-500">
            A name and one photo is all you need. You can write her personality — or have it
            written for you — on her page afterwards.
          </p>

          <label className="block">
            <span className="text-xs font-medium uppercase tracking-wide text-zinc-400">Name</span>
            <input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Nova"
              className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100"
            />
            <span className="mt-1 block text-xs text-zinc-500">
              {displayName.trim() ? `Her id will be "${slugify(displayName)}".` : 'What users see.'}
            </span>
          </label>

          <label className="block">
            <span className="text-xs font-medium uppercase tracking-wide text-zinc-400">Photo</span>
            <input
              ref={fileInput}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="mt-1 block w-full text-sm text-zinc-300 file:mr-3 file:rounded-lg file:border-0 file:bg-zinc-800 file:px-3 file:py-2 file:text-sm file:text-zinc-200"
            />
            <span className="mt-1 block text-xs text-zinc-500">
              JPEG, PNG or WebP. This becomes her first primary reference.
            </span>
          </label>

          {saveError && (
            <p role="alert" className="rounded-lg border border-red-900 bg-red-950/60 px-3 py-2 text-sm text-red-300">
              {saveError}
            </p>
          )}

          <button
            type="submit"
            disabled={saving}
            className="rounded-lg bg-rose-600 px-4 py-2 text-sm font-medium text-white hover:bg-rose-500 disabled:opacity-50"
          >
            {saving ? 'Creating…' : 'Create character'}
          </button>
        </form>
      )}

      {loadError && (
        <div role="alert" className="rounded-lg border border-red-900 bg-red-950/60 px-4 py-3 text-sm text-red-300">
          {loadError}
          <button type="button" onClick={load} className="ml-3 underline">
            Retry
          </button>
        </div>
      )}

      {!loadError && characters === null && <p className="text-sm text-zinc-500">Loading…</p>}

      {characters !== null && characters.length === 0 && (
        <div className="rounded-lg border border-dashed border-zinc-800 bg-zinc-900/40 px-6 py-12 text-center">
          <p className="text-sm text-zinc-300">No characters yet</p>
          <p className="mt-1 text-sm text-zinc-500">
            Create one with a name and a photo — the rest can wait.
          </p>
        </div>
      )}

      {characters !== null && characters.length > 0 && (
        <ul className="divide-y divide-zinc-800 rounded-lg border border-zinc-800">
          {characters.map((character) => (
            <li key={character.id}>
              <Link
                to={`/admin/characters/${character.id}`}
                className="flex items-center justify-between gap-4 px-4 py-3 transition-colors hover:bg-zinc-900/60"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-zinc-100">
                    {character.displayName}{' '}
                    <span className="text-zinc-500">/ {character.name}</span>
                  </p>
                  <p className="truncate text-xs text-zinc-500">{readinessOf(character)}</p>
                  {profileNoteOf(character) && (
                    <p className="truncate text-xs text-amber-500/80">{profileNoteOf(character)}</p>
                  )}
                </div>
                <span
                  className={`shrink-0 rounded px-2 py-0.5 text-[10px] uppercase tracking-wide ${
                    character.status === 'active'
                      ? 'bg-emerald-950 text-emerald-400'
                      : 'bg-zinc-800 text-zinc-400'
                  }`}
                >
                  {character.status}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
