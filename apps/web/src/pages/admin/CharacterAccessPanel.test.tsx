import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { AdminCharacterContentAccess, AdminClipAccess } from '@over18/shared';
import CharacterAccessSection, { ContentAccessPanel, accessSummary, clipStateLabel } from './CharacterAccessPanel';

/**
 * P4.D2 -- a character's Free and Premium clips.
 *
 * The whole operator decision is Free or Premium, per clip. These pin that the
 * panel offers exactly that and nothing else: the reason field, the free-clip
 * count, the random allocation, the clear-all and the Credit price controls are
 * gone from this screen, and the tests below fail if any of them return.
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

const FREE_CLIP = 'aaaaaaaa-1111-4111-8111-111111111111';
const PREMIUM_CLIP = 'bbbbbbbb-2222-4222-8222-222222222222';

const page = (over: Partial<AdminCharacterContentAccess> = {}): AdminCharacterContentAccess => ({
  characterId: 'c-1',
  economyEnabled: true,
  allocation: { configured: false, freeClipCount: null },
  clips: [clip(FREE_CLIP, { state: 'free', byDefault: false }), clip(PREMIUM_CLIP)],
  counts: { clips: 2, free: 1, premium: 1, credit: 0 },
  ...over,
});

const panel = (over: Partial<AdminCharacterContentAccess> = {}) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <ContentAccessPanel page={page(over)} busy={false} messages={[]} onMark={() => {}} />
    </MemoryRouter>,
  );

describe('what the panel says', () => {
  it('leads with Premium, because that is what most clips are', () => {
    expect(accessSummary(page())).toBe('1 of 2 Premium, 1 Free.');
    expect(accessSummary(page({ clips: [], counts: { clips: 0, free: 0, premium: 0, credit: 0 } }))).toBe(
      'She has no clips yet. Anything uploaded will be Premium.',
    );
  });

  it('states the rule in one short line, with no allocation terminology', () => {
    const html = panel();
    expect(html).toContain('All clips are Premium by default. Mark individual clips Free when needed.');
    for (const jargon of ['allocation', 'allocate', 'opt in', 'activate', 'at random']) {
      expect({ jargon, found: html.toLowerCase().includes(jargon) }, jargon).toEqual({ jargon, found: false });
    }
  });

  it('names each access state as an operator would say it', () => {
    expect(clipStateLabel(clip('a', { state: 'free' }))).toBe('Free');
    expect(clipStateLabel(clip('a', { state: 'premium' }))).toBe('Premium');
    expect(clipStateLabel(clip('a', { state: 'credit', creditPrice: 50 }))).toBe('50 Credits');
  });
});

describe('the per-clip decision', () => {
  it('gives every clip exactly two choices', () => {
    const html = panel();
    expect(html.match(/data-testid="clip-access-row"/g)).toHaveLength(2);
    expect(html.match(/data-testid="set-free"/g)).toHaveLength(2);
    expect(html.match(/data-testid="set-premium"/g)).toHaveLength(2);
    expect(html).toContain('role="group"');
  });

  /**
   * The state a clip is in is the one that is pressed, and it is the one that
   * cannot be pressed again -- re-selecting it would write an offer and an
   * audit row saying nothing changed.
   */
  it('shows which state a clip is in, and offers only the other one', () => {
    const html = panel();
    const free = html.slice(html.indexOf(FREE_CLIP.slice(0, 8)), html.indexOf(PREMIUM_CLIP.slice(0, 8)));
    expect(free).toMatch(/data-testid="set-free"[^>]*aria-pressed="true"/);
    expect(free).toMatch(/data-testid="set-free"[^>]*disabled=""/);
    expect(free).toMatch(/data-testid="set-premium"[^>]*aria-pressed="false"/);
    expect(free).not.toMatch(/data-testid="set-premium"[^>]*disabled=""/);
  });

  it('marks the clips that are only following the default', () => {
    expect(panel()).toContain('by default');
  });

  it('names a Credit price set elsewhere without offering to change it here', () => {
    const html = panel({
      clips: [clip('c', { state: 'credit', creditPrice: 50, byDefault: false })],
      counts: { clips: 1, free: 0, premium: 0, credit: 1 },
    });
    expect(html).toContain('50 Credits');
    // Named, not editable: no price box and no way to set one on this screen.
    expect(html).not.toContain('data-testid="credit-price"');
    expect(html).not.toContain('data-testid="set-credit"');
  });

  it('is read-only while the economy is off, and says why', () => {
    const html = panel({ economyEnabled: false });
    expect(html).toContain('The economy is switched off');
    expect(html).toContain('role="status"');
    // Every choice on every clip.
    expect(html.match(/disabled=""/g)).toHaveLength(4);
  });

  it('says what a clip uploaded later will be when she has none yet', () => {
    const html = panel({ clips: [], counts: { clips: 0, free: 0, premium: 0, credit: 0 } });
    expect(html).toContain('No clips yet. Anything uploaded is Premium.');
    expect(html).not.toContain('clip-access-row');
  });
});

/**
 * THE REMOVALS, held open.
 *
 * Each of these was a control on this screen. They are listed by the words an
 * operator would have seen, so the test fails if any of them comes back --
 * including as a differently-named equivalent asking for the same thing.
 */
describe('what this screen no longer asks for', () => {
  it('asks for no reason, no count, no random pick, no clear-all and no price', () => {
    const html = panel();
    for (const gone of [
      'Reason',
      'Free clips',
      'Choose at random',
      'Turn off',
      'Clear all',
      'Price in Credits',
      'Set price',
      'Credit price for clip',
      '<details',
      '<input',
      '<form',
    ]) {
      expect({ gone, found: html.includes(gone) }, gone).toEqual({ gone, found: false });
    }
  });

  it('offers no control at all beyond the two classification buttons', () => {
    const html = panel();
    const testids = [...html.matchAll(/data-testid="([a-z-]+)"/g)].map((m) => m[1]);
    expect([...new Set(testids)].sort()).toEqual(['access-model', 'access-summary', 'clip-access-row', 'content-access-panel', 'set-free', 'set-premium']);
    // Two buttons per clip, and nothing else clickable.
    expect(html.match(/<button/g)).toHaveLength(4);
  });
});

describe('the section', () => {
  it('is called Clip access, and asks the server rather than assuming anything', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <CharacterAccessSection characterId="c-1" />
      </MemoryRouter>,
    );
    expect(html).toContain('Clip access');
    expect(html).not.toContain('Pricing');
    expect(html).toContain('Loading clip access');
  });
});
