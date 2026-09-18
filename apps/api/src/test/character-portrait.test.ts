import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
  characters,
  characterVisualAssets,
  type CharacterVisualAssetRow,
} from '../db/schema.js';
import { SEED_CHARACTERS } from '../db/seed-data.js';
import { seedCharacters, seedVisualIdentities } from '../db/seed.js';
import {
  choosePortrait,
  portraitUrlOf,
  resolveCharacterPortrait,
} from '../services/character-portrait.js';
import {
  createCharacter,
  getActiveCharacterById,
  listActiveCharacters,
} from '../services/character-service.js';
import { uploadLibraryAsset } from '../services/library-upload-service.js';
import {
  approveVisualAsset,
  archiveVisualAsset,
  rejectVisualAsset,
  unarchiveVisualAsset,
} from '../services/visual-asset-service.js';
import {
  activateVisualIdentityVersion,
  createVisualIdentityVersion,
  getActiveVisualIdentity,
} from '../services/visual-identity-service.js';
import {
  createTestContext,
  destroyTestContext,
  extractSessionCookie,
  migrateTestDb,
  testEnv,
  truncateAll,
  type TestContext,
} from './helpers.js';

/**
 * P0.2 -- ONE SOURCE OF TRUTH FOR A CHARACTER'S PORTRAIT.
 *
 * `characters.profile_image` used to be a second, independently writable
 * channel for "what this character looks like", and every surface decided for
 * itself whether to believe it or the identity model. It is now a DEPRECATED
 * FALLBACK, consulted in exactly one function, after the canonical asset model
 * has had its say.
 *
 * The load-bearing tests here are the two that could silently regress:
 *
 *   - a character whose canonical reference predates stored media (the seeded
 *     roster, and anything like it in production) must keep the portrait she
 *     shows today rather than losing it to an initial-letter tile;
 *   - approving, rejecting, archiving and re-activating must mean exactly what
 *     P0.3-P0.9 made them mean. A portrait is a read of that model, never a
 *     licence to relax it.
 */

const LUNA = SEED_CHARACTERS.find((c) => c.name === 'luna')!;
const MARIA = SEED_CHARACTERS.find((c) => c.name === 'maria')!;
const STORAGE = { storageDir: testEnv.media.storageDir, servePathPrefix: '/admin/content/uploads' };
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const DNA = { apparentAgeBand: 'adult', hair: 'dark' };

let on: TestContext;
let cookie: string;

beforeAll(async () => {
  migrateTestDb();
  on = await createTestContext();
});
afterAll(async () => destroyTestContext(on));
beforeEach(async () => {
  await truncateAll(on);
  await seedCharacters(on.db);
  await seedVisualIdentities(on.db);
  const email = `portrait-${randomUUID()}@example.com`;
  const res = await on.app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email, password: 'portrait-12' },
  });
  const c = extractSessionCookie(res)!;
  await on.pool.query(`UPDATE users SET role = 'admin' WHERE email = $1`, [email]);
  cookie = `${c.name}=${c.value}`;
});

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/** A reference upload bound to whatever version is active now. Pending. */
async function reference(characterId: string, identityId?: string) {
  return uploadLibraryAsset(on.db, STORAGE, {
    characterId,
    mimeType: 'image/png',
    bytes: PNG,
    originalName: 'reference.png',
    kind: 'reference',
    ...(identityId ? { visualIdentityId: identityId } : {}),
  });
}

/** An approved canonical reference -- the thing a portrait is made of. */
async function canonicalReference(characterId: string, identityId?: string) {
  const created = await reference(characterId, identityId);
  return approveVisualAsset(on.db, created.id);
}

/** Approved CONTENT, which must never be mistaken for an identity portrait. */
async function approvedContent(characterId: string) {
  const created = await uploadLibraryAsset(on.db, STORAGE, {
    characterId,
    mimeType: 'image/png',
    bytes: PNG,
    originalName: 'content.png',
  });
  return approveVisualAsset(on.db, created.id);
}

const assetRoute = (assetId: string) => `/api/media/assets/${assetId}/file`;

const columnOf = async (characterId: string) => {
  const [row] = await on.db
    .select({ profileImage: characters.profileImage })
    .from(characters)
    .where(eq(characters.id, characterId));
  return row!.profileImage;
};

