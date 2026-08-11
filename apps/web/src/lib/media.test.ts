import { describe, it, expect } from 'vitest';
import type { CharacterVisualIdentityResponse, PublicCharacter } from '@over18/shared';
import {
  apparentAge,
  characterMediaList,
  firstCanonicalImage,
  resolveHeroMedia,
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
