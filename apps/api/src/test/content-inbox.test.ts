import { readdir } from 'node:fs/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { characterVisualAssets, contentInbox, users } from '../db/schema.js';
import { SEED_CHARACTERS } from '../db/seed-data.js';
import { seedCharacters, seedVisualIdentities } from '../db/seed.js';
import { getActiveVisualIdentity } from '../services/visual-identity-service.js';
import { listVisualAssets, listCanonicalReferences } from '../services/visual-asset-service.js';
import {
  createTestContext,
  destroyTestContext,
  extractSessionCookie,
  migrateTestDb,
  resetContentRequirements,
  testEnv,
  truncateAll,
  type TestContext,
} from './helpers.js';

/**
 * The unassigned inbox.
 *
 * Two properties matter most here and are tested directly rather than argued
 * for: an unassigned upload is invisible to every character-scoped read in the
 * product, and a failed assignment leaves no orphaned file behind.
 */

const LUNA = SEED_CHARACTERS.find((c) => c.name === 'luna')!;
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const MP4 = Buffer.from('fake-mp4-bytes-for-the-inbox');

let ctx: TestContext;

beforeAll(async () => {
  migrateTestDb();
  ctx = await createTestContext();
});
afterAll(async () => destroyTestContext(ctx));
beforeEach(async () => {
  await truncateAll(ctx);
  await resetContentRequirements(ctx);
  await seedCharacters(ctx.db);
  await seedVisualIdentities(ctx.db);
});

async function adminCookies(email = 'ops.inbox@example.com') {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email, password: 'inbox-test-pass1' },
  });
  const c = extractSessionCookie(res)!;
  await ctx.db.update(users).set({ role: 'admin' }).where(eq(users.email, email));
  return { [c.name]: c.value };
}

