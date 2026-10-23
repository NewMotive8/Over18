import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import ClipGridCard from './ClipGridCard';
import PersonaGridCard from './PersonaGridCard';
import type { PublicCharacterCard, PublicClip } from '../../lib/api';

/**
 * THE AGE ON A CLIP RAIL.
 *
 * The clip rails -- New, Top rated, Popular -- carried no age at all, in the
 * payload or the card, while Play with me carried a confirmed one. So the same
 * character read "Donna 32" in one rail and "Donna" in the next, and no amount
 * of confirming ages would have changed it.
 *
 * These pin the fix and, just as importantly, pin that the number can only ever
 * be the confirmed one.
 */

const clip = (over: Partial<PublicClip> = {}): PublicClip => ({
  id: 'clip-1',
  mediaType: 'video',
  url: '/api/media/assets/clip-1/file',
  characterId: 'char-1',
  characterName: 'Donna',
  characterAge: null,
  ...over,
});

const render = (c: PublicClip) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <ClipGridCard clip={c} />
    </MemoryRouter>,
  );

describe('a confirmed age on a clip card', () => {
  it('renders beside her name', () => {
    const html = render(clip({ characterAge: 32 }));
    expect(html).toContain('Donna');
    expect(html).toContain('>32<');
  });

  it('reaches the accessible name too, as Play with me does', () => {
    expect(render(clip({ characterAge: 32 }))).toContain('aria-label="Open Donna, 32"');
  });

  it('renders NO age when nobody has confirmed one', () => {
    const html = render(clip({ characterAge: null }));
    expect(html).toContain('aria-label="Open Donna"');
    expect(html).not.toMatch(/>\d+</);
  });
});

describe('what can never appear as an age', () => {
  it('refuses a non-adult number rather than printing it', () => {
    /**
     * The server validates too, so this is the second lock -- and it is the one
     * that matters on an adult product: a number beside her name is read as a
     * fact about her.
     */
    const html = render(clip({ characterAge: 17 as number }));
    expect(html).toContain('aria-label="Open Donna"');
    expect(html).not.toContain('>17<');
  });

  it('refuses a fractional or absurd age', () => {
    expect(render(clip({ characterAge: 29.5 as number }))).not.toContain('29.5');
    expect(render(clip({ characterAge: 999 as number }))).not.toContain('>999<');
  });
});

describe('an image clip is still unrenderable here', () => {
  it('renders nothing at all, age or not', () => {
    // The pre-existing guard: the server filters to video and this is the
    // second lock. Adding an age must not have widened what the card accepts.
    expect(render(clip({ mediaType: 'image', characterAge: 32 }))).toBe('');
  });
});

/* ------------------------------------------------------------------ *
 * The obsolete band fallback
 * ------------------------------------------------------------------ */

describe('PersonaGridCard no longer derives an age from the band', () => {
  const card: PublicCharacterCard = {
    id: 'char-1',
    name: 'donna',
    displayName: 'Donna',
    shortBio: 'A bio.',
    profileImage: null,
    categories: [],
    clip: null,
  };

  it('shows no age, rather than one invented from the apparent-age band', () => {
    /**
     * It read `adultAgeFromBand(apparentAge(visual))`, and the band is the bare
     * string 'adult' for 62 of 65 characters -- so it rendered 26 for almost
     * the whole roster. The component is dead code today, which is exactly why
     * the fallback had to go: it would come back looking correct.
     */
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <PersonaGridCard character={card} index={0} />
      </MemoryRouter>,
    );
    expect(html).toContain('Donna');
    expect(html).toContain('aria-label="Open Donna"');
    expect(html).not.toContain('26');
  });

  it('neither imports nor calls the band helper', async () => {
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('./PersonaGridCard.tsx', import.meta.url), 'utf8'),
    );
    /**
     * COMMENTS ARE STRIPPED FIRST, because the file deliberately names both
     * helpers in the note recording why they were removed -- including in
     * call-shaped form. Asserting against the raw text would fail on the
     * documentation, which would be a reason to delete the documentation.
     */
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split(/\r?\n/)
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');

    expect(code).not.toContain('adultAgeFromBand');
    expect(code).not.toContain('apparentAge');
  });
});
