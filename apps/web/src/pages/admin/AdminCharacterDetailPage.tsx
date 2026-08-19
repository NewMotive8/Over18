import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  API_URL,
  ApiRequestError,
  adminCharactersApi,
  type AdminCharacterDetail,
  type VisualIdentityView,
} from '../../lib/api';

/**
 * US-101 — one character: persona, visual identity versions, primary references.
 *
 * Versioning is the point of this screen. Editing identity attributes NEVER
 * overwrites a version — it creates the next one — so history survives and a
 * bad change can be rolled back by re-activating an earlier version.
 *
 * Exactly one version is active, and the screen says so in words rather than
 * relying on a highlight: the active version is the one generation will use.
 *
 * Identity only. Nothing here approves or rejects generated content.
 */

/** Identity attributes the form edits. Presentation (pose, lighting, clothing)
 *  is deliberately absent — that is a generation-time concern, not identity. */
const DNA_FIELDS: ReadonlyArray<{ key: string; label: string; required?: boolean }> = [
  { key: 'apparentAgeBand', label: 'Apparent age band', required: true },
  { key: 'face', label: 'Face' },
  { key: 'eyes', label: 'Eyes' },
  { key: 'hair', label: 'Hair' },
  { key: 'skin', label: 'Skin' },
  { key: 'body', label: 'Body' },
  { key: 'distinctiveFeatures', label: 'Distinctive features' },
];

function dnaToForm(dna: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const field of DNA_FIELDS) {
    const value = dna?.[field.key];
    out[field.key] = typeof value === 'string' ? value : '';
  }
  return out;
}

