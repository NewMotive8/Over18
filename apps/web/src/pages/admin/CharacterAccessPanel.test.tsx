import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { AdminCharacterContentAccess, AdminClipAccess } from '@over18/shared';
import { TILE_MEDIA_CLASS, tileFrameClass } from '../../lib/mediaTile';
import CharacterAccessSection, {
  ContentAccessPanel,
  accessSummary,
  clipDetails,
  clipDurationLabel,
  clipStateLabel,
} from './CharacterAccessPanel';

/**
 * P4.D2 -- a character's Free and Premium clips.
 *
 * Two things are pinned here. The operator must be able to RECOGNISE the clip
 * they are classifying, which means a still of the real asset rather than the
 * head of a uuid. And the decision must stay two words: the reason field, the
 * free-clip count, the random allocation, the clear-all and the Credit price
 * controls are gone from this screen, and the tests below fail if any of them
 * return.
 */

const clip = (assetId: string, over: Partial<AdminClipAccess> = {}): AdminClipAccess => ({
  assetId,
  mediaType: 'video',
  workflow: 'approved',
  live: true,
  previewUrl: `/admin/content/assets/${assetId}/file`,
  fileName: 'mazalbar_sfw__random2_00001_.mp4',
  durationSeconds: 5,
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

/* ------------------------------------------------------------------ *
 * Recognising the clip
 * ------------------------------------------------------------------ */

describe('the clip an operator is looking at', () => {
  it('shows a still of the real asset, for every clip', () => {
    const html = panel();
    expect(html.match(/data-testid="clip-thumb"/g)).toHaveLength(2);
    // The asset's own admin locator, not a storage key and not a guess.
    expect(html).toContain(`/admin/content/assets/${FREE_CLIP}/file`);
    expect(html).toContain(`/admin/content/assets/${PREMIUM_CLIP}/file`);
  });

  it('borrows the shared admin tile rules rather than inventing a frame', () => {
    const html = panel();
    expect(html).toContain(tileFrameClass(true));
    expect(html).toContain(TILE_MEDIA_CLASS);
    // contain, never cover: the operator judges the clip, not a crop of it.
    expect(TILE_MEDIA_CLASS).toContain('object-contain');
  });

  /**
   * A dozen looping videos to answer "which clip is this?" fetches a dozen
   * files for a question one frame answers.
   */
  it('takes a frame from the video instead of playing it', () => {
    const html = panel();
    expect(html).toContain('data-testid="clip-thumb-video"');
    expect(html).toContain('preload="metadata"');
    // The frame a tenth of a second in -- frame zero is often black.
    expect(html).toContain('/file#t=0.1');
    expect(html).not.toContain('autoplay');
    expect(html).not.toContain('loop');
  });

  it('renders an image clip as an image', () => {
    const html = panel({
      clips: [clip('c', { mediaType: 'image', durationSeconds: null })],
      counts: { clips: 1, free: 0, premium: 1, credit: 0 },
    });
    expect(html).toContain('data-testid="clip-thumb-image"');
    expect(html).not.toContain('data-testid="clip-thumb-video"');
  });

  it('says so when a clip has no file, rather than showing an empty square', () => {
    const html = panel({
      clips: [clip('c', { previewUrl: null })],
      counts: { clips: 1, free: 0, premium: 1, credit: 0 },
    });
    expect(html).toContain('no preview');
    expect(html).not.toContain('data-testid="clip-thumb-video"');
  });

  it("shows the file's own name, and none at all when there is none", () => {
    expect(panel()).toContain('mazalbar_sfw__random2_00001_.mp4');
    const nameless = panel({
      clips: [clip('c', { fileName: null })],
      counts: { clips: 1, free: 0, premium: 1, credit: 0 },
    });
    expect(nameless).not.toContain('data-testid="clip-name"');
    // No invented title, no "Untitled", no "Clip 1".
    for (const invented of ['Untitled', 'Clip 1', 'Unnamed', 'Unknown']) {
      expect({ invented, found: nameless.includes(invented) }, invented).toEqual({ invented, found: false });
    }
  });

  it('reads a duration where one exists, and nothing where none does', () => {
    expect(clipDurationLabel(5)).toBe('0:05');
    expect(clipDurationLabel(75)).toBe('1:15');
    expect(clipDurationLabel(null)).toBeNull();
    expect(clipDurationLabel(0)).toBeNull();
    expect(clipDetails(clip('a'))).toEqual(['Video', '0:05', 'Live']);
    expect(clipDetails(clip('a', { durationSeconds: null }))).toEqual(['Video', 'Live']);
  });

  it('says where a clip stands when it is not live', () => {
    expect(clipDetails(clip('a', { live: false, workflow: 'pending_review' }))).toContain('In review');
    expect(clipDetails(clip('a', { live: false, workflow: 'archived' }))).toContain('Archived');
  });

  it('keeps the asset id as small secondary detail, not as the clip label', () => {
    const html = panel();
    const name = html.indexOf('mazalbar_sfw__random2_00001_.mp4');
    const id = html.indexOf(FREE_CLIP.slice(0, 8), name);
    // The thumbnail and the name come first; the id trails them.
    expect(name).toBeGreaterThan(-1);
    expect(id).toBeGreaterThan(name);
    expect(html).toContain('font-mono text-[10px]');
  });
});

/* ------------------------------------------------------------------ *
 * The decision
 * ------------------------------------------------------------------ */

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

  it('keeps both buttons at a 44px touch target', () => {
    // min-h-11 is 2.75rem. A thumb on a phone, not a mouse on a desktop.
    expect(panel().match(/min-h-11/g)).toHaveLength(4);
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

  /**
   * CLASSIFYING IS NOT SELLING, so this panel no longer waits for the economy.
   *
   * It used to grey itself out whenever `ECONOMY_ENABLED` was off -- which is
   * production -- and say clip access "cannot be changed yet". Marking a clip
   * Free or Premium charges nobody, and the server now allows it with the flag
   * off, so the panel simply works.
   */
  it('works with the economy off, and no longer says otherwise', () => {
    const html = panel({ economyEnabled: false });
    for (const gone of ['The economy is switched off', 'read-only', 'cannot be changed yet']) {
      expect({ gone, found: html.includes(gone) }, gone).toEqual({ gone, found: false });
    }
    // Exactly as many disabled buttons as with the economy on: one per clip,
    // the state it is already in -- and never because of the flag.
    expect(html.match(/disabled=""/g)).toHaveLength(2);
    expect(html).toBe(panel({ economyEnabled: true }));
  });

  it('offers both choices on every clip whatever the flag says', () => {
    for (const economyEnabled of [true, false]) {
      const html = panel({ economyEnabled });
      expect(html.match(/data-testid="set-free"/g), String(economyEnabled)).toHaveLength(2);
      expect(html.match(/data-testid="set-premium"/g), String(economyEnabled)).toHaveLength(2);
      // The pressed one is the clip's own state, not a lock.
      expect(html.match(/aria-pressed="true"/g), String(economyEnabled)).toHaveLength(2);
    }
  });

  it('says what a clip uploaded later will be when she has none yet', () => {
    const html = panel({ clips: [], counts: { clips: 0, free: 0, premium: 0, credit: 0 } });
    expect(html).toContain('No clips yet. Anything uploaded is Premium.');
    expect(html).not.toContain('clip-access-row');
  });
});

/* ------------------------------------------------------------------ *
 * Order, and the shape of the row
 * ------------------------------------------------------------------ */

describe('the order and the layout', () => {
  /**
   * THE ADMIN LIST IS THE SERVER'S ORDER, UNTOUCHED -- the character's own
   * content order. The customer's Free-before-Premium rule belongs to the clip
   * list the app reads; re-sorting here would move every row the moment an
   * operator classified one.
   */
  it('renders the clips in the order the server sent them, Free or not', () => {
    const [a, b, c] = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333'];
    const html = panel({
      // A Premium clip, then a Free one, then Premium: the free one is NOT lifted.
      clips: [clip(a), clip(b, { state: 'free', byDefault: false }), clip(c)],
      counts: { clips: 3, free: 1, premium: 2, credit: 0 },
    });
    const at = (id: string) => html.indexOf(`/admin/content/assets/${id}/file`);
    expect(at(a)).toBeLessThan(at(b));
    expect(at(b)).toBeLessThan(at(c));
    // No sort of its own: the panel never reads state to decide position.
    expect(html.indexOf('data-state="free"')).toBeGreaterThan(html.indexOf('data-state="premium"'));
  });

  /**
   * NO HORIZONTAL SCROLL ON A PHONE. This was a table inside `overflow-x-auto`
   * with a `min-w-[26rem]` floor, which on a 375px screen is a sideways scroll
   * to reach the buttons. The row instead lets its text column shrink, and the
   * things that must not shrink say so.
   */
  it('cannot scroll sideways on a phone', () => {
    const html = panel();
    for (const overflow of ['overflow-x-auto', 'min-w-[', '<table', 'whitespace-nowrap']) {
      expect({ overflow, found: html.includes(overflow) }, overflow).toEqual({ overflow, found: false });
    }
    // The text column shrinks (so `truncate` can work) and the rest does not.
    expect(html).toContain('min-w-0 flex-1');
    expect(html.match(/shrink-0/g)!.length).toBeGreaterThanOrEqual(4);
    expect(html).toContain('truncate');
  });

  /**
   * A row inside the admin shell is about 250px wide at 375px. Three columns
   * left roughly 40px for the name -- the file rendered as "m." next to two
   * buttons, which is the failure this change exists to fix. The decision
   * wraps onto its own line instead, and rejoins the row from `sm` up.
   */
  it('gives the name the full width on a phone by stacking the decision', () => {
    const html = panel();
    expect(html).toContain('flex flex-wrap items-center');
    expect(html).toContain('basis-full sm:basis-auto');
    // Full-width buttons on that line, back to their natural size above `sm`.
    expect(html).toContain('w-full shrink-0');
    expect(html).toContain('sm:w-auto');
    expect(html.match(/flex-1 px-3[^"]*sm:flex-none/g)).toHaveLength(4);
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
    expect([...new Set(testids)].sort()).toEqual([
      'access-model',
      'access-summary',
      'clip-access-list',
      'clip-access-row',
      'clip-name',
      'clip-thumb',
      'clip-thumb-video',
      'content-access-panel',
      'set-free',
      'set-premium',
    ]);
    // Two buttons per clip, and nothing else clickable -- the thumbnail is
    // something to look at, not a control.
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
