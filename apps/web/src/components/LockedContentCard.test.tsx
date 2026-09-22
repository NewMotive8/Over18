import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { CustomerContentAccess } from '@over18/shared';
import { contentCardView } from '../lib/contentAccess';
import LockedContentCard from './LockedContentCard';

/**
 * P8.1 -- the card in each state the server can send, rendered statically.
 * Every state, price and age below is server-shaped test data passed in.
 */

const access = (over: Partial<CustomerContentAccess> = {}): CustomerContentAccess => ({
  assetId: 'asset-1',
  state: 'free',
  creditPrice: null,
  ageFloor: null,
  decision: 'open',
  ...over,
});

const card = (over: Partial<CustomerContentAccess> | null = {}, title = 'Post 1') =>
  renderToStaticMarkup(
    <MemoryRouter>
      <LockedContentCard
        view={contentCardView(over === null ? null : access(over))}
        title={title}
        media={<video src="/api/media/assets/a/file" />}
        footer={<span data-testid="heart" />}
      />
    </MemoryRouter>,
  );

describe('revealed content', () => {
  it('plays, is pressable, and carries the surface decoration', () => {
    const html = card();
    expect(html).toContain('<button type="button" aria-label="Post 1"');
    expect(html).toContain('/api/media/assets/a/file');
    expect(html).toContain('data-testid="heart"');
    expect(html).not.toContain('blur-xl');
    expect(html).not.toContain('locked-content-card');
  });

  it('says Premium content is included, without any call to action', () => {
    const html = card({ state: 'premium', decision: 'open' });
    expect(html).toContain('Included');
    expect(html).not.toContain('See Premium');
  });

  it('shows content the customer owns, with an Unlocked chip and no way to buy it again', () => {
    const html = card({ state: 'credit', creditPrice: 50, decision: 'owned' });
    expect(html).toContain('Unlocked');
    expect(html).toContain('<video');
    expect(html).not.toContain('Unlock ·');
    expect(html).not.toContain('50 Credits');
    // The locked overlay is absent: the media is shown, not blurred behind a lock.
    expect(html).not.toContain('blur-xl');
  });

  it('renders exactly as today when the server said nothing about the content', () => {
    const html = card(null);
    expect(html).toContain('<button type="button"');
    expect(html).not.toContain('blur-xl');
    expect(html).not.toMatch(/Premium|Credits|Unavailable/);
  });
});

describe('locked content', () => {
  it('keeps the media on the tile, blurred and hidden from assistive technology, and is not pressable', () => {
    const html = card({ state: 'premium', decision: 'premium_required' });
    expect(html).toContain('data-testid="locked-content-card"');
    expect(html).toContain('data-state="premium_required"');
    // The content is still there -- a locked tile is not an empty box.
    expect(html).toContain('/api/media/assets/a/file');
    expect(html).toContain('blur-xl');
    expect(html).toContain('aria-hidden="true"');
    // Nothing opens it, and the surface decoration is not shown over a lock.
    expect(html).not.toContain('<button type="button" aria-label="Post 1"');
    expect(html).not.toContain('data-testid="heart"');
  });

  it('describes itself to assistive technology as locked, with the reason', () => {
    expect(card({ state: 'premium', decision: 'premium_required' })).toContain('aria-label="Post 1 — locked. Included with Premium."');
  });

  /**
   * PREMIUM CARRIES NO CTA. The chip, the lock and the line say what it is; the
   * tile does not also ask. Credit content keeps its button because that button
   * names a price, which is information nothing else on the tile carries.
   */
  it('Premium: a rose Premium chip, the line, and no button anywhere', () => {
    const html = card({ state: 'premium', decision: 'premium_required' });
    expect(html).toContain('Premium');
    expect(html).toContain('Included with Premium.');
    expect(html).toContain('rose');
    expect(html).not.toContain('See Premium');
    expect(html).not.toContain('href="/subscription"');
    expect(html).not.toContain('href="/credits"');
    expect(html).not.toContain('<button');
    expect(html).not.toContain('<a ');
  });

  it('Credit: an amber chip with the price, and an unlock that is not open yet', () => {
    const html = card({ state: 'credit', creditPrice: 50, decision: 'credits_required' });
    expect(html).toContain('50 Credits');
    expect(html).toContain('amber');
    expect(html).toContain('Unlock · 50 Credits');
    expect(html).toMatch(/<button type="button" disabled=""/);
    expect(html).toContain('Unlocking is coming soon.');
    expect(html).not.toContain('href=');
  });

  it('Credit, where the surface can unlock: a real button, no link, and no "coming soon"', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <LockedContentCard
          view={contentCardView(access({ state: 'credit', creditPrice: 50, decision: 'credits_required' }), { canUnlock: true })}
          title="Post 1"
          media={<video src="/api/media/assets/a/file" />}
          onUnlock={() => {}}
        />
      </MemoryRouter>,
    );
    expect(html).toContain('Unlock · 50 Credits');
    expect(html).not.toContain('disabled=""');
    expect(html).not.toContain('Unlocking is coming soon.');
    expect(html).not.toContain('href=');
    // Still locked until the server says otherwise: pressing it only asks.
    expect(html).toContain('data-state="credits_required"');
    expect(html).toContain('blur-xl');
  });

  it('too few Credits: the price stays, and the way out is Credits', () => {
    const html = card({ state: 'credit', creditPrice: 50, decision: 'insufficient_credits' });
    expect(html).toContain('You need 50 Credits to unlock this.');
    expect(html).toContain('href="/credits"');
    expect(html).not.toContain('href="/subscription"');
  });

  it('age restricted: the age is shown and nothing can be confirmed yet', () => {
    const html = card({ state: 'free', ageFloor: 21, decision: 'age_restricted' });
    expect(html).toContain('21+');
    expect(html).toContain('Confirm your age to view this.');
    expect(html).toMatch(/<button type="button" disabled=""/);
    expect(html).toContain('Age confirmation is coming soon.');
  });

  it('unavailable: explained, with nothing to press at all', () => {
    const html = card({ state: 'unavailable', decision: 'unavailable' });
    expect(html).toContain('Unavailable');
    expect(html).toContain('This content isn&#x27;t available.');
    expect(html).not.toContain('<button');
    expect(html).not.toContain('href=');
  });

  it('states every lock in words, never by colour alone, and speaks no backend terms', () => {
    for (const over of [
      { state: 'premium' as const, decision: 'premium_required' as const },
      { state: 'credit' as const, creditPrice: 50, decision: 'credits_required' as const },
      { state: 'credit' as const, creditPrice: 50, decision: 'insufficient_credits' as const },
      { state: 'free' as const, ageFloor: 18, decision: 'age_restricted' as const },
      { state: 'unavailable' as const, decision: 'unavailable' as const },
    ]) {
      const html = card(over);
      expect(html, over.decision).toMatch(/Premium|Credits|Confirm your age|Unavailable/);
      expect(html, over.decision).not.toMatch(/wallet|ledger|held|spendable|entitlement/i);
      // A tappable control is at least 44px tall.
      if (html.includes('min-h-11')) expect(html, over.decision).toContain('min-h-11');
    }
  });
});
