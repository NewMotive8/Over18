import { CrownIcon } from '../icons';
import CharacterAvatar from '../CharacterAvatar';

/**
 * Her identity, as the heading of the desktop profile's right column.
 *
 * DESKTOP ONLY (`hidden lg:flex`). On a phone and tablet the identity overlays
 * the bottom of the media in `ProfileHero`, exactly as before; from `lg` the
 * media is a card in the left column and her name belongs beside it, where a
 * desktop reader looks for a heading -- so that overlay is hidden and this is
 * shown. Never both: each is `display: none` where the other is visible.
 *
 * THE SAME CONTENT AS THE OVERLAY, nothing added: avatar, name, adult age, the
 * VIP badge and "Online now", only larger. If the overlay's content changes in
 * `ProfileHero`, change it here too.
 */
export default function ProfileIdentity({
  name,
  age,
  avatarPoster,
}: {
  name: string;
  age: number;
  avatarPoster?: string;
}) {
  return (
    <div data-testid="profile-identity-desktop" className="hidden items-center gap-4 lg:flex">
      <CharacterAvatar name={name} src={avatarPoster} size="lg" />
      <div className="min-w-0">
        <div className="flex items-center gap-3">
          <h1 className="truncate text-4xl font-black tracking-tight text-white">{name}</h1>
          <span className="text-2xl font-semibold text-zinc-200">{age}</span>
          <span className="inline-flex items-center gap-1 rounded-full bg-amber-400/90 px-2.5 py-1 text-xs font-bold text-amber-950">
            <CrownIcon className="h-3.5 w-3.5" /> VIP
          </span>
        </div>
        <p className="mt-1 flex items-center gap-1.5 text-sm text-zinc-300">
          <span className="h-2 w-2 rounded-full bg-emerald-400" /> Online now
        </p>
      </div>
    </div>
  );
}