const publicDetail = async (characterId: string) => {
  const res = await on.app.inject({ method: 'GET', url: `/api/characters/${characterId}` });
  expect(res.statusCode).toBe(200);
  return res.json() as { id: string; profileImage: string | null };
};

const adminDetail = async (characterId: string) => {
  const res = await on.app.inject({
    method: 'GET',
    url: `/admin/characters/${characterId}`,
    headers: { cookie },
  });
  expect(res.statusCode).toBe(200);
  return (res.json() as { character: { id: string; profileImage: string | null } }).character;
};

/** Make a character publishable enough to appear on the public list. */
const activate = (characterId: string) =>
  on.db.update(characters).set({ status: 'active' }).where(eq(characters.id, characterId));

/* ================================================================== *
 * 1. Creating a character
 * ================================================================== */

describe('creating a character never establishes the legacy column', () => {
  it('ignores profileImage in the create body -- the column stays null', async () => {
    // Shaped exactly as a route body arrives, so the field genuinely reaches
    // the service the way it used to. It used to be accepted and written.
    const body: Record<string, unknown> = {
      name: `newbie-${randomUUID().slice(0, 8)}`,
      displayName: 'Newbie',
      shortBio: 'A new character.',
      personality: 'Curious.',
      conversationStyle: 'Warm.',
      systemPrompt: 'You are Newbie.',
      profileImage: 'https://attacker.example/portrait.png',
    };
    const created = await createCharacter(on.db, body as never);

    expect(await columnOf(created.id)).toBeNull();
    expect(created.profileImage).toBeNull();
  });

  it('the same is true through the admin route', async () => {
    const res = await on.app.inject({
      method: 'POST',
      url: '/admin/characters',
      headers: { cookie },
      payload: {
        name: `routed-${randomUUID().slice(0, 8)}`,
        displayName: 'Routed',
        shortBio: 'Bio.',
        personality: 'Personality.',
        conversationStyle: 'Style.',
        systemPrompt: 'Prompt.',
        profileImage: '/media/somebody/else.png',
      },
    });
    expect(res.statusCode).toBe(201);
    const created = res.json() as { id: string; profileImage: string | null };
    expect(created.profileImage).toBeNull();
    expect(await columnOf(created.id)).toBeNull();
  });

  it('a PATCH cannot set it either -- identity changes go through references', async () => {
    const res = await on.app.inject({
      method: 'PATCH',
      url: `/admin/characters/${LUNA.id}`,
      headers: { cookie },
      payload: { profileImage: 'https://attacker.example/portrait.png', shortBio: 'Edited bio.' },
    });
    expect(res.statusCode).toBe(200);
    // The edit that WAS legitimate still landed...
    expect((res.json() as { shortBio: string }).shortBio).toBe('Edited bio.');
    // ...and the one that would have forked the identity did not.
    expect(await columnOf(LUNA.id)).toBe(LUNA.profileImage);
  });

  it('a character created with no media has no portrait at all', async () => {
    const created = await createCharacter(on.db, {
      name: `bare-${randomUUID().slice(0, 8)}`,
      displayName: 'Bare',
      shortBio: 'Bio.',
      personality: 'Personality.',
      conversationStyle: 'Style.',
      systemPrompt: 'Prompt.',
    });
    expect(created.profileImage).toBeNull();
    expect((await resolveCharacterPortrait(on.db, { id: created.id, profileImage: null })).source).toBe(
      'none',
    );
  });
});

/* ================================================================== *
 * 2. Retrieval: the canonical asset answers
 * ================================================================== */

describe('the portrait comes from the active identity\'s canonical reference', () => {
  it('resolves to the opaque media route for that asset', async () => {
    const asset = await canonicalReference(MARIA.id);
    const portrait = await resolveCharacterPortrait(on.db, {
      id: MARIA.id,
      profileImage: MARIA.profileImage ?? null,
    });
    expect(portrait).toEqual({ url: assetRoute(asset.id), source: 'canonical-reference' });
  });

  it('prefers the FIRST canonical reference, by the shared canonical order', async () => {
    const first = await canonicalReference(MARIA.id);
    const second = await canonicalReference(MARIA.id);
    await on.db
      .update(characterVisualAssets)
      .set({ position: 1 })
      .where(eq(characterVisualAssets.id, second.id));
    await on.db
      .update(characterVisualAssets)
      .set({ position: 2 })
      .where(eq(characterVisualAssets.id, first.id));

    const portrait = await resolveCharacterPortrait(on.db, { id: MARIA.id, profileImage: null });
    expect(portrait.url).toBe(assetRoute(second.id));
  });

  it('outranks the legacy column, which is still populated underneath', async () => {
    const asset = await canonicalReference(MARIA.id);
    expect(await columnOf(MARIA.id)).toBe(MARIA.profileImage);
    expect((await publicDetail(MARIA.id)).profileImage).toBe(assetRoute(asset.id));
  });
});

