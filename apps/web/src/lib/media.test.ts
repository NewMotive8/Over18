import { describe, it, expect } from 'vitest';
import type { CharacterVisualIdentityResponse, PublicCharacter } from '@over18/shared';
import {
  apparentAge,
  characterMediaList,
  firstCanonicalImage,
  resolveHeroMedia,
  resolveRailMedia,
} from './media';

function character(overrides: Partial<PublicCharacter> = {}): PublicCharacter {
  return {
    id: 'c1',
    name: 'nova',
    displayName: 'Nova',
    profileImage: 'https://img.example/nova.png',
    shortBio: 'bio',
    personality: 'p',
    interests: [],
    conversationStyle: 's',
    ...overrides,
  };
}

function visual(
  canonicals: Array<{ id: string; position: number | null; imageUrl: string }>,
  attributes: Array<{ label: string; value: string }> = [],
): CharacterVisualIdentityResponse {
  return {
    identity:
      attributes.length > 0
        ? { characterId: 'c1', version: 1, label: 'v1', attributes }
        : { characterId: 'c1', version: 1, label: 'v1', attributes: [] },
    canonicalAssets: canonicals,
  };
}

describe('resolveHeroMedia', () => {
  it('is video-first when the character carries a video url (future API field)', () => {
    const withVideo = { ...character(), videoUrl: 'https://cdn.example/nova.mp4' } as PublicCharacter;
    const media = resolveHeroMedia(withVideo, null);
    expect(media.kind).toBe('video');
    if (media.kind === 'video') {
      expect(media.src).toBe('https://cdn.example/nova.mp4');
      // best available still becomes the poster
      expect(media.poster).toBe('https://img.example/nova.png');
    }
  });

  it('uses the visual identity poster for video when available', () => {
    const withVideo = { ...character(), videoUrl: 'https://cdn.example/nova.mp4' } as PublicCharacter;
    const media = resolveHeroMedia(
      withVideo,
      visual([{ id: 'a1', position: 0, imageUrl: 'https://img.example/canon.png' }]),
    );
    expect(media.kind === 'video' && media.poster).toBe('https://img.example/canon.png');
  });

  it('falls back to the first canonical image when there is no video', () => {
    const media = resolveHeroMedia(
      character(),
      visual([
        { id: 'a2', position: 1, imageUrl: 'https://img.example/second.png' },
        { id: 'a1', position: 0, imageUrl: 'https://img.example/first.png' },
      ]),
    );
    expect(media).toEqual({ kind: 'image', src: 'https://img.example/first.png' });
  });

  it('falls back to profileImage when there is no visual identity', () => {
    const media = resolveHeroMedia(character(), null);
    expect(media).toEqual({ kind: 'image', src: 'https://img.example/nova.png' });
  });

  it('falls back to an initial-letter placeholder when there is no media at all', () => {
    const media = resolveHeroMedia(character({ profileImage: null }), null);
    expect(media).toEqual({ kind: 'placeholder', initial: 'N' });
  });
});

describe('firstCanonicalImage', () => {
  it('picks the lowest-position asset and ignores blank urls', () => {
    expect(
      firstCanonicalImage(
        visual([
          { id: 'a2', position: 2, imageUrl: 'https://img.example/two.png' },
          { id: 'a1', position: 0, imageUrl: 'https://img.example/zero.png' },
        ]),
      ),
    ).toBe('https://img.example/zero.png');
    expect(firstCanonicalImage(visual([{ id: 'a1', position: 0, imageUrl: '   ' }]))).toBeUndefined();
    expect(firstCanonicalImage(null)).toBeUndefined();
  });
});

describe('characterMediaList', () => {
  it('opens with a free hero and gates the rest behind Premium (mock-filled) by default', () => {
    const items = characterMediaList(character(), null);
    expect(items).toHaveLength(6); // default minItems
    expect(items[0]?.premium).toBe(false); // hero is free
    expect(items[0]?.media).toEqual({ kind: 'image', src: 'https://img.example/nova.png' });
    expect(items.filter((i) => i.premium).length).toBe(5);
    expect(items.slice(1).every((i) => i.premium && i.mock)).toBe(true); // padded tiles are flagged mock
  });

  it('treats additional REAL canonical stills as free, viewable media', () => {
    const items = characterMediaList(
      character(),
      visual([
        { id: 'a1', position: 0, imageUrl: 'https://img.example/one.png' },
        { id: 'a2', position: 1, imageUrl: 'https://img.example/two.png' },
        { id: 'a3', position: 2, imageUrl: 'https://img.example/three.png' },
      ]),
    );
    const free = items.filter((i) => !i.premium);
    expect(free.length).toBe(3); // hero + 2 additional canonical
    expect(free[1]?.media).toEqual({ kind: 'image', src: 'https://img.example/two.png' });
    expect(items.filter((i) => i.premium).length).toBe(3); // padded to minItems 6
  });

  it('respects a custom minItems', () => {
    expect(characterMediaList(character(), null, { minItems: 3 })).toHaveLength(3);
  });
});

