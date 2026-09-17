import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { characterVisualAssets } from '../db/schema.js';
import { SEED_CHARACTERS, SEED_VISUAL_ASSETS } from '../db/seed-data.js';
import { seedCharacters, seedVisualIdentities } from '../db/seed.js';
import { createMockProviders } from '../media-pipeline/mock-adapter.js';
import { assetActionsOf, assetLifecycleOf, assetRoleOf, assetWorkflowOf } from '../services/asset-lifecycle.js';
import { assignInboxItem, createInboxItem } from '../services/content-inbox-service.js';
import { deleteLibraryAsset, LibraryDeleteError, uploadLibraryAsset } from '../services/library-upload-service.js';
import { approveVisualAsset, createVisualAsset, getVisualAssetById } from '../services/visual-asset-service.js';
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
 * P0.3 -- the asset lifecycle model: ROLE (`kind`), ORIGIN (`origin`) and
 * WORKFLOW (`status`) are separate facts, each read from its own column, and
 * none of them implies distribution.
 */

const LUNA = SEED_CHARACTERS.find((c) => c.name === 'luna')!;
const TOKEN = testEnv.media.internalToken!;
const FIXTURES = join(testEnv.media.storageDir, '__lifecycle_fixtures__');
const IMAGE_FIXTURE = join(FIXTURES, 'seed.jpg');
const VIDEO_FIXTURE = join(FIXTURES, 'seed.mp4');
const STORAGE = { storageDir: testEnv.media.storageDir, servePathPrefix: '/admin/content/uploads' };
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

let on: TestContext;
let adminCookies: Record<string, string>;

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
  const email = `lifecycle-${randomUUID()}@example.com`;
  const res = await on.app.inject({ method: 'POST', url: '/api/auth/register', payload: { email, password: 'lifecycle-1' } });
  const cookie = extractSessionCookie(res)!;
  await on.pool.query(`UPDATE users SET role = 'admin' WHERE email = $1`, [email]);
  adminCookies = { [cookie.name]: cookie.value };
});

const upload = (over: Partial<Parameters<typeof uploadLibraryAsset>[2]> = {}) =>
  uploadLibraryAsset(on.db, STORAGE, { characterId: LUNA.id, mimeType: 'image/png', bytes: PNG, originalName: 'x.png', ...over });
/** Since P0.4 an upload lands pending review; approval is its own step. */
const uploadApproved = async (over: Partial<Parameters<typeof uploadLibraryAsset>[2]> = {}) =>
  approveVisualAsset(on.db, (await upload(over)).id);
/** The three P0.3 facts, without the P0.4 action list. */
const facts = (row: Parameters<typeof assetLifecycleOf>[0]) => {
  const { role, origin, workflow } = assetLifecycleOf(row);
  return { role, origin, workflow };
};

async function generateImage() {
  const res = await on.app.inject({
    method: 'POST',
    url: '/internal/media/generate-image',
    headers: { 'x-internal-token': TOKEN },
    payload: { characterId: LUNA.id, prompt: 'a calm studio portrait', contentRating: 'sfw' },
  });
  expect(res.statusCode).toBe(201);
  return (await getVisualAssetById(on.db, res.json().asset.id))!;
}

/* ------------------------------------------------------------------ *
 * Each writer records the right three facts
 * ------------------------------------------------------------------ */

