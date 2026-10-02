import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { CustomerContentAccess } from '@over18/shared';
import { contentCardView } from '../../lib/contentAccess';
import { readStoreContext, returnTarget, withStoreLink } from '../../lib/creditsStore';
import LockedContentCard from '../LockedContentCard';

/**
 * Credits Store PR 2, found on Staging: a post the customer cannot afford yet
 * shows its OWN "Get Credits" link -- the server says `insufficient_credits`,
 * so the unlock confirmation never opens. That link must carry the post and
 * whose it is, or the store cannot bring them back to finish the unlock.
 */

const ASSET = '22c28c89-c759-4e03-a449-67aee69a04e3';
const CHARACTER = '6c904827-ba3b-4993-8d8f-454a2091fa83';
const access = (over: Partial<CustomerContentAccess>): CustomerContentAccess => ({
  assetId: ASSET, state: 'credit', creditPrice: 25, ageFloor: null, decision: 'credits_required', ...over,
});

describe("a locked post's Get Credits link", () => {
  it('carries the post and the character into the store, which brings them back to finish it', () => {
    const view = withStoreLink(contentCardView(access({ decision: 'insufficient_credits' }), { canUnlock: true }), ASSET, CHARACTER);
    expect(view.cta?.label).toBe('Get Credits');
    const href = view.cta!.to!;
    expect(href).toBe(`/credits?origin=profile&originAction=content_unlock&assetId=${ASSET}&characterId=${CHARACTER}`);
    // The store reads it back, and the way back is that character's Posts, resuming the unlock.
    const context = readStoreContext(new URL(href, 'https://app.example').searchParams);
    expect(returnTarget(context)).toBe(`/characters/${CHARACTER}?tab=posts&unlock=${ASSET}`);
  });

  it('is what the tile actually renders', () => {
    const view = withStoreLink(contentCardView(access({ decision: 'insufficient_credits' }), { canUnlock: true }), ASSET, CHARACTER);
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <LockedContentCard view={view} title="Post 1" media={<span />} onFollowCta={() => undefined} />
      </MemoryRouter>,
    );
    expect(html).toContain(`href="/credits?origin=profile&amp;originAction=content_unlock&amp;assetId=${ASSET}&amp;characterId=${CHARACTER}"`);
    expect(html).toContain('Get Credits');
    expect(html).not.toMatch(/subscribe/i);
  });

  it('leaves every other tile exactly as it was', () => {
    for (const decision of ['credits_required', 'owned', 'premium_required', 'open'] as const) {
      const view = contentCardView(access({ decision }), { canUnlock: true });
      expect(withStoreLink(view, ASSET, CHARACTER)).toBe(view);
    }
  });
});
