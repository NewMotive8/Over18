import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { eq } from 'drizzle-orm';
import { characterVisualAssets } from '../db/schema.js';
import { SEED_CHARACTERS } from '../db/seed-data.js';
import { seedCharacters, seedVisualIdentities } from '../db/seed.js';
import { createVisualAsset } from '../services/visual-asset-service.js';
import { getActiveVisualIdentity } from '../services/visual-identity-service.js';
import { inspectMp4 } from '../services/mp4-inspect.js';
import { verifyDerivative } from '../services/media-verify-service.js';
import { optimisedPathFor } from '../services/media-optimise-service.js';
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
 * OPTIMISED DERIVATIVES — the switch, the gate, and the promise that the
 * original always wins.
 *
 * Three things are worth pinning here, and they are the three that would be
 * silent if they broke:
 *
 *  1. WITH THE FLAG OFF, NOTHING CHANGED. A derivative can exist on disk and be
 *     recorded on the row, and every surface still serves the original bytes
 *     under the original content type. That is what makes shipping the
 *     machinery and shipping the behaviour two separate decisions.
 *
 *  2. THE ORIGINAL IS THE FALLBACK, ALWAYS. Flag on but no derivative, flag on
 *     but the file is gone — both serve the original rather than 404.
 *
 *  3. VERIFICATION IS A GATE, NOT A SUGGESTION. Every check refuses on its own,
 *     and a refusal leaves the row untouched.
 *
 * NO ENCODER IS REQUIRED TO RUN THESE. The MP4s below are synthesised box by
 * box, so every branch of the verifier is reachable deterministically and the
 * suite does not depend on ffmpeg being installed — which the API image does
 * not ship and is not going to.
 */

const LUNA = SEED_CHARACTERS.find((c) => c.name === 'luna')!;

/* ------------------------------------------------------------------ *
 * A tiny MP4 writer — just enough boxes for the inspector to read
 * ------------------------------------------------------------------ */

function box(type: string, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  const header = Buffer.alloc(8);
  header.writeUInt32BE(body.length + 8, 0);
  header.write(type, 4, 'latin1');
  return Buffer.concat([header, body]);
}

function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n, 0);
  return b;
}

function tkhd(width: number, height: number): Buffer {
  // version 0: width sits at body+76, height at body+80.
  return box(
    'tkhd',
    Buffer.alloc(4), // version + flags
    Buffer.alloc(20), // creation, modification, track id, reserved, duration
    Buffer.alloc(52), // reserved, layer, alt group, volume, reserved, matrix
    u32(width * 65536),
    u32(height * 65536),
  );
}

function mdhd(timescale: number, duration: number): Buffer {
  return box('mdhd', Buffer.alloc(4), Buffer.alloc(8), u32(timescale), u32(duration), Buffer.alloc(4));
}

function hdlr(handler: string): Buffer {
  return box('hdlr', Buffer.alloc(4), Buffer.alloc(4), Buffer.from(handler, 'latin1'), Buffer.alloc(12));
}

function stsd(fourcc: string): Buffer {
  const entry = Buffer.concat([u32(16), Buffer.from(fourcc, 'latin1'), Buffer.alloc(8)]);
  return box('stsd', Buffer.alloc(4), u32(1), entry);
}

function stts(frames: number): Buffer {
  return box('stts', Buffer.alloc(4), u32(1), u32(frames), u32(1));
}

function videoTrak(o: {
  width: number;
  height: number;
  frames: number;
  timescale: number;
  duration: number;
  fourcc: string;
}): Buffer {
  return box(
    'trak',
    tkhd(o.width, o.height),
    box(
      'mdia',
      mdhd(o.timescale, o.duration),
      hdlr('vide'),
      box('minf', box('stbl', stsd(o.fourcc), stts(o.frames))),
    ),
  );
}

function audioTrak(): Buffer {
  return box(
    'trak',
    tkhd(0, 0),
    box('mdia', mdhd(48000, 48000), hdlr('soun'), box('minf', box('stbl', stsd('mp4a'), stts(100)))),
  );
}

interface FakeMp4 {
  width?: number;
  height?: number;
  frames?: number;
  timescale?: number;
  duration?: number;
  fourcc?: string;
  audioTracks?: number;
  faststart?: boolean;
  padding?: number;
}

