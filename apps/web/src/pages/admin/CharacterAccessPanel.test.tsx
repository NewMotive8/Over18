import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { AdminCharacterContentAccess, AdminClipAccess } from '@over18/shared';
import CharacterAccessSection, { ContentAccessPanel, allocationSummary, clipStateLabel, parseCreditPrice } from './CharacterAccessPanel';

/**
 * P4.D2 -- a character's Free/Premium clips, rendered statically. Every state
 * and count below is server-shaped test data passed in; the panel decides
 * nothing and manages no content.
 */

const clip = (assetId: string, over: Partial<AdminClipAccess> = {}): AdminClipAccess => ({
  assetId,
  mediaType: 'video',
  workflow: 'approved',
  live: true,
  state: 'premium',
  byDefault: true,
  creditPrice: null,
  ageFloor: null,
  ...over,
});

const page = (over: Partial<AdminCharacterContentAccess> = {}): AdminCharacterContentAccess => ({
  characterId: 'c-1',
  economyEnabled: true,
  allocation: { configured: true, freeClipCount: 2 },
  clips: [clip('aaaaaaaa-1111-4111-8111-111111111111', { state: 'free', byDefault: false }), clip('bbbbbbbb-2222-4222-8222-222222222222')],
  counts: { clips: 2, free: 1, premium: 1, credit: 0 },
  ...over,
});

const noop = () => {};
const panel = (over: Partial<AdminCharacterContentAccess> = {}, reason = 'Launch allocation', prices: Record<string, string> = {}) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <ContentAccessPanel
        page={page(over)}
        freeCount="2"
        reason={reason}
        busy={false}
        messages={[]}
        prices={prices}
        onFreeCount={noop}
        onReason={noop}
        onPrice={noop}
        onAllocate={noop}
        onClear={noop}
        onMark={noop}
      />
    </MemoryRouter>,
  );

describe('what the panel says about a character', () => {
  /**
   * P4.D2: every clip is Premium by default, so the summary leads with Premium
   * and says "new clips are Premium" for EVERY character -- configured or not.
   * The old copy told an unconfigured character that new clips would be Free,
   * which was the opposite of the decision.
   */
  it('leads with Premium, and says new clips are Premium whether or not she is configured', () => {
    expect(allocationSummary(page())).toBe('1 of 2 Premium, 1 Free. New clips are Premium. 2 Free clips are configured.');
    expect(allocationSummary(page({ allocation: { configured: false, freeClipCount: null } }))).toBe(
      '1 of 2 Premium, 1 Free. New clips are Premium.',
    );
    expect(allocationSummary(page({ clips: [], counts: { clips: 0, free: 0, premium: 0, credit: 0 } }))).toBe(
      'She has no clips yet. Anything uploaded will be Premium.',
    );
  });

  it('never suggests a character must be opted in to be Premium', () => {
    const unconfigured = page({ allocation: { configured: false, freeClipCount: null } });
    const html = panel({ allocation: { configured: false, freeClipCount: null } });
    for (const gone of ['not in Free/Premium yet', 'New clips are Free', 'Turn off']) {
      expect({ gone, found: html.includes(gone) }, gone).toEqual({ gone, found: false });
    }
    expect(allocationSummary(unconfigured)).not.toMatch(/opt|turn on|enable/i);
    expect(html).toContain('Every clip is Premium unless you make it Free.');
  });

  it('names each access state as an operator would say it', () => {
    expect(clipStateLabel(clip('a', { state: 'free' }))).toBe('Free');
    expect(clipStateLabel(clip('a', { state: 'premium' }))).toBe('Premium');
    expect(clipStateLabel(clip('a', { state: 'credit', creditPrice: 50 }))).toBe('50 Credits');
    expect(clipStateLabel(clip('a', { state: 'unavailable' }))).toBe('Unavailable');
  });
});