describe('each writer records role, origin and workflow independently', () => {
  it('a GENERATED content asset: content / generated / pending review, with full provenance kept', async () => {
    const row = await generateImage();
    expect(facts(row)).toEqual({ role: 'content', origin: 'generated', workflow: 'pending_review' });
    const provenance = row.provenance as Record<string, unknown>;
    for (const key of ['jobId', 'provider', 'model', 'prompt', 'storagePath', 'generatedAt']) {
      expect({ key, present: provenance[key] !== undefined }).toEqual({ key, present: true });
    }
    // Generation never makes anything live: no release, no placement.
    expect(row.publishedAt).toBeNull();
  });

  it('a MANUALLY uploaded content asset: content / manual -- the same `kind` as generated, a different origin', async () => {
    const row = await upload();
    expect(row.kind).toBe('generated');
    expect(facts(row)).toEqual({ role: 'content', origin: 'manual', workflow: 'pending_review' });
    expect((row.provenance as Record<string, unknown>).source).toBe('manual-upload');
    expect(row.publishedAt).toBeNull();
  });

  it('a REFERENCE asset: reference role, origin as uploaded', async () => {
    const row = await upload({ kind: 'reference', approve: false });
    expect(facts(row)).toEqual({ role: 'reference', origin: 'manual', workflow: 'pending_review' });
  });

  it('a CHAT asset: chat role, even once approved', async () => {
    const row = await uploadApproved({ kind: 'chat' });
    expect(facts(row)).toEqual({ role: 'chat', origin: 'manual', workflow: 'approved' });
  });

  it('a Content Inbox assignment is MANUAL intake, not an import, and lands pending review', async () => {
    const item = await createInboxItem(on.db, STORAGE, { mimeType: 'image/png', bytes: PNG, originalName: 'staged.png' });
    const { asset } = await assignInboxItem(on.db, STORAGE, { inboxId: item.id, characterId: LUNA.id });
    expect(facts(asset)).toEqual({ role: 'content', origin: 'manual', workflow: 'pending_review' });
  });

  it('an explicit import is recorded as imported', async () => {
    const row = await upload({ origin: 'imported' });
    expect(row.origin).toBe('imported');
  });

  it('a writer that states no origin records legacy -- never a guess from kind or status', async () => {
    const identity = (await getActiveVisualIdentity(on.db, LUNA.id))!;
    const row = await createVisualAsset(on.db, { characterId: LUNA.id, visualIdentityId: identity.id, kind: 'generated' });
    expect(row.origin).toBe('legacy');
  });
});

/* ------------------------------------------------------------------ *
 * Workflow
 * ------------------------------------------------------------------ */

describe('workflow states', () => {
  it('maps every stored status, with both pending statuses as one review queue', () => {
    expect(assetWorkflowOf('generated')).toBe('pending_review');
    expect(assetWorkflowOf('under_review')).toBe('pending_review');
    expect(assetWorkflowOf('approved')).toBe('approved');
    expect(assetWorkflowOf('rejected')).toBe('rejected');
  });

  it('approving and rejecting change workflow only -- never role or origin', async () => {
    const pending = await generateImage();
    const approve = await on.app.inject({ method: 'POST', url: `/admin/content/assets/${pending.id}/approve`, cookies: adminCookies });
    expect(approve.statusCode).toBe(200);
    const approved = (await getVisualAssetById(on.db, pending.id))!;
    expect(facts(approved)).toEqual({ role: 'content', origin: 'generated', workflow: 'approved' });
    // Approved is not distributed.
    expect(approved.publishedAt).toBeNull();

    const other = await upload({ approve: false });
    const reject = await on.app.inject({ method: 'POST', url: `/admin/content/assets/${other.id}/reject`, cookies: adminCookies });
    expect(reject.statusCode).toBe(200);
    expect(facts((await getVisualAssetById(on.db, other.id))!)).toEqual({
      role: 'content',
      origin: 'manual',
      workflow: 'rejected',
    });
  });
});

/* ------------------------------------------------------------------ *
 * No fact is inferred from another
 * ------------------------------------------------------------------ */

describe('role, origin and workflow are never inferred from one another', () => {
  it('holds every stored combination as-is', async () => {
    const identity = (await getActiveVisualIdentity(on.db, LUNA.id))!;
    const kinds = ['reference', 'generated', 'chat'] as const;
    const origins = ['generated', 'manual', 'imported', 'legacy'] as const;
    const statuses = ['generated', 'under_review', 'approved', 'rejected'] as const;
    for (const kind of kinds) {
      for (const origin of origins) {
        for (const status of statuses) {
          const row = await createVisualAsset(on.db, { characterId: LUNA.id, visualIdentityId: identity.id, kind, origin, status });
          const view = assetLifecycleOf(row);
          expect({ kind, origin, status, view }).toEqual({
            kind,
            origin,
            status,
            view: { role: assetRoleOf(kind), origin, workflow: assetWorkflowOf(status), actions: assetActionsOf(row) },
          });
        }
      }
    }
    // The misleading names in particular: `kind = generated` is a ROLE, and
    // `status = generated` is a WORKFLOW state. Neither is an origin.
    expect(facts({ kind: 'generated', origin: 'manual', status: 'generated', publishedAt: null })).toEqual({
      role: 'content',
      origin: 'manual',
      workflow: 'pending_review',
    });
  });
});