/** A file part and NOTHING else — no character, which is the entire point. */
function fileOnly(bytes: Buffer, filename = 'mystery.png', contentType = 'image/png') {
  const boundary = '----inboxboundary';
  return {
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
          `Content-Type: ${contentType}\r\n\r\n`,
      ),
      bytes,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

const upload = (cookies: Record<string, string>, bytes = PNG, name?: string, type?: string) => {
  const { payload, headers } = fileOnly(bytes, name, type);
  return ctx.app.inject({ method: 'POST', url: '/admin/content/inbox', headers, payload, cookies });
};

async function storedFileCount(): Promise<number> {
  const entries = await readdir(testEnv.media.storageDir, {
    recursive: true,
    withFileTypes: true,
  }).catch(() => []);
  return entries.filter((e) => e.isFile()).length;
}

/* ------------------------------------------------------------------ *
 * Upload without a character
 * ------------------------------------------------------------------ */

describe('uploading with no character', () => {
  it('accepts a file and holds it as unassigned', async () => {
    const cookies = await adminCookies();
    const res = await upload(cookies);
    expect(res.statusCode).toBe(201);

    const item = res.json();
    expect(item.status).toBe('unassigned');
    expect(item.mediaType).toBe('image');
    expect(item.originalName).toBe('mystery.png');
    // Storage internals never reach the client.
    expect(res.payload).not.toContain('storagePath');
    expect(res.payload).not.toContain(testEnv.media.storageDir);

    const queue = (
      await ctx.app.inject({ method: 'GET', url: '/admin/content/inbox', cookies })
    ).json();
    expect(queue.items.map((i: { inboxId: string }) => i.inboxId)).toContain(item.inboxId);

    const file = await ctx.app.inject({ method: 'GET', url: item.fileUrl, cookies });
    expect(file.statusCode).toBe(200);
    expect(file.rawPayload.equals(PNG)).toBe(true);
  });

  it('accepts video as readily as images, classified from the mime type', async () => {
    const cookies = await adminCookies();
    const item = (await upload(cookies, MP4, 'clip.mp4', 'video/mp4')).json();
    expect(item.mediaType).toBe('video');
  });

  it('refuses an unsupported type and an empty file, storing nothing', async () => {
    const cookies = await adminCookies();
    const before = await storedFileCount();
    expect((await upload(cookies, PNG, 'x.txt', 'text/plain')).statusCode).toBe(400);
    expect((await upload(cookies, Buffer.alloc(0))).statusCode).toBe(400);
    expect(await storedFileCount()).toBe(before);
  });
});

/* ------------------------------------------------------------------ *
 * Isolation — the security property
 * ------------------------------------------------------------------ */

describe('an unassigned upload belongs to nobody', () => {
  it('is invisible to every character-scoped read until it is assigned', async () => {
    const cookies = await adminCookies();
    const item = (await upload(cookies)).json();
    const identity = (await getActiveVisualIdentity(ctx.db, LUNA.id))!;

    // Nothing was written to the assets table at all.
    expect(await ctx.db.select().from(characterVisualAssets).where(
      eq(characterVisualAssets.requirementKey, 'unassigned'),
    )).toHaveLength(0);

    const before = await listVisualAssets(ctx.db, LUNA.id, identity.id);
    const canonical = await listCanonicalReferences(ctx.db, LUNA.id, identity.id);

    // Every surface that could show it to a character.
    const board = (
      await ctx.app.inject({
        method: 'GET',
        url: `/admin/content/review/workspace?characterId=${LUNA.id}`,
        cookies,
      })
    ).json();
    const queue = (
      await ctx.app.inject({ method: 'GET', url: '/admin/content/review', cookies })
    ).json();
    const library = (
      await ctx.app.inject({ method: 'GET', url: '/admin/content/library', cookies })
    ).json();
    const publicView = (
      await ctx.app.inject({ method: 'GET', url: `/api/characters/${LUNA.id}/visual-identity` })
    ).json();

    const haystack = JSON.stringify({ board, queue, library, publicView, before, canonical });
    expect(haystack).not.toContain(item.inboxId);
    // It is not attributed to a character anywhere, because the row has no
    // character column to attribute it with.
    expect(board.selected.triage).toHaveLength(
      board.selected.triage.filter((t: { assetId: string }) => t.assetId !== item.inboxId).length,
    );
    expect(board.inbox.unassignedCount).toBe(1);
  });

  it('has no character column to leak through', async () => {
    const { rows } = await ctx.pool.query(
      `select column_name from information_schema.columns where table_name = 'content_inbox'`,
    );
    const columns = rows.map((r: { column_name: string }) => r.column_name);
    expect(columns).not.toContain('character_id');
    expect(columns).not.toContain('visual_identity_id');
  });
});

/* ------------------------------------------------------------------ *
 * Assignment
 * ------------------------------------------------------------------ */

describe('assigning an inbox item', () => {
  it('creates a real asset in REVIEW, filed under the chosen category', async () => {
    const cookies = await adminCookies();
    const item = (await upload(cookies)).json();

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/admin/content/inbox/${item.inboxId}/assign`,
      payload: { characterId: LUNA.id, requirementKey: 'primary_nude' },
      cookies,
    });
    expect(res.statusCode).toBe(200);

    const { asset } = res.json();
    expect(asset.characterId).toBe(LUNA.id);
    expect(asset.requirementKey).toBe('primary_nude');
    // Assignment is intake, NOT approval — Review is never bypassed.
    expect(asset.status).toBe('under_review');
    expect(asset.isPrimary).toBe(false);

    // It now appears on that character's board, as pending.
    const board = (
      await ctx.app.inject({
        method: 'GET',
        url: `/admin/content/review/workspace?characterId=${LUNA.id}`,
        cookies,
      })
    ).json();
    const entry = board.selected.requirements.find((r: { key: string }) => r.key === 'primary_nude');
    expect(entry.pending).toBe(1);
    expect(entry.approved).toBe(0);
    expect(entry.assets[0].assetId).toBe(asset.assetId);

    // ...and it has left the inbox.
    const queue = (
      await ctx.app.inject({ method: 'GET', url: '/admin/content/inbox', cookies })
    ).json();
    expect(queue.items).toHaveLength(0);
    expect(board.inbox.unassignedCount).toBe(0);
  });

  it('reaches the Library by approval, counting toward the requirement', async () => {
    const cookies = await adminCookies();
    const item = (await upload(cookies)).json();
    const { asset } = (
      await ctx.app.inject({
        method: 'POST',
        url: `/admin/content/inbox/${item.inboxId}/assign`,
        payload: { characterId: LUNA.id, requirementKey: 'primary_nude' },
        cookies,
      })
    ).json();

    await ctx.app.inject({
      method: 'POST',
      url: `/admin/content/assets/${asset.assetId}/approve`,
      cookies,
    });

    const library = (
      await ctx.app.inject({ method: 'GET', url: '/admin/content/library', cookies })
    ).json();
    expect(library.assets.map((a: { assetId: string }) => a.assetId)).toContain(asset.assetId);

    const status = (
      await ctx.app.inject({
        method: 'GET',
        url: `/admin/characters/${LUNA.id}/requirements`,
        cookies,
      })
    ).json();
    const entry = status.requirements.find((r: { key: string }) => r.key === 'primary_nude');
    expect(entry.approved).toBe(1);
    expect(entry.satisfied).toBe(true);
  });

  it('may be assigned with no category, landing in triage', async () => {
    const cookies = await adminCookies();
    const item = (await upload(cookies)).json();
    const { asset } = (
      await ctx.app.inject({
        method: 'POST',
        url: `/admin/content/inbox/${item.inboxId}/assign`,
        payload: { characterId: LUNA.id },
        cookies,
      })
    ).json();
    expect(asset.requirementKey).toBeNull();

    const board = (
      await ctx.app.inject({
        method: 'GET',
        url: `/admin/content/review/workspace?characterId=${LUNA.id}`,
        cookies,
      })
    ).json();
    const triaged = board.selected.triage.find(
      (t: { assetId: string }) => t.assetId === asset.assetId,
    );
    expect(triaged.reason).toBe('uncategorised');
  });

  it('refuses an unknown character, an unconfigured category, and a second assignment', async () => {
    const cookies = await adminCookies();
    const item = (await upload(cookies)).json();
    const assign = (payload: Record<string, unknown>) =>
      ctx.app.inject({
        method: 'POST',
        url: `/admin/content/inbox/${item.inboxId}/assign`,
        payload,
        cookies,
      });

    expect((await assign({})).statusCode).toBe(400);
    expect(
      (await assign({ characterId: '00000000-0000-4000-8000-000000000009' })).statusCode,
    ).toBe(404);
    const bogus = await assign({ characterId: LUNA.id, requirementKey: 'not_configured' });
    expect(bogus.statusCode).toBe(400);
    expect(bogus.json().error).toBe('unknown_requirement');

    // Still assignable after every refusal.
    expect((await assign({ characterId: LUNA.id })).statusCode).toBe(200);
    // ...but not twice.
    const again = await assign({ characterId: LUNA.id });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe('already_resolved');
  });

  it('leaves no orphaned file when assignment fails', async () => {
    const cookies = await adminCookies();
    const item = (await upload(cookies)).json();
    const before = await storedFileCount();

    await ctx.app.inject({
      method: 'POST',
      url: `/admin/content/inbox/${item.inboxId}/assign`,
      payload: { characterId: LUNA.id, requirementKey: 'not_configured' },
      cookies,
    });
    await ctx.app.inject({
      method: 'POST',
      url: `/admin/content/inbox/${item.inboxId}/assign`,
      payload: { characterId: '00000000-0000-4000-8000-000000000009' },
      cookies,
    });

    // Nothing written, nothing lost: the intake file is still exactly where it
    // was and the item is still assignable.
    expect(await storedFileCount()).toBe(before);
    const [row] = await ctx.db.select().from(contentInbox).where(eq(contentInbox.id, item.inboxId));
    expect(row!.status).toBe('unassigned');
    expect(row!.assignedAssetId).toBeNull();

    const ok = await ctx.app.inject({
      method: 'POST',
      url: `/admin/content/inbox/${item.inboxId}/assign`,
      payload: { characterId: LUNA.id },
      cookies,
    });
    expect(ok.statusCode).toBe(200);
    // The intake copy is cleaned up once the asset owns the bytes.
    expect(await storedFileCount()).toBe(before);
  });

  it('refuses assignment to a character with no active visual identity', async () => {
    const cookies = await adminCookies();
    const item = (await upload(cookies)).json();
    const draft = (
      await ctx.app.inject({
        method: 'POST',
        url: '/admin/characters',
        payload: {
          name: 'identityless',
          displayName: 'Identityless',
          shortBio: 'x',
          personality: 'x',
          conversationStyle: 'x',
          systemPrompt: 'x',
        },
        cookies,
      })
    ).json();

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/admin/content/inbox/${item.inboxId}/assign`,
      payload: { characterId: draft.id },
      cookies,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('no_active_identity');
    // Clear message, not a 500 — and the item survives for a second try.
    const [row] = await ctx.db.select().from(contentInbox).where(eq(contentInbox.id, item.inboxId));
    expect(row!.status).toBe('unassigned');
  });
});

/* ------------------------------------------------------------------ *
 * Discard
 * ------------------------------------------------------------------ */

describe('discarding', () => {
  it('removes the bytes, keeps the intake record, and leaves the queue', async () => {
    const cookies = await adminCookies();
    const item = (await upload(cookies)).json();
    const before = await storedFileCount();

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/admin/content/inbox/${item.inboxId}/discard`,
      cookies,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('discarded');
    expect(await storedFileCount()).toBe(before - 1);

    const [row] = await ctx.db.select().from(contentInbox).where(eq(contentInbox.id, item.inboxId));
    expect(row).toBeDefined();
    expect(row!.storagePath).toBeNull();

    const queue = (
      await ctx.app.inject({ method: 'GET', url: '/admin/content/inbox', cookies })
    ).json();
    expect(queue.items).toHaveLength(0);
    // The file is gone, so serving it 404s rather than erroring.
    expect((await ctx.app.inject({ method: 'GET', url: item.fileUrl, cookies })).statusCode).toBe(404);
  });

  it('will not discard something already assigned to a character', async () => {
    const cookies = await adminCookies();
    const item = (await upload(cookies)).json();
    await ctx.app.inject({
      method: 'POST',
      url: `/admin/content/inbox/${item.inboxId}/assign`,
      payload: { characterId: LUNA.id },
      cookies,
    });

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/admin/content/inbox/${item.inboxId}/discard`,
      cookies,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain('Reject it in Review');
  });
});


describe('guards found by review', () => {
  it('two concurrent assignments produce ONE asset, not two', async () => {
    // A double-click, or a retry after a slow response, used to pass the
    // read-then-write guard twice and create two assets from one file.
    const cookies = await adminCookies();
    const item = (await upload(cookies)).json();

    const attempts = await Promise.all(
      [0, 1, 2].map(() =>
        ctx.app.inject({
          method: 'POST',
          url: `/admin/content/inbox/${item.inboxId}/assign`,
          payload: { characterId: LUNA.id },
          cookies,
        }),
      ),
    );
    expect(attempts.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(attempts.filter((r) => r.statusCode === 409)).toHaveLength(2);

    // Exactly one asset exists for the one file.
    const fromInbox = await ctx.db
      .select()
      .from(characterVisualAssets)
      .where(eq(characterVisualAssets.kind, 'generated'));
    expect(fromInbox).toHaveLength(1);
  });

  it('refuses a category of the wrong medium and leaves the item assignable', async () => {
    const cookies = await adminCookies();
    const item = (await upload(cookies, MP4, 'clip.mp4', 'video/mp4')).json();

    const mismatch = await ctx.app.inject({
      method: 'POST',
      url: `/admin/content/inbox/${item.inboxId}/assign`,
      payload: { characterId: LUNA.id, requirementKey: 'primary_nude' }, // image
      cookies,
    });
    expect(mismatch.statusCode).toBe(400);
    expect(mismatch.json().error).toBe('media_mismatch');

    const [row] = await ctx.db.select().from(contentInbox).where(eq(contentInbox.id, item.inboxId));
    expect(row!.status).toBe('unassigned');

    const ok = await ctx.app.inject({
      method: 'POST',
      url: `/admin/content/inbox/${item.inboxId}/assign`,
      payload: { characterId: LUNA.id, requirementKey: 'selfie' },
      cookies,
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().asset.requirementKey).toBe('selfie');
  });

  it('never offers an item whose bytes never landed', async () => {
    // Such a row could never be assigned, so listing it would only waste time.
    const cookies = await adminCookies();
    const item = (await upload(cookies)).json();
    await ctx.db
      .update(contentInbox)
      .set({ storagePath: null })
      .where(eq(contentInbox.id, item.inboxId));

    const queue = (
      await ctx.app.inject({ method: 'GET', url: '/admin/content/inbox', cookies })
    ).json();
    expect(queue.items).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ *
 * Authorization
 * ------------------------------------------------------------------ */

describe('authorization', () => {
  const id = '00000000-0000-4000-8000-000000000001';
  const routes: Array<[string, string]> = [
    ['GET', '/admin/content/inbox'],
    ['POST', '/admin/content/inbox'],
    ['GET', `/admin/content/inbox/${id}/file`],
    ['POST', `/admin/content/inbox/${id}/assign`],
    ['POST', `/admin/content/inbox/${id}/discard`],
  ];

  it('refuses anonymous callers, including the file route', async () => {
    for (const [method, url] of routes) {
      const res = await ctx.app.inject({ method: method as 'GET', url });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it('refuses a signed-in non-admin, and stores nothing', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'regular.inbox@example.com', password: 'inbox-test-pass1' },
    });
    const c = extractSessionCookie(res)!;
    const cookies = { [c.name]: c.value };
    const before = await storedFileCount();

    for (const [method, url] of routes) {
      const forbidden = await ctx.app.inject({ method: method as 'GET', url, cookies });
      expect(forbidden.statusCode, `${method} ${url}`).toBe(403);
    }
    expect((await upload(cookies)).statusCode).toBe(403);
    expect(await storedFileCount()).toBe(before);
    expect(await ctx.db.select().from(contentInbox)).toHaveLength(0);
  });

  it('cannot be reached with a file path instead of an id', async () => {
    const cookies = await adminCookies();
    for (const url of [
      '/admin/content/inbox/not-a-uuid/file',
      `/admin/content/inbox/${id}/file`,
    ]) {
      expect((await ctx.app.inject({ method: 'GET', url, cookies })).statusCode).toBe(404);
    }
  });
});
