import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import type { CharacterVisualIdentityResponse, PublicCharacter } from '@over18/shared';
import CharacterCard from '../components/CharacterCard';
import PersonaGridCard from '../components/lobby/PersonaGridCard';
import { API_URL, type PublicCharacterCard } from './api';
import { absoluteMediaUrl, characterHeaderItems, resolveHeroMedia } from './media';

/**
 * P0.2 QA fixes (D1-D3) -- how the web turns the server's portrait into pixels.
 *
 * The server resolves `profileImage` from the canonical reference model and
 * knows which references can be served. Two things went wrong on the way to
 * the screen, and these pin both:
 *
 *   D1  the Character page and the browse grid asked `/visual-identity` for an
 *       image FIRST. That list includes seeded scaffolding references whose
 *       bytes do not exist, so a seeded character showed a letter tile, and
 *       kept showing it after an operator uploaded a real portrait.
 *   D2  `profileImage` now arrives in two shapes that live on DIFFERENT
 *       servers: a canonical `/api/...` route (API origin) and a legacy
 *       `/media/...` file (web origin). Only the `/api/` prefix may be sent to
 *       the API.
 *   D3  CharacterCard prefixed every root-relative path with the API origin.
 */

/** The exact shape QA observed: seed scaffolding at 1-3, a real upload unpositioned. */
const SEEDED_VISUAL: CharacterVisualIdentityResponse = {
  identity: { characterId: 'luna', version: 1, label: null, attributes: [] },
  canonicalAssets: [
    { id: 'seed-1', position: 1, imageUrl: '/api/media/assets/seed-1/file' },
    { id: 'seed-2', position: 2, imageUrl: '/api/media/assets/seed-2/file' },
    { id: 'seed-3', position: 3, imageUrl: '/api/media/assets/seed-3/file' },
  ],
};
const AFTER_UPLOAD: CharacterVisualIdentityResponse = {
  ...SEEDED_VISUAL,
  canonicalAssets: [
    ...SEEDED_VISUAL.canonicalAssets,
    { id: 'real', position: null, imageUrl: '/api/media/assets/real/file' },
  ],
};

const LUNA_LEGACY = 'https://placehold.co/512x512/1c1917/f43f5e?text=Luna';
const MARIA_LEGACY = '/media/maria/portrait.png';
const CANONICAL = '/api/media/assets/real/file';

function character(profileImage: string | null, name = 'luna'): PublicCharacter {
  return {
    id: name,
    name,
    displayName: name.charAt(0).toUpperCase() + name.slice(1),
    profileImage,
    shortBio: 'bio',
    personality: 'p',
    interests: [],
    conversationStyle: 's',
  };
}

function gridCard(profileImage: string | null): PublicCharacterCard {
  return {
    id: 'grid',
    name: 'grid',
    displayName: 'Grid',
    shortBio: 'bio',
    profileImage,
    categories: [],
    clip: null,
  };
}

const still = (media: ReturnType<typeof resolveHeroMedia>) =>
  media.kind === 'image' ? media.src : media.kind === 'video' ? media.poster : `placeholder:${media.initial}`;

/* ================================================================== *
 * D2 -- each locator goes to the server that owns it
 * ================================================================== */

describe('absoluteMediaUrl sends each portrait to the server that owns it', () => {
  it('1. a canonical /api/ portrait resolves to the API origin', () => {
    expect(absoluteMediaUrl(CANONICAL)).toBe(`${API_URL}${CANONICAL}`);
  });

  it('2. a /media/ legacy fallback stays a web-origin path', () => {
    expect(absoluteMediaUrl(MARIA_LEGACY)).toBe(MARIA_LEGACY);
    expect(absoluteMediaUrl(MARIA_LEGACY)).not.toContain(API_URL);
  });

  it('3. an absolute external URL is unchanged', () => {
    expect(absoluteMediaUrl(LUNA_LEGACY)).toBe(LUNA_LEGACY);
  });

  it('only the /api/ prefix is the API\'s -- a path that merely starts with /a is not', () => {
    expect(absoluteMediaUrl('/apix/thing.png')).toBe('/apix/thing.png');
    expect(absoluteMediaUrl('/admin/content/uploads/x/file')).toBe('/admin/content/uploads/x/file');
  });

  it('blank and missing locators are absent, not empty strings', () => {
    expect(absoluteMediaUrl(null)).toBeUndefined();
    expect(absoluteMediaUrl(undefined)).toBeUndefined();
    expect(absoluteMediaUrl('   ')).toBeUndefined();
  });
});