/* ------------------------------------------------------------------ *
 * Legacy compatibility -- the shipped backfill
 * ------------------------------------------------------------------ */

describe('the 0030 backfill classifies existing assets from recorded evidence only', () => {
  const backfill = () => {
    const sql = readFileSync(new URL('../../drizzle/0030_mushy_puppet_master.sql', import.meta.url), 'utf8');
    return sql.slice(sql.indexOf('UPDATE "character_visual_assets"'));
  };

  it('maps generation, manual, imported and unknown provenance -- and never rewrites provenance', async () => {
    const identity = (await getActiveVisualIdentity(on.db, LUNA.id))!;
    const make = async (provenance: Record<string, unknown>) =>
      (await createVisualAsset(on.db, { characterId: LUNA.id, visualIdentityId: identity.id, kind: 'generated', provenance, origin: 'manual' })).id;

    const byJob = await make({ jobId: randomUUID(), provider: 'atlas' });
    const byResult = await make({ note: 'no job id, but linked from generation history' });
    const manual = await make({ source: 'manual-upload', originalName: 'a.png' });
    const imported = await make({ source: 'approved-site-content', sourceFile: 'Content/Site/x.jpg' });
    const placeholder = await make({ source: 'seed-placeholder' });
    const empty = await make({});
    const unknown = await make({ source: 'some-future-thing' });

    // A generation_results row pointing at the asset is generation evidence too.
    const job = (
      await on.pool.query<{ id: string }>(
        `INSERT INTO generation_jobs (character_id, type, provider, model, effective_config)
         VALUES ($1, 'image', 'mock', 'mock-model', '{}') RETURNING id`,
        [LUNA.id],
      )
    ).rows[0]!.id;
    await on.pool.query('INSERT INTO generation_results (job_id, ordinal, asset_id) VALUES ($1, 1, $2)', [job, byResult]);

    const before = await on.pool.query('SELECT id, provenance FROM character_visual_assets ORDER BY id');
    await on.pool.query(`UPDATE character_visual_assets SET origin = 'legacy'`);
    await on.pool.query(backfill());
    await on.pool.query(backfill()); // idempotent

    const originOf = async (id: string) =>
      (await on.pool.query<{ origin: string }>('SELECT origin FROM character_visual_assets WHERE id = $1', [id])).rows[0]!.origin;
    expect(await originOf(byJob)).toBe('generated');
    expect(await originOf(byResult)).toBe('generated');
    expect(await originOf(manual)).toBe('manual');
    expect(await originOf(imported)).toBe('imported');
    expect(await originOf(placeholder)).toBe('legacy');
    expect(await originOf(empty)).toBe('legacy');
    expect(await originOf(unknown)).toBe('legacy');

    const after = await on.pool.query('SELECT id, provenance FROM character_visual_assets ORDER BY id');
    expect(after.rows).toEqual(before.rows);
  });

  it('agrees with the seed data: placeholders are legacy, the supplied portrait is imported', async () => {
    await on.pool.query(`UPDATE character_visual_assets SET origin = 'legacy'`);
    await on.pool.query(backfill());
    for (const seed of SEED_VISUAL_ASSETS) {
      const row = (await getVisualAssetById(on.db, seed.id))!;
      expect({ id: seed.id, origin: row.origin }).toEqual({ id: seed.id, origin: seed.origin });
    }
  });
});

/* ------------------------------------------------------------------ *
 * Deletion
 * ------------------------------------------------------------------ */

