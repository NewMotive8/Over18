import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { OhRequestError, getCharacterStatus } from '../services/my-ai/oh-client.js';
import { downloadPortrait, isRendered } from '../services/my-ai/my-ai-service.js';

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

    const path = await downloadPortrait(URL_AT_PROVIDER, dir, ID, noSleep);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(path).toBe(join(dir, 'my-ai', `${ID}.jpg`));
    expect(readFileSync(path)).toEqual(JPEG);
  });

  it('treats a 403 the same way — a signed URL a moment early', async () => {
    fetchMock.mockResolvedValueOnce(notOk(403)).mockResolvedValueOnce(ok());
    await expect(downloadPortrait(URL_AT_PROVIDER, dir, ID, noSleep)).resolves.toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('gives up after the cap rather than asking for ever', async () => {
    fetchMock.mockResolvedValue(notOk(404));

    await expect(downloadPortrait(URL_AT_PROVIDER, dir, ID, noSleep, 3)).rejects.toThrow(
      OhRequestError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('waits between attempts, and not after the last one', async () => {
    fetchMock.mockResolvedValue(notOk(404));
    const sleep = vi.fn(() => Promise.resolve());

    await expect(downloadPortrait(URL_AT_PROVIDER, dir, ID, sleep, 3)).rejects.toThrow();
    expect(sleep).toHaveBeenCalledTimes(2); // 3 attempts, 2 gaps
  });
});

describe('what is not worth asking twice', () => {
  it('stops at the first answer that is not a 404 or a 403', async () => {
    fetchMock.mockResolvedValue(notOk(500));

    await expect(downloadPortrait(URL_AT_PROVIDER, dir, ID, noSleep)).rejects.toThrow(
      /picture could not be downloaded/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('names the provider’s status for the log, and nothing else for the user', async () => {
    fetchMock.mockResolvedValue(notOk(500));

    const error = await downloadPortrait(URL_AT_PROVIDER, dir, ID, noSleep).catch((e) => e);
    expect(error).toBeInstanceOf(OhRequestError);
    expect((error as OhRequestError).providerDetail).toBe('portrait download 500');
    // The owner is told something plain -- never a URL, never provider text.
    expect(error.message).not.toContain('example.invalid');
  });

  it('refuses an empty body or an implausibly large one', async () => {
    fetchMock.mockResolvedValue(ok(Buffer.alloc(0)));
    await expect(downloadPortrait(URL_AT_PROVIDER, dir, ID, noSleep)).rejects.toThrow(
      OhRequestError,
    );

    fetchMock.mockResolvedValue(ok(Buffer.alloc(16 * 1024 * 1024)));
    await expect(downloadPortrait(URL_AT_PROVIDER, dir, ID, noSleep)).rejects.toThrow(
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
   * THE REGRESSION ITSELF. Having a URL is not having a picture, and the
   * download must sit behind the wait, not in front of it.
   */
  it('the generation waits for a drawn status before it fetches anything', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../services/my-ai/my-ai-service.ts', import.meta.url)),
      'utf8',
    );
    expect(source).toContain('while (!isRendered(status) && now() < deadline)');
    expect(source).toContain('if (!isRendered(status)) {');
    // The URL is the 202's; the poll only ever adds one, never clears it.
    expect(source).toContain('imageUrl = polled.images?.nsfw_image ?? polled.images?.sfw_image ?? imageUrl;');
    // And the download happens after that loop, not inside the accept step.
    expect(source.indexOf('const imagePath = await downloadPortrait(')).toBeGreaterThan(
      source.indexOf('while (!isRendered(status)'),
    );
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
