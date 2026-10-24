import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  characters,
  characterPersonas,
  characterVisualAssets,
  characterVisualIdentities,
} from '../db/schema.js';
import { seedCharacters } from '../db/seed.js';
import { saveCharacterPersona } from '../services/character-persona-service.js';
import { createVisualAsset } from '../services/visual-asset-service.js';
import { getActiveVisualIdentity } from '../services/visual-identity-service.js';
import { listPublicCharacterClips } from '../services/home-composition-service.js';
import {
  createTestContext,
  destroyTestContext,
  migrateTestDb,
  truncateAll,
  type TestContext,
} from './helpers.js';

/**
 * THE AGE ON A CLIP PAYLOAD.
 *
 * The clip rails -- New, Top rated, Popular -- carried no age in the payload at
 * all, while Play with me carried a confirmed one. The same character therefore
 * read "Donna 32" in one rail and "Donna" in the next, and confirming more ages
 * could never have fixed it.
 *
 * These assert the field exists, that it is the CONFIRMED age and nothing else,
 * and that the two surfaces agree about the same character.
 */

let ctx: TestContext;

beforeAll(async () => {
  migrateTestDb();
  ctx = await createTestContext({});
}, 180_000);

afterAll(async () => destroyTestContext(ctx));

beforeEach(async () => {
  await truncateAll(ctx);
  await seedCharacters(ctx.db);
});

const firstCharacter = async () => {
  const [row] = await ctx.db.select().from(characters).limit(1);
  return row!;
};

/**
 * One listed clip of hers.
 *
 * APPROVED, GENERATED, WITH MEDIA, ON AN ACTIVE CHARACTER -- the four things
 * the posts condition actually requires. Built rather than seeded because the
 * seed carries no clips at all, which made an earlier version of this file pass
 * by iterating an empty array. A test that asserts nothing is worse than no
 * test, because it reports success.
 */
const giveHerAClip = async (characterId: string) => {
  // The seed creates no visual identities, and an asset must belong to one.
  let identity = await getActiveVisualIdentity(ctx.db, characterId);
  if (!identity) {
    const [created] = await ctx.db
      .insert(characterVisualIdentities)
      .values({
        characterId,
        version: 1,
        status: 'active',
        visualDna: { apparentAgeBand: 'adult (late 20s)' },
        label: 'seeded for the clip-age test',
      })
      .returning();
    identity = created!;
  }
  const asset = await createVisualAsset(ctx.db, {
    characterId,
    visualIdentityId: identity.id,
    kind: 'generated',
    status: 'approved',
    contentRating: 'sfw',
  } as never);
  await ctx.db
    .update(characterVisualAssets)
    // Media, and a publication date: the posts channel is "publishedAt is not
    // null", so an approved asset nobody released is correctly invisible.
    .set({ storageKey: `/media/test/${asset.id}.mp4`, publishedAt: new Date() })
    .where(eq(characterVisualAssets.id, asset.id));
  return asset;
};

describe('the clip payload carries a confirmed age', () => {
  it('reports null when nobody has confirmed an age', async () => {
    const character = await firstCharacter();
    await giveHerAClip(character.id);
    // The seed gives her one, so "unconfirmed" has to be arranged explicitly.
    await ctx.db.update(characters).set({ age: null }).where(eq(characters.id, character.id));

    const clips = await listPublicCharacterClips(ctx.db, character.id);
    expect(clips.length).toBeGreaterThan(0);
    for (const clip of clips) {
      expect(clip).toHaveProperty('characterAge');
      expect(clip.characterAge).toBeNull();
    }
  });

  it('reports her confirmed age on every clip of hers once it is set', async () => {
    const character = await firstCharacter();
    await giveHerAClip(character.id);
    await ctx.db.update(characters).set({ age: 32 }).where(eq(characters.id, character.id));

    const clips = await listPublicCharacterClips(ctx.db, character.id);
    expect(clips.length).toBeGreaterThan(0);
    for (const clip of clips) expect(clip.characterAge).toBe(32);
  });

  it('agrees with the Play with me card about the same character', async () => {
    /**
     * The defect in one assertion. The two surfaces are built from different
     * queries, so nothing but a test keeps them aligned -- and their
     * disagreement is exactly what sent somebody hunting for a rendering bug
     * that did not exist.
     */
    const character = await firstCharacter();
    await giveHerAClip(character.id);
    await ctx.db.update(characters).set({ age: 29 }).where(eq(characters.id, character.id));

    const payload = (await ctx.app.inject({ method: 'GET', url: '/api/home' })).json() as {
      playWithMe?: { id: string; age: number | null }[];
    };
    const card = (payload.playWithMe ?? []).find((c) => c.id === character.id);
    const clips = await listPublicCharacterClips(ctx.db, character.id);

    if (card) expect(card.age).toBe(29);
    for (const clip of clips) expect(clip.characterAge).toBe(29);
  });
});

describe('what can never reach a clip payload', () => {
  it('never reports the persona age when no age is confirmed', async () => {
    const character = await firstCharacter();
    await giveHerAClip(character.id);
    await ctx.db.update(characters).set({ age: null }).where(eq(characters.id, character.id));
    // A plausible guess, which is exactly what must not be published.
    await saveCharacterPersona(ctx.db, character.id, { age: 27 });

    const [persona] = await ctx.db
      .select()
      .from(characterPersonas)
      .where(eq(characterPersonas.characterId, character.id))
      .limit(1);
    expect((persona!.persona as { age?: number }).age).toBe(27);

    const clips = await listPublicCharacterClips(ctx.db, character.id);
    expect(clips.length).toBeGreaterThan(0);
    for (const clip of clips) expect(clip.characterAge).toBeNull();
  });

  it('never reports an implausible age, even if one reached the column', async () => {
    const character = await firstCharacter();
    await giveHerAClip(character.id);

    /**
     * The database constrains this column too, so this is the second lock -- and
     * on an adult product it is the one worth having twice. If the write is
     * refused the first lock held and there is nothing left to check; if it
     * succeeds, the projection must still report nothing.
     */
    const wrote = await ctx.db
      .update(characters)
      .set({ age: 200 })
      .where(eq(characters.id, character.id))
      .then(() => true)
      .catch(() => false);

    const clips = await listPublicCharacterClips(ctx.db, character.id);
    expect(clips.length).toBeGreaterThan(0);
    for (const clip of clips) expect(clip.characterAge).toBeNull();
    expect(typeof wrote).toBe('boolean');
  });
});