/** A structurally valid MP4 with exactly the facts the test cares about. */
function fakeMp4(o: FakeMp4 = {}): Buffer {
  const width = o.width ?? 768;
  const height = o.height ?? 1168;
  const frames = o.frames ?? 145;
  const timescale = o.timescale ?? 24;
  const duration = o.duration ?? frames;
  const traks = [
    videoTrak({ width, height, frames, timescale, duration, fourcc: o.fourcc ?? 'avc1' }),
  ];
  for (let i = 0; i < (o.audioTracks ?? 0); i++) traks.push(audioTrak());

  const ftyp = box('ftyp', Buffer.from('isom', 'latin1'), Buffer.alloc(8));
  const moov = box('moov', ...traks);
  const mdat = box('mdat', Buffer.alloc(o.padding ?? 2048, 0x11));
  return o.faststart === false
    ? Buffer.concat([ftyp, mdat, moov])
    : Buffer.concat([ftyp, moov, mdat]);
}

/* ------------------------------------------------------------------ *
 * Harness
 * ------------------------------------------------------------------ */

let off: TestContext;
let on: TestContext;
let adminCookies: Record<string, string>;
let seq = 0;

const STORAGE = testEnv.media.storageDir;

beforeAll(async () => {
  migrateTestDb();
  off = await createTestContext();
  on = await createTestContext({ optimisedMediaEnabled: true });
});
afterAll(async () => {
  await destroyTestContext(off);
  await destroyTestContext(on);
});

beforeEach(async () => {
  await truncateAll(off);
  await seedCharacters(off.db);
  await seedVisualIdentities(off.db);
  const res = await off.app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email: 'opt.admin@example.com', password: 'optimisation-1' },
  });
  const cookie = extractSessionCookie(res)!;
  await off.pool.query(`UPDATE users SET role = 'admin' WHERE email = $1`, [
    'opt.admin@example.com',
  ]);
  adminCookies = { [cookie.name]: cookie.value };
});

/** An approved upload whose ORIGINAL bytes really exist, publicly reachable. */
async function makeUpload(originalBytes: Buffer) {
  const identity = (await getActiveVisualIdentity(off.db, LUNA.id))!;
  const asset = await createVisualAsset(off.db, {
    characterId: LUNA.id,
    visualIdentityId: identity.id,
    kind: 'generated',
    status: 'approved',
    contentRating: 'sfw',
  });
  const storagePath = join(STORAGE, LUNA.id, 'uploads', `${asset.id}.mp4`);
  mkdirSync(dirname(storagePath), { recursive: true });
  writeFileSync(storagePath, originalBytes);
  await off.db
    .update(characterVisualAssets)
    .set({
      storageKey: `/admin/content/uploads/${asset.id}/file`,
      provenance: {
        source: 'manual-upload',
        mimeType: 'video/quicktime', // a .mov source: the content-type trap
        mediaType: 'video',
        byteSize: originalBytes.length,
        storagePath,
      },
    })
    .where(eq(characterVisualAssets.id, asset.id));

  // Publish it so the public byte route will serve it at all.
  const cat = await off.app.inject({
    method: 'POST',
    url: '/admin/app-categories',
    payload: { name: `Opt ${process.pid} ${++seq}` },
    cookies: adminCookies,
  });
  const category = cat.json();
  await off.app.inject({
    method: 'POST',
    url: `/admin/app-categories/${category.id}/assets`,
    payload: { assetIds: [asset.id] },
    cookies: adminCookies,
  });
  await off.app.inject({
    method: 'PATCH',
    url: `/admin/home/categories/${category.id}`,
    payload: { homePublished: true },
    cookies: adminCookies,
  });
  return { asset, storagePath };
}

/** Records a derivative on the row exactly as adoption would. */
async function writeDerivative(assetId: string, storagePath: string, bytes: Buffer) {
  const target = optimisedPathFor(storagePath, assetId);
  writeFileSync(target, bytes);
  const [row] = await off.db
    .select()
    .from(characterVisualAssets)
    .where(eq(characterVisualAssets.id, assetId));
  await off.db
    .update(characterVisualAssets)
    .set({
      provenance: { ...(row!.provenance as Record<string, unknown>), optimisedPath: target },
    })
    .where(eq(characterVisualAssets.id, assetId));
  return target;
}

