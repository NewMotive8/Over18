import { describe, it, expect } from 'vitest';
import type { PublicCharacter } from '@over18/shared';
import {
  characterAdditionalVideos,
  characterHeroVideo,
  characterVideoItems,
  characterVideos,
  videoToHeroMedia,
} from './characterMedia';

function character(name: string): PublicCharacter {
  return {
    id: `id-${name}`,
    name,
    displayName: name.charAt(0).toUpperCase() + name.slice(1),
    profileImage: null,
    shortBio: 'bio',
    personality: 'p',
    interests: [],
    conversationStyle: 's',
  };
}

describe('characterVideos manifest', () => {
  it('maps each character to ONLY its approved clips (hero first)', () => {
    // Luna has a single approved clip (Profile 04) — used as her featured/hero.
    expect(characterVideos(character('luna')).map((v) => v.src)).toEqual(['/media/luna/profile-04.mp4']);
    expect(characterVideos(character('ember')).map((v) => v.src)).toEqual([
      '/media/ember/hero.mp4',
      '/media/ember/profile-02.mp4',
      '/media/ember/profile-03.mp4',
    ]);
    expect(characterVideos(character('sage')).map((v) => v.src)).toEqual([
      '/media/sage/hero.mp4',
      '/media/sage/profile-02.mp4',
    ]);
    // Exactly six approved clips across the three characters.
    const total = ['luna', 'ember', 'sage'].reduce((n, name) => n + characterVideos(character(name)).length, 0);
    expect(total).toBe(6);
  });

  it('returns no clips for a character without shipped media', () => {
    expect(characterVideos(character('nova'))).toEqual([]);
  });

  it('uses Ember/Sage hero clips and separates additional thematic clips', () => {
    expect(characterHeroVideo(character('ember'))?.src).toBe('/media/ember/hero.mp4');
    expect(characterHeroVideo(character('sage'))?.src).toBe('/media/sage/hero.mp4');
    expect(characterHeroVideo(character('luna'))?.src).toBe('/media/luna/profile-04.mp4');
    const emberAdditional = characterAdditionalVideos(character('ember'));
    expect(emberAdditional).toHaveLength(2);
    expect(emberAdditional.some((v) => v.role === 'hero')).toBe(false);
    // Luna's single clip is her hero, so she has no additional clips.
    expect(characterAdditionalVideos(character('luna'))).toHaveLength(0);
  });

  it('exposes clips as MediaViewer-compatible video items', () => {
    expect(videoToHeroMedia({ role: 'hero', src: 'a.mp4', poster: 'a.jpg', label: 'x' })).toEqual({
      kind: 'video',
      src: 'a.mp4',
      poster: 'a.jpg',
    });
    const items = characterVideoItems(character('ember'));
    expect(items).toHaveLength(3);
    expect(items[0]?.media.kind).toBe('video');
    expect(items.every((i) => i.premium === false)).toBe(true);
  });
});
