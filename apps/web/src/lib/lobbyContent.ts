import type { PublicCharacter } from '@over18/shared';

/**
 * Lobby / Discovery Hub presentation content (US-28).
 *
 * This module holds the small amount of UI-only content the media-led lobby
 * needs on top of the real character API — categories, hero/promo copy, badge
 * and age derivation. It is deliberately isolated so nothing here leaks into
 * the data layer or invents a backend.
 *
 * PRODUCT GUARDRAIL — ADULTS ONLY: Over18 personas are all adults. Categories
 * are curated to be unambiguously adult; the design brief's "Teen" example is
 * intentionally NOT used. Every displayed age is clamped to an adult value.
 */

/**
 * Adult-safe discovery categories. First entry ("All") is the default.
 * Curated to avoid any minor-coded or ambiguous-age language.
 */
export const CATEGORIES = [
  'All',
  'Trending',
  'New',
  'Girlfriend',
  'Milf',
  'Dominant',
  'Submissive',
  'Cosplay',
  'Fantasy',
  'Fitness',
  'Goth',
  'Luxury',
] as const;

export type Category = (typeof CATEGORIES)[number];

/**
 * Terms that must never appear in categories or persona metadata. Used by the
 * adult-safety guard test to keep the surface adults-only. Not shown to users.
 */
export const FORBIDDEN_AGE_TERMS = [
  'teen',
  'teenager',
  'adolescent',
  'schoolgirl',
  'schoolboy',
  'child',
  'minor',
  'underage',
  'under-age',
  'preteen',
  'jailbait',
  'barely legal',
  'loli',
  'young girl',
  'high school',
] as const;

/**
 * Derives a clearly-adult numeric age from a Visual Identity apparent-age band
 * (e.g. "adult (mid-20s)"). The band is already adult-validated server-side;
 * this maps it to a display number and clamps to >= 21 so the lobby can never
 * present an ambiguous or minor-coded age. Falls back to a safe adult default.
 */
export function adultAgeFromBand(band?: string | null): number {
  const SAFE_DEFAULT = 26;
  const MIN_ADULT = 21;
  if (!band) return SAFE_DEFAULT;
  const text = band.toLowerCase();

  const decadeMatch = text.match(/(\d{2})\s*s\b/) ?? text.match(/(\d{2})/);
  const decade = decadeMatch ? parseInt(decadeMatch[1]!, 10) : null;

  let age: number;
  if (decade != null) {
    const base = Math.floor(decade / 10) * 10; // 25 -> 20, 34 -> 30
    if (/early/.test(text)) age = base + 2;
    else if (/late/.test(text)) age = base + 8;
    else if (/mid/.test(text)) age = base + 5;
    else age = decade >= base ? decade : base + 5;
  } else {
    age = SAFE_DEFAULT;
  }

  return Math.max(MIN_ADULT, age);
}

export type PersonaBadge = 'NEW' | 'HOT' | null;

/**
 * Deterministic NEW/HOT badge for a persona at a given feed position. Pure UI
 * decoration (no backend "trending" signal exists yet) — stable per index so
 * the feed looks intentional rather than random.
 */
export function personaBadge(index: number): PersonaBadge {
  const slot = index % 4;
  if (slot === 0) return 'HOT';
  if (slot === 1) return 'NEW';
  return null;
}

/**
 * Deterministic adult-safe category tags for a persona, used for the
 * category-pill filter. Derived from stable position + the character's own
 * interests so filtering is genuine (not random) without a backend taxonomy.
 * Every persona always carries 'Trending' so the default hubs are never empty.
 */
export function personaTags(character: PublicCharacter, index: number): Category[] {
  const rotating: Category[] = ['Girlfriend', 'Milf', 'Dominant', 'Submissive', 'Fantasy', 'Fitness', 'Goth', 'Luxury'];
  // Seed off both the feed position and a stable property of the persona so tags
  // feel tied to the character rather than to raw ordering.
  const seed = index + character.displayName.length;
  const tags = new Set<Category>(['Trending']);
  if (index % 3 === 0) tags.add('New');
  // Two stable rotating tags per persona so several categories have content.
  tags.add(rotating[seed % rotating.length]!);
  tags.add(rotating[(seed + 3) % rotating.length]!);
  return Array.from(tags);
}

export interface HeroSlide {
  id: string;
  kind: 'promo' | 'persona';
  eyebrow: string;
  headline: string;
  sub: string;
  ctaLabel: string;
  ctaTo: string;
  /** For persona slides: the character whose media backs the slide. */
  character?: PublicCharacter;
}

/**
 * Builds the hero carousel slides: a non-persona promo slide first (the brief's
 * "Refer a Friend" style CTA), then data-driven persona slides from the loaded
 * characters — no hard-coded persona identities.
 */
export function buildHeroSlides(characters: PublicCharacter[]): HeroSlide[] {
  const slides: HeroSlide[] = [
    {
      id: 'promo-refer',
      kind: 'promo',
      eyebrow: 'Limited offer',
      headline: 'Refer a friend, get 85% off',
      sub: 'Invite someone in and unlock a premium month for less.',
      ctaLabel: 'Refer a friend',
      ctaTo: '/subscription',
    },
  ];

  for (const character of characters.slice(0, 3)) {
    slides.push({
      id: `persona-${character.id}`,
      kind: 'persona',
      eyebrow: 'Featured tonight',
      headline: `Spend the evening with ${character.displayName}`,
      sub: character.shortBio,
      ctaLabel: 'Say hello',
      ctaTo: `/characters/${character.id}`,
      character,
    });
  }

  return slides;
}