/* ================================================================== *
 * 3 & 4. The payloads
 * ================================================================== */

describe('public and admin payloads carry the same resolved portrait', () => {
  it('/api/characters and /api/characters/:id agree with each other', async () => {
    const asset = await canonicalReference(MARIA.id);
    const list = await listActiveCharacters(on.db);
    const maria = list.find((c) => c.id === MARIA.id)!;
    expect(maria.profileImage).toBe(assetRoute(asset.id));
    expect((await publicDetail(MARIA.id)).profileImage).toBe(maria.profileImage);
    expect((await getActiveCharacterById(on.db, MARIA.id))!.profileImage).toBe(maria.profileImage);
  });

  it('the admin payload agrees with the public one -- one portrait, not two', async () => {
    const asset = await canonicalReference(MARIA.id);
    expect((await adminDetail(MARIA.id)).profileImage).toBe(assetRoute(asset.id));

    const listRes = await on.app.inject({
      method: 'GET',
      url: '/admin/characters',
      headers: { cookie },
    });
    const row = (listRes.json() as Array<{ id: string; profileImage: string | null }>).find(
      (c) => c.id === MARIA.id,
    )!;
    expect(row.profileImage).toBe(assetRoute(asset.id));
  });

  it('the chat conversation header carries it too', async () => {
    const asset = await canonicalReference(MARIA.id);
    const start = await on.app.inject({
      method: 'POST',
      url: '/api/conversations',
      headers: { cookie },
      payload: { characterId: MARIA.id },
    });
    expect(start.statusCode).toBeLessThan(300);
    const conversationId = (start.json() as { id: string }).id;
    const res = await on.app.inject({
      method: 'GET',
      url: `/api/conversations/${conversationId}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { character: { profileImage: string } }).character.profileImage).toBe(
      assetRoute(asset.id),
    );
  });

  it('leaks no storage key or filesystem path, whichever source answered', async () => {
    await canonicalReference(MARIA.id);
    const payload = (await on.app.inject({ method: 'GET', url: '/api/characters' })).payload;
    expect(payload).not.toContain('storageKey');
    expect(payload).not.toContain('storagePath');
    expect(payload).not.toContain(testEnv.media.storageDir);
    expect(payload).not.toContain('/admin/content/uploads');
  });
});

/* ================================================================== *
 * 5. The legacy fallback -- what production actually looks like
 * ================================================================== */

describe('a character still relying on the legacy column keeps her portrait', () => {
  /**
   * THE SEEDED ROSTER IS THE REAL CASE. Their canonical references carry web
   * DISPLAY LOCATORS (placehold.co, /media/maria/portrait.png) rather than
   * stored media, so `resolveMediaFile` refuses them as `outside_storage_root`
   * and the media route cannot serve their bytes. Advertising an id-keyed route
   * for one of those rows would hand every browser a 404 and replace a live
   * portrait with an initial-letter tile.
   */
  it('a seeded character falls back rather than advertising a 404', async () => {
    const portrait = await resolveCharacterPortrait(on.db, {
      id: LUNA.id,
      profileImage: LUNA.profileImage ?? null,
    });
    expect(portrait).toEqual({ url: LUNA.profileImage, source: 'legacy-profile-image' });
    expect((await publicDetail(LUNA.id)).profileImage).toBe(LUNA.profileImage);
  });

  it('every active seeded character still has a portrait on the public list', async () => {
    const list = await listActiveCharacters(on.db);
    expect(list.length).toBeGreaterThan(0);
    for (const character of list) {
      expect({ name: character.name, hasPortrait: Boolean(character.profileImage) }).toEqual({
        name: character.name,
        hasPortrait: true,
      });
    }
  });

  it('a real upload takes over from the legacy value the moment it is approved', async () => {
    const before = await publicDetail(LUNA.id);
    expect(before.profileImage).toBe(LUNA.profileImage);

    const created = await reference(LUNA.id);
    // PENDING is not a portrait: approval is a separate act (P0.4).
    expect((await publicDetail(LUNA.id)).profileImage).toBe(LUNA.profileImage);

    await approveVisualAsset(on.db, created.id);
    expect((await publicDetail(LUNA.id)).profileImage).toBe(assetRoute(created.id));
  });

  it('an empty column reads as no portrait, not as an empty-string image', async () => {
    await on.db.update(characters).set({ profileImage: '   ' }).where(eq(characters.id, LUNA.id));
    expect((await publicDetail(LUNA.id)).profileImage).toBeNull();
  });
});

/* ================================================================== *
 * 6. Identity change
 * ================================================================== */

describe('changing the active identity version changes the portrait with it', () => {
  it('activating v2 hands the portrait to v2\'s reference', async () => {
    const v1Asset = await canonicalReference(MARIA.id);
    expect((await publicDetail(MARIA.id)).profileImage).toBe(assetRoute(v1Asset.id));

    const v2 = await createVisualIdentityVersion(on.db, MARIA.id, DNA);
    const v2Asset = await canonicalReference(MARIA.id, v2.id);
    // Not active yet: a draft version does not speak for the character.
    expect((await publicDetail(MARIA.id)).profileImage).toBe(assetRoute(v1Asset.id));

    await activateVisualIdentityVersion(on.db, v2.id);
    expect((await publicDetail(MARIA.id)).profileImage).toBe(assetRoute(v2Asset.id));
  });

  it('the retired version\'s reference survives -- it just stops answering (P0.6)', async () => {
    const v1Asset = await canonicalReference(MARIA.id);
    const v1 = (await getActiveVisualIdentity(on.db, MARIA.id))!;
    const v2 = await createVisualIdentityVersion(on.db, MARIA.id, DNA);
    await canonicalReference(MARIA.id, v2.id);
    await activateVisualIdentityVersion(on.db, v2.id);

    const [row] = await on.db
      .select()
      .from(characterVisualAssets)
      .where(eq(characterVisualAssets.id, v1Asset.id));
    expect(row!.status).toBe('approved');
    expect(row!.isCanonical).toBe(true);
    expect(row!.visualIdentityId).toBe(v1.id);
  });

  it('a version with no reference of its own falls back rather than inventing one', async () => {
    await canonicalReference(MARIA.id);
    const v2 = await createVisualIdentityVersion(on.db, MARIA.id, DNA);
    await activateVisualIdentityVersion(on.db, v2.id);
    // v1's reference belongs to v1. v2 has none, so the deprecated column
    // answers -- exactly the state a fresh redesign is in before its images
    // are uploaded.
    expect((await publicDetail(MARIA.id)).profileImage).toBe(MARIA.profileImage);
  });
});

/* ================================================================== *
 * 7. The P0.3-P0.9 lifecycle is not relaxed by a portrait
 * ================================================================== */

describe('a portrait is a READ of the lifecycle, never an exception to it', () => {
  it('a pending reference is not a portrait (P0.4: uploads do not bypass review)', async () => {
    await reference(MARIA.id);
    const portrait = await resolveCharacterPortrait(on.db, { id: MARIA.id, profileImage: null });
    expect(portrait.source).toBe('none');
  });

  it('a rejected reference is not a portrait', async () => {
    const created = await reference(MARIA.id);
    await rejectVisualAsset(on.db, created.id);
    expect(
      (await resolveCharacterPortrait(on.db, { id: MARIA.id, profileImage: null })).source,
    ).toBe('none');
  });

  it('approved CONTENT is never promoted to a portrait -- a post is not an identity', async () => {
    const content = await approvedContent(MARIA.id);
    expect(content.status).toBe('approved');
    expect(content.isCanonical).toBe(false);
    expect(
      (await resolveCharacterPortrait(on.db, { id: MARIA.id, profileImage: null })).source,
    ).toBe('none');
  });

  it('archiving and unarchiving CONTENT leaves the portrait untouched', async () => {
    const asset = await canonicalReference(MARIA.id);
    const content = await approvedContent(MARIA.id);
    const expected = assetRoute(asset.id);

    await archiveVisualAsset(on.db, content.id);
    expect((await publicDetail(MARIA.id)).profileImage).toBe(expected);

    await unarchiveVisualAsset(on.db, content.id);
    expect((await publicDetail(MARIA.id)).profileImage).toBe(expected);
  });

  it('an inactive character is still not reachable publicly, portrait or not', async () => {
    await canonicalReference(MARIA.id);
    await on.db.update(characters).set({ status: 'inactive' }).where(eq(characters.id, MARIA.id));
    const res = await on.app.inject({ method: 'GET', url: `/api/characters/${MARIA.id}` });
    expect(res.statusCode).toBe(404);
    await activate(MARIA.id);
  });
});

/* ================================================================== *
 * 8. The two paths, stated as a rule rather than observed in passing
 * ================================================================== */

/**
 * The database tests above show the resolver behaving correctly on real rows.
 * These state the CONTRACT directly, on synthetic ones, so each clause has a
 * test that fails for exactly one reason:
 *
 *   1. the active identity's canonical reference is consulted first;
 *   2. it is used when this deployment can serve it;
 *   3. `characters.profile_image` answers ONLY when it cannot;
 *   4. the column is never authoritative -- it cannot outrank a servable
 *      reference, and it is never the reason a portrait exists when the
 *      canonical model has a usable answer.
 */
describe('the fallback contract, clause by clause', () => {
  const asset = (over: Partial<CharacterVisualAssetRow>): CharacterVisualAssetRow =>
    ({
      id: 'asset-1',
      characterId: 'c1',
      visualIdentityId: 'v1',
      kind: 'reference',
      origin: 'manual',
      status: 'approved',
      isCanonical: true,
      position: 1,
      storageKey: null,
      provenance: {},
      contentRating: 'sfw',
      requirementKey: null,
      approvedBy: null,
      approvedAt: null,
      publishedAt: null,
      archivedAt: null,
      archivedBy: null,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
      ...over,
    }) as CharacterVisualAssetRow;

  /** An operator's upload: a route-shaped key plus a real path in provenance. */
  const stored = (id: string) =>
    asset({
      id,
      storageKey: `/admin/content/uploads/${id}/file`,
      provenance: { source: 'manual-upload', storagePath: '/app/var/media/c1/uploads/x.png' },
    });

  it('2. a servable canonical reference wins, as an opaque route', () => {
    expect(choosePortrait([stored('a')], '/media/legacy.png')).toEqual({
      url: '/api/media/assets/a/file',
      source: 'canonical-reference',
    });
  });

  it('3. an http display locator cannot be served, so the legacy column answers', () => {
    const seeded = asset({ storageKey: 'https://placehold.co/640x800?text=Luna' });
    expect(portraitUrlOf(seeded)).toBeNull();
    expect(choosePortrait([seeded], 'https://placehold.co/512x512?text=Luna')).toEqual({
      url: 'https://placehold.co/512x512?text=Luna',
      source: 'legacy-profile-image',
    });
  });

  it('3. a /media web path is the same case -- Maria, exactly as production has her', () => {
    const seeded = asset({ storageKey: '/media/maria/portrait.png' });
    expect(portraitUrlOf(seeded)).toBeNull();
    expect(choosePortrait([seeded], '/media/maria/portrait.png')).toEqual({
      url: '/media/maria/portrait.png',
      source: 'legacy-profile-image',
    });
  });

  it('3. an unservable reference with no legacy value invents nothing', () => {
    const seeded = asset({ storageKey: 'https://placehold.co/640x800' });
    expect(choosePortrait([seeded], null)).toEqual({ url: null, source: 'none' });
  });

  it('4. the column never outranks a reference that can be served', () => {
    const unservable = asset({ id: 'seed', storageKey: 'https://placehold.co/1' });
    const real = stored('real');
    // Even with the unservable row FIRST in canonical order, the answer is the
    // reference -- not the column sitting underneath both.
    expect(choosePortrait([unservable, real], '/media/legacy.png')).toEqual({
      url: '/api/media/assets/real/file',
      source: 'canonical-reference',
    });
  });

  it('4. a raw storage key is never emitted, whichever branch answers', () => {
    // The generated convention puts an absolute server path in storage_key.
    // It resolves to the opaque route, never to the path itself.
    const generated = asset({ id: 'gen', storageKey: '/app/var/media/c1/generated/j.png' });
    expect(portraitUrlOf(generated)).toBe('/api/media/assets/gen/file');
    expect(portraitUrlOf(asset({ storageKey: null }))).toBeNull();
  });
});
