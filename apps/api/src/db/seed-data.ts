import type { VisualDna } from '@over18/shared';
import type {
  characters,
  characterVisualAssets,
  characterVisualIdentities,
} from './schema.js';

type CharacterSeed = typeof characters.$inferInsert & { id: string };
type VisualIdentitySeed = typeof characterVisualIdentities.$inferInsert & {
  id: string;
  visualDna: VisualDna;
};
type VisualAssetSeed = typeof characterVisualAssets.$inferInsert & { id: string };

/**
 * Deterministic seed characters for the PoC.
 *
 * Fixed UUIDs make seeding idempotent (upsert by id) and give stable
 * references for tests, demos, and future stories. Kept separate from the
 * seeding script so tests can import the data without side effects.
 */
export const SEED_CHARACTERS: CharacterSeed[] = [
  {
    id: '5f0c6b10-0000-4000-8000-000000000001',
    name: 'luna',
    displayName: 'Luna',
    profileImage: 'https://placehold.co/512x512/1c1917/f43f5e?text=Luna',
    shortBio:
      'Night-owl astronomy grad student who believes the best conversations happen after midnight.',
    personality:
      'Dreamy, curious, and quietly affectionate. Luna is a listener first — she remembers small details and brings them back when you least expect it. Slow to open up, deeply loyal once she does.',
    interests: ['astronomy', 'lo-fi music', 'late-night walks', 'science fiction', 'tea rituals'],
    conversationStyle:
      'Soft-spoken and reflective. Prefers unhurried, thoughtful conversation without unnecessary verbosity. Asks thoughtful follow-up questions and often relates topics back to the night sky.',
    systemPrompt:
      'You are Luna, a 24-year-old astronomy graduate student. You are dreamy, curious, and quietly affectionate. You speak softly and reflectively, ask thoughtful follow-up questions, remember small details the user shares, and often draw gentle metaphors from astronomy and the night sky. You are slow to open up but warm and loyal. Keep responses conversational and intimate in tone, never clinical.',
    status: 'active',
  },
  {
    id: '5f0c6b10-0000-4000-8000-000000000002',
    name: 'ember',
    displayName: 'Ember',
    profileImage: 'https://placehold.co/512x512/1c1917/f97316?text=Ember',
    shortBio:
      'Firecracker chef with a food truck, a fast mouth, and zero patience for boring small talk.',
    personality:
      'Bold, playful, and teasing. Ember leads with humor and challenges the people she likes. Under the bravado she is generous and fiercely protective of her people.',
    interests: ['street food', 'salsa dancing', 'motorbikes', 'stand-up comedy', 'spicy everything'],
    conversationStyle:
      'Quick, witty banter with plenty of playful teasing. Short punchy messages, bold opinions, and the occasional surprisingly sincere moment when it matters.',
    systemPrompt:
      'You are Ember, a 27-year-old chef who runs her own food truck. You are bold, playful, and teasing, with quick witty banter and strong opinions. You challenge the user in a flirtatious, good-natured way and avoid boring small talk. Underneath the bravado you are generous and protective; let sincere moments land occasionally. Keep messages short and punchy.',
    status: 'active',
  },
  {
    id: '5f0c6b10-0000-4000-8000-000000000003',
    name: 'sage',
    displayName: 'Sage',
    profileImage: 'https://placehold.co/512x512/1c1917/10b981?text=Sage',
    shortBio:
      'Former city lawyer who traded billable hours for a mountain cabin, a wood stove, and honest conversation.',
    personality:
      'Grounded, warm, and quietly confident. Sage gives considered advice without judging, values honesty over comfort, and has a dry sense of humor that sneaks up on people.',
    interests: ['hiking', 'woodworking', 'philosophy', 'coffee roasting', 'old maps'],
    conversationStyle:
      'Calm and steady. Takes time to answer properly, tells short stories from his old and new life, and asks questions that make you think. Dry humor delivered deadpan.',
    systemPrompt:
      'You are Sage, a 35-year-old former corporate lawyer who now lives in a mountain cabin. You are grounded, warm, and quietly confident, with a dry deadpan sense of humor. You give considered, honest advice without judgment, tell short stories from your two very different lives, and ask questions that make the user reflect. Your pace is calm and unhurried.',
    // US-88: RETIRED from the active product roster, NOT deleted. Only the
    // product status changes — the row, its visual identity, its canonical
    // assets, its provenance and its shipped media all remain intact, and the
    // UUID is never reused. `inactive` is exactly the soft-hide the schema
    // documents, so the public active-character API excludes Sage naturally.
    status: 'inactive',
  },
  {
    // US-88: Maria replaces Sage on the active roster. PRODUCT NAME is
    // "Maria"; the authoritative supplied source content is named "Sigal"
    // (Content/Site). New stable UUID — Sage's is never reused.
    id: '5f0c6b10-0000-4000-8000-000000000004',
    name: 'maria',
    displayName: 'Maria',
    profileImage: '/media/maria/portrait.png',
    // The PO explicitly approved NEUTRAL PLACEHOLDERS for the character text:
    // no biography, backstory, personality, interests or conversation
    // characteristics have been authored for Maria yet, and none are invented
    // here. These columns are NOT NULL, which an empty string satisfies.
    shortBio: '',
    personality: 'Not specified.',
    interests: [],
    conversationStyle: 'Default.',
    systemPrompt: '',
    status: 'active',
  },
];

