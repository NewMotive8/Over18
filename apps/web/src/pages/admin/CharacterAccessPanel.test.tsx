import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { AdminCharacterContentAccess, AdminClipAccess } from '@over18/shared';
import CharacterAccessSection, { ContentAccessPanel, allocationSummary, clipStateLabel } from './CharacterAccessPanel';

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
  counts: { clips: 2, free: 1, premium: 1 },
  ...over,
});

const noop = () => {};
const panel = (over: Partial<AdminCharacterContentAccess> = {}, reason = 'Launch allocation') =>
  renderToStaticMarkup(
    <MemoryRouter>
      <ContentAccessPanel
        page={page(over)}
        freeCount="2"
        reason={reason}
        busy={false}
        messages={[]}
        onFreeCount={noop}
        onReason={noop}
        onAllocate={noop}
        onClear={noop}
        onMark={noop}
      />
    </MemoryRouter>,
  );

describe('what the panel says about a character', () => {
  it('summarises her clips, and whether new ones will be Premium', () => {
    expect(allocationSummary(page())).toBe('1 of 2 Free, 1 Premium. New clips are Premium; 2 Free clips configured.');
    expect(allocationSummary(page({ allocation: { configured: false, freeClipCount: null } }))).toBe(
      '1 of 2 Free, 1 Premium. New clips are Free: she is not in Free/Premium yet.',
    );
    expect(allocationSummary(page({ clips: [], counts: { clips: 0, free: 0, premium: 0 } }))).toBe('She has no clips yet.');
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
    // The action offered is the opposite of what the clip is now.
    expect(html).toContain('Make Premium');
    expect(html).toContain('Make Free');
  });

  it('offers the random allocation, and turning it off only when she is in it', () => {
    expect(panel()).toContain('Choose at random');
    expect(panel()).toContain('Turn off');
    expect(panel({ allocation: { configured: false, freeClipCount: null } })).not.toContain('Turn off');
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
    const html = panel({ clips: [], counts: { clips: 0, free: 0, premium: 0 } });
    expect(html).toContain('No clips yet.');
    expect(html).toContain('follows this character');
    expect(html).not.toContain('clip-access-row');
  });

  it('shows no Credit price or age floor of its own: only what the server sent', () => {
    const html = panel({ clips: [clip('c', { state: 'credit', creditPrice: 50, byDefault: false })], counts: { clips: 1, free: 0, premium: 0 } });
    expect(html).toContain('50 Credits');
    expect(html).not.toMatch(/\$\d|wallet|ledger/i);
  });
});

describe('the section', () => {
  it('asks the server for the character rather than assuming anything', () => {
    expect(renderToStaticMarkup(<MemoryRouter><CharacterAccessSection characterId="c-1" /></MemoryRouter>)).toContain('Loading clip access');
  });
});