/* ================================================================== *
 * D1 -- the server portrait beats the separate identity lookup
 * ================================================================== */

describe('the server-resolved portrait beats the visual-identity lookup', () => {
  it('4. a real canonical upload wins over a seeded placeholder', () => {
    const media = resolveHeroMedia(character(CANONICAL), AFTER_UPLOAD);
    expect(still(media)).toBe(`${API_URL}${CANONICAL}`);
    // The Character header resolves through the same function.
    expect(still(characterHeaderItems(character(CANONICAL), [], AFTER_UPLOAD)[0]!.media)).toBe(
      `${API_URL}${CANONICAL}`,
    );
  });

  it('4. a seeded character with no upload keeps her working legacy portrait', () => {
    // Before this fix these resolved to /api/media/assets/seed-1/file, which the
    // API answers 404, and HeroMedia drew the letter.
    expect(still(resolveHeroMedia(character(LUNA_LEGACY), SEEDED_VISUAL))).toBe(LUNA_LEGACY);
    expect(still(resolveHeroMedia(character(MARIA_LEGACY, 'maria'), SEEDED_VISUAL))).toBe(MARIA_LEGACY);
  });

  it('4. a video still takes the same portrait as its poster', () => {
    const withVideo = {
      ...character(CANONICAL),
      clip: { url: '/api/media/assets/v1/file', mediaType: 'video' as const },
    };
    const media = resolveHeroMedia(withVideo, AFTER_UPLOAD);
    expect(media.kind).toBe('video');
    expect(still(media)).toBe(`${API_URL}${CANONICAL}`);
  });

  it('5. with no server portrait, the visual identity may be used', () => {
    const media = resolveHeroMedia(character(null), AFTER_UPLOAD);
    expect(still(media)).toBe(`${API_URL}/api/media/assets/seed-1/file`);
  });

  it('6. with neither, the initial-letter placeholder is unchanged', () => {
    expect(resolveHeroMedia(character(null), null)).toEqual({ kind: 'placeholder', initial: 'L' });
    expect(
      resolveHeroMedia(character(null), { identity: null, canonicalAssets: [] }),
    ).toEqual({ kind: 'placeholder', initial: 'L' });
  });
});

/* ================================================================== *
 * What actually reaches the markup
 * ================================================================== */

describe('rendered portraits point at the right server', () => {
  const render = (node: React.ReactNode) => renderToStaticMarkup(<MemoryRouter>{node}</MemoryRouter>);

  it('the browse grid card renders a canonical portrait from the API origin', () => {
    const html = render(<PersonaGridCard character={gridCard(CANONICAL)} index={3} />);
    expect(html).toContain(`src="${API_URL}${CANONICAL}"`);
  });

  it('the browse grid card renders a /media/ fallback from the web origin', () => {
    const html = render(<PersonaGridCard character={gridCard(MARIA_LEGACY)} index={3} />);
    expect(html).toContain(`src="${MARIA_LEGACY}"`);
    expect(html).not.toContain(`${API_URL}${MARIA_LEGACY}`);
  });

  it('D3. CharacterCard normalises each shape correctly', () => {
    expect(render(<CharacterCard character={character(CANONICAL)} />)).toContain(
      `src="${API_URL}${CANONICAL}"`,
    );
    const maria = render(<CharacterCard character={character(MARIA_LEGACY, 'maria')} />);
    expect(maria).toContain(`src="${MARIA_LEGACY}"`);
    expect(maria).not.toContain(`${API_URL}${MARIA_LEGACY}`);
    expect(render(<CharacterCard character={character(LUNA_LEGACY)} />)).toContain(
      `src="${LUNA_LEGACY.replace(/&/g, '&amp;')}"`,
    );
  });

  it('D3. CharacterCard with no portrait draws the initial, not a broken image', () => {
    const html = render(<CharacterCard character={character(null)} />);
    expect(html).not.toContain('<img');
    expect(html).toContain('>L<');
  });
});