/**
 * ── US-16B seed visual identity ─────────────────────────────────────────
 *
 * One active Visual Identity (version 1) per seed character so the visual
 * identity system is immediately demonstrable in the browser. Visual DNA is
 * IDENTITY-only (no presentation attributes). Fixed UUIDs keep seeding
 * idempotent.
 */
const LUNA_ID = SEED_CHARACTERS[0]!.id;
const EMBER_ID = SEED_CHARACTERS[1]!.id;
const SAGE_ID = SEED_CHARACTERS[2]!.id;
const MARIA_ID = SEED_CHARACTERS[3]!.id;

const LUNA_IDENTITY = '5f0c6b10-1111-4000-8000-000000000001';
const EMBER_IDENTITY = '5f0c6b10-1111-4000-8000-000000000002';
const SAGE_IDENTITY = '5f0c6b10-1111-4000-8000-000000000003';
const MARIA_IDENTITY = '5f0c6b10-1111-4000-8000-000000000004';

/**
 * US-88: the ONE authoritative Maria portrait, shipped as a static web asset.
 * The supplied Content/Site/Sigal.jpg carries PNG bytes, so it is stored under
 * its true format extension — the same magic-byte-truth rule the media
 * pipeline applies to generated images. The source file is never modified.
 */
export const MARIA_PORTRAIT_URL = '/media/maria/portrait.png';

export const SEED_VISUAL_IDENTITIES: VisualIdentitySeed[] = [
  {
    id: LUNA_IDENTITY,
    characterId: LUNA_ID,
    version: 1,
    status: 'active',
    label: 'v1',
    visualDna: {
      apparentAgeBand: 'adult (mid-20s)',
      face: { shape: 'heart', jaw: 'soft', cheeks: 'high' },
      eyes: 'deep brown, almond-shaped',
      nose: 'straight, delicate',
      lips: 'full, natural',
      skin: { tone: 'warm fair', texture: 'smooth', marks: ['light freckles across the nose'] },
      hair: { color: 'dark brown', length: 'long', texture: 'wavy' },
      body: { build: 'slender', proportions: 'balanced' },
      distinctiveFeatures: ['freckles', 'small beauty mark near the left eye'],
    },
  },
  {
    id: EMBER_IDENTITY,
    characterId: EMBER_ID,
    version: 1,
    status: 'active',
    label: 'v1',
    visualDna: {
      apparentAgeBand: 'adult (late-20s)',
      face: { shape: 'oval', jaw: 'defined', cheeks: 'sculpted' },
      eyes: 'hazel, sharp',
      nose: 'straight with a slight upturn',
      lips: 'full, expressive',
      skin: { tone: 'warm olive', texture: 'smooth', marks: [] },
      hair: { color: 'copper red', length: 'shoulder-length', texture: 'tousled' },
      body: { build: 'athletic', proportions: 'toned' },
      distinctiveFeatures: ['small nose ring', 'faint scar through the right eyebrow'],
    },
  },
  {
    id: SAGE_IDENTITY,
    characterId: SAGE_ID,
    version: 1,
    status: 'active',
    label: 'v1',
    visualDna: {
      apparentAgeBand: 'adult (mid-30s)',
      face: { shape: 'square', jaw: 'strong', cheeks: 'lean' },
      eyes: 'grey-blue, calm',
      nose: 'straight',
      lips: 'medium',
      skin: { tone: 'light, weathered', texture: 'natural', marks: ['laugh lines'] },
      hair: { color: 'dark with grey at the temples', length: 'short', texture: 'straight' },
      body: { build: 'solid', proportions: 'broad-shouldered' },
      distinctiveFeatures: ['short beard', 'crow’s feet'],
    },
  },
  {
    /**
     * US-88 — Maria's APPROVED Visual DNA, transcribed exactly from the
     * approved specification. Nothing is inferred or embellished.
     *
     * Two deliberate omissions, both required by the specification:
     *  - no exact numerical age: the age band uses the application's existing
     *    adult mechanism ('adult'), which isAdultAgeBand accepts.
     *  - NO `body` key at all: height, weight, measurements and build were not
     *    supplied, `body` is optional in VisualDna, so nothing is invented.
     * Maria's DNA is authored from her own approved description — it shares
     * nothing with Sage's.
     */
    id: MARIA_IDENTITY,
    characterId: MARIA_ID,
    version: 1,
    status: 'active',
    label: 'v1',
    visualDna: {
      apparentAgeBand: 'adult',
      face: {
        shape: 'soft oval, slightly heart-shaped',
        cheekbones: 'defined',
        asymmetry: 'natural facial asymmetry',
        realism: 'photorealistic adult appearance',
      },
      eyes: 'brown, almond-shaped, expressive, defined lashes, visible iris detail',
      brows: 'full, dark brown, soft natural shape',
      nose: 'straight, proportionate, soft natural appearance',
      lips: 'full, rose/nude tone, natural texture, no exaggerated cosmetic proportions',
      skin: {
        tone: 'light warm-neutral',
        variation: 'natural variation',
        texture: 'visible skin texture, realistic pores',
        finish: 'no plastic or artificial appearance',
      },
      hair: {
        color: 'dark brown',
        length: 'long',
        texture: 'soft waves',
        volume: 'voluminous',
        arrangement: 'loose, natural side part',
        detail: 'realistic individual strands',
      },
      generalAppearance: [
        'sophisticated',
        'feminine',
        'polished',
        'photorealistic',
        'naturally attractive',
        'adult',
      ],
    },
  },
];

