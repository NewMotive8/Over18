import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { conversations, users } from '../db/schema.js';
import { SEED_CHARACTERS, SEED_VISUAL_ASSETS } from '../db/seed-data.js';
import { seedCharacters, seedVisualIdentities } from '../db/seed.js';
import { createMockProviders } from '../media-pipeline/mock-adapter.js';
import {
  assetActionsOf,
  checkTransition,
  type AssetAction,
  type TransitionSubject,
} from '../services/asset-lifecycle.js';
import { uploadLibraryAsset } from '../services/library-upload-service.js';
import { createDeterministicMediaSelector } from '../services/message-media-service.js';
import { computeRequirementStatus } from '../services/requirement-status-service.js';
import { createVisualAsset, getVisualAssetById } from '../services/visual-asset-service.js';
import { getActiveVisualIdentity } from '../services/visual-identity-service.js';
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
 * P0.4 -- the moderation workflow and the ARCHIVED state.
 *
 *   Ingest -> Pending review -> Approved | Rejected
 *   Approved (released or not) -> Archived -> (unarchive) Approved
 *
 * Every test drives the REAL admin routes and reads REAL public routes; the
 * public-surface checks carry a control that proves each surface was showing
 * the asset before it was hidden, so an absence is never an empty page.
 */

const LUNA = SEED_CHARACTERS.find((c) => c.name === 'luna')!;
const TOKEN = testEnv.media.internalToken!;
const FIXTURES = join(testEnv.media.storageDir, '__moderation_fixtures__');
const IMAGE_FIXTURE = join(FIXTURES, 'seed.jpg');
const VIDEO_FIXTURE = join(FIXTURES, 'seed.mp4');
const STORAGE = { storageDir: testEnv.media.storageDir, servePathPrefix: '/admin/content/uploads' };

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const MP4 = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x18]),
  Buffer.from('ftypmp42'),
  Buffer.from([0x00, 0x00, 0x00, 0x00]),
  Buffer.from('mp42isom'),
  Buffer.alloc(32, 0x21),
]);

let on: TestContext;
let cookie: string;
let adminId: string;

beforeAll(async () => {
  migrateTestDb();
  mkdirSync(FIXTURES, { recursive: true });
  writeFileSync(IMAGE_FIXTURE, Buffer.from('fake-jpeg-bytes'));
  writeFileSync(VIDEO_FIXTURE, Buffer.from('fake-mp4-bytes'));
  on = await createTestContext({
    mediaProviders: createMockProviders({ imageFixturePath: IMAGE_FIXTURE, videoFixturePath: VIDEO_FIXTURE }),
  });
});
afterAll(async () => {
  await destroyTestContext(on);
  rmSync(FIXTURES, { recursive: true, force: true });
});
beforeEach(async () => {
  await truncateAll(on);
  await seedCharacters(on.db);
  await seedVisualIdentities(on.db);
  const email = `moderation-${randomUUID()}@example.com`;
  const res = await on.app.inject({ method: 'POST', url: '/api/auth/register', payload: { email, password: 'moderation-1' } });
  const c = extractSessionCookie(res)!;
  await on.pool.query(`UPDATE users SET role = 'admin' WHERE email = $1`, [email]);
  adminId = (await on.pool.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [email])).rows[0]!.id;
  cookie = `${c.name}=${c.value}`;
});

/* ------------------------------------------------------------------ *
 * Helpers -- all through the real routes
 * ------------------------------------------------------------------ */

