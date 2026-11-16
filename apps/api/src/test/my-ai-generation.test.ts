import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { OhRequestError, getCharacterStatus } from '../services/my-ai/oh-client.js';
import { isRendered } from '../services/my-ai/my-ai-service.js';
import { downloadImage } from '../services/my-ai/media.js';

/**
 * Getting her picture off the provider and onto our volume.
 *
 * WHY THIS SUITE EXISTS. The very first companion anyone created on staging
 * failed 1.3 seconds in, on `portrait download 404`, and the cause was a
 * wrong assumption rather than a wrong value: OhAPI names the image URL in
 * the response that ACCEPTS the job, about eleven seconds before the file
 * behind it exists. The old code treated "I have a URL" as "she is drawn".
 *
 * No database and no network: the provider is a stubbed `fetch`, which is the
 * only way to exercise a sequence of provider responses at all.
 */

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(512, 0x7a)]);
const ID = 'bd632a62-24bf-4b35-a589-e023e0235a30';
const URL_AT_PROVIDER = 'https://cdn.example.invalid/characters/abc/nsfw.jpg';

/** Never actually waits: the retry gap is a parameter, not a test's problem. */
const noSleep = () => Promise.resolve();

const ok = (body = JPEG) => ({
  ok: true,
  status: 200,
  arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
});
const notOk = (status: number) => ({ ok: false, status, arrayBuffer: async () => new ArrayBuffer(0) });

let dir: string;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'over18-my-ai-'));
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});

