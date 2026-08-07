import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { PublicCharacter } from '@over18/shared';
import { charactersApi } from '../lib/api';

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; characters: PublicCharacter[] };

export default function CharactersPage() {
  const [state, setState] = useState<LoadState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    charactersApi
      .list()
      .then((characters) => !cancelled && setState({ status: 'ready', characters }))
      .catch(() => !cancelled && setState({ status: 'error', message: 'Could not load characters. Please try again.' }));
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.status === 'loading') {
    return (
      <div className="flex justify-center py-16">
        <span className="text-sm text-zinc-400">Loading characters…</span>
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <div className="py-16 text-center">
        <p role="alert" className="text-sm text-red-400">
          {state.message}
        </p>
      </div>
    );
  }

  if (state.characters.length === 0) {
    return (
      <div className="py-16 text-center">
        <p className="text-sm text-zinc-400">No characters available yet. Check back soon.</p>
      </div>
    );
  }

  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-xl font-semibold">Characters</h2>
      <ul className="flex flex-col gap-3">
        {state.characters.map((character) => (
          <li key={character.id}>
            <Link
              to={`/characters/${character.id}`}
              className="flex gap-3 rounded-xl border border-zinc-800 bg-zinc-900/60 p-3 transition-colors hover:border-zinc-700"
            >
              {character.profileImage ? (
                <img
                  src={character.profileImage}
                  alt=""
                  className="h-16 w-16 shrink-0 rounded-lg object-cover"
                />
              ) : (
                <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-lg bg-zinc-800 text-xl">
                  {character.displayName.charAt(0)}
                </div>
              )}
              <div className="min-w-0">
                <h3 className="font-medium">{character.displayName}</h3>
                <p className="mt-0.5 line-clamp-2 text-sm text-zinc-400">{character.shortBio}</p>
                <p className="mt-1 truncate text-xs text-zinc-500">
                  {character.interests.slice(0, 3).join(' · ')}
                </p>
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
