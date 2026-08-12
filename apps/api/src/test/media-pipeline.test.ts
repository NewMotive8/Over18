import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CostLedger } from '../media-pipeline/cost-ledger.js';
import { createAtlasProviders, normalizeFluxSize } from '../media-pipeline/atlas-adapter.js';
import { createMockProviders } from '../media-pipeline/mock-adapter.js';
import { qaImage, qaVideo } from '../media-pipeline/media-qa.js';
import { MediaPipeline, PipelineRefusal } from '../media-pipeline/pipeline.js';
import { ProviderError } from '../media-pipeline/types.js';

/**
 * US-16E — offline media pipeline. No network, no spend: everything runs
 * against the mock provider, injected fetch fakes, and the REAL approved
 * Luna/Ember media files as representative fixtures.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_MEDIA = resolve(HERE, '..', '..', '..', 'web', 'public', 'media');
const LUNA_MP4 = join(WEB_MEDIA, 'luna', 'profile-04.mp4');
const LUNA_JPG = join(WEB_MEDIA, 'luna', 'profile-04.jpg');
const EMBER_MP4 = join(WEB_MEDIA, 'ember', 'hero.mp4');
const EMBER_JPG = join(WEB_MEDIA, 'ember', 'hero.jpg');

const FAKE_KEY = 'sk-atlas-test-DO-NOT-LEAK-9f8e7d6c';

let root: string;
let ledgerFile: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'media-pipeline-'));
  ledgerFile = join(root, 'sprint-ledger.json');
  process.env.ATLASCLOUD_API_KEY = FAKE_KEY; // present so secret-leak tests are meaningful
});

afterEach(() => {
  delete process.env.ATLASCLOUD_API_KEY;
});

function mockProviders(failureMode?: 'provider_error' | 'malformed_response') {
  return createMockProviders({ imageFixturePath: LUNA_JPG, videoFixturePath: LUNA_MP4, failureMode });
}

function makePipeline(options?: { budget?: number; ledger?: CostLedger; failureMode?: 'provider_error' | 'malformed_response' }) {
  const ledger = options?.ledger ?? new CostLedger(ledgerFile);
  return new MediaPipeline(root, 'nova', mockProviders(options?.failureMode), ledger, options?.budget, 'run-test');
}

// ───────────────────────── cost accounting ────────────────────────────────

describe('cost ledger', () => {
  it('refuses unknown/invalid costs — never treats unknown as zero', () => {
    const ledger = new CostLedger(ledgerFile);
    for (const bad of [Number.NaN, 0, -1, Number.POSITIVE_INFINITY]) {
      const auth = ledger.authorize(bad, 'nova');
      expect(auth.ok).toBe(false);
      expect(auth.reason).toContain('unknown');
    }
    expect(() =>
      ledger.record({
        runId: 'r',
        character: 'nova',
        provider: 'mock',
        model: 'm',
        operation: 'image',
        status: 'succeeded',
        unit: 'image',
        quantity: 1,
        unitCostUsd: Number.NaN,
        estimatedCostUsd: Number.NaN,
      }),
    ).toThrow(/invalid cost/);
  });

  it('enforces the per-character budget BEFORE a call', () => {
    const ledger = new CostLedger(ledgerFile);
    ledger.record({
      runId: 'r',
      character: 'nova',
      provider: 'mock',
      model: 'm',
      operation: 'image',
      status: 'succeeded',
      unit: 'image',
      quantity: 1,
      unitCostUsd: 4.9,
      estimatedCostUsd: 4.9,
    });
    expect(ledger.authorize(0.2, 'nova', 5).ok).toBe(false);
    expect(ledger.authorize(0.05, 'nova', 5).ok).toBe(true);
    // Another character's spend does not count against nova's budget…
    expect(ledger.authorize(0.2, 'other', 5).ok).toBe(true);
  });

  it('enforces the sprint hard stop and emits the soft warning', () => {
    const ledger = new CostLedger(ledgerFile, { sprintCeilingUsd: 75, hardStopUsd: 60, softWarnUsd: 40 });
    ledger.record({
      runId: 'r',
      character: 'nova',
      provider: 'mock',
      model: 'm',
      operation: 'video',
      status: 'succeeded',
      unit: 'second',
      quantity: 5,
      unitCostUsd: 11.99,
      estimatedCostUsd: 59.95,
    });
    const refused = ledger.authorize(0.1, 'nova');
    expect(refused.ok).toBe(false);
    expect(refused.reason).toContain('HARD STOP');
    // Below hard stop but above soft warn → allowed with warning.
    const warned = new CostLedger(join(root, 'ledger2.json'), { sprintCeilingUsd: 75, hardStopUsd: 60, softWarnUsd: 40 });
    warned.record({
      runId: 'r',
      character: 'nova',
      provider: 'mock',
      model: 'm',
      operation: 'video',
      status: 'succeeded',
      unit: 'second',
      quantity: 5,
      unitCostUsd: 8,
      estimatedCostUsd: 40,
    });
    const auth = warned.authorize(0.1, 'nova');
    expect(auth.ok).toBe(true);
    expect(auth.softWarning).toContain('soft warning');
  });

  it('counts FAILED attempts toward spend (conservative accounting) and persists across reloads', () => {
    const ledger = new CostLedger(ledgerFile);
    ledger.record({
      runId: 'r',
      character: 'nova',
      provider: 'mock',
      model: 'm',
      operation: 'image',
      status: 'failed',
      unit: 'image',
      quantity: 1,
      unitCostUsd: 0.025,
      estimatedCostUsd: 0.025,
    });
    const reloaded = new CostLedger(ledgerFile);
    expect(reloaded.cumulativeUsd).toBeCloseTo(0.025, 6);
    expect(reloaded.characterSpentUsd('nova')).toBeCloseTo(0.025, 6);
  });
});

// ───────────────────────── successful mock flow ───────────────────────────

describe('pipeline happy path (mock provider, real fixture media)', () => {
  it('generates candidates, selects canonical, generates video, approves with QA + poster', async () => {
    const pipeline = makePipeline({ budget: 5 });

    const images = await pipeline.generateImageCandidates('portrait test prompt', 2);
    expect(images).toHaveLength(2);
    images.forEach((f) => expect(existsSync(f)).toBe(true));

    const canonical = pipeline.selectCanonical(images[0]!);
    expect(existsSync(canonical)).toBe(true);
    // Second selection without --replace is refused (no silent overwrite).
    expect(() => pipeline.selectCanonical(images[1]!)).toThrow(/already exists/);

    const videos = await pipeline.generateVideoCandidates('gentle motion test', 1, { durationSeconds: 5 });
    expect(videos).toHaveLength(1);

    const approved = pipeline.approveVideo(videos[0]!, { humanApproval: 'erez (test)' });
    expect(approved.qa.pass).toBe(true);
    expect(existsSync(approved.video)).toBe(true);
    expect(existsSync(approved.poster)).toBe(true);
    // Approved lives in approved/, candidate remains untouched in candidates/.
    expect(approved.video).toContain(join('nova', 'approved'));
    expect(existsSync(videos[0]!)).toBe(true);

    // Re-approval never overwrites implicitly.
    expect(() => pipeline.approveVideo(videos[0]!, { humanApproval: 'erez (test)' })).toThrow(/already exists/);
    // Human attribution is mandatory.
    expect(() => pipeline.approveVideo(videos[0]!, { humanApproval: '', as: 'alt' })).toThrow(/human/i);

    // Auditable run record: what, which model, source reference, cost, approval.
    const events = pipeline.events();
    const actions = events.map((e) => e.action);
    expect(actions).toContain('generate_image');
    expect(actions).toContain('select_canonical');
    expect(actions).toContain('generate_video');
    expect(actions).toContain('approve');
    expect(actions).toContain('approve_refused');
    const gen = events.find((e) => e.action === 'generate_video')!;
    expect(gen.model).toBe('mock-video-fixture');
    expect(gen.referenceImage).toContain('reference.jpg');
    expect(gen.estimatedCostUsd).toBeCloseTo(0.1, 6);
    const approve = events.find((e) => e.action === 'approve')!;
    expect(approve.reason).toContain('erez (test)');
  });

  it('records rejections with a mandatory reason', async () => {
    const pipeline = makePipeline();
    const images = await pipeline.generateImageCandidates('p', 1);
    expect(() => pipeline.reject(images[0]!, '   ')).toThrow(/reason/);
    pipeline.reject(images[0]!, 'hands malformed');
    const rejection = pipeline.events().find((e) => e.action === 'reject')!;
    expect(rejection.reason).toBe('hands malformed');
  });

  it('refuses video generation before a canonical reference exists', async () => {
    const pipeline = makePipeline();
    await expect(pipeline.generateVideoCandidates('motion', 1)).rejects.toThrow(/canonical/);
  });
});

// ───────────────────────── failure safety ─────────────────────────────────

describe('pipeline failure safety', () => {
  it('provider failure: throws, records a FAILED (still costed) attempt, produces no candidate', async () => {
    const ledger = new CostLedger(ledgerFile);
    const pipeline = makePipeline({ ledger, failureMode: 'provider_error' });
    await expect(pipeline.generateImageCandidates('p', 1)).rejects.toThrow(/500/);
    expect(ledger.cumulativeUsd).toBeCloseTo(0.025, 6); // failure ≠ free
    expect(readdirSync(join(root, 'nova', 'candidates', 'images'))).toHaveLength(0);
    const failed = pipeline.events().find((e) => e.action === 'generation_failed')!;
    expect(failed.reason).toContain('500');
  });

  it('malformed provider response: throws, never records a false success', async () => {
    const pipeline = makePipeline({ failureMode: 'malformed_response' });
    await expect(pipeline.generateImageCandidates('p', 1)).rejects.toThrow(/unexpected response/);
    expect(pipeline.events().some((e) => e.action === 'generate_image')).toBe(false);
  });

  it('character budget refusal happens BEFORE the paid call: no ledger entry, no file', async () => {
    const ledger = new CostLedger(ledgerFile);
    const pipeline = makePipeline({ ledger, budget: 0.01 }); // image costs 0.025
    await expect(pipeline.generateImageCandidates('p', 1)).rejects.toThrow(PipelineRefusal);
    expect(ledger.cumulativeUsd).toBe(0);
    expect(readdirSync(join(root, 'nova', 'candidates', 'images'))).toHaveLength(0);
    expect(pipeline.events().at(-1)!.action).toBe('generation_refused');
  });

  it('sprint hard stop blocks generation across characters', async () => {
    const ledger = new CostLedger(ledgerFile, { sprintCeilingUsd: 0.05, hardStopUsd: 0.04, softWarnUsd: 0.01 });
    const pipeline = new MediaPipeline(root, 'nova', mockProviders(), ledger, undefined, 'run-test');
    await pipeline.generateImageCandidates('p', 1); // 0.025 spent (soft-warned)
    await expect(pipeline.generateImageCandidates('p', 1)).rejects.toThrow(/HARD STOP/);
    expect(ledger.summary().entries).toBe(1);
  });

  it('a file failing technical QA can never be approved', () => {
    const pipeline = makePipeline();
    const junk = join(root, 'nova', 'candidates', 'videos', 'junk.mp4');
    writeFileSync(junk, 'this is not a video');
    expect(() => pipeline.approveVideo(junk, { humanApproval: 'erez (test)' })).toThrow(/technical QA/);
    expect(existsSync(join(root, 'nova', 'approved', 'hero.mp4'))).toBe(false);
  });
});

// ───────────────────────── secrets never leak ─────────────────────────────

describe('secret hygiene', () => {
  it('the API key never appears in the ledger or run record', async () => {
    const pipeline = makePipeline({ budget: 5 });
    const images = await pipeline.generateImageCandidates('p', 1);
    pipeline.selectCanonical(images[0]!);
    await pipeline.generateVideoCandidates('m', 1);
    for (const file of [ledgerFile, join(root, 'nova', 'run-record.json')]) {
      expect(readFileSync(file, 'utf8')).not.toContain(FAKE_KEY);
    }
  });

  it('atlas adapter errors never contain the key', async () => {
    const atlas = createAtlasProviders({
      contractConfirmed: true,
      fetchImpl: async () => new Response('{}', { status: 500 }),
    });
    try {
      await atlas.image.generateImage({ prompt: 'p', width: 1080, height: 1920, outputPath: join(root, 'x.jpg') });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(String(err)).not.toContain(FAKE_KEY);
      expect((err as ProviderError).kind).toBe('http');
    }
  });
});

// ───────────────────────── atlas adapter (no network) ─────────────────────

describe('atlas adapter contract guards', () => {
  it('refuses to run until the live contract is confirmed', async () => {
    const atlas = createAtlasProviders({});
    await expect(
      atlas.image.generateImage({ prompt: 'p', width: 1080, height: 1920, outputPath: join(root, 'x.jpg') }),
    ).rejects.toMatchObject({ kind: 'not_verified' });
  });

  it('refuses without ATLASCLOUD_API_KEY', async () => {
    delete process.env.ATLASCLOUD_API_KEY;
    const atlas = createAtlasProviders({ contractConfirmed: true, fetchImpl: async () => new Response('{}') });
    await expect(
      atlas.image.generateImage({ prompt: 'p', width: 1080, height: 1920, outputPath: join(root, 'x.jpg') }),
    ).rejects.toMatchObject({ kind: 'auth' });
  });

  it('treats an unexpected response shape as malformed — never a false success', async () => {
    const atlas = createAtlasProviders({
      contractConfirmed: true,
      fetchImpl: async () => new Response(JSON.stringify({ surprise: true }), { status: 200 }),
    });
    await expect(
      atlas.image.generateImage({ prompt: 'p', width: 1080, height: 1920, outputPath: join(root, 'x.jpg') }),
    ).rejects.toMatchObject({ kind: 'malformed_response' });
    expect(existsSync(join(root, 'x.jpg'))).toBe(false);
  });

  it('normalizes requested sizes to FLUX-native dimensions (multiples of 16, <=2MP)', () => {
    // The approved-media target 1080x1920 is NOT FLUX-valid (1080 % 16 != 0)
    // and slightly exceeds the recommended 2MP: scaled + snapped.
    expect(normalizeFluxSize(1080, 1920)).toEqual({ width: 1056, height: 1888 });
    // Already-valid sizes pass through untouched.
    expect(normalizeFluxSize(1024, 1024)).toEqual({ width: 1024, height: 1024 });
    expect(normalizeFluxSize(1008, 1792)).toEqual({ width: 1008, height: 1792 });
    // Oversized requests are scaled under the pixel cap, preserving aspect.
    const big = normalizeFluxSize(4000, 8000);
    expect(big.width % 16).toBe(0);
    expect(big.height % 16).toBe(0);
    expect(big.width * big.height).toBeLessThanOrEqual(2_100_000);
    expect(Math.abs(big.width / big.height - 0.5)).toBeLessThan(0.01);
    // Tiny inputs clamp to the model minimum.
    expect(normalizeFluxSize(10, 10)).toEqual({ width: 64, height: 64 });
    // Nonsense is rejected, never silently sent.
    expect(() => normalizeFluxSize(0, 1920)).toThrow();
    // Aspect drift from snapping stays under 1% for the target size.
    const n = normalizeFluxSize(1080, 1920);
    expect(Math.abs(n.width / n.height - 1080 / 1920)).toBeLessThan(0.01 * (1080 / 1920));
  });

  it('REGRESSION (US-36 404): image submit hits the exact documented endpoint with the documented body', async () => {
    const calls: Array<{ url: string; body?: string }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      calls.push({ url, body: init?.body ? String(init.body) : undefined });
      if (url === 'https://api.atlascloud.ai/api/v1/model/generateImage') {
        // documented sync-ish variant: already completed with output array
        return new Response(
          JSON.stringify({ id: 'img-1', status: 'completed', output: ['https://cdn.example/img.jpg'], urls: { result: 'https://api.atlascloud.ai/api/v1/model/prediction/img-1' } }),
          { status: 200 },
        );
      }
      if (url === 'https://cdn.example/img.jpg') return new Response(readFileSync(LUNA_JPG), { status: 200 });
      return new Response('not found', { status: 404 });
    };
    const atlas = createAtlasProviders({ contractConfirmed: true, fetchImpl, pollIntervalMs: 1 });
    const out = join(root, 'atlas-img.jpg');
    await atlas.image.generateImage({ prompt: 'probe', width: 1080, height: 1920, outputPath: out });
    expect(existsSync(out)).toBe(true);
    // The exact endpoint that previously 404'd:
    expect(calls[0]!.url).toBe('https://api.atlascloud.ai/api/v1/model/generateImage');
    const body = JSON.parse(calls[0]!.body!);
    expect(body.model).toBe('black-forest-labs/flux-kontext-dev');
    expect(body.prompt).toBe('probe');
    expect(body.size).toBe('1056*1888'); // FLUX-native normalization of the 1080x1920 target, asterisk format
    expect(body.num_images).toBe(1);
  });

  it('documented async flow: processing envelope → poll urls.result → output array → bytes on disk', async () => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      calls.push(url);
      if (url === 'https://api.atlascloud.ai/api/v1/model/generateVideo') {
        return new Response(
          JSON.stringify({ id: 'pred-1', status: 'processing', output: [], urls: { result: 'https://api.atlascloud.ai/api/v1/model/prediction/pred-1' } }),
          { status: 200 },
        );
      }
      if (url === 'https://api.atlascloud.ai/api/v1/model/prediction/pred-1') {
        return new Response(JSON.stringify({ id: 'pred-1', status: 'completed', output: ['https://cdn.example/clip.mp4'] }), { status: 200 });
      }
      if (url === 'https://cdn.example/clip.mp4') return new Response(readFileSync(LUNA_MP4), { status: 200 });
      return new Response('not found', { status: 404 });
    };
    const atlas = createAtlasProviders({ contractConfirmed: true, fetchImpl, pollIntervalMs: 1 });
    const out = join(root, 'atlas-clip.mp4');
    const result = await atlas.video.imageToVideo({
      referenceImagePath: LUNA_JPG,
      prompt: 'gentle motion',
      durationSeconds: 5,
      resolution: '1080p',
      outputPath: out,
    });
    expect(existsSync(out)).toBe(true);
    expect(result.estimatedCostUsd).toBeCloseTo(0.5, 6); // 5s × $0.10
    expect(calls[0]).toBe('https://api.atlascloud.ai/api/v1/model/generateVideo');
    expect(calls[1]).toBe('https://api.atlascloud.ai/api/v1/model/prediction/pred-1'); // polls the envelope's ABSOLUTE urls.result
  });

  it('HTTP 404 from Atlas surfaces as a clear http error with the path, never a success', async () => {
    const atlas = createAtlasProviders({
      contractConfirmed: true,
      fetchImpl: async () => new Response('not found', { status: 404 }),
    });
    try {
      await atlas.image.generateImage({ prompt: 'p', width: 1080, height: 1920, outputPath: join(root, 'x.jpg') });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as ProviderError).kind).toBe('http');
      expect((err as Error).message).toContain('404');
      expect((err as Error).message).toContain('/model/generateImage');
    }
    expect(existsSync(join(root, 'x.jpg'))).toBe(false);
  });

  it('failed generation status aborts without writing output', async () => {
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith('/model/generateVideo')) {
        return new Response(
          JSON.stringify({ id: 'pred-2', status: 'processing', urls: { result: 'https://api.atlascloud.ai/api/v1/model/prediction/pred-2' } }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ id: 'pred-2', status: 'failed' }), { status: 200 });
    };
    const atlas = createAtlasProviders({ contractConfirmed: true, fetchImpl, pollIntervalMs: 1 });
    await expect(
      atlas.video.imageToVideo({
        referenceImagePath: LUNA_JPG,
        prompt: 'p',
        durationSeconds: 5,
        resolution: '1080p',
        outputPath: join(root, 'never.mp4'),
      }),
    ).rejects.toMatchObject({ kind: 'http' });
    expect(existsSync(join(root, 'never.mp4'))).toBe(false);
  });

  it('unknown non-terminal statuses re-poll (documented client behavior) and are never success by themselves', async () => {
    let polls = 0;
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith('/model/generateImage')) {
        return new Response(JSON.stringify({ data: { id: 'x', status: 'transmogrifying' } }), { status: 200 });
      }
      if (url.endsWith('/model/prediction/x')) {
        polls += 1;
        return polls < 2
          ? new Response(JSON.stringify({ data: { id: 'x', status: 'still-transmogrifying' } }), { status: 200 })
          : new Response(JSON.stringify({ data: { id: 'x', status: 'completed', outputs: ['https://cdn.example/u.jpg'] } }), { status: 200 });
      }
      if (url === 'https://cdn.example/u.jpg') return new Response(readFileSync(LUNA_JPG), { status: 200 });
      return new Response('not found', { status: 404 });
    };
    const atlas = createAtlasProviders({ contractConfirmed: true, fetchImpl, pollIntervalMs: 1 });
    const out = join(root, 'unknown-status.jpg');
    await atlas.image.generateImage({ prompt: 'p', width: 1080, height: 1920, outputPath: out });
    expect(existsSync(out)).toBe(true);
    expect(polls).toBe(2); // unknown statuses re-polled, success only on terminal completed
  });

  it('unknown non-terminal statuses time out at the deadline rather than looping forever', async () => {
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith('/model/generateImage')) {
        return new Response(JSON.stringify({ data: { id: 'y', status: 'transmogrifying' } }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: { id: 'y', status: 'transmogrifying' } }), { status: 200 });
    };
    const atlas = createAtlasProviders({ contractConfirmed: true, fetchImpl, pollIntervalMs: 1, timeoutMs: 50 });
    await expect(
      atlas.image.generateImage({ prompt: 'p', width: 1080, height: 1920, outputPath: join(root, 'never2.jpg') }),
    ).rejects.toMatchObject({ kind: 'network' });
  });

  it('REGRESSION (US-36 probe #3): the exact live in-progress envelope polls the constructed prediction endpoint', async () => {
    // Live evidence: data-wrapped envelope with outputs:null, an urls object
    // WITHOUT a usable result URL, status in progress, empty error string.
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith('/model/generateImage')) {
        return new Response(
          JSON.stringify({
            data: {
              id: 'live3',
              model: 'black-forest-labs/flux-schnell',
              outputs: null,
              urls: { cancel: 'https://api.atlascloud.ai/api/v1/model/prediction/live3/cancel' },
              has_nsfw_contents: null,
              status: 'processing',
              created_at: '2026-08-12T00:00:00Z',
              error: '',
              executionTime: 0,
              timings: {},
            },
          }),
          { status: 200 },
        );
      }
      if (url === 'https://api.atlascloud.ai/api/v1/model/prediction/live3') {
        return new Response(JSON.stringify({ data: { id: 'live3', status: 'completed', outputs: ['https://cdn.example/live3.jpg'], error: '' } }), { status: 200 });
      }
      if (url === 'https://cdn.example/live3.jpg') return new Response(readFileSync(LUNA_JPG), { status: 200 });
      return new Response('not found', { status: 404 });
    };
    const atlas = createAtlasProviders({ contractConfirmed: true, fetchImpl, pollIntervalMs: 1 });
    const out = join(root, 'live3.jpg');
    await atlas.image.generateImage({ prompt: 'p', width: 1080, height: 1920, outputPath: out });
    expect(existsSync(out)).toBe(true);
    expect(calls[1]).toBe('https://api.atlascloud.ai/api/v1/model/prediction/live3'); // constructed, NOT urls.result
  });

  it('a non-empty provider error field fails the generation even mid-lifecycle', async () => {
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith('/model/generateImage')) {
        return new Response(JSON.stringify({ data: { id: 'e1', status: 'processing', error: '' } }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: { id: 'e1', status: 'processing', error: 'NSFW content rejected by safety checker' } }), { status: 200 });
    };
    const atlas = createAtlasProviders({ contractConfirmed: true, fetchImpl, pollIntervalMs: 1 });
    try {
      await atlas.image.generateImage({ prompt: 'p', width: 1080, height: 1920, outputPath: join(root, 'err.jpg') });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as ProviderError).kind).toBe('http');
      expect((err as Error).message).toContain('safety checker');
      expect((err as Error).message).not.toContain(FAKE_KEY);
    }
    expect(existsSync(join(root, 'err.jpg'))).toBe(false);
  });

  it('REGRESSION (US-36 probe #2): a live envelope WITHOUT top-level status polls urls.result and completes', async () => {
    // The live API returned an envelope missing the documented top-level
    // "status"; the old adapter rejected it outright. Now: no status + a
    // urls.result → poll until terminal state.
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith('/model/generateImage')) {
        return new Response(
          JSON.stringify({ id: 'live-1', urls: { result: 'https://api.atlascloud.ai/api/v1/model/prediction/live-1', cancel: 'https://x' }, output: [] }),
          { status: 200 },
        );
      }
      if (url.endsWith('/model/prediction/live-1')) {
        return new Response(JSON.stringify({ id: 'live-1', status: 'succeeded', output: ['https://cdn.example/live.jpg'] }), { status: 200 });
      }
      if (url === 'https://cdn.example/live.jpg') return new Response(readFileSync(LUNA_JPG), { status: 200 });
      return new Response('not found', { status: 404 });
    };
    const atlas = createAtlasProviders({ contractConfirmed: true, fetchImpl, pollIntervalMs: 1 });
    const out = join(root, 'live.jpg');
    await atlas.image.generateImage({ prompt: 'p', width: 1080, height: 1920, outputPath: out });
    expect(existsSync(out)).toBe(true);
    expect(calls[1]).toContain('/model/prediction/live-1');
  });

  it('no status + no urls.result + populated output = sync result verified by the download', async () => {
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith('/model/generateImage')) {
        return new Response(JSON.stringify({ id: 'sync-1', output: ['https://cdn.example/sync.jpg'] }), { status: 200 });
      }
      if (url === 'https://cdn.example/sync.jpg') return new Response(readFileSync(LUNA_JPG), { status: 200 });
      return new Response('not found', { status: 404 });
    };
    const atlas = createAtlasProviders({ contractConfirmed: true, fetchImpl, pollIntervalMs: 1 });
    const out = join(root, 'sync.jpg');
    await atlas.image.generateImage({ prompt: 'p', width: 1080, height: 1920, outputPath: out });
    expect(existsSync(out)).toBe(true);
  });

  it('unwraps a {data: {...}} gateway envelope', async () => {
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith('/model/generateImage')) {
        return new Response(
          JSON.stringify({ code: 200, message: 'ok', data: { id: 'w-1', status: 'completed', output: ['https://cdn.example/w.jpg'] } }),
          { status: 200 },
        );
      }
      if (url === 'https://cdn.example/w.jpg') return new Response(readFileSync(LUNA_JPG), { status: 200 });
      return new Response('not found', { status: 404 });
    };
    const atlas = createAtlasProviders({ contractConfirmed: true, fetchImpl, pollIntervalMs: 1 });
    const out = join(root, 'wrapped.jpg');
    await atlas.image.generateImage({ prompt: 'p', width: 1080, height: 1920, outputPath: out });
    expect(existsSync(out)).toBe(true);
  });

  it('malformed errors carry a SANITIZED shape summary — key names/types only, never values', async () => {
    const secretish = 'sk-value-that-must-never-appear-1234567890';
    const atlas = createAtlasProviders({
      contractConfirmed: true,
      fetchImpl: async () => new Response(JSON.stringify({ foo: secretish, bar: 7, baz: [1, 2] }), { status: 200 }),
    });
    try {
      await atlas.image.generateImage({ prompt: 'p', width: 1080, height: 1920, outputPath: join(root, 'x.jpg') });
      expect.unreachable('should have thrown');
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain('foo:string');
      expect(message).toContain('bar:number');
      expect(message).toContain('baz:array(2)');
      expect(message).not.toContain(secretish);
      expect(message).not.toContain(FAKE_KEY);
    }
  });

  it('success status without a usable output URL is malformed, not success', async () => {
    const atlas = createAtlasProviders({
      contractConfirmed: true,
      fetchImpl: async () => new Response(JSON.stringify({ id: 'x', status: 'completed', output: [] }), { status: 200 }),
    });
    await expect(
      atlas.image.generateImage({ prompt: 'p', width: 1080, height: 1920, outputPath: join(root, 'x.jpg') }),
    ).rejects.toMatchObject({ kind: 'malformed_response' });
  });
});

// ───────────────────────── launcher regression (US-36 silent-failure bug) ─

describe('scripts/media-pipeline.mjs launcher', () => {
  const LAUNCHER = resolve(HERE, '..', '..', 'scripts', 'media-pipeline.mjs');

  it('REGRESSION: runs without npx/PATH resolution (the Windows silent-failure bug)', async () => {
    // The original launcher used spawnSync('npx', ...): on Windows, .cmd shims
    // cannot be spawned without a shell (EINVAL post CVE-2024-27980), and the
    // spawn error was silently swallowed -> instant exit, no output, no work.
    // The fixed launcher resolves tsx's JS entry and runs it with THIS node
    // binary, so it must work even when PATH is completely empty.
    const { spawnSync } = await import('node:child_process');
    const out = mkdtempSync(join(tmpdir(), 'launcher-'));
    const result = spawnSync(process.execPath, [LAUNCHER, 'status'], {
      env: { ...process.env, PATH: '', MEDIA_OUT_DIR: out, MEDIA_LEDGER_FILE: join(out, 'ledger.json') },
      encoding: 'utf8',
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('sprint spend');
  });

  it('unknown commands exit non-zero WITH a visible message (never silent)', async () => {
    const { spawnSync } = await import('node:child_process');
    const result = spawnSync(process.execPath, [LAUNCHER, 'no-such-command'], { encoding: 'utf8' });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('usage');
  });
});

// ───────────────────────── media QA vs real approved assets ───────────────

describe('technical media QA against the real approved benchmark assets', () => {
  it('passes the existing approved Luna and Ember media', () => {
    expect(qaVideo(LUNA_MP4, LUNA_JPG).pass).toBe(true);
    expect(qaVideo(EMBER_MP4, EMBER_JPG).pass).toBe(true);
    expect(qaImage(LUNA_JPG).pass).toBe(true);
    expect(qaImage(EMBER_JPG).pass).toBe(true);
  });

  it('reports the loop-restart metric as warn-only', () => {
    const report = qaVideo(LUNA_MP4);
    const loop = report.checks.find((c) => c.name.includes('loop'))!;
    expect(loop.ok).toBe(true); // warn-only: never fails the report
  });

  it('fails garbage files on integrity', () => {
    const junk = join(root, 'junk.mp4');
    writeFileSync(junk, 'not media');
    expect(qaVideo(junk).pass).toBe(false);
    expect(qaImage(junk).pass).toBe(false);
  });

  it('fails a landscape/short video (a non-portrait clip cannot pass)', () => {
    // Poster used as "video" is not decodable as H.264 video stream with
    // duration — integrity/codec checks must fail it.
    const report = qaVideo(LUNA_JPG);
    expect(report.pass).toBe(false);
  });
});
