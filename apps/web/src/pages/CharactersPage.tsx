import CharacterCard from '../components/CharacterCard';
import { useCharacters } from '../hooks/useCharacters';

/** Skeleton placeholder matching the card layout while the API loads. */
function CharacterCardSkeleton() {
  return (
    <div className="animate-pulse overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900">
      <div className="aspect-[4/5] w-full bg-zinc-800" />
      <div className="absolute" />
    </div>
  );
}

export default function CharactersPage() {
  const { state, reload } = useCharacters();

  return (
    <section className="flex flex-col gap-4">
      <header>
        <h2 className="text-xl font-semibold">Discover</h2>
        <p className="mt-0.5 text-sm text-zinc-400">Choose someone to get to know.</p>
      </header>

      {state.status === 'loading' && (
        <div className="grid grid-cols-2 gap-3" aria-hidden data-testid="characters-skeleton">
          {Array.from({ length: 4 }, (_, i) => (
            <CharacterCardSkeleton key={i} />
          ))}
        </div>
      )}

      {state.status === 'error' && (
        <div className="flex flex-col items-center gap-4 rounded-2xl border border-zinc-800 bg-zinc-900/60 px-6 py-14 text-center">
          <span aria-hidden className="text-3xl">
            ⚠
          </span>
          <div>
            <p className="font-medium">Couldn't load characters</p>
            <p className="mt-1 text-sm text-zinc-400">
              Something went wrong on our side. Check your connection and try again.
            </p>
          </div>
          <button
            type="button"
            onClick={reload}
            className="rounded-lg bg-rose-600 px-5 py-2 text-sm font-semibold text-white transition-colors hover:bg-rose-500"
          >
            Retry
          </button>
        </div>
      )}

      {state.status === 'ready' && state.characters.length === 0 && (
        <div className="flex flex-col items-center gap-3 rounded-2xl border border-zinc-800 bg-zinc-900/60 px-6 py-14 text-center">
          <span aria-hidden className="text-3xl">
            ☾
          </span>
          <div>
            <p className="font-medium">No one's here yet</p>
            <p className="mt-1 text-sm text-zinc-400">
              New characters are on their way. Check back soon.
            </p>
          </div>
        </div>
      )}

      {state.status === 'ready' && state.characters.length > 0 && (
        <ul className="grid grid-cols-2 gap-3">
          {state.characters.map((character) => (
            <li key={character.id}>
              <CharacterCard character={character} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