/**
 * Approved canonical reference assets for each seed identity. THESE ARE
 * SCAFFOLDING ONLY: storage_key holds a placeholder URL (an opaque display
 * locator, exactly like characters.profile_image), NOT a generated or
 * photorealistic image. No image generation exists yet. provenance is
 * server-side-only and records the placeholder origin.
 */
function canonicalRefs(
  characterId: string,
  identityId: string,
  idPrefix: string,
  colour: string,
  name: string,
): VisualAssetSeed[] {
  const shots = ['Portrait', 'Selfie', 'Mirror'];
  return shots.map((shot, i) => ({
    id: `5f0c6b10-2222-4000-8000-00000000${idPrefix}0${i + 1}`,
    characterId,
    visualIdentityId: identityId,
    kind: 'reference',
    status: 'approved',
    isCanonical: true,
    position: i + 1,
    storageKey: `https://placehold.co/640x800/1c1917/${colour}?text=${encodeURIComponent(`${name} ${shot} (placeholder)`)}`,
    contentRating: 'sfw',
    provenance: {
      source: 'seed-placeholder',
      note: 'US-16B scaffolding placeholder — not generated, not photorealistic',
      shot,
    },
  }));
}

export const SEED_VISUAL_ASSETS: VisualAssetSeed[] = [
  ...canonicalRefs(LUNA_ID, LUNA_IDENTITY, '01', 'f43f5e', 'Luna'),
  ...canonicalRefs(EMBER_ID, EMBER_IDENTITY, '02', 'f97316', 'Ember'),
  // US-88: Sage's canonical references are PRESERVED byte-for-byte. Retiring a
  // character changes its product status only — never its visual history.
  ...canonicalRefs(SAGE_ID, SAGE_IDENTITY, '03', '10b981', 'Sage'),
  /**
   * US-88: Maria's canonical reference set. Unlike the placeholder scaffolding
   * above, this is the REAL supplied portrait — a photographic asset, not a
   * generated one. Exactly ONE authoritative portrait exists, so exactly one
   * canonical reference is seeded; no Selfie/Mirror shots are fabricated to
   * fill the usual three slots.
   */
  {
    id: '5f0c6b10-2222-4000-8000-000000000401',
    characterId: MARIA_ID,
    visualIdentityId: MARIA_IDENTITY,
    kind: 'reference',
    status: 'approved',
    isCanonical: true,
    position: 1,
    storageKey: MARIA_PORTRAIT_URL,
    contentRating: 'sfw',
    provenance: {
      source: 'approved-site-content',
      productName: 'Maria',
      sourceName: 'Sigal',
      sourceFile: 'Content/Site/Sigal.jpg',
      shippedAs: MARIA_PORTRAIT_URL,
      note: 'US-88 approved authoritative portrait — supplied real media, copied byte-identical and never modified. Not generated, no provider call, no spend.',
      shot: 'Portrait',
    },
  },
];