describe('apparentAge', () => {
  it('reads the "Apparent age" identity attribute when present', () => {
    expect(apparentAge(visual([], [{ label: 'Apparent age', value: 'adult (mid-20s)' }]))).toBe(
      'adult (mid-20s)',
    );
  });
  it('returns undefined when no age attribute exists', () => {
    expect(apparentAge(visual([], [{ label: 'Hair', value: 'dark' }]))).toBeUndefined();
    expect(apparentAge(null)).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ *
 * The CMS clip as a card's video
 *
 * THE GAP THIS CLOSES. A character created through the CMS could upload and
 * approve any number of videos and her public card stayed a still image
 * forever, because the only video source a card had was a hard-coded manifest
 * keyed on four seeded names. The card component is unchanged; what changed is
 * which data it is allowed to select from.
 * ------------------------------------------------------------------ */

const clip = (mediaType: 'image' | 'video', id = 'a1') => ({
  url: `/api/media/assets/${id}/file`,
  mediaType,
});

describe('a character’s CMS clip can be her card video', () => {
  it('uses an approved CMS VIDEO as the card’s video', () => {
    const media = resolveHeroMedia(character({ name: 'nova-cms', clip: clip('video') } as never));
    expect(media.kind).toBe('video');
    // Absolutised against the API origin — the web app is a different origin.
    expect(media.kind === 'video' && media.src).toContain('/api/media/assets/a1/file');
  });

  it('does NOT treat a CMS image clip as a video', () => {
    const media = resolveHeroMedia(character({ name: 'nova-cms', clip: clip('image') } as never));
    expect(media.kind).toBe('image');
  });

  it('posters the CMS video with the canonical still, then profileImage', () => {
    const withCanonical = resolveHeroMedia(
      character({ name: 'nova-cms', clip: clip('video') } as never),
      visual([{ id: 'i1', position: 0, imageUrl: '/api/media/assets/i1/file' }]),
    );
    expect(withCanonical.kind === 'video' && withCanonical.poster).toContain('/assets/i1/file');

    const withProfile = resolveHeroMedia(character({ name: 'nova-cms', clip: clip('video') } as never));
    expect(withProfile.kind === 'video' && withProfile.poster).toBe('https://img.example/nova.png');
  });

  it('leaves a character with no clip exactly as she was', () => {
    // The field is optional: the older /api/characters payload has none, and
    // every existing caller must keep working untouched.
    const media = resolveHeroMedia(character({ name: 'unknown-to-manifest' }));
    expect(media.kind).toBe('image');
    expect(media.kind === 'image' && media.src).toBe('https://img.example/nova.png');
  });

  it('a null clip is handled like an absent one', () => {
    const media = resolveHeroMedia(character({ name: 'unknown-to-manifest', clip: null } as never));
    expect(media.kind).toBe('image');
  });
});

describe('the seeded characters keep working', () => {
  it('Luna still plays her MANIFEST clip when her CMS clip is an image', () => {
    // Her representative clip is a canonical image, so nothing here supplies a
    // CMS video and the manifest is still what plays. This is the regression
    // that would break Maria/Ember/Luna if the precedence were wrong.
    const media = resolveHeroMedia(character({ name: 'luna', clip: clip('image') } as never));
    expect(media.kind).toBe('video');
    expect(media.kind === 'video' && media.src).toBe('/media/luna/profile-04.mp4');
  });

  it('Luna with NO clip at all is unchanged', () => {
    const media = resolveHeroMedia(character({ name: 'luna' }));
    expect(media.kind === 'video' && media.src).toBe('/media/luna/profile-04.mp4');
  });

  it('Ember and Maria still resolve their own manifest clips', () => {
    for (const [name, src] of [
      ['ember', '/media/ember/hero.mp4'],
      ['maria', '/media/maria/hero.mp4'],
    ] as const) {
      const media = resolveHeroMedia(character({ name, clip: clip('image') } as never));
      expect(media.kind === 'video' && media.src).toBe(src);
    }
  });

  it('a CMS VIDEO outranks the manifest — an operator’s choice beats a constant', () => {
    const media = resolveHeroMedia(character({ name: 'luna', clip: clip('video', 'new') } as never));
    expect(media.kind === 'video' && media.src).toContain('/api/media/assets/new/file');
  });
});

/* ------------------------------------------------------------------ *
 * The HOME CHARACTER RAILS are clip-only
 *
 * THE DEFECT THIS CLOSES. Play with me rendered `resolveHeroMedia`, which uses
 * the CMS clip only when it is a VIDEO and otherwise falls through to
 * `firstCanonicalImage(visual) ?? profileImage` — the character's identity
 * image, shown as though it were her clip. `resolveRailMedia` cannot reach any
 * of those sources at all.
 * ------------------------------------------------------------------ */

describe('the Play with me rail renders a real video or NO CARD', () => {
  const video = { url: '/api/media/assets/vid/file', mediaType: 'video' as const };
  const image = { url: '/api/media/assets/img/file', mediaType: 'image' as const };

  it('renders the character\u2019s own approved VIDEO', () => {
    const media = resolveRailMedia(character({ clip: video } as never));
    expect(media?.kind).toBe('video');
    expect(media?.kind === 'video' && media.src).toContain('/api/media/assets/vid/file');
  });

  it('returns NULL when she has no eligible video \u2014 no card, no substitute', () => {
    // `character()` carries profileImage 'https://img.example/nova.png'.
    expect(resolveRailMedia(character({ clip: null } as never))).toBeNull();
  });

  it('NEVER falls back to profileImage', () => {
    const media = resolveRailMedia(character({ clip: null } as never));
    expect(JSON.stringify(media)).not.toContain('img.example');
  });

  it('NEVER falls back to the canonical/visual-identity image', () => {
    // resolveRailMedia takes no `visual` argument at all \u2014 the identity image
    // is not reachable from here by construction, not by convention.
    expect(resolveRailMedia.length).toBe(1);
    expect(resolveRailMedia(character({ clip: null } as never))).toBeNull();
  });

  it('NEVER falls back to the hard-coded manifest, even for a seeded name', () => {
    // Luna has a manifest entry. On a rail it must not be used.
    const media = resolveRailMedia(character({ name: 'luna', clip: null } as never));
    expect(media).toBeNull();
    expect(JSON.stringify(media)).not.toContain('/media/luna');
  });

  it('NEVER renders a placeholder \u2014 the old lettered tile is gone', () => {
    // It used to return { kind: 'placeholder', initial: 'N' }. A lettered tile
    // among video tiles is still a card claiming she has content.
    const media = resolveRailMedia(character({ displayName: 'Nova', clip: null } as never));
    expect(media).toBeNull();
    expect(JSON.stringify(media)).not.toContain('placeholder');
  });

  it('does NOT treat an image clip as rail media', () => {
    const media = resolveRailMedia(character({ clip: image } as never));
    expect(media).toBeNull();
    expect(JSON.stringify(media)).not.toContain('/assets/img/file');
  });

  it('a seeded character WITH an approved video plays that video', () => {
    // Maria/Ember/Luna resolve from their own content, not their reference image.
    const media = resolveRailMedia(character({ name: 'maria', clip: video } as never));
    expect(media?.kind === 'video' && media.src).toContain('/api/media/assets/vid/file');
    expect(JSON.stringify(media)).not.toContain('/media/maria');
  });
});

describe('the OTHER surfaces keep their image behaviour', () => {
  // resolveHeroMedia still serves the discovery grid, the swipe card and the
  // Character page, where showing a character's own image is correct. This
  // fix must not have leaked into them.
  it('resolveHeroMedia still falls back to profileImage', () => {
    const media = resolveHeroMedia(character({ name: 'not-in-manifest' }));
    expect(media.kind).toBe('image');
    expect(media.kind === 'image' && media.src).toBe('https://img.example/nova.png');
  });

  it('resolveHeroMedia still prefers the canonical image over profileImage', () => {
    const media = resolveHeroMedia(
      character({ name: 'not-in-manifest' }),
      visual([{ id: 'i1', position: 0, imageUrl: '/api/media/assets/i1/file' }]),
    );
    expect(media.kind === 'image' && media.src).toContain('/assets/i1/file');
  });

  it('resolveHeroMedia still serves the seeded manifest videos', () => {
    expect(resolveHeroMedia(character({ name: 'luna' })).kind).toBe('video');
  });
});