const fetchPublic = (ctx: TestContext, assetId: string) =>
  ctx.app.inject({ method: 'GET', url: `/api/media/assets/${assetId}/file` });

/* ------------------------------------------------------------------ *
 * 1. Flag OFF — nothing changed
 * ------------------------------------------------------------------ */

describe('with MEDIA_OPTIMISED_ENABLED off, the original is served', () => {
  it('serves the ORIGINAL bytes even when a derivative exists and is recorded', async () => {
    const original = fakeMp4({ padding: 40_000 });
    const derivative = fakeMp4({ padding: 2_000 });
    const { asset, storagePath } = await makeUpload(original);
    await writeDerivative(asset.id, storagePath, derivative);

    const res = await fetchPublic(off, asset.id);
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.length).toBe(original.length);
    expect(res.rawPayload.equals(original)).toBe(true);
  });

  it('keeps the ORIGINAL content type', async () => {
    // The upload recorded video/quicktime. With the flag off that is what the
    // header must say — the derivative's .mp4 type must not leak in.
    const { asset, storagePath } = await makeUpload(fakeMp4({ padding: 40_000 }));
    await writeDerivative(asset.id, storagePath, fakeMp4({ padding: 2_000 }));

    const res = await fetchPublic(off, asset.id);
    expect(res.headers['content-type']).toBe('video/quicktime');
  });

  it('is the default: an env with no flag set resolves to false', () => {
    expect(testEnv.media.optimisedEnabled).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * 2. Flag ON — the derivative serves, and the original still backs it
 * ------------------------------------------------------------------ */

describe('with MEDIA_OPTIMISED_ENABLED on', () => {
  it('serves the DERIVATIVE bytes', async () => {
    const original = fakeMp4({ padding: 40_000 });
    const derivative = fakeMp4({ padding: 2_000 });
    const { asset, storagePath } = await makeUpload(original);
    await writeDerivative(asset.id, storagePath, derivative);

    const res = await fetchPublic(on, asset.id);
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.equals(derivative)).toBe(true);
  });

  it('labels it video/mp4, NOT the original upload’s type', async () => {
    // The regression this guards: a .mov original records video/quicktime, and
    // sending that header with an .mp4 body mislabels every transcoded clip.
    const { asset, storagePath } = await makeUpload(fakeMp4({ padding: 40_000 }));
    await writeDerivative(asset.id, storagePath, fakeMp4({ padding: 2_000 }));

    const res = await fetchPublic(on, asset.id);
    expect(res.headers['content-type']).toBe('video/mp4');
  });

  it('falls back to the original when the derivative FILE is missing', async () => {
    const original = fakeMp4({ padding: 40_000 });
    const { asset, storagePath } = await makeUpload(original);
    // Record a path but never write the file — a volume that lost it.
    const [row] = await off.db
      .select()
      .from(characterVisualAssets)
      .where(eq(characterVisualAssets.id, asset.id));
    await off.db
      .update(characterVisualAssets)
      .set({
        provenance: {
          ...(row!.provenance as Record<string, unknown>),
          optimisedPath: optimisedPathFor(storagePath, asset.id),
        },
      })
      .where(eq(characterVisualAssets.id, asset.id));

    const res = await fetchPublic(on, asset.id);
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.equals(original)).toBe(true);
    expect(res.headers['content-type']).toBe('video/quicktime');
  });

  it('serves the original when no derivative was ever recorded', async () => {
    const original = fakeMp4({ padding: 40_000 });
    const { asset } = await makeUpload(original);
    const res = await fetchPublic(on, asset.id);
    expect(res.rawPayload.equals(original)).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * 3. The verifier — every check refuses on its own
 * ------------------------------------------------------------------ */

describe('verifyDerivative', () => {
  const dir = join(tmpdir(), `over18-verify-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  let n = 0;
  const write = (bytes: Buffer) => {
    const p = join(dir, `v${++n}.mp4`);
    writeFileSync(p, bytes);
    return p;
  };

  const ORIGINAL = () => fakeMp4({ padding: 60_000 });

  it('accepts a derivative that matches the original and is smaller', () => {
    const v = verifyDerivative(write(ORIGINAL()), write(fakeMp4({ padding: 4_000 })));
    expect(v.ok).toBe(true);
    expect(v.failed).toEqual([]);
  });

  it('refuses a changed RESOLUTION', () => {
    const v = verifyDerivative(write(ORIGINAL()), write(fakeMp4({ width: 640, padding: 4_000 })));
    expect(v.ok).toBe(false);
    expect(v.failed).toContain('resolution');
  });

  it('refuses a changed FRAME COUNT — the truncated-encode signature', () => {
    const v = verifyDerivative(write(ORIGINAL()), write(fakeMp4({ frames: 100, padding: 4_000 })));
    expect(v.ok).toBe(false);
    expect(v.failed).toContain('frameCount');
  });

  it('refuses a changed DURATION', () => {
    const v = verifyDerivative(
      write(ORIGINAL()),
      write(fakeMp4({ duration: 72, padding: 4_000 })),
    );
    expect(v.ok).toBe(false);
    expect(v.failed).toContain('duration');
  });

  it('REFUSES A DERIVATIVE THAT DROPPED AUDIO', () => {
    // The product requirement, as a gate. An original with sound may only be
    // replaced by a derivative that still has it — so `-an` can never be
    // introduced by accident, in this pipeline or any future one.
    const withSound = write(fakeMp4({ audioTracks: 1, padding: 60_000 }));
    const silenced = write(fakeMp4({ audioTracks: 0, padding: 4_000 }));
    const v = verifyDerivative(withSound, silenced);
    expect(v.ok).toBe(false);
    expect(v.failed).toContain('audioStreams');
  });

  it('accepts a derivative that KEPT its audio track', () => {
    const v = verifyDerivative(
      write(fakeMp4({ audioTracks: 1, padding: 60_000 })),
      write(fakeMp4({ audioTracks: 1, padding: 4_000 })),
    );
    expect(v.ok).toBe(true);
  });

  it('refuses a derivative whose moov is at the END', () => {
    const v = verifyDerivative(
      write(ORIGINAL()),
      write(fakeMp4({ faststart: false, padding: 4_000 })),
    );
    expect(v.ok).toBe(false);
    expect(v.failed).toContain('faststart');
  });

  it('refuses a derivative that is not meaningfully smaller', () => {
    const v = verifyDerivative(write(ORIGINAL()), write(fakeMp4({ padding: 60_000 })));
    expect(v.ok).toBe(false);
    expect(v.failed).toContain('smaller');
  });

  it('refuses a derivative LARGER than the original', () => {
    const v = verifyDerivative(write(ORIGINAL()), write(fakeMp4({ padding: 200_000 })));
    expect(v.ok).toBe(false);
    expect(v.failed).toContain('smaller');
  });

  it('refuses a non-H.264 derivative', () => {
    const v = verifyDerivative(
      write(ORIGINAL()),
      write(fakeMp4({ fourcc: 'hvc1', padding: 4_000 })),
    );
    expect(v.ok).toBe(false);
    expect(v.failed).toContain('codec');
  });

  it('refuses when either file cannot be read — fails CLOSED', () => {
    const junk = write(Buffer.from('this is not an mp4 at all', 'utf8'));
    expect(verifyDerivative(write(ORIGINAL()), junk).ok).toBe(false);
    expect(verifyDerivative(junk, write(fakeMp4({ padding: 4_000 }))).ok).toBe(false);
    expect(verifyDerivative(write(ORIGINAL()), junk).failed).toContain('readable');
  });

  it('reads the facts it compares', () => {
    const facts = inspectMp4(write(fakeMp4({ audioTracks: 1 })));
    expect(facts).not.toBeNull();
    expect(facts!.width).toBe(768);
    expect(facts!.height).toBe(1168);
    expect(facts!.frameCount).toBe(145);
    expect(facts!.audioStreams).toBe(1);
    expect(facts!.videoStreams).toBe(1);
    expect(facts!.videoCodec).toBe('h264');
    expect(facts!.faststart).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * 4. Adoption — a refusal changes nothing
 * ------------------------------------------------------------------ */

describe('adopting a derivative through the admin route', () => {
  const multipart = (bytes: Buffer, filename = 'opt.mp4', type = 'video/mp4') => {
    const boundary = '----over18opt';
    const head = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
        `Content-Type: ${type}\r\n\r\n`,
      'utf8',
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
    return {
      payload: Buffer.concat([head, bytes, tail]),
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    };
  };

  it('adopts a good derivative and records it', async () => {
    const original = fakeMp4({ padding: 60_000 });
    const { asset } = await makeUpload(original);
    const good = fakeMp4({ padding: 4_000 });
    const { payload, headers } = multipart(good);

    const res = await off.app.inject({
      method: 'POST',
      url: `/admin/content/assets/${asset.id}/optimised`,
      payload,
      headers,
      cookies: adminCookies,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().adopted).toBe(true);

    const [row] = await off.db
      .select()
      .from(characterVisualAssets)
      .where(eq(characterVisualAssets.id, asset.id));
    const provenance = row!.provenance as Record<string, unknown>;
    expect(typeof provenance.optimisedPath).toBe('string');
    expect(existsSync(provenance.optimisedPath as string)).toBe(true);
    // The ORIGINAL is still exactly where it was, untouched.
    expect(existsSync(provenance.storagePath as string)).toBe(true);
  });

  it('REFUSES a bad derivative and leaves the row untouched', async () => {
    const { asset } = await makeUpload(fakeMp4({ padding: 60_000 }));
    const bad = fakeMp4({ width: 320, padding: 4_000 });
    const { payload, headers } = multipart(bad);

    const res = await off.app.inject({
      method: 'POST',
      url: `/admin/content/assets/${asset.id}/optimised`,
      payload,
      headers,
      cookies: adminCookies,
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().failed).toContain('resolution');

    const [row] = await off.db
      .select()
      .from(characterVisualAssets)
      .where(eq(characterVisualAssets.id, asset.id));
    expect((row!.provenance as Record<string, unknown>).optimisedPath).toBeUndefined();
  });

  it('leaves no temp file behind after a refusal', async () => {
    const { asset, storagePath } = await makeUpload(fakeMp4({ padding: 60_000 }));
    const { payload, headers } = multipart(fakeMp4({ frames: 12, padding: 4_000 }));
    await off.app.inject({
      method: 'POST',
      url: `/admin/content/assets/${asset.id}/optimised`,
      payload,
      headers,
      cookies: adminCookies,
    });
    expect(existsSync(`${optimisedPathFor(storagePath, asset.id)}.tmp`)).toBe(false);
    expect(existsSync(optimisedPathFor(storagePath, asset.id))).toBe(false);
  });

  it('revoking clears the key but keeps BOTH files on disk', async () => {
    const { asset, storagePath } = await makeUpload(fakeMp4({ padding: 60_000 }));
    const { payload, headers } = multipart(fakeMp4({ padding: 4_000 }));
    await off.app.inject({
      method: 'POST',
      url: `/admin/content/assets/${asset.id}/optimised`,
      payload,
      headers,
      cookies: adminCookies,
    });

    const res = await off.app.inject({
      method: 'DELETE',
      url: `/admin/content/assets/${asset.id}/optimised`,
      cookies: adminCookies,
    });
    expect(res.statusCode).toBe(200);

    const [row] = await off.db
      .select()
      .from(characterVisualAssets)
      .where(eq(characterVisualAssets.id, asset.id));
    expect((row!.provenance as Record<string, unknown>).optimisedPath).toBeUndefined();
    // Nothing was destroyed — re-adopting is pointing at it again.
    expect(existsSync(optimisedPathFor(storagePath, asset.id))).toBe(true);
    expect(existsSync(storagePath)).toBe(true);
  });

  it('requires an admin session', async () => {
    const { asset } = await makeUpload(fakeMp4({ padding: 60_000 }));
    const { payload, headers } = multipart(fakeMp4({ padding: 4_000 }));
    const res = await off.app.inject({
      method: 'POST',
      url: `/admin/content/assets/${asset.id}/optimised`,
      payload,
      headers,
    });
    expect([401, 403]).toContain(res.statusCode);
  });
});