describe('a 404 just after she is drawn means “not uploaded yet”', () => {
  it('asks again, and keeps the picture when it appears', async () => {
    fetchMock.mockResolvedValueOnce(notOk(404)).mockResolvedValueOnce(ok());

    const path = await downloadImage(URL_AT_PROVIDER, dir, 'my-ai', ID, noSleep);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(path).toBe(join(dir, 'my-ai', `${ID}.jpg`));
    expect(readFileSync(path)).toEqual(JPEG);
  });

  it('treats a 403 the same way — a signed URL a moment early', async () => {
    fetchMock.mockResolvedValueOnce(notOk(403)).mockResolvedValueOnce(ok());
    await expect(downloadImage(URL_AT_PROVIDER, dir, 'my-ai', ID, noSleep)).resolves.toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('gives up after the cap rather than asking for ever', async () => {
    fetchMock.mockResolvedValue(notOk(404));

    await expect(downloadImage(URL_AT_PROVIDER, dir, 'my-ai', ID, noSleep, 3)).rejects.toThrow(
      OhRequestError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('waits between attempts, and not after the last one', async () => {
    fetchMock.mockResolvedValue(notOk(404));
    const sleep = vi.fn(() => Promise.resolve());

    await expect(downloadImage(URL_AT_PROVIDER, dir, 'my-ai', ID, sleep, 3)).rejects.toThrow();
    expect(sleep).toHaveBeenCalledTimes(2); // 3 attempts, 2 gaps
  });
});

describe('what is not worth asking twice', () => {
  it('stops at the first answer that is not a 404 or a 403', async () => {
    fetchMock.mockResolvedValue(notOk(500));

    await expect(downloadImage(URL_AT_PROVIDER, dir, 'my-ai', ID, noSleep)).rejects.toThrow(
      /picture could not be downloaded/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('names the provider’s status for the log, and nothing else for the user', async () => {
    fetchMock.mockResolvedValue(notOk(500));

    const error = await downloadImage(URL_AT_PROVIDER, dir, 'my-ai', ID, noSleep).catch((e) => e);
    expect(error).toBeInstanceOf(OhRequestError);
    expect((error as OhRequestError).providerDetail).toBe('image download 500');
    // The owner is told something plain -- never a URL, never provider text.
    expect(error.message).not.toContain('example.invalid');
  });

  it('refuses an empty body or an implausibly large one', async () => {
    fetchMock.mockResolvedValue(ok(Buffer.alloc(0)));
    await expect(downloadImage(URL_AT_PROVIDER, dir, 'my-ai', ID, noSleep)).rejects.toThrow(
      OhRequestError,
    );

    fetchMock.mockResolvedValue(ok(Buffer.alloc(16 * 1024 * 1024)));
    await expect(downloadImage(URL_AT_PROVIDER, dir, 'my-ai', ID, noSleep)).rejects.toThrow(
      OhRequestError,
    );
  });
});

describe('when she counts as drawn', () => {
  it('is the provider’s finished states, bookkeeping included', () => {
    expect(isRendered('ready')).toBe(true);
    // A poll can land after OhAPI has moved past `ready` on its own.
    expect(isRendered('saving')).toBe(true);
    expect(isRendered('saved')).toBe(true);

    expect(isRendered('draft')).toBe(false);
    expect(isRendered('generating')).toBe(false);
    expect(isRendered('failed')).toBe(false);
  });

  /*
   * THE REGRESSION ITSELF, twice over.
   *
   * First: having a URL is not having a picture — the download must sit
   * behind the wait, not in front of it.
   *
   * Second, and the reason Honda arrived naked: the provider's REFERENCE
   * image is never what we show. It is a single canonical body render and
   * nothing on the character request dresses it. Her portrait is a prompted
   * photograph, made after she is saved.
   */
  it('waits for a drawn status, and never downloads the reference image', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../services/my-ai/my-ai-service.ts', import.meta.url)),
      'utf8',
    );
    expect(source).toContain('while (!isRendered(status) && now() < deadline)');
    expect(source).toContain('if (!isRendered(status)) {');

    // The naked one is never fetched, by any name.
    expect(source).not.toContain('nsfw_image');
    expect(source).not.toContain('await downloadPortrait(');

    // Her picture is asked for in words, after the save that mints her id.
    expect(source).toContain('openingPhotoPrompt({');
    expect(source.indexOf('await renderPhotoToFile(')).toBeGreaterThan(
      source.indexOf('const characterId = await awaitSavedId('),
    );
  });

  it('keeps her when the opening photo fails, rather than falling back to the nude one', () => {
    // The character is the expensive, irreversible part and it is already
    // saved by then. She arrives without a picture and her page invites one.
    const source = readFileSync(
      fileURLToPath(new URL('../services/my-ai/my-ai-service.ts', import.meta.url)),
      'utf8',
    );
    expect(source).toContain("'my-ai: opening photo failed; she exists without a picture'");
    // The picture's outcome is recorded; her own status is NOT re-asserted.
    expect(source).toContain("portraitStatus: imagePath ? ('ready' as const) : ('failed' as const),");
  });

  /*
   * ── SHE IS FINISHED BEFORE HER PHOTOGRAPH IS ──────────────────────────────
   *
   * Measured on staging four times: drawn in 15-19s, a further ~17s for the
   * provider save, then a 53-second second render for her opening photograph.
   * Nothing that makes her usable depends on the last two — her conversation
   * is built from her own attributes — so `ready` is set at the drawing and
   * the picture lands behind her. This is the ordering that makes creation
   * take twenty seconds instead of ninety, so it is pinned here.
   */
  it('marks her ready when she is drawn, long before the save and the photograph', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../services/my-ai/my-ai-service.ts', import.meta.url)),
      'utf8',
    );

    const flip = source.indexOf(".set({ status: 'ready', errorMessage: null, updatedAt: new Date() })");
    const save = source.indexOf('const characterId = await awaitSavedId(');
    const photo = source.indexOf('await renderPhotoToFile(');

    expect(flip).toBeGreaterThan(-1);
    expect(flip).toBeLessThan(save);
    expect(flip).toBeLessThan(photo);

    // And the save still precedes the photograph: the provider answers
    // `404 Character <guid> not found` when the image endpoint is handed a
    // guid, so an unsaved character cannot be photographed at all.
    expect(save).toBeLessThan(photo);
  });

  it('does not fail a companion her owner is already talking to', () => {
    /*
     * The provider save throws from between the flip and the photograph. Before
     * this, such a throw reached the outer catch and marked her `failed` —
     * "she could not be created", about a companion already on the list and
     * answering messages.
     */
    const source = readFileSync(
      fileURLToPath(new URL('../services/my-ai/my-ai-service.ts', import.meta.url)),
      'utf8',
    );
    expect(source).toContain('let isUsable = false;');
    expect(source).toContain('isUsable = true;');

    const guard = source.indexOf('if (isUsable) {');
    const failCall = source.indexOf('await fail(\n      db,\n      companionId,');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(failCall);
  });
});

describe('the provider id that makes a second photograph possible', () => {
  const env = { ohApiKey: 'test-key', ohBaseUrl: 'https://provider.invalid', timeoutMs: 5_000 };
  const json = (body: unknown) => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
  });

  /*
   * THE DISTINCTION THIS EXISTS TO HOLD. The guid names a generation job and
   * exists from the moment OhAPI accepts one. The numeric id appears only
   * once she is SAVED, and it is what their image endpoint addresses a
   * character by -- so reading it is how "another photograph of her" ever
   * becomes possible. Both states were measured live on staging.
   */
  it('reads the number from a saved character', async () => {
    fetchMock.mockResolvedValue(
      json({ characterGuid: 'g', status: 'saved', characterId: 27956, errorMessage: null }),
    );
    const status = await getCharacterStatus(env, 'g');
    expect(status.status).toBe('saved');
    expect(status.characterId).toBe(27956);
  });

  it('reports null for one that is drawn but not saved', async () => {
    fetchMock.mockResolvedValue(
      json({ characterGuid: 'g', status: 'ready', characterId: null, errorMessage: null }),
    );
    const status = await getCharacterStatus(env, 'g');
    expect(status.status).toBe('ready');
    expect(status.characterId).toBeNull();
  });

  it('never invents one from a body that omits it', async () => {
    fetchMock.mockResolvedValue(json({ characterGuid: 'g', status: 'generating' }));
    expect((await getCharacterStatus(env, 'g')).characterId).toBeNull();
  });

  it('is stored on the companion once the save lands', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../services/my-ai/my-ai-service.ts', import.meta.url)),
      'utf8',
    );
    expect(source).toContain('await saveCharacter(env, started.characterGuid);');
    expect(source).toContain('const characterId = await awaitSavedId(deps, started.characterGuid);');
    expect(source).toContain('.set({ providerCharacterId: characterId, updatedAt: new Date() })');
  });
});
