import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import CardNameAge, { cardAriaLabel } from './CardNameAge';
import ClipRail from './ClipRail';
import ClipGridCard from './ClipGridCard';
import type { PublicCategoryRail, PublicClip } from '../../lib/api';

/**
 * "NAME · AGE", EVERYWHERE OR NOWHERE.
 *
 * Five surfaces rendered this pairing and had drifted into four answers: Play
 * with me showed an age, the results grid showed it at a different weight, the
 * New/Top rated/Popular rails showed none at all, and two dead components still
 * derived one from the apparent-age band. Each was defensible alone; together
 * the same character read differently depending on which rail she appeared in.
 *
 * These pin the shared treatment and, more importantly, pin that the
 * confirmed-only rule lives inside it -- so a sixth surface gets it right by
 * construction rather than by remembering.
 */

const markup = (node: React.ReactNode) =>
  renderToStaticMarkup(<MemoryRouter>{node}</MemoryRouter>);

describe('the shared name/age row', () => {
  it('renders name, separator and age when an age is confirmed', () => {
    const html = markup(<CardNameAge name="Donna" age={32} />);
    expect(html).toContain('Donna');
    expect(html).toContain('·');
    expect(html).toContain('>32<');
  });

  it('renders the name alone when there is no confirmed age', () => {
    const html = markup(<CardNameAge name="Zina" age={null} />);
    expect(html).toContain('Zina');
    // No separator either: a lone middot would read as a missing value.
    expect(html).not.toContain('·');
    expect(html).not.toMatch(/>\d+</);
  });

  it('hides the separator from assistive technology', () => {
    // The link already announces "Open Donna, 32"; a spoken middot is noise.
    expect(markup(<CardNameAge name="Donna" age={32} />)).toContain('aria-hidden="true"');
  });

  it('truncates the name and never the age', () => {
    const html = markup(<CardNameAge name="A very long character name indeed" age={32} />);
    expect(html).toMatch(/class="truncate[^"]*"/);
    expect(html).toContain('shrink-0');
  });
});

describe('the confirmed-only rule lives in the component', () => {
  it('refuses a non-adult age however a caller supplies it', () => {
    /**
     * The rule cannot be bypassed by a caller resolving the age itself and
     * passing a number, which is precisely how the surfaces drifted before.
     */
    for (const bad of [17, 0, -1, 29.5, 999]) {
      const html = markup(<CardNameAge name="X" age={bad} />);
      expect(html, `${bad} must not render`).not.toContain('·');
    }
  });

  it('refuses undefined as well as null', () => {
    expect(markup(<CardNameAge name="X" age={undefined} />)).not.toContain('·');
  });

  it('builds a matching accessible name', () => {
    expect(cardAriaLabel('Donna', 32)).toBe('Open Donna, 32');
    expect(cardAriaLabel('Zina', null)).toBe('Open Zina');
    // The label and the visible text resolve through the same rule, so a card
    // can never announce an age it does not show.
    expect(cardAriaLabel('X', 17)).toBe('Open X');
  });
});

describe('size varies; the relationship does not', () => {
  it('uses a larger treatment for a full-width tile', () => {
    const small = markup(<CardNameAge name="Donna" age={32} />);
    const base = markup(<CardNameAge name="Donna" age={32} size="base" />);
    expect(small).toContain('text-sm font-bold');
    expect(base).toContain('text-base font-bold');
  });

  it('keeps the age lighter and smaller than the name at every size', () => {
    for (const size of ['sm', 'base'] as const) {
      const html = markup(<CardNameAge name="Donna" age={32} size={size} />);
      expect(html).toContain('items-baseline');
      expect(html).toContain('text-zinc-');
    }
  });
});

/* ------------------------------------------------------------------ *
 * The surfaces
 * ------------------------------------------------------------------ */

const clip = (over: Partial<PublicClip> = {}): PublicClip => ({
  id: 'clip-1',
  mediaType: 'video',
  url: '/api/media/assets/clip-1/file',
  characterId: 'char-1',
  characterName: 'Donna',
  characterAge: 32,
  ...over,
});

const rail = (clips: PublicClip[]): PublicCategoryRail => ({
  id: 'rail-1',
  slug: 'new',
  name: 'New',
  tagline: null,
  clips,
});

describe('the New / Top rated / Popular rails', () => {
  it('now show her age, which they never did before', () => {
    /**
     * THE ACTUAL GAP. These rails render their own tile -- not ClipGridCard --
     * so an earlier fix to the results grid left them untouched, and the same
     * character read "Donna 32" in Play with me and "Donna" here.
     */
    const html = markup(<ClipRail rail={rail([clip()])} />);
    expect(html).toContain('Donna');
    expect(html).toContain('·');
    expect(html).toContain('>32<');
  });

  it('announce the age too', () => {
    expect(markup(<ClipRail rail={rail([clip()])} />)).toContain('aria-label="Open Donna, 32"');
  });

  it('show the name alone when nothing is confirmed', () => {
    const html = markup(<ClipRail rail={rail([clip({ characterAge: null })])} />);
    expect(html).toContain('aria-label="Open Donna"');
    expect(html).not.toContain('·');
  });

  it('still renders nothing for an empty rail', () => {
    expect(markup(<ClipRail rail={rail([])} />)).toBe('');
  });
});

describe('the results grid', () => {
  it('shows the same pairing at its own size', () => {
    const html = markup(<ClipGridCard clip={clip()} />);
    expect(html).toContain('Donna');
    expect(html).toContain('·');
    expect(html).toContain('text-base font-bold');
  });

  it('still refuses to render an image clip at all', () => {
    // The pre-existing guard. Sharing a name row must not widen what it accepts.
    expect(markup(<ClipGridCard clip={clip({ mediaType: 'image' })} />)).toBe('');
  });
});
