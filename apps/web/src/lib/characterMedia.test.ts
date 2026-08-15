import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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
    // US-88: Maria's three approved supplied clips.
    expect(characterVideos(character('maria')).map((v) => v.src)).toEqual([
      '/media/maria/hero.mp4',
      '/media/maria/profile-02.mp4',
      '/media/maria/profile-03.mp4',
    ]);
    // Nine approved clips across the four mapped characters (Sage's two are
    // preserved even though she is retired at the product level).
    const total = ['luna', 'ember', 'sage', 'maria'].reduce(
      (n, name) => n + characterVideos(character(name)).length,
      0,
    );
    expect(total).toBe(9);
  });

  it('returns no clips for a character without shipped media', () => {
    expect(characterVideos(character('nova'))).toEqual([]);
  });

  /**
   * ── US-88 — Maria's media resolves through the existing manifest ───────
   * No Maria-specific frontend logic exists; she is served by exactly the
   * same data-driven seam as every other character.
   */
  it('AC3/AC9 — Maria resolves a hero clip, posters and additional clips like any other character', () => {
    const maria = character('maria');
    const hero = characterHeroVideo(maria);
    expect(hero?.src).toBe('/media/maria/hero.mp4');
    expect(hero?.poster).toBe('/media/maria/hero.jpg');
    expect(characterAdditionalVideos(maria)).toHaveLength(2);
    expect(characterAdditionalVideos(maria).some((v) => v.role === 'hero')).toBe(false);
    // Every clip has a real poster locator alongside it.
    for (const clip of characterVideos(maria)) {
      expect(clip.poster).toMatch(/^\/media\/maria\/.+\.jpg$/);
      expect(clip.src).toMatch(/^\/media\/maria\/.+\.mp4$/);
    }
    expect(characterVideoItems(maria)).toHaveLength(3);
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

/**
 * ── US-88 — Maria's approved media is really on disk ────────────────────
 *
 * The manifest is only half the promise: a locator that resolves to nothing
 * is a broken tile in the browser. These assertions open the actual static
 * files and check their magic bytes, so a missing or mis-copied asset fails
 * here instead of in front of a user. Sage's shipped media is checked too —
 * retiring her must never remove a byte.
 */
function publicPath(url: string): string {
  return fileURLToPath(new URL(`../../public${url}`, import.meta.url));
}

function magic(url: string, bytes: number): string {
  return readFileSync(publicPath(url)).subarray(0, bytes).toString('hex');
}

describe('US-88 shipped media on disk', () => {
  it('AC3 — Maria\'s portrait exists and carries real image bytes', () => {
    const portrait = '/media/maria/portrait.png';
    expect(existsSync(publicPath(portrait))).toBe(true);
    // PNG signature — the supplied file is PNG data, named truthfully.
    expect(magic(portrait, 8)).toBe('89504e470d0a1a0a');
    expect(readFileSync(publicPath(portrait)).length).toBeGreaterThan(10_000);
  });

  it('AC3 — every Maria clip and poster in the manifest exists and is real media', () => {
    const clips = characterVideos(character('maria'));
    expect(clips).toHaveLength(3);
    for (const clip of clips) {
      expect(existsSync(publicPath(clip.src))).toBe(true);
      expect(existsSync(publicPath(clip.poster))).toBe(true);
      // ISO base-media (MP4) files carry an 'ftyp' box type at offset 4.
      expect(readFileSync(publicPath(clip.src)).subarray(4, 8).toString('ascii')).toBe('ftyp');
      // Posters are genuine JPEGs (SOI marker).
      expect(magic(clip.poster, 3)).toBe('ffd8ff');
      expect(readFileSync(publicPath(clip.src)).length).toBeGreaterThan(100_000);
    }
  });

  it('AC6 — Sage\'s existing media is preserved on disk', () => {
    for (const clip of characterVideos(character('sage'))) {
      expect(existsSync(publicPath(clip.src))).toBe(true);
      expect(existsSync(publicPath(clip.poster))).toBe(true);
    }
  });

  it('AC7 — Luna\'s and Ember\'s media is untouched', () => {
    for (const name of ['luna', 'ember']) {
      for (const clip of characterVideos(character(name))) {
        expect(existsSync(publicPath(clip.src))).toBe(true);
        expect(existsSync(publicPath(clip.poster))).toBe(true);
      }
    }
  });
});