describe('deletion is the only destructive path, and stays as it was', () => {
  it('removes the row and its file, cascades distribution rows, and keeps generation history', async () => {
    const row = await generateImage();
    await on.db.update(characterVisualAssets).set({ status: 'approved' }).where(eq(characterVisualAssets.id, row.id));
    const upload1 = await upload();
    const filePath = (upload1.provenance as Record<string, unknown>).storagePath as string;
    expect(existsSync(filePath)).toBe(true);

    const category = (
      await on.pool.query<{ id: string }>(`INSERT INTO app_categories (slug, name) VALUES ('lifecycle-cat', 'Lifecycle') RETURNING id`)
    ).rows[0]!.id;
    await on.pool.query('INSERT INTO app_category_assets (category_id, asset_id) VALUES ($1, $2)', [category, upload1.id]);

    const result = await deleteLibraryAsset(on.db, STORAGE, upload1.id);
    expect(result).toMatchObject({ assetId: upload1.id, fileRemoved: true });
    expect(await getVisualAssetById(on.db, upload1.id)).toBeNull();
    expect(existsSync(filePath)).toBe(false);
    expect((await on.pool.query('SELECT 1 FROM app_category_assets WHERE asset_id = $1', [upload1.id])).rowCount).toBe(0);

    // A generated asset's generation history survives its deletion, unlinked.
    const history = await on.pool.query('SELECT id FROM generation_results WHERE asset_id = $1', [row.id]);
    await deleteLibraryAsset(on.db, STORAGE, row.id);
    for (const { id } of history.rows as Array<{ id: string }>) {
      const { rows } = await on.pool.query('SELECT asset_id FROM generation_results WHERE id = $1', [id]);
      expect(rows).toEqual([{ asset_id: null }]);
    }
  });

  it('refuses to delete a canonical (primary) reference', async () => {
    const canonical = SEED_VISUAL_ASSETS.find((a) => a.characterId === LUNA.id)!;
    await expect(deleteLibraryAsset(on.db, STORAGE, canonical.id)).rejects.toBeInstanceOf(LibraryDeleteError);
    expect(await getVisualAssetById(on.db, canonical.id)).not.toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * Chat privacy
 * ------------------------------------------------------------------ */

describe('an approved chat asset never reaches a public surface', () => {
  /**
   * Worst case, forced in SQL past every admin guard: approved, released to
   * Posts, in a published category, on the Hero, and carrying a keyword an
   * enabled discovery category queries. Every public reader must still refuse
   * it, because the role allow-lists decide -- not workflow, not distribution.
   */
  it('stays private even when approved, released and placed everywhere', async () => {
    const chat = await uploadApproved({ kind: 'chat' });
    expect(chat.status).toBe('approved');
    await on.pool.query('UPDATE character_visual_assets SET published_at = now() WHERE id = $1', [chat.id]);
    const category = (
      await on.pool.query<{ id: string }>(
        `INSERT INTO app_categories (slug, name, enabled, home_published) VALUES ('chat-leak', 'Chat leak', true, true) RETURNING id`,
      )
    ).rows[0]!.id;
    await on.pool.query('INSERT INTO app_category_assets (category_id, asset_id) VALUES ($1, $2)', [category, chat.id]);
    await on.pool.query('INSERT INTO home_hero_clips (asset_id, position) VALUES ($1, 0)', [chat.id]);
    const keyword = (await on.pool.query<{ id: string }>(`INSERT INTO content_keywords (key, label) VALUES ('chatleak', 'chatleak') RETURNING id`)).rows[0]!.id;
    const discovery = (
      await on.pool.query<{ id: string }>(`INSERT INTO discovery_categories (slug, name, enabled) VALUES ('chat-leak-d', 'Chat leak', true) RETURNING id`)
    ).rows[0]!.id;
    await on.pool.query('INSERT INTO discovery_category_keywords (discovery_category_id, keyword_id) VALUES ($1, $2)', [discovery, keyword]);
    await on.pool.query('INSERT INTO asset_keywords (asset_id, keyword_id) VALUES ($1, $2)', [chat.id, keyword]);

    // CONTROL: a CONTENT asset forced into exactly the same places. It must
    // appear, which proves the readers below are live and populated -- so the
    // chat asset's absence is the role boundary, not an empty page.
    const content = await uploadApproved();
    await on.pool.query('UPDATE character_visual_assets SET published_at = now() WHERE id = $1', [content.id]);
    await on.pool.query('INSERT INTO app_category_assets (category_id, asset_id, position) VALUES ($1, $2, 1)', [category, content.id]);
    await on.pool.query('INSERT INTO home_hero_clips (asset_id, position) VALUES ($1, 1)', [content.id]);
    await on.pool.query('INSERT INTO asset_keywords (asset_id, keyword_id) VALUES ($1, $2)', [content.id, keyword]);

    const get = (url: string) => on.app.inject({ method: 'GET', url });
    expect((await get(`/api/media/assets/${content.id}/file`)).statusCode).toBe(200);
    expect((await get(`/api/characters/${LUNA.id}/clips`)).payload).toContain(content.id);
    expect((await get('/api/home')).payload).toContain(content.id);

    expect((await get(`/api/media/assets/${chat.id}/file`)).statusCode).toBe(404);
    for (const url of ['/api/home', `/api/characters/${LUNA.id}/clips`, '/api/browse/clips', '/api/browse/characters', '/api/play-with-me']) {
      const res = await get(url);
      expect(res.statusCode).toBe(200);
      expect({ url, leaked: res.payload.includes(chat.id) }).toEqual({ url, leaked: false });
    }
  });
});

/* ------------------------------------------------------------------ *
 * Read models and writers
 * ------------------------------------------------------------------ */

describe('admin read models expose role, origin and workflow', () => {
  it('on the character content shelf, Review/Library and primary references', async () => {
    const generated = await generateImage();
    const manual = await uploadApproved();
    const content = (
      await on.app.inject({ method: 'GET', url: `/admin/characters/${LUNA.id}/content`, cookies: adminCookies })
    ).json().assets as Array<{ assetId: string; role: string; origin: string; workflow: string }>;
    expect(content.find((a) => a.assetId === generated.id)).toMatchObject({ role: 'content', origin: 'generated', workflow: 'pending_review' });
    expect(content.find((a) => a.assetId === manual.id)).toMatchObject({ role: 'content', origin: 'manual', workflow: 'approved' });

    const review = (await on.app.inject({ method: 'GET', url: '/admin/content/review', cookies: adminCookies })).json();
    const reviewAssets = (Array.isArray(review) ? review : review.assets) as Array<{ assetId: string; origin: string; role: string; workflow: string }>;
    expect(reviewAssets.find((a) => a.assetId === generated.id)).toMatchObject({ role: 'content', origin: 'generated', workflow: 'pending_review' });

    const detail = (await on.app.inject({ method: 'GET', url: `/admin/characters/${LUNA.id}`, cookies: adminCookies })).json();
    for (const ref of detail.primaryReferences as Array<{ role: string; origin: string; workflow: string }>) {
      expect(ref).toMatchObject({ role: 'reference', origin: 'legacy', workflow: 'approved' });
    }
  });

  it('never exposes provenance internals beyond what those views already showed', async () => {
    const manual = await upload();
    const res = await on.app.inject({ method: 'GET', url: `/admin/characters/${LUNA.id}/content`, cookies: adminCookies });
    expect(res.payload).not.toContain((manual.provenance as Record<string, unknown>).storagePath as string);
  });
});

describe('every application writer states an origin', () => {
  it('passes origin in every createVisualAsset call outside the service itself', () => {
    const src = fileURLToPath(new URL('..', import.meta.url));
    const files = (function walk(dir: string): string[] {
      return readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) return name === 'test' ? [] : walk(path);
        return name.endsWith('.ts') && !name.endsWith('.test.ts') ? [path] : [];
      });
    })(src);
    const calls: Array<{ file: string; hasOrigin: boolean }> = [];
    for (const path of files) {
      const rel = relative(src, path).split('\\').join('/');
      if (rel === 'services/visual-asset-service.ts') continue;
      const text = readFileSync(path, 'utf8');
      for (let i = text.indexOf('createVisualAsset(db, {'); i !== -1; i = text.indexOf('createVisualAsset(db, {', i + 1)) {
        const call = text.slice(i, text.indexOf('});', i));
        calls.push({ file: rel, hasOrigin: /\borigin:/.test(call) });
      }
    }
    expect(calls.length).toBeGreaterThanOrEqual(3);
    expect(calls.filter((c) => !c.hasOrigin)).toEqual([]);
  });
});
