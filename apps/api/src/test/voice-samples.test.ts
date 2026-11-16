import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTestContext, destroyTestContext, testEnv, type TestContext } from './helpers.js';

/**
 * The public voice preview, used by the My AI wizard.
 *
 * TWO THINGS THIS HOLDS. First, that a visitor hears the voice a call would
 * actually use: the names on offer are SpicyAPI's, the cached samples are
 * xAI's, and the route maps between them with the SAME function the call path
 * uses. Second, that a name nobody recognises is a 404 and not a stand-in —
 * `resolveGrokVoice` answers a default for anything unknown, which is correct
 * when somebody has to speak and wrong when somebody is choosing.
 */

const MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(128, 0x11)]);
const sampleDir = join(testEnv.media.storageDir, 'voice-samples');

let on: TestContext;

beforeAll(async () => {
  mkdirSync(sampleDir, { recursive: true });
  // `eve` is what Serena maps to; `ara` is Tina's. Nothing is written for
  // `carina`, so Maia stands for a voice whose sample has not been generated.
  writeFileSync(join(sampleDir, 'eve.mp3'), MP3);
  writeFileSync(join(sampleDir, 'ara.mp3'), MP3);
  rmSync(join(sampleDir, 'carina.mp3'), { force: true });
  on = await createTestContext();
});
afterAll(async () => destroyTestContext(on));

describe('hearing a voice before choosing it', () => {
  it('serves the mapped sample for a name the wizard offers', async () => {
    const res = await on.app.inject({ method: 'GET', url: '/api/voice-samples/Serena' });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('audio/mpeg');
    expect(res.rawPayload.length).toBe(MP3.length);
  });

  it('serves a Grok voice asked for by its own id', async () => {
    const res = await on.app.inject({ method: 'GET', url: '/api/voice-samples/ara' });
    expect(res.statusCode).toBe(200);
  });

  it('needs no session — the wizard is playable signed out', async () => {
    // Deliberately unlike `/admin/voice/samples/:voice`, which is adminOnly.
    const res = await on.app.inject({ method: 'GET', url: '/api/voice-samples/Serena' });
    expect(res.statusCode).toBe(200);
  });

  it('lets a shared cache hold it: the bytes are the same for everyone', async () => {
    const res = await on.app.inject({ method: 'GET', url: '/api/voice-samples/Serena' });
    expect(res.headers['cache-control']).toContain('public');
    expect(res.headers['cache-control']).toContain('immutable');
  });
});

describe('what it refuses', () => {
  it('404s a name nobody has, rather than playing the default voice', async () => {
    // The trap: `resolveGrokVoice` answers `eve` for anything unknown, so a
    // route that resolved first would play Serena's voice to someone who
    // asked about "Beyoncé" and let them believe they had heard her.
    for (const name of ['Beyonce', 'definitely-not-a-voice', 'EVE_NOT_REAL']) {
      const res = await on.app.inject({ method: 'GET', url: `/api/voice-samples/${name}` });
      expect(res.statusCode, name).toBe(404);
    }
  });

  it('404s a real voice whose sample has not been generated here', async () => {
    // Maia maps to `carina`, and no file was written for it. An ordinary
    // state: the samples are per-environment files, not code.
    const res = await on.app.inject({ method: 'GET', url: '/api/voice-samples/Maia' });
    expect(res.statusCode).toBe(404);
  });

  it('never serves audio for an absurd length', async () => {
    const res = await on.app.inject({
      method: 'GET',
      url: `/api/voice-samples/${'a'.repeat(300)}`,
    });
    // Fastify's own URI limit answers 414 before the handler is reached; the
    // route's 40-character cap is the backstop for anything under that.
    // Either way nothing is read from disk and no audio comes back.
    expect([404, 414]).toContain(res.statusCode);
    expect(res.headers['content-type'] ?? '').not.toContain('audio');
  });

  it('cannot be talked into reading another file', async () => {
    for (const attempt of ['..%2F..%2Fetc%2Fpasswd', '%2E%2E%2Fcost-ledger.json', 'eve.mp3']) {
      const res = await on.app.inject({ method: 'GET', url: `/api/voice-samples/${attempt}` });
      expect(res.statusCode, attempt).toBe(404);
    }
  });
});