export default function AdminCharacterDetailPage() {
  const { characterId } = useParams<{ characterId: string }>();
  const [detail, setDetail] = useState<AdminCharacterDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const [personaOpen, setPersonaOpen] = useState(false);
  const [personaDraft, setPersonaDraft] = useState({ displayName: '', shortBio: '', personality: '', conversationStyle: '', systemPrompt: '' });
  const [interestsText, setInterestsText] = useState('');
  // Autofill state is separate from `busy`: it is a proposal, not a save, and
  // it must never make the page look like something was written to the server.
  const [autofilling, setAutofilling] = useState(false);
  const [autofilled, setAutofilled] = useState(false);

  const [identityOpen, setIdentityOpen] = useState(false);
  const [dnaForm, setDnaForm] = useState<Record<string, string>>(dnaToForm(undefined));
  const [identityLabel, setIdentityLabel] = useState('');

  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    if (!characterId) return;
    setError(null);
    adminCharactersApi
      .get(characterId)
      .then((next) => {
        setDetail(next);
        setPersonaDraft({
          displayName: next.character.displayName,
          shortBio: next.character.shortBio,
          personality: next.character.personality,
          conversationStyle: next.character.conversationStyle,
          systemPrompt: next.character.systemPrompt,
        });
        setInterestsText(next.character.interests.join(', '));
        setAutofilled(false);
      })
      .catch((err) => {
        if (err instanceof ApiRequestError && err.status === 404) setNotFound(true);
        else setError("Couldn't load this character.");
      });
  }, [characterId]);

  useEffect(load, [load]);

  async function run(action: () => Promise<unknown>, failure: string) {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    try {
      await action();
      load();
    } catch (err) {
      setActionError(err instanceof ApiRequestError ? err.message : failure);
    } finally {
      setBusy(false);
    }
  }

  /**
   * Asks the server to PROPOSE a persona. Nothing is saved: the result lands in
   * the open editor for the operator to change or discard, and only "Save
   * persona" writes it. Running it again simply proposes a different one.
   */
  async function handleAutofill(characterId: string) {
    if (autofilling) return;
    setAutofilling(true);
    setActionError(null);
    try {
      const { draft } = await adminCharactersApi.autofill(characterId);
      setPersonaDraft({
        displayName: draft.displayName,
        shortBio: draft.shortBio,
        personality: draft.personality,
        conversationStyle: draft.conversationStyle,
        systemPrompt: draft.systemPrompt,
      });
      setInterestsText(draft.interests.join(', '));
      setPersonaOpen(true);
      setAutofilled(true);
    } catch (err) {
      setActionError(
        err instanceof ApiRequestError ? err.message : "Couldn't write a profile just now.",
      );
    } finally {
      setAutofilling(false);
    }
  }

  if (notFound) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-16 text-center">
        <p className="text-sm text-zinc-300">Character not found</p>
        <Link to="/admin/characters" className="mt-3 inline-block text-sm text-rose-400 underline">
          Back to characters
        </Link>
      </div>
    );
  }
  if (error) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-16 text-center">
        <p role="alert" className="text-sm text-red-300">{error}</p>
        <button type="button" onClick={load} className="mt-3 text-sm text-rose-400 underline">
          Retry
        </button>
      </div>
    );
  }
  if (!detail) return <p className="px-6 py-8 text-sm text-zinc-500">Loading…</p>;

  const { character, identities, activeIdentity, primaryReferences } = detail;
  const seedFrom = (identity: VisualIdentityView | null) => {
    setDnaForm(dnaToForm(identity?.visualDna));
    setIdentityLabel('');
    setIdentityOpen(true);
  };

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <nav className="mb-4 text-xs text-zinc-500">
        <Link to="/admin/characters" className="hover:text-zinc-300">
          Characters
        </Link>{' '}
        / {character.displayName}
      </nav>

      <header className="mb-8 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-white">{character.displayName}</h1>
          <p className="mt-1 text-sm text-zinc-500">/{character.name}</p>
        </div>
        {/* Publishing is deliberately explicit. A quick-created character is
            INACTIVE — she has no persona yet — so nothing half-written reaches
            real users until someone says so. */}
        <div className="flex shrink-0 flex-col items-end gap-1">
          <span
            className={`rounded px-2 py-0.5 text-[10px] uppercase tracking-wide ${
              character.status === 'active' ? 'bg-emerald-950 text-emerald-400' : 'bg-zinc-800 text-zinc-400'
            }`}
          >
            {character.status === 'active' ? 'Live' : 'Not live'}
          </span>
          <button
            type="button"
            disabled={busy || (character.status !== 'active' && !character.profileComplete)}
            onClick={() =>
              run(
                () =>
                  adminCharactersApi.update(character.id, {
                    status: character.status === 'active' ? 'inactive' : 'active',
                  }),
                "Couldn't change whether she is live.",
              )
            }
            className="text-xs text-rose-400 hover:text-rose-300 disabled:cursor-not-allowed disabled:text-zinc-600"
          >
            {character.status === 'active' ? 'Take offline' : 'Publish'}
          </button>
          {character.status !== 'active' && !character.profileComplete && (
            <span className="text-[10px] text-zinc-500">Write her profile first</span>
          )}
        </div>
      </header>

      {actionError && (
        <p role="alert" className="mb-4 rounded-lg border border-red-900 bg-red-950/60 px-3 py-2 text-sm text-red-300">
          {actionError}
        </p>
      )}

      {/* ---------------- Persona ---------------- */}
      <section className="mb-10">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">Persona</h2>
          <div className="flex items-center gap-4">
            <button
              type="button"
              disabled={autofilling}
              onClick={() => void handleAutofill(character.id)}
              className="text-sm text-rose-400 hover:text-rose-300 disabled:opacity-50"
            >
              {autofilling ? 'Writing…' : character.profileComplete ? 'Autofill again' : 'Autofill'}
            </button>
            <button
              type="button"
              onClick={() => setPersonaOpen((o) => !o)}
              className="text-sm text-rose-400 hover:text-rose-300"
            >
              {personaOpen ? 'Cancel' : 'Edit'}
            </button>
          </div>
        </div>

        {!character.profileComplete && !personaOpen && (
          <p className="mb-3 rounded-lg border border-amber-900/60 bg-amber-950/30 px-3 py-2 text-xs text-amber-300">
            Her profile is not written yet
            {character.missingProfileFields.length > 0 &&
              ` (${character.missingProfileFields.length} field${
                character.missingProfileFields.length === 1 ? '' : 's'
              } empty)`}
            . Write it yourself, or use Autofill and edit what it suggests.
          </p>
        )}

        {autofilled && personaOpen && (
          <p className="mb-3 rounded-lg border border-zinc-700 bg-zinc-900/60 px-3 py-2 text-xs text-zinc-300">
            This is a suggestion — nothing has been saved. Edit anything you like, then press Save
            persona. Autofill again for a different take.
          </p>
        )}

        {personaOpen ? (
          <div className="space-y-3 rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
            {(
              [
                ['displayName', 'Display name'],
                ['shortBio', 'Short bio'],
                ['personality', 'Personality'],
                ['conversationStyle', 'Conversation style'],
                ['systemPrompt', 'System prompt'],
              ] as const
            ).map(([key, label]) => (
              <label key={key} className="block">
                <span className="text-xs font-medium uppercase tracking-wide text-zinc-400">{label}</span>
                <textarea
                  rows={key === 'displayName' ? 1 : 3}
                  value={personaDraft[key]}
                  onChange={(e) => setPersonaDraft({ ...personaDraft, [key]: e.target.value })}
                  className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100"
                />
              </label>
            ))}
            <label className="block">
              <span className="text-xs font-medium uppercase tracking-wide text-zinc-400">
                Interests
              </span>
              <input
                type="text"
                value={interestsText}
                onChange={(e) => setInterestsText(e.target.value)}
                placeholder="astronomy, jazz"
                className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100"
              />
              <span className="mt-1 block text-xs text-zinc-500">Comma separated.</span>
            </label>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  await adminCharactersApi.update(character.id, {
                    ...personaDraft,
                    interests: interestsText
                      .split(',')
                      .map((i) => i.trim())
                      .filter(Boolean),
                  });
                  setPersonaOpen(false);
                  setAutofilled(false);
                }, "Couldn't save the character.")
              }
              className="rounded-lg bg-rose-600 px-4 py-2 text-sm font-medium text-white hover:bg-rose-500 disabled:opacity-50"
            >
              Save persona
            </button>
          </div>
        ) : (
          <dl className="grid gap-3 rounded-lg border border-zinc-800 p-4 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-xs uppercase tracking-wide text-zinc-500">Short bio</dt>
              <dd className="text-zinc-300">{character.shortBio || '—'}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-zinc-500">Personality</dt>
              <dd className="text-zinc-300">{character.personality || '—'}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-zinc-500">Conversation style</dt>
              <dd className="text-zinc-300">{character.conversationStyle || '—'}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-zinc-500">Interests</dt>
              <dd className="text-zinc-300">{character.interests.join(', ') || '—'}</dd>
            </div>
          </dl>
        )}
      </section>

      {/* ---------------- Visual identity ---------------- */}
      <section className="mb-10">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">
            Visual identity
          </h2>
          <button
            type="button"
            onClick={() => seedFrom(activeIdentity)}
            className="text-sm text-rose-400 hover:text-rose-300"
          >
            {identities.length === 0 ? 'Create v1' : 'New version'}
          </button>
        </div>

        <p className="mb-3 text-xs text-zinc-500">
          {activeIdentity
            ? `Version ${activeIdentity.version} is active — this is the identity generation uses.`
            : identities.length === 0
              ? 'No visual identity yet. Create v1 to describe how she looks.'
              : 'No version is active yet. Activate one before generating anything.'}{' '}
          Editing never overwrites history: a change creates a new version.
        </p>

        {identityOpen && (
          <div className="mb-4 space-y-3 rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
            <h3 className="text-sm font-medium text-zinc-200">
              New version{identities.length > 0 ? ` (v${identities[0]!.version + 1})` : ' (v1)'}
            </h3>
            {DNA_FIELDS.map((field) => (
              <label key={field.key} className="block">
                <span className="text-xs font-medium uppercase tracking-wide text-zinc-400">
                  {field.label}
                  {field.required && <span className="text-rose-400"> *</span>}
                </span>
                <input
                  type="text"
                  value={dnaForm[field.key] ?? ''}
                  onChange={(e) => setDnaForm({ ...dnaForm, [field.key]: e.target.value })}
                  placeholder={field.required ? 'adult' : ''}
                  className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100"
                />
              </label>
            ))}
            <label className="block">
              <span className="text-xs font-medium uppercase tracking-wide text-zinc-400">
                Label (optional)
              </span>
              <input
                type="text"
                value={identityLabel}
                onChange={(e) => setIdentityLabel(e.target.value)}
                placeholder="softer look"
                className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100"
              />
            </label>
            <p className="text-xs text-zinc-500">
              Apparent age band must describe an adult; anything else is rejected.
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    const visualDna: Record<string, string> = {};
                    for (const [key, value] of Object.entries(dnaForm)) {
                      if (value.trim()) visualDna[key] = value.trim();
                    }
                    await adminCharactersApi.createIdentity(character.id, {
                      visualDna,
                      label: identityLabel.trim() || undefined,
                    });
                    setIdentityOpen(false);
                  }, "Couldn't create the version.")
                }
                className="rounded-lg bg-rose-600 px-4 py-2 text-sm font-medium text-white hover:bg-rose-500 disabled:opacity-50"
              >
                Create version
              </button>
              <button
                type="button"
                onClick={() => setIdentityOpen(false)}
                className="rounded-lg border border-zinc-700 px-4 py-2 text-sm text-zinc-300"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {identities.length === 0 ? (
          <div className="rounded-lg border border-dashed border-zinc-800 px-6 py-10 text-center text-sm text-zinc-500">
            No versions yet.
          </div>
        ) : (
          <ul className="divide-y divide-zinc-800 rounded-lg border border-zinc-800">
            {identities.map((identity) => (
              <li key={identity.id} className="flex items-center justify-between gap-4 px-4 py-3">
                <div className="min-w-0">
                  <p className="text-sm text-zinc-100">
                    v{identity.version}{' '}
                    <span className="text-zinc-500">{identity.label ?? 'unlabelled'}</span>
                  </p>
                  <p className="text-xs text-zinc-500">
                    {identity.isActive
                      ? 'Active — used by all generation'
                      : identity.status === 'draft'
                        ? 'Draft — not used yet'
                        : 'Retired — kept for history'}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {identity.isActive ? (
                    <span className="rounded bg-emerald-950 px-2 py-0.5 text-[10px] uppercase tracking-wide text-emerald-400">
                      Active
                    </span>
                  ) : (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        run(
                          () => adminCharactersApi.activateIdentity(identity.id),
                          "Couldn't activate that version.",
                        )
                      }
                      className="rounded-lg border border-zinc-700 px-3 py-1 text-xs text-zinc-200 hover:border-zinc-600 disabled:opacity-50"
                    >
                      Activate
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => seedFrom(identity)}
                    className="rounded-lg border border-zinc-700 px-3 py-1 text-xs text-zinc-200 hover:border-zinc-600"
                  >
                    Duplicate
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ---------------- Primary references ---------------- */}
      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">
            Primary references
          </h2>
          {activeIdentity && (
            <>
              <input
                ref={fileInput}
                type="file"
                accept="image/jpeg,image/png,image/webp,video/mp4,video/webm,video/quicktime"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (!file) return;
                  void run(
                    () => adminCharactersApi.uploadReference(activeIdentity.id, file),
                    "Couldn't upload that reference.",
                  );
                }}
              />
              <button
                type="button"
                disabled={busy}
                onClick={() => fileInput.current?.click()}
                className="text-sm text-rose-400 hover:text-rose-300 disabled:opacity-50"
              >
                Add reference
              </button>
            </>
          )}
        </div>

        {!activeIdentity ? (
          <div className="rounded-lg border border-dashed border-zinc-800 px-6 py-10 text-center text-sm text-zinc-500">
            Activate a visual identity version first — references belong to a version.
          </div>
        ) : (
          <>
            <p className="mb-3 text-xs text-zinc-500">
              Attached to v{activeIdentity.version}. These are what users see and what generation
              will match against.
            </p>
            {primaryReferences.length === 0 ? (
              <div className="rounded-lg border border-dashed border-zinc-800 px-6 py-10 text-center text-sm text-zinc-500">
                No primary references yet — add one.
              </div>
            ) : (
              <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {primaryReferences.map((reference) => (
                  <li key={reference.assetId} className="overflow-hidden rounded-lg border border-zinc-800">
                    <div className="relative aspect-[3/4] bg-zinc-900">
                      {reference.fileUrl &&
                        (reference.mediaType === 'video' ? (
                          <video
                            src={`${API_URL}${reference.fileUrl}`}
                            muted
                            playsInline
                            preload="metadata"
                            className="h-full w-full object-contain"
                          />
                        ) : (
                          <img
                            src={`${API_URL}${reference.fileUrl}`}
                            alt=""
                            loading="lazy"
                            className="h-full w-full object-contain"
                          />
                        ))}
                    </div>
                    <div className="flex items-center justify-between gap-2 px-2 py-1.5">
                      <span className="text-[10px] uppercase tracking-wide text-emerald-400">
                        Primary
                      </span>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          run(
                            () => adminCharactersApi.removePrimary(reference.assetId),
                            "Couldn't remove that reference.",
                          )
                        }
                        className="text-[10px] uppercase tracking-wide text-zinc-500 hover:text-zinc-300 disabled:opacity-50"
                      >
                        Remove
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </section>
    </div>
  );
}