describe('the panel', () => {
  it('lists every clip with its access, marking the ones that are only following the default', () => {
    const html = panel();
    expect(html.match(/data-testid="clip-access-row"/g)).toHaveLength(2);
    expect(html).toContain('data-state="free"');
    expect(html).toContain('data-state="premium"');
    expect(html).toContain('by default');
    // Three explicit choices per clip, rather than a two-way toggle.
    expect(html.match(/data-testid="set-free"/g)).toHaveLength(2);
    expect(html.match(/data-testid="set-premium"/g)).toHaveLength(2);
    expect(html.match(/data-testid="set-credit"/g)).toHaveLength(2);
    expect(html.match(/data-testid="credit-price"/g)).toHaveLength(2);
  });

  it('offers the random allocation, and clearing only when something was configured', () => {
    expect(panel()).toContain('Choose at random');
    expect(panel()).toContain('Clear all');
    expect(panel({ allocation: { configured: false, freeClipCount: null } })).not.toContain('Clear all');
    // What N actually does, next to the field that takes it.
    expect(panel()).toContain('N become Free at random; the rest stay Premium.');
  });

  it('asks for a reason before anything can be changed', () => {
    const withoutReason = panel({}, '   ');
    expect(withoutReason.match(/disabled=""/g)?.length).toBeGreaterThanOrEqual(3);
    expect(panel()).toContain('Reason (required)');
  });

  it('is read-only while the economy is off, and says why', () => {
    const html = panel({ economyEnabled: false });
    expect(html).toContain('The economy is switched off');
    expect(html).toContain('role="status"');
    // Every control -- the two inputs, the allocation, turning off, and each clip.
    expect(html.match(/disabled=""/g)?.length).toBeGreaterThanOrEqual(6);
  });

  it('says what happens to clips uploaded later when she has none yet', () => {
    const html = panel({ clips: [], counts: { clips: 0, free: 0, premium: 0, credit: 0 } });
    expect(html).toContain('No clips yet.');
    expect(html).toContain('Anything uploaded later is Premium.');
    expect(html).not.toContain('clip-access-row');
  });

  /**
   * CREDIT PRICING IS A SEPARATE SCOPE (P4.D2 vs P4.1 pricing). The capability
   * is still here and still reachable, but folded away so it cannot be read as
   * part of the Free/Premium decision.
   */
  it('puts Free and Premium first, with the Credit price folded away behind a disclosure', () => {
    const html = panel();
    expect(html.match(/data-testid="set-free"/g)).toHaveLength(2);
    expect(html.match(/data-testid="set-premium"/g)).toHaveLength(2);
    // Still present, but inside a collapsed <details>.
    expect(html.match(/data-testid="credit-disclosure"/g)).toHaveLength(2);
    expect(html.match(/data-testid="credit-price"/g)).toHaveLength(2);
    expect(html).toContain('<details');
    expect(html).not.toContain('<details open');
  });

  /**
   * PRICING ONE CLIP IN CREDITS.
   *
   * The price box is the only new input, and "Set price" stays shut until what
   * is in it is a price. The SERVER still decides -- this only avoids sending
   * a request that would certainly be refused.
   */
  const shutCreditButtons = (html: string) => (html.match(/data-testid="set-credit"[^>]*disabled=""/g) ?? []).length;

  it('will not offer to set a Credit price until a whole number is typed', () => {
    expect(shutCreditButtons(panel()), 'nothing typed: neither clip can be priced').toBe(2);
    expect(shutCreditButtons(panel({}, 'Launch allocation', { 'bbbbbbbb-2222-4222-8222-222222222222': '50' }))).toBe(1);
    expect(shutCreditButtons(panel({}, 'Launch allocation', { 'bbbbbbbb-2222-4222-8222-222222222222': '12.5' }))).toBe(2);
    expect(shutCreditButtons(panel({}, 'Launch allocation', { 'bbbbbbbb-2222-4222-8222-222222222222': '0' }))).toBe(2);
  });

  it('will not price anything without a reason, however good the price is', () => {
    expect(shutCreditButtons(panel({}, '   ', { 'bbbbbbbb-2222-4222-8222-222222222222': '50' }))).toBe(2);
  });

  it('counts Credit-priced clips in the summary instead of hiding them', () => {
    const priced = page({
      clips: [clip('c', { state: 'credit', creditPrice: 50, byDefault: false })],
      counts: { clips: 1, free: 0, premium: 0, credit: 1 },
    });
    expect(allocationSummary(priced)).toContain('1 Credit-priced');
  });

  it('shows no Credit price or age floor of its own: only what the server sent', () => {
    const html = panel({ clips: [clip('c', { state: 'credit', creditPrice: 50, byDefault: false })], counts: { clips: 1, free: 0, premium: 0, credit: 0 } });
    expect(html).toContain('50 Credits');
    expect(html).not.toMatch(/\$\d|wallet|ledger/i);
  });
});

describe('what counts as a Credit price', () => {
  it('accepts whole Credits, 1 or more, however it was spaced', () => {
    expect(parseCreditPrice('1')).toBe(1);
    expect(parseCreditPrice(' 50 ')).toBe(50);
    expect(parseCreditPrice('1000')).toBe(1000);
  });

  it('rejects everything that is not one', () => {
    for (const bad of ['', '   ', '0', '-3', '12.5', '1e3', 'fifty', '5 Credits', '٥', '+7']) {
      expect(parseCreditPrice(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe('the section', () => {
  it('asks the server for the character rather than assuming anything', () => {
    expect(renderToStaticMarkup(<MemoryRouter><CharacterAccessSection characterId="c-1" /></MemoryRouter>)).toContain('Loading clip access');
  });
});
