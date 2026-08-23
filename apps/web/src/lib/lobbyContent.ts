
/**
 * Adult-safety presentation helpers (US-28, trimmed by US-102.4).
 *
 * WHAT THIS USED TO BE, AND WHY MOST OF IT IS GONE. This module also held a
 * hard-coded category list beginning with "All", `personaTags()` (which derived
 * category membership from `index + displayName.length`), `personaBadge()`
 * (NEW/HOT from `index % 4`) and `buildHeroSlides()` (a hard-coded promo hero).
 * All of it was invented client-side, so nothing an operator did in the CMS
 * could change what the app showed. US-102.4 made Home CMS-composed and deleted
 * every one of them — see lib/homeContent.ts.
 *
 * WHAT REMAINS is the part that was never invented content: the adults-only
 * guardrail. Over18 personas are all adults, every displayed age is clamped to
 * an adult value, and FORBIDDEN_AGE_TERMS backs the safety guard test.
 */

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
