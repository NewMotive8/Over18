import type { PublicClip } from '../../lib/api';
import { accessFor, contentCardView, useContentAccess, type ContentAccessState } from '../../lib/contentAccess';
import { useContentUnlock, type ContentUnlockClient } from '../../lib/contentUnlock';
import { spendableCredits, useCustomerEconomy, type CustomerEconomyClient } from '../../lib/customerEconomy';
import ClipMedia from '../lobby/ClipMedia';
import { CreditBalance } from '../CustomerEconomy';
import LockedContentCard from '../LockedContentCard';
import UnlockSheet from '../UnlockSheet';
import { LikeIcon } from '../icons';

/**
 * Posts tab — the character's real content collection.
 *
 * WHAT THIS REPLACED, and why none of it could stay. The tab used to read a
 * hard-coded four-name manifest (`characterVideos`), take two entries off it,
 * fabricate six more "locked" tiles by cycling whatever poster it could find,
 * and fall back to `character.profileImage` when the manifest had no entry —
 * which is every character created through the CMS. It rendered poster JPEGs,
 * never the clips. Not one tile corresponded to a record, and the tab claimed
 * "8" because 2 + 6 = 8.
 *
 * NOW IT IS THE COLLECTION. Every tile is a `character_visual_assets` row the
 * server has already confirmed publicly reachable, in full and unsliced. The
 * count is whatever she actually has.
 *
 * MEDIA COMES FROM `ClipMedia`, never a poster and never a fallback. That is
 * the shared clip renderer used by the Hero and the category rails: a video
 * plays with the same autoplay/muted/loop/playsInline behaviour as every other
 * clip surface, an image CONTENT asset renders as an image, and a clip that
 * fails degrades to a neutral frame. It has NO character-image fallback, which
 * is what makes it impossible for a profile or reference image to reappear
 * here.
 *
 * PRESENTATION IS THE APPROVED ONE: same two-column grid, same tile frame, same
 * gradient, same bottom-left heart mark in the same position and styling.
 *
 * ACCESS IS THE SERVER'S (P4.2, P8.1). Each tile renders in the state the
 * access endpoint gives for that asset: free content plays as before, and
 * Premium, Credit-priced, age-restricted or withdrawn content renders locked,
 * with the server's price and the right call to action. Nothing here decides
 * access, and while the endpoint is not wired up (the pending client, and the
 * economy is off) every tile renders exactly as it does today.
 *
 * THE HEART CARRIES NO NUMBER, and must never carry one again. The approved
 * tile printed `240 + index * 57` beside it — tile 1 said 240, tile 2 said 297,
 * tile 3 said 354. That was the tile's position dressed up as engagement; there
 * is no likes column, no reactions table, and no engagement source anywhere in
 * the schema. The mark itself is approved presentation and stays; the invented
 * count does not come back unless a real one exists to print.
 *
 * UNLOCKING HAPPENS HERE (P8.2), because this is where Credit-priced content
 * and the customer's balance are both already on screen. The tab offers the
 * confirmation and sends it; it owns no ownership state of its own. When the
 * server confirms, the tab re-reads BOTH the access answers and the balance,
 * and the tile changes because the server now says `owned` — not because
 * anything here decided it did. A failure changes nothing at all.
 */
export default function PostsTab({
  clips,
  onOpenClip,
  access,
  accessClient,
  economyClient,
  unlockClient,
}: {
  clips: PublicClip[];
  onOpenClip: (index: number) => void;
  /** The server's access answers. Read here when the caller passes none. */
  access?: ContentAccessState;
  /** Injected in tests and development; production uses the module defaults. */
  accessClient?: Parameters<typeof useContentAccess>[1];
  economyClient?: CustomerEconomyClient;
  unlockClient?: ContentUnlockClient;
}) {
  const [fetched, refreshAccess] = useContentAccess(
    clips.map((clip) => clip.id),
    accessClient,
  );
  const state = access ?? fetched;
  // Her Credits, read once here: the pill shows them, the confirmation states
  // them, and both move together when an unlock goes through.
  const [economy, refreshEconomy] = useCustomerEconomy(economyClient);
  const unlock = useContentUnlock({
    client: unlockClient,
    onUnlocked: () => {
      refreshAccess();
      refreshEconomy();
    },
  });

  if (clips.length === 0) {
    // Said plainly rather than filled with invented tiles. An empty collection
    // is a real state, and pretending otherwise is what this tab used to do.
    return <p className="py-10 text-center text-sm text-zinc-500">No posts yet.</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Her Credits, where she might spend them. Empty -- and invisible --
          while no balance is known, so the tab is unchanged as it is today. */}
      <div className="flex justify-end empty:hidden">
        {economy.status === 'ready' && <CreditBalance overview={economy.overview} compact />}
      </div>
      <div className="grid grid-cols-2 gap-3">
        {clips.map((clip, index) => {
          const item = accessFor(state, clip.id);
          // This tab can carry an unlock through, so a Credit-priced tile
          // offers one rather than saying it is coming.
          const view = contentCardView(item, { canUnlock: true, pending: state.status === 'loading' });
          const title = `Post ${index + 1}`;
          return (
            <LockedContentCard
              key={clip.id}
              view={view}
              title={title}
              onOpen={() => onOpenClip(index)}
              onUnlock={() => unlock.open({ assetId: clip.id, title, creditPrice: item?.creditPrice ?? null })}
              media={<ClipMedia clip={clip} autoPlay={view.revealed} />}
              footer={
                /* Approved mark, unchanged position and styling. Decorative: it
                   states nothing, so it is hidden from assistive technology. */
                <span
                  aria-hidden
                  className="absolute bottom-2 left-2 flex items-center gap-1 text-[11px] font-semibold text-white"
                >
                  <LikeIcon className="h-3.5 w-3.5 text-rose-400" />
                </span>
              }
            />
          );
        })}
      </div>

      {unlock.target && (
        <UnlockSheet
          target={unlock.target}
          balance={spendableCredits(economy.status === 'ready' ? economy.overview : null)}
          busy={unlock.busy}
          failure={unlock.failure}
          onConfirm={unlock.confirm}
          onCancel={unlock.cancel}
        />
      )}
    </div>
  );
}