function multipart(fields: Record<string, string>, file: { filename: string; contentType: string; bytes: Buffer }) {
  const boundary = '----moderation5555';
  let head = '';
  for (const [name, value] of Object.entries(fields)) {
    head += `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
  }
  head +=
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.filename}"\r\n` +
    `Content-Type: ${file.contentType}\r\n\r\n`;
  return {
    payload: Buffer.concat([Buffer.from(head), file.bytes, Buffer.from(`\r\n--${boundary}--\r\n`)]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

const VIDEO = { filename: 'clip.mp4', contentType: 'video/mp4', bytes: MP4 };
const IMAGE = { filename: 'shot.png', contentType: 'image/png', bytes: PNG };

type View = {
  assetId: string;
  status: string;
  workflow: string;
  role: string;
  actions: AssetAction[];
  publishedAt: string | null;
  archivedAt: string | null;
  approvedAt: string | null;
};

async function uploadVia(fields: Record<string, string>, file = VIDEO): Promise<View> {
  const { payload, headers } = multipart({ characterId: LUNA.id, ...fields }, file);
  const res = await on.app.inject({ method: 'POST', url: '/admin/content/uploads', headers: { ...headers, cookie }, payload });
  expect(res.statusCode).toBe(201);
  return res.json();
}

const shelf = (section: 'regular' | 'explicit' | 'chat', file = VIDEO) =>
  uploadVia({ section, contentRating: section === 'explicit' ? 'explicit' : 'sfw' }, file);

async function act(assetId: string, verb: string) {
  return on.app.inject({ method: 'POST', url: `/admin/content/assets/${assetId}/${verb}`, headers: { cookie } });
}

async function actOk(assetId: string, verb: string): Promise<View> {
  const res = await act(assetId, verb);
  expect({ verb, status: res.statusCode, body: res.statusCode === 200 ? null : res.json() }).toEqual({ verb, status: 200, body: null });
  return res.json();
}

async function refused(assetId: string, verb: string): Promise<string> {
  const res = await act(assetId, verb);
  expect({ verb, status: res.statusCode }).toEqual({ verb, status: 409 });
  expect(res.json().error).toBe('invalid_transition');
  return res.json().message;
}

const row = async (id: string) => (await getVisualAssetById(on.db, id))!;
const get = (url: string) => on.app.inject({ method: 'GET', url });
const adminGet = (url: string) => on.app.inject({ method: 'GET', url, headers: { cookie } });
const ids = (list: Array<{ assetId?: string; id?: string }>) => list.map((a) => a.assetId ?? a.id);

async function reviewQueueIds() {
  return ids((await adminGet('/admin/content/review')).json().assets);
}
async function libraryIds(status?: string) {
  return ids((await adminGet(`/admin/content/library${status ? `?status=${status}` : ''}`)).json().assets);
}
async function postsIds() {
  return ids((await get(`/api/characters/${LUNA.id}/clips`)).json().clips);
}

/** Puts an approved content clip EVERYWHERE a public reader can find it. */
async function placeEverywhere(assetId: string) {
  const category = (
    await on.pool.query<{ id: string }>(
      `INSERT INTO app_categories (slug, name, enabled, home_published) VALUES ('mod-cat', 'Moderation', true, true) RETURNING id`,
    )
  ).rows[0]!.id;
  await on.pool.query('INSERT INTO app_category_assets (category_id, asset_id, position) VALUES ($1, $2, 0)', [category, assetId]);
  await on.pool.query('INSERT INTO home_hero_clips (asset_id, position) VALUES ($1, 0)', [assetId]);
  const keyword = (
    await on.pool.query<{ id: string }>(`INSERT INTO content_keywords (key, label) VALUES ('modkey', 'modkey') RETURNING id`)
  ).rows[0]!.id;
  const discovery = (
    await on.pool.query<{ id: string }>(
      `INSERT INTO discovery_categories (slug, name, enabled) VALUES ('mod-disc', 'Moderation', true) RETURNING id`,
    )
  ).rows[0]!.id;
  await on.pool.query('INSERT INTO discovery_category_keywords (discovery_category_id, keyword_id) VALUES ($1, $2)', [discovery, keyword]);
  await on.pool.query('INSERT INTO asset_keywords (asset_id, keyword_id) VALUES ($1, $2)', [assetId, keyword]);
}

const PUBLIC_READERS = [
  '/api/home',
  `/api/characters/${LUNA.id}/clips`,
  '/api/browse/clips',
  '/api/browse/characters',
  '/api/play-with-me',
  '/api/discovery/clips',
  '/api/discovery/clips?category=mod-disc',
];

async function publicReadersShowing(assetId: string) {
  const showing: string[] = [];
  if ((await get(`/api/media/assets/${assetId}/file`)).statusCode === 200) showing.push('media');
  for (const url of PUBLIC_READERS) {
    const res = await get(url);
    expect({ url, status: res.statusCode }).toEqual({ url, status: 200 });
    if (res.payload.includes(assetId)) showing.push(url);
  }
  return showing;
}

/* ================================================================== *
 * 1-3. Uploads start in review
 * ================================================================== */

describe('uploads start in review', () => {
  it('1. a REGULAR shelf upload is pending review, unapproved, unreleased and not public', async () => {
    const asset = await shelf('regular');
    expect(asset).toMatchObject({ status: 'under_review', workflow: 'pending_review', role: 'content', approvedAt: null, publishedAt: null });
    expect(asset.actions).toEqual(['approve', 'reject']);
    expect(await reviewQueueIds()).toContain(asset.assetId);
    expect(await libraryIds()).not.toContain(asset.assetId);
    expect(await publicReadersShowing(asset.assetId)).toEqual([]);
  });

  it('2. an EXPLICIT shelf upload is pending review too, and keeps its rating', async () => {
    const asset = await shelf('explicit');
    expect(asset).toMatchObject({ status: 'under_review', workflow: 'pending_review', approvedAt: null, publishedAt: null });
    expect((await row(asset.assetId)).contentRating).toBe('explicit');
    expect(await reviewQueueIds()).toContain(asset.assetId);
    expect(await publicReadersShowing(asset.assetId)).toEqual([]);
  });

  it('3. a CHAT upload is pending review, is not sendable until approved, and is never public or releasable', async () => {
    const asset = await shelf('chat', IMAGE);
    expect(asset).toMatchObject({ status: 'under_review', workflow: 'pending_review', role: 'chat', approvedAt: null });
    expect(asset.actions).toEqual(['approve', 'reject']);

    const [viewer] = await on.db.insert(users).values({ email: `v-${randomUUID()}@example.com`, passwordHash: 'x' }).returning();
    const [conv] = await on.db.insert(conversations).values({ userId: viewer!.id, characterId: LUNA.id }).returning();
    const select = () =>
      createDeterministicMediaSelector(testEnv.media.storageDir)(on.db, { characterId: LUNA.id, conversationId: conv!.id, requested: 'image' });
    expect(await select()).toBeNull();

    const approved = await actOk(asset.assetId, 'approve');
    expect(approved.workflow).toBe('approved');
    // Approved chat offers ARCHIVE only: it can never be released.
    expect(approved.actions).toEqual(['archive']);
    expect((await select())?.assetId).toBe(asset.assetId);
    expect(await refused(asset.assetId, 'publish')).toContain('chat media is private');
    expect(await publicReadersShowing(asset.assetId)).toEqual([]);

    // Archive and unarchive follow the same rules, and it stays private throughout.
    await actOk(asset.assetId, 'archive');
    expect(await select()).toBeNull();
    expect(await publicReadersShowing(asset.assetId)).toEqual([]);
    const unarchived = await actOk(asset.assetId, 'unarchive');
    expect(unarchived.workflow).toBe('approved');
    expect((await select())?.assetId).toBe(asset.assetId);
    expect(await publicReadersShowing(asset.assetId)).toEqual([]);
  });
});

/* ================================================================== *
 * 4-8. The transitions
 * ================================================================== */

describe('approve, reject, release, archive, unarchive', () => {
  it('4. APPROVE records the approver and releases nothing', async () => {
    const asset = await shelf('regular');
    const approved = await actOk(asset.assetId, 'approve');
    expect(approved).toMatchObject({ status: 'approved', workflow: 'approved', publishedAt: null });
    expect(approved.actions).toEqual(['publish', 'archive']);
    const stored = await row(asset.assetId);
    expect(stored.approvedBy).toBe(adminId);
    expect(stored.approvedAt).not.toBeNull();
    expect(stored.publishedAt).toBeNull();
    expect(await postsIds()).not.toContain(asset.assetId);
    expect(await reviewQueueIds()).not.toContain(asset.assetId);
    expect(await libraryIds()).toContain(asset.assetId);
    // Approving again changes nothing.
    await actOk(asset.assetId, 'approve');
    expect((await row(asset.assetId)).approvedAt).toEqual(stored.approvedAt);
  });

  it('5. REJECT is not deletion: the row, file and provenance stay, and it cannot be approved back', async () => {
    const asset = await shelf('regular');
    const before = await row(asset.assetId);
    const file = (before.provenance as Record<string, unknown>).storagePath as string;

    const rejected = await actOk(asset.assetId, 'reject');
    expect(rejected).toMatchObject({ status: 'rejected', workflow: 'rejected' });
    expect(rejected.actions).toEqual([]);

    const after = await row(asset.assetId);
    expect(after.provenance).toEqual(before.provenance);
    expect(existsSync(file)).toBe(true);
    expect((await adminGet(`/admin/content/assets/${asset.assetId}`)).statusCode).toBe(200);
    expect(await refused(asset.assetId, 'approve')).toBe('Cannot approve a rejected asset.');
    expect(await refused(asset.assetId, 'archive')).toContain('Rejected content');
    expect(await publicReadersShowing(asset.assetId)).toEqual([]);
  });

  it('6. RELEASE requires approval, is content-only, keeps its original time, and is what puts it on Posts', async () => {
    const asset = await shelf('regular');
    expect(await refused(asset.assetId, 'publish')).toContain('Only approved content');
    await actOk(asset.assetId, 'approve');

    const released = await actOk(asset.assetId, 'publish');
    expect(released.publishedAt).not.toBeNull();
    expect(released.actions).toEqual(['unpublish', 'archive']);
    expect(await postsIds()).toContain(asset.assetId);
    expect((await get(`/api/media/assets/${asset.assetId}/file`)).statusCode).toBe(200);

    const again = await actOk(asset.assetId, 'publish');
    expect(again.publishedAt).toBe(released.publishedAt);

    // A reference cannot be released either.
    const reference = SEED_VISUAL_ASSETS.find((a) => a.characterId === LUNA.id)!;
    expect(await refused(reference.id, 'publish')).toContain('References are identity');
  });

  it('7. ARCHIVE takes an approved or a released item out of use; pending, rejected and references are refused', async () => {
    const unreleased = await shelf('regular');
    await actOk(unreleased.assetId, 'approve');
    const archived = await actOk(unreleased.assetId, 'archive');
    expect(archived).toMatchObject({ status: 'archived', workflow: 'archived' });
    expect(archived.actions).toEqual(['unarchive']);
    const stored = await row(unreleased.assetId);
    expect(stored.archivedAt).not.toBeNull();
    expect(stored.archivedBy).toBe(adminId);

    const released = await shelf('explicit');
    await actOk(released.assetId, 'approve');
    await actOk(released.assetId, 'publish');
    expect((await actOk(released.assetId, 'archive')).workflow).toBe('archived');
    // Idempotent: archiving twice keeps the first archive time.
    const firstTime = (await row(released.assetId)).archivedAt;
    await actOk(released.assetId, 'archive');
    expect((await row(released.assetId)).archivedAt).toEqual(firstTime);

    // Archived content cannot be approved, released or placed.
    expect(await refused(released.assetId, 'approve')).toContain('archived');
    expect(await refused(released.assetId, 'publish')).toContain('Unarchive it first');

    const pending = await shelf('regular');
    expect(await refused(pending.assetId, 'archive')).toContain('Approve or reject it first');
    const rejected = await shelf('regular');
    await actOk(rejected.assetId, 'reject');
    expect(await refused(rejected.assetId, 'archive')).toContain('Rejected content');
    const reference = SEED_VISUAL_ASSETS.find((a) => a.characterId === LUNA.id)!;
    expect(await refused(reference.id, 'archive')).toContain('Identity references are not archived');
    expect((await row(reference.id)).status).toBe('approved');
  });

  it('8. UNARCHIVE returns it to Approved ONLY -- never back in front of customers', async () => {
    const asset = await shelf('regular');
    await actOk(asset.assetId, 'approve');
    await actOk(asset.assetId, 'publish');
    await placeEverywhere(asset.assetId);
    expect(await postsIds()).toContain(asset.assetId);
    await actOk(asset.assetId, 'archive');

    const restored = await actOk(asset.assetId, 'unarchive');
    expect(restored).toMatchObject({ status: 'approved', workflow: 'approved', archivedAt: null, publishedAt: null });
    // Approved and unreleased: Release is on offer again, Take off Posts is not.
    expect(restored.actions).toEqual(['publish', 'archive']);
    expect((await row(asset.assetId)).archivedBy).toBeNull();

    // No customer-facing distribution came back with it.
    expect(await postsIds()).not.toContain(asset.assetId);
    expect(await publicReadersShowing(asset.assetId)).toEqual([]);
    const placements = await on.pool.query(
      `SELECT (SELECT count(*) FROM app_category_assets WHERE asset_id = $1)::int AS categories,
              (SELECT count(*) FROM home_hero_clips WHERE asset_id = $1)::int AS hero,
              (SELECT count(*) FROM asset_keywords WHERE asset_id = $1)::int AS keywords`,
      [asset.assetId],
    );
    expect(placements.rows[0]).toEqual({ categories: 0, hero: 0, keywords: 0 });

    // It is ordinary approved content again: releasing it works, deliberately.
    await actOk(asset.assetId, 'publish');
    expect(await postsIds()).toContain(asset.assetId);

    // Unarchiving an approved item is a no-op; pending and rejected are refused.
    await actOk(asset.assetId, 'unarchive');
    const pending = await shelf('regular');
    expect(await refused(pending.assetId, 'unarchive')).toBe('Only archived content can be unarchived.');
    await actOk(pending.assetId, 'reject');
    expect(await refused(pending.assetId, 'unarchive')).toBe('Only archived content can be unarchived.');
  });

  it('keeps Delete separate: archiving never removes a file, and an archived item can still be deleted', async () => {
    const asset = await shelf('regular');
    await actOk(asset.assetId, 'approve');
    await actOk(asset.assetId, 'archive');
    const file = ((await row(asset.assetId)).provenance as Record<string, unknown>).storagePath as string;
    expect(existsSync(file)).toBe(true);

    const del = await on.app.inject({ method: 'DELETE', url: `/admin/content/assets/${asset.assetId}`, headers: { cookie } });
    expect(del.statusCode).toBe(200);
    expect(await getVisualAssetById(on.db, asset.assetId)).toBeNull();
    expect(existsSync(file)).toBe(false);
  });

  it('answers 404 for an unknown asset on every new verb', async () => {
    for (const verb of ['archive', 'unarchive']) {
      expect((await act(randomUUID(), verb)).statusCode).toBe(404);
      expect((await act('not-a-uuid', verb)).statusCode).toBe(404);
    }
  });
});

/* ================================================================== *
 * 9. Archived content is excluded from public readers
 * ================================================================== */

describe('9. an archived item is hidden from every public reader, and comes back on unarchive', () => {
  it('released, in the Hero, a published category and an enabled discovery keyword -- then archived', async () => {
    const asset = await shelf('regular');
    await actOk(asset.assetId, 'approve');
    await actOk(asset.assetId, 'publish');
    await placeEverywhere(asset.assetId);

    // CONTROL: before archiving, these readers really do show it.
    const before = await publicReadersShowing(asset.assetId);
    for (const reader of ['media', '/api/home', `/api/characters/${LUNA.id}/clips`]) {
      expect(before).toContain(reader);
    }

    await actOk(asset.assetId, 'archive');
    expect(await publicReadersShowing(asset.assetId)).toEqual([]);

    // Admin pickers and queues treat it as out of use as well.
    expect(await reviewQueueIds()).not.toContain(asset.assetId);
    expect(await libraryIds()).not.toContain(asset.assetId);
    expect(await libraryIds('archived')).toContain(asset.assetId);
    const categoryCandidates = (await adminGet(`/admin/app-categories/candidates?characterId=${LUNA.id}`)).json().assets;
    expect(ids(categoryCandidates)).not.toContain(asset.assetId);
    const heroCandidates = (await adminGet('/admin/home/hero/candidates')).json().candidates;
    expect(JSON.stringify(heroCandidates)).not.toContain(asset.assetId);

    // And unarchiving does NOT bring any of it back: the asset is approved
    // again, and every public reader still refuses it until it is released and
    // placed deliberately.
    await actOk(asset.assetId, 'unarchive');
    expect((await row(asset.assetId)).status).toBe('approved');
    expect(await publicReadersShowing(asset.assetId)).toEqual([]);
    expect(await libraryIds()).toContain(asset.assetId);
    const categoryOffers = (await adminGet(`/admin/app-categories/candidates?characterId=${LUNA.id}`)).json().assets;
    expect(ids(categoryOffers)).toContain(asset.assetId);
  });

  it('does not count toward, or wait in triage for, a content requirement', () => {
    const requirement = {
      id: 'r',
      key: 'clips',
      label: 'Clips',
      mediaType: 'video' as const,
      requiredQuantity: 2,
      contentRating: null,
      enabled: true,
      assignPrimaryReference: false,
      position: 0,
      createdAt: '',
      updatedAt: '',
    };
    const base = {
      characterId: LUNA.id,
      visualIdentityId: 'v',
      kind: 'generated' as const,
      origin: 'manual' as const,
      isCanonical: false,
      position: null,
      storageKey: 'k',
      provenance: {},
      contentRating: 'sfw' as const,
      approvedBy: null,
      approvedAt: null,
      publishedAt: null,
      archivedAt: null,
      archivedBy: null,
      createdAt: new Date('2026-08-01'),
      updatedAt: new Date('2026-08-01'),
      mediaType: 'video' as const,
    };
    const status = computeRequirementStatus(LUNA.id, [requirement], [
      { ...base, id: 'approved', status: 'approved', requirementKey: 'clips' },
      { ...base, id: 'archived', status: 'archived', requirementKey: 'clips', archivedAt: new Date() },
      { ...base, id: 'archived-loose', status: 'archived', requirementKey: null, archivedAt: new Date() },
    ]);
    expect(status.entries[0]!.approved).toBe(1);
    expect(status.entries[0]!.assets.map((a) => a.id)).toEqual(['approved']);
    expect(status.triage.map((a) => a.id)).toEqual([]);
  });
});

/* ================================================================== *
 * 10. Archive preserves everything
 * ================================================================== */

describe('10. archiving preserves media, provenance, lineage, approval, release and placements', () => {
  it('changes status and the archive record -- and nothing else -- on a generated, released, placed clip', async () => {
    const generated = await on.app.inject({
      method: 'POST',
      url: '/internal/media/generate-image',
      headers: { 'x-internal-token': TOKEN },
      payload: { characterId: LUNA.id, prompt: 'a calm studio portrait', contentRating: 'sfw' },
    });
    expect(generated.statusCode).toBe(201);
    const assetId = generated.json().asset.id as string;
    await actOk(assetId, 'approve');
    await on.pool.query('UPDATE character_visual_assets SET published_at = now() WHERE id = $1', [assetId]);
    await placeEverywhere(assetId);

    const snapshot = async () => {
      const r = await row(assetId);
      // Everything EXCEPT the three fields archiving is allowed to write.
      const kept: Record<string, unknown> = { ...r };
      for (const field of ['status', 'archivedAt', 'archivedBy', 'updatedAt']) delete kept[field];
      const placements = await on.pool.query(
        `SELECT (SELECT count(*) FROM app_category_assets WHERE asset_id = $1)::int AS categories,
                (SELECT count(*) FROM home_hero_clips WHERE asset_id = $1)::int AS hero,
                (SELECT count(*) FROM asset_keywords WHERE asset_id = $1)::int AS keywords,
                (SELECT count(*) FROM generation_results WHERE asset_id = $1)::int AS generation`,
        [assetId],
      );
      const path = (r.provenance as Record<string, unknown>).storagePath as string;
      return { kept, placements: placements.rows[0], file: existsSync(path) ? readFileSync(path).toString('hex') : null };
    };

    const before = await snapshot();
    expect(before.file).not.toBeNull();
    expect(before.placements).toEqual({ categories: 1, hero: 1, keywords: 1, generation: 1 });

    await actOk(assetId, 'archive');
    const archived = await row(assetId);
    expect(archived.status).toBe('archived');
    expect(await snapshot()).toEqual(before);

    // Unarchiving keeps everything that is NOT distribution, and clears what is.
    await actOk(assetId, 'unarchive');
    const after = await snapshot();
    expect(after.file).toEqual(before.file);
    expect(after.placements).toEqual({ categories: 0, hero: 0, keywords: 0, generation: 1 });
    const restored = await row(assetId);
    expect({
      provenance: restored.provenance,
      identity: restored.visualIdentityId,
      origin: restored.origin,
      kind: restored.kind,
      rating: restored.contentRating,
      requirementKey: restored.requirementKey,
      approvedAt: restored.approvedAt,
      approvedBy: restored.approvedBy,
      storageKey: restored.storageKey,
    }).toEqual({
      provenance: (before.kept as Record<string, unknown>).provenance,
      identity: (before.kept as Record<string, unknown>).visualIdentityId,
      origin: (before.kept as Record<string, unknown>).origin,
      kind: (before.kept as Record<string, unknown>).kind,
      rating: (before.kept as Record<string, unknown>).contentRating,
      requirementKey: (before.kept as Record<string, unknown>).requirementKey,
      approvedAt: (before.kept as Record<string, unknown>).approvedAt,
      approvedBy: (before.kept as Record<string, unknown>).approvedBy,
      storageKey: (before.kept as Record<string, unknown>).storageKey,
    });
    expect(restored.publishedAt).toBeNull();
  });
});

/* ================================================================== *
 * 11. No upload path approves or releases
 * ================================================================== */

/**
 * Every `uploadLibraryAsset(...)` CALL in a source file (the definition is
 * skipped), with the rule each must keep: no release option, and `approve:
 * true` only alongside `kind: 'reference'`. The whole call is taken by
 * balancing parentheses, so a multi-line object is read in full.
 */
function auditUploadCalls(code: string): { calls: number; violations: string[] } {
  const violations: string[] = [];
  let calls = 0;
  let at = code.indexOf('uploadLibraryAsset(');
  while (at !== -1) {
    let depth = 0;
    let end = at + 'uploadLibraryAsset'.length;
    do {
      if (code[end] === '(') depth += 1;
      else if (code[end] === ')') depth -= 1;
      end += 1;
    } while (depth > 0 && end < code.length);
    const call = code.slice(at, end);
    const isDefinition = code.slice(Math.max(0, at - 15), at).includes('function ');
    if (!isDefinition) {
      calls += 1;
      if (/\bpublish\s*:/.test(call)) violations.push(`releases on upload: ${call.slice(0, 60)}`);
      if (/approve\s*:\s*true/.test(call) && !/kind\s*:\s*'reference'/.test(call)) {
        violations.push(`approves content on upload: ${call.slice(0, 60)}`);
      }
    }
    at = code.indexOf('uploadLibraryAsset(', at + 1);
  }
  return { calls, violations };
}

describe('11. no upload or generation path approves or releases anything', () => {
  it('every content route lands pending and unreleased -- even when the request asks otherwise', async () => {
    const landed: View[] = [
      await shelf('regular'),
      await shelf('explicit'),
      await shelf('chat', IMAGE),
      await uploadVia({}, IMAGE), // Content Library
      // Fields a client might try. The route reads none of them.
      await uploadVia({ section: 'regular', approve: 'true', publish: 'true', status: 'approved', kind: 'reference' }),
    ];

    // Content Inbox: upload with no character, then assign.
    const { payload, headers } = multipart({}, IMAGE);
    const inbox = await on.app.inject({ method: 'POST', url: '/admin/content/inbox', headers: { ...headers, cookie }, payload });
    expect(inbox.statusCode).toBe(201);
    const assigned = await on.app.inject({
      method: 'POST',
      url: `/admin/content/inbox/${inbox.json().inboxId}/assign`,
      headers: { cookie },
      payload: { characterId: LUNA.id },
    });
    expect(assigned.statusCode).toBe(200);
    landed.push(assigned.json().asset);

    // Generation.
    const generated = await on.app.inject({
      method: 'POST',
      url: '/internal/media/generate-image',
      headers: { 'x-internal-token': TOKEN },
      payload: { characterId: LUNA.id, prompt: 'studio portrait', contentRating: 'sfw' },
    });
    expect(generated.statusCode).toBe(201);

    const assetIds = [...landed.map((a) => a.assetId), generated.json().asset.id as string];
    for (const id of assetIds) {
      const r = await row(id);
      expect({ id, workflow: ['generated', 'under_review'].includes(r.status), approvedAt: r.approvedAt, publishedAt: r.publishedAt, canonical: r.isCanonical }).toEqual({
        id,
        workflow: true,
        approvedAt: null,
        publishedAt: null,
        canonical: false,
      });
    }
    expect((await row(landed[4]!.assetId)).kind).toBe('generated');
  });

  it('the upload service REFUSES to approve content, and writes nothing when asked', async () => {
    const count = async () => (await on.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM character_visual_assets')).rows[0]!.n;
    const n = await count();
    for (const kind of [undefined, 'generated', 'chat'] as const) {
      await expect(
        uploadLibraryAsset(on.db, STORAGE, { characterId: LUNA.id, mimeType: 'image/png', bytes: PNG, kind, approve: true }),
      ).rejects.toThrow('only an identity reference may be approved on upload');
    }
    expect(await count()).toBe(n);
  });

  it('only the identity REFERENCE upload approves, and says so explicitly in code', async () => {
    const identity = (await getActiveVisualIdentity(on.db, LUNA.id))!;
    const { payload, headers } = multipart({}, IMAGE);
    const res = await on.app.inject({ method: 'POST', url: `/admin/identities/${identity.id}/references`, headers: { ...headers, cookie }, payload });
    expect(res.statusCode).toBe(201);
    const r = await row(res.json().assetId);
    expect([r.kind, r.status, r.isCanonical, r.publishedAt]).toEqual(['reference', 'approved', true, null]);
  });

  /**
   * Source guard. Every application call of `uploadLibraryAsset` that passes
   * `approve: true` must be a reference upload, no upload call passes a
   * release, and no ingest service writes a release time or approves.
   */
  it('the source audit catches a planted offender (it is not vacuous)', () => {
    const planted = `
      await uploadLibraryAsset(db, storage, {
        characterId,
        kind: 'generated',
        approve: true,
      });
      await uploadLibraryAsset(db, storage, { characterId, publish: true });
      await uploadLibraryAsset(db, storage, { characterId, kind: 'reference', approve: true });
    `;
    const audit = auditUploadCalls(planted);
    expect(audit.calls).toBe(3);
    expect(audit.violations).toHaveLength(2);
  });

  it('no application source approves content on upload or releases on ingest', () => {
    const srcRoot = fileURLToPath(new URL('..', import.meta.url));
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) {
          if (name !== 'test') walk(full);
        } else if (name.endsWith('.ts')) files.push(full);
      }
    };
    walk(srcRoot);

    let uploadCalls = 0;
    for (const file of files) {
      const rel = relative(srcRoot, file).split('\\').join('/');
      const found = auditUploadCalls(readFileSync(file, 'utf8'));
      uploadCalls += found.calls;
      expect({ rel, violations: found.violations }).toEqual({ rel, violations: [] });
    }
    // admin-content (shelves + library), content-inbox, and two reference routes.
    expect(uploadCalls).toBeGreaterThanOrEqual(4);

    for (const rel of ['services/library-upload-service.ts', 'services/content-inbox-service.ts', 'services/media-generation-service.ts']) {
      const code = readFileSync(join(srcRoot, rel), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
      expect({ rel, releases: /publishedAt\s*:/.test(code) }).toEqual({ rel, releases: false });
    }
    for (const rel of ['services/content-inbox-service.ts', 'services/media-generation-service.ts']) {
      const code = readFileSync(join(srcRoot, rel), 'utf8');
      expect({ rel, approves: code.includes('approveVisualAsset(') }).toEqual({ rel, approves: false });
    }
  });
});

/* ================================================================== *
 * 12. Legacy statuses
 * ================================================================== */

describe('12. legacy `generated` and `under_review` rows behave as one pending state', () => {
  it('both are pending review, both queue, both approve and both reject', async () => {
    const identity = (await getActiveVisualIdentity(on.db, LUNA.id))!;
    const make = (status: 'generated' | 'under_review') =>
      createVisualAsset(on.db, { characterId: LUNA.id, visualIdentityId: identity.id, kind: 'generated', origin: 'legacy', status, storageKey: '/x.mp4' });

    for (const status of ['generated', 'under_review'] as const) {
      const toApprove = await make(status);
      const toReject = await make(status);
      expect(assetActionsOf(toApprove)).toEqual(['approve', 'reject']);
      const queue = await reviewQueueIds();
      expect(queue).toContain(toApprove.id);
      expect(queue).toContain(toReject.id);
      expect((await actOk(toApprove.id, 'approve')).workflow).toBe('approved');
      expect((await actOk(toReject.id, 'reject')).workflow).toBe('rejected');
      // Neither can be archived while pending.
      const stillPending = await make(status);
      expect(await refused(stillPending.id, 'archive')).toContain('Approve or reject it first');
    }
  });

  it('the migration left existing statuses untouched and the database holds archive consistent', async () => {
    const identity = (await getActiveVisualIdentity(on.db, LUNA.id))!;
    const legacy = await createVisualAsset(on.db, { characterId: LUNA.id, visualIdentityId: identity.id, kind: 'generated', status: 'generated' });
    expect((await row(legacy.id)).status).toBe('generated');

    await expect(
      on.pool.query(`UPDATE character_visual_assets SET status = 'archived' WHERE id = $1`, [legacy.id]),
    ).rejects.toThrow(/character_visual_assets_archived_consistent/);
    await expect(
      on.pool.query(`UPDATE character_visual_assets SET archived_at = now() WHERE id = $1`, [legacy.id]),
    ).rejects.toThrow(/character_visual_assets_archived_consistent/);
    expect((await row(legacy.id)).status).toBe('generated');
  });
});

/* ================================================================== *
 * The transition matrix, exhaustively
 * ================================================================== */

describe('the transition matrix', () => {
  const STATUSES = ['generated', 'under_review', 'approved', 'rejected', 'archived'] as const;
  const KINDS = ['generated', 'chat', 'reference'] as const;

  it('offers exactly the documented actions for every status, role and release state', () => {
    const offered = (kind: TransitionSubject['kind'], status: TransitionSubject['status'], released: boolean) =>
      assetActionsOf({ kind, status, publishedAt: released ? new Date() : null });

    for (const kind of KINDS) {
      for (const released of [false, true]) {
        expect(offered(kind, 'generated', released)).toEqual(['approve', 'reject']);
        expect(offered(kind, 'under_review', released)).toEqual(['approve', 'reject']);
        expect(offered(kind, 'rejected', released)).toEqual([]);
        expect(offered(kind, 'archived', released)).toEqual(['unarchive']);
      }
    }
    // Approved: Release / Archive; Released: (Take off Posts) / Archive.
    expect(offered('generated', 'approved', false)).toEqual(['publish', 'archive']);
    expect(offered('generated', 'approved', true)).toEqual(['unpublish', 'archive']);
    expect(offered('chat', 'approved', false)).toEqual(['archive']);
    expect(offered('reference', 'approved', false)).toEqual([]);
  });

  it('every offered action is one the server accepts, and nothing offered is a no-op', () => {
    for (const kind of KINDS) {
      for (const status of STATUSES) {
        for (const released of [false, true]) {
          const subject = { kind, status, publishedAt: released ? new Date() : null };
          for (const action of assetActionsOf(subject)) {
            expect({ kind, status, released, action, check: checkTransition(subject, action) }).toEqual({
              kind,
              status,
              released,
              action,
              check: { allowed: true, noop: false },
            });
          }
        }
      }
    }
  });

  it('no action ever moves pending content straight to released', () => {
    for (const kind of KINDS) {
      for (const status of ['generated', 'under_review'] as const) {
        expect(checkTransition({ kind, status, publishedAt: null }, 'publish').allowed).toBe(false);
      }
    }
  });
});
