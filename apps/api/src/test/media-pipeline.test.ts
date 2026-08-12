import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CostLedger } from '../media-pipeline/cost-ledger.js';
import { createAtlasProviders, normalizeFluxSize, normalizeWanResolution, validateWanDuration } from '../media-pipeline/atlas-adapter.js';
import { createMockProviders } from '../media-pipeline/mock-adapter.js';
import { QaToolingError, qaImage, qaVideo, readImageInfo, sniffImageFormat } from '../media-pipeline/media-qa.js';
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

// ─── budget boundary precision (IEEE-754: 0.275 + 0.025 === 0.30000000000004) ─

describe('budget boundary precision', () => {
  function spend(ledger: CostLedger, character: string, usd: number): void {
    ledger.record({
      runId: 'r',
      character,
      provider: 'mock',
      model: 'm',
      operation: 'image',
      status: 'succeeded',
      unit: 'image',
      quantity: 1,
      unitCostUsd: usd,
      estimatedCostUsd: usd,
    });
  }

  it('sanity: the naive float comparison really does misfire at this boundary', () => {
    // Guards the premise — if this ever stops being true the regression below
    // would pass vacuously. This is the exact Nova case that refused wrongly.
    expect(0.275 + 0.025 > 0.3).toBe(true); // IEEE-754 drift → 0.30000000000000004
  });

  it('authorizes a request landing EXACTLY on the character budget (0.275 + 0.025 == 0.30)', () => {
    const ledger = new CostLedger(ledgerFile);
    spend(ledger, 'nova', 0.275);
    expect(ledger.characterSpentUsd('nova')).toBeCloseTo(0.275, 6);
    const auth = ledger.authorize(0.025, 'nova', 0.3);
    expect(auth.ok).toBe(true); // must NOT be refused by float drift
  });

  it('authorizes just BELOW the character budget', () => {
    const ledger = new CostLedger(ledgerFile);
    spend(ledger, 'nova', 0.275);
    expect(ledger.authorize(0.024, 'nova', 0.3).ok).toBe(true); // 0.299
  });

  it('still REFUSES a request genuinely just above the character budget', () => {
    const ledger = new CostLedger(ledgerFile);
    spend(ledger, 'nova', 0.275);
    const auth = ledger.authorize(0.026, 'nova', 0.3); // 0.301 — a real overage
    expect(auth.ok).toBe(false);
    expect(auth.reason).toContain('character budget');
  });

  it('applies the same exact-boundary semantics to the sprint hard stop', () => {
    // spend 0.275 across the sprint, hard stop 0.30: +0.025 lands exactly on it.
    const atBoundary = new CostLedger(join(root, 'hs-boundary.json'), { sprintCeilingUsd: 0.4, hardStopUsd: 0.3, softWarnUsd: 0.2 });
    spend(atBoundary, 'nova', 0.275);
    expect(atBoundary.authorize(0.025, 'nova').ok).toBe(true); // exactly 0.30, allowed

    const overBoundary = new CostLedger(join(root, 'hs-over.json'), { sprintCeilingUsd: 0.4, hardStopUsd: 0.3, softWarnUsd: 0.2 });
    spend(overBoundary, 'nova', 0.275);
    const refused = overBoundary.authorize(0.026, 'nova'); // 0.301
    expect(refused.ok).toBe(false);
    expect(refused.reason).toContain('HARD STOP');
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

// ───────── I2V reference override — use a still WITHOUT changing canonical ──

describe('I2V reference override', () => {
  it('drives video from an explicit reference WITHOUT changing the canonical, and records provenance', async () => {
    const ledger = new CostLedger(ledgerFile);
    const pipeline = makePipeline({ ledger, budget: 5 });
    const images = await pipeline.generateImageCandidates('p', 1);
    const canonical = pipeline.selectCanonical(images[0]!); // canonical = luna fixture bytes
    const before = readFileSync(canonical);

    // A DIFFERENT, valid portrait still as the override reference.
    const override = join(root, 'nova', 'candidates', 'images', 'glamour.jpg');
    copyFileSync(EMBER_JPG, override);

    const videos = await pipeline.generateVideoCandidates('sensual glamour motion', 1, {
      durationSeconds: 5,
      referenceImagePath: override,
    });
    expect(videos).toHaveLength(1);
    expect(existsSync(videos[0]!)).toBe(true);

    // Canonical on disk is byte-for-byte unchanged — never promoted or replaced.
    expect(readFileSync(canonical).equals(before)).toBe(true);
    expect(pipeline.events().some((e) => e.action === 'select_canonical' && e.referenceImage === override)).toBe(false);

    // Provenance cites the override, and the reference was QA-gated first.
    const gen = pipeline.events().find((e) => e.action === 'generate_video')!;
    expect(gen.referenceImage).toBe(override);
    expect(gen.referenceImage).not.toContain('reference.jpg');
    const refQa = pipeline.events().filter((e) => e.action === 'qa' && e.file === override);
    expect(refQa).toHaveLength(1);
    expect(refQa[0]!.qa!.pass).toBe(true);
  });

  it('refuses a reference override that fails technical image QA — before any paid call', async () => {
    const ledger = new CostLedger(ledgerFile);
    const pipeline = makePipeline({ ledger, budget: 5 });
    const images = await pipeline.generateImageCandidates('p', 1);
    const canonical = pipeline.selectCanonical(images[0]!);
    const spentAfterImage = ledger.cumulativeUsd; // 0.025, image only

    const junk = join(root, 'nova', 'candidates', 'images', 'not-an-image.jpg');
    writeFileSync(junk, 'this is not a decodable image');

    await expect(
      pipeline.generateVideoCandidates('motion', 1, { referenceImagePath: junk }),
    ).rejects.toThrow(/reference image failed technical image QA/);

    // No paid call happened: no new spend, no candidate video, canonical intact.
    expect(ledger.cumulativeUsd).toBeCloseTo(spentAfterImage, 6);
    expect(readdirSync(join(root, 'nova', 'candidates', 'videos'))).toHaveLength(0);
    expect(existsSync(canonical)).toBe(true);
    expect(pipeline.events().at(-1)!.action).toBe('qa'); // the failing gate is recorded
  });

  it('refuses a reference override whose file is missing', async () => {
    const pipeline = makePipeline({ budget: 5 });
    await expect(
      pipeline.generateVideoCandidates('motion', 1, { referenceImagePath: join(root, 'nope.jpg') }),
    ).rejects.toThrow(/reference image not found/);
  });

  it('a reference override still honors the budget — refused before the paid call', async () => {
    const ledger = new CostLedger(ledgerFile);
    const pipeline = makePipeline({ ledger, budget: 0.01 }); // a 5s clip costs 0.10
    const override = join(root, 'nova', 'candidates', 'images', 'ref.jpg');
    copyFileSync(EMBER_JPG, override);
    await expect(
      pipeline.generateVideoCandidates('motion', 1, { referenceImagePath: override, durationSeconds: 5 }),
    ).rejects.toThrow(PipelineRefusal);
    expect(ledger.cumulativeUsd).toBe(0);
    expect(readdirSync(join(root, 'nova', 'candidates', 'videos'))).toHaveLength(0);
    expect(pipeline.events().at(-1)!.action).toBe('generation_refused');
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
      if (url === 'https://api.atlascloud.ai/api/v1/model/uploadMedia') {
        return new Response(JSON.stringify({ url: 'https://cdn.example/uploads/ref.jpg' }), { status: 200 });
      }
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
    expect(calls[0]).toBe('https://api.atlascloud.ai/api/v1/model/uploadMedia'); // reference uploaded FIRST
    expect(calls[1]).toBe('https://api.atlascloud.ai/api/v1/model/generateVideo');
    expect(calls[2]).toBe('https://api.atlascloud.ai/api/v1/model/prediction/pred-1'); // polls the constructed prediction endpoint
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
      if (url.endsWith('/model/uploadMedia')) {
        return new Response(JSON.stringify({ download_url: 'https://cdn.example/uploads/ref.jpg' }), { status: 200 });
      }
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

// ─── media QA: image inspection is pure-JS; tooling failure != bad asset ────
//
// Root cause of the run-msqatez0 incident: qaImage shelled out to ffprobe and
// its blanket catch turned "ffprobe could not run" (no ffprobe on the Windows
// host) into "file integrity: not decodable" — a valid JPEG wrongly rejected.
// Image QA is now pure-JS (no external tool); video QA still uses ffprobe but
// distinguishes a MISSING tool from a bad asset.

describe('media QA robustness (pure-JS image inspection + tooling honesty)', () => {
  // Minimal, parser-valid PNG: signature + IHDR(w,h) + trailing IEND chunk.
  function makePng(w: number, h: number): Buffer {
    const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const ihdrLen = Buffer.from([0, 0, 0, 13]);
    const ihdrType = Buffer.from('IHDR', 'ascii');
    const dims = Buffer.alloc(8);
    dims.writeUInt32BE(w, 0);
    dims.writeUInt32BE(h, 4);
    const ihdrRest = Buffer.from([8, 2, 0, 0, 0]); // bitdepth, colortype, compression, filter, interlace
    const ihdrCrc = Buffer.from([0, 0, 0, 0]);
    const iend = Buffer.concat([Buffer.from([0, 0, 0, 0]), Buffer.from('IEND', 'ascii'), Buffer.from([0xae, 0x42, 0x60, 0x82])]);
    return Buffer.concat([sig, ihdrLen, ihdrType, dims, ihdrRest, ihdrCrc, iend]);
  }
  // Minimal, parser-valid WebP (VP8X) with canvas dims.
  function makeWebp(w: number, h: number): Buffer {
    const buf = Buffer.alloc(30);
    buf.write('RIFF', 0, 'ascii');
    buf.writeUInt32LE(30 - 8, 4);
    buf.write('WEBP', 8, 'ascii');
    buf.write('VP8X', 12, 'ascii');
    buf.writeUInt32LE(10, 16); // VP8X chunk length (not read by the parser)
    buf.writeUIntLE(w - 1, 24, 3);
    buf.writeUIntLE(h - 1, 27, 3);
    return buf;
  }
  function writeTmp(name: string, buf: Buffer): string {
    const p = join(root, name);
    writeFileSync(p, buf);
    return p;
  }

  it('sniffs formats from magic bytes, not the extension', () => {
    expect(sniffImageFormat(readFileSync(LUNA_JPG))).toBe('jpeg');
    expect(sniffImageFormat(makePng(720, 1280))).toBe('png');
    expect(sniffImageFormat(makeWebp(720, 1280))).toBe('webp');
    expect(sniffImageFormat(Buffer.from('this is not an image'))).toBeUndefined();
  });

  it('reads true dimensions of real JPEGs with NO external tool (matches ffprobe)', () => {
    const luna = readImageInfo(LUNA_JPG);
    expect(luna).toMatchObject({ format: 'jpeg', width: 1240, height: 1668, complete: true });
    const ember = readImageInfo(EMBER_JPG);
    expect(ember).toMatchObject({ format: 'jpeg', width: 1080, height: 1920, complete: true });
    expect(readImageInfo(writeTmp('info.png', makePng(800, 1400)))).toMatchObject({ format: 'png', width: 800, height: 1400, complete: true });
    expect(readImageInfo(writeTmp('info.webp', makeWebp(800, 1400)))).toMatchObject({ format: 'webp', width: 800, height: 1400 });
  });

  it('THE incident: a valid JPEG passes image QA even when ffprobe is unavailable', () => {
    // Point ffprobe at a binary that cannot spawn — the Windows-host condition.
    process.env.FFPROBE_BIN = 'definitely-not-a-real-binary-xyz';
    try {
      const report = qaImage(LUNA_JPG);
      expect(report.pass).toBe(true); // pre-fix this reported "not decodable"
      expect(report.checks.find((c) => c.name === 'decodable image')?.ok).toBe(true);
    } finally {
      delete process.env.FFPROBE_BIN;
    }
  });

  it('genuinely invalid images still FAIL image QA (not a tooling error)', () => {
    const junk = join(root, 'not-an-image.jpg');
    writeFileSync(junk, 'this is not a decodable image');
    const report = qaImage(junk);
    expect(report.pass).toBe(false);
    expect(report.checks[0]!.value).toBe('not decodable');
  });

  it('a truncated JPEG (missing EOI) fails the completeness check', () => {
    const full = readFileSync(LUNA_JPG);
    const truncated = join(root, 'truncated.jpg');
    writeFileSync(truncated, full.subarray(0, full.length - 4)); // drop the ff d9 tail
    const report = qaImage(truncated);
    expect(report.pass).toBe(false);
    expect(report.checks.find((c) => c.name === 'complete (not truncated)')?.ok).toBe(false);
  });

  it('a portrait PNG passes; an undersized one fails on resolution (format-agnostic checks)', () => {
    const tall = writeTmp('tall.png', makePng(800, 1400));
    expect(qaImage(tall).pass).toBe(true);
    const small = writeTmp('small.png', makePng(320, 480));
    const report = qaImage(small);
    expect(report.pass).toBe(false);
    expect(report.checks.find((c) => c.name === 'minimum resolution')?.ok).toBe(false);
  });

  it('VIDEO QA: a missing ffprobe raises a tooling error, never a false "not decodable" verdict', () => {
    process.env.FFPROBE_BIN = 'definitely-not-a-real-binary-xyz';
    try {
      expect(() => qaVideo(LUNA_MP4)).toThrow(QaToolingError);
    } finally {
      delete process.env.FFPROBE_BIN;
    }
  });

  it('VIDEO QA: a real corrupt clip (ffprobe present) still fails as not-decodable', () => {
    const junk = join(root, 'corrupt.mp4');
    writeFileSync(junk, 'not a video');
    const report = qaVideo(junk);
    expect(report.pass).toBe(false);
    expect(report.checks[0]!.value).toBe('not decodable');
  });
});

// ─── adapter names images by their REAL format (truthful extension) ─────────

describe('atlas image truthful format/extension', () => {
  function imageFetch(assetBytes: Buffer | string, assetUrl = 'https://cdn.example/out'): typeof fetch {
    return async (input) => {
      const url = String(input);
      if (url.endsWith('/model/generateImage')) {
        return new Response(JSON.stringify({ data: { id: 'i1', status: 'completed', outputs: [assetUrl] } }), { status: 200 });
      }
      if (url === assetUrl) return new Response(assetBytes, { status: 200 });
      return new Response('not found', { status: 404 });
    };
  }
  function makePng(w: number, h: number): Buffer {
    const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const dims = Buffer.alloc(8);
    dims.writeUInt32BE(w, 0);
    dims.writeUInt32BE(h, 4);
    return Buffer.concat([
      sig,
      Buffer.from([0, 0, 0, 13]), Buffer.from('IHDR', 'ascii'), dims, Buffer.from([8, 2, 0, 0, 0, 0, 0, 0, 0]),
      Buffer.from([0, 0, 0, 0]), Buffer.from('IEND', 'ascii'), Buffer.from([0xae, 0x42, 0x60, 0x82]),
    ]);
  }

  it('saves PNG bytes with a .png extension even when a .jpg path was requested', async () => {
    const atlas = createAtlasProviders({ contractConfirmed: true, fetchImpl: imageFetch(makePng(1056, 1888)), pollIntervalMs: 1 });
    const requested = join(root, 'nova', 'candidates', 'images', 'run-x-img-01.jpg');
    const result = await atlas.image.generateImage({ prompt: 'p', width: 1080, height: 1920, outputPath: requested });
    expect(result.outputPath.endsWith('.png')).toBe(true);
    expect(existsSync(result.outputPath)).toBe(true);
    expect(existsSync(requested)).toBe(false); // never wrote the lying .jpg
    expect(sniffImageFormat(readFileSync(result.outputPath))).toBe('png');
  });

  it('keeps the .jpg extension when the bytes really are JPEG', async () => {
    const atlas = createAtlasProviders({ contractConfirmed: true, fetchImpl: imageFetch(readFileSync(LUNA_JPG)), pollIntervalMs: 1 });
    const requested = join(root, 'nova', 'candidates', 'images', 'run-y-img-01.jpg');
    const result = await atlas.image.generateImage({ prompt: 'p', width: 1080, height: 1920, outputPath: requested });
    expect(result.outputPath).toBe(requested);
    expect(existsSync(requested)).toBe(true);
  });

  it('refuses to save non-image bytes as an image (never writes a lie)', async () => {
    const atlas = createAtlasProviders({ contractConfirmed: true, fetchImpl: imageFetch('<html>error</html>'), pollIntervalMs: 1 });
    const requested = join(root, 'nova', 'candidates', 'images', 'run-z-img-01.jpg');
    await expect(
      atlas.image.generateImage({ prompt: 'p', width: 1080, height: 1920, outputPath: requested }),
    ).rejects.toMatchObject({ kind: 'malformed_response' });
    expect(existsSync(requested)).toBe(false);
  });

  it('pipeline records the TRUTHFUL output path the provider returns', async () => {
    // A provider that (like the fixed adapter) returns a .png although .jpg was asked.
    const provider = {
      image: {
        name: 'stub',
        imageModel: 'stub-image',
        estimateImageCost: () => 0.01,
        async generateImage(req: { outputPath: string }) {
          const out = req.outputPath.replace(/\.jpg$/, '.png');
          writeFileSync(out, makePng(1056, 1888));
          return { outputPath: out, provider: 'stub', model: 'stub-image', unit: 'image' as const, quantity: 1, unitCostUsd: 0.01, estimatedCostUsd: 0.01 };
        },
      },
      video: mockProviders().video,
    };
    const pipeline = new MediaPipeline(root, 'nova', provider, new CostLedger(ledgerFile), 5, 'run-truthful');
    const [written] = await pipeline.generateImageCandidates('p', 1);
    expect(written!.endsWith('.png')).toBe(true);
    const ev = pipeline.events().find((e) => e.action === 'generate_image')!;
    expect(ev.file!.endsWith('.png')).toBe(true);
  });
});

// ────────────── atlas VIDEO contract (US-36 pre-probe verification) ────────
//
// The video path was written by analogy to the image path and never verified.
// Checking it against the official Wan model pages found three defects that
// would each have burned a paid call. These lock the verified contract in.

describe('atlas video contract', () => {
  function videoFetch(record: { body?: Record<string, unknown>; upload?: boolean } = {}): typeof fetch {
    return async (input, init) => {
      const url = String(input);
      if (url.endsWith('/model/uploadMedia')) {
        record.upload = true;
        // Multipart: fetch must own the boundary, so no explicit Content-Type.
        expect((init?.headers as Record<string, string>)['Content-Type']).toBeUndefined();
        expect(init?.body).toBeInstanceOf(FormData);
        return new Response(JSON.stringify({ data: { url: 'https://cdn.example/uploads/ref.jpg' } }), { status: 200 });
      }
      if (url.endsWith('/model/generateVideo')) {
        record.body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({ data: { id: 'v1', status: 'completed', outputs: ['https://cdn.example/clip.mp4'] } }), { status: 200 });
      }
      if (url === 'https://cdn.example/clip.mp4') return new Response(readFileSync(LUNA_MP4), { status: 200 });
      return new Response('not found', { status: 404 });
    };
  }

  it('sends the documented body: uploaded image URL (never base64), task-suffixed model, seed, anti-cut negative prompt', async () => {
    const record: { body?: Record<string, unknown>; upload?: boolean } = {};
    const atlas = createAtlasProviders({ contractConfirmed: true, fetchImpl: videoFetch(record), pollIntervalMs: 1 });
    await atlas.video.imageToVideo({
      referenceImagePath: LUNA_JPG,
      prompt: 'gentle motion',
      durationSeconds: 5,
      resolution: '1080p',
      outputPath: join(root, 'v.mp4'),
    });
    expect(record.upload).toBe(true);
    expect(record.body!.model).toBe('atlascloud/wan-2.7-spicy/image-to-video'); // task suffix, not the bare family id
    expect(record.body!.image).toBe('https://cdn.example/uploads/ref.jpg');
    expect(String(record.body!.image)).not.toMatch(/^[A-Za-z0-9+/]{100,}={0,2}$/); // never raw base64
    expect(record.body!.duration).toBe(5);
    expect(record.body!.seed).toBe(-1);
    expect(String(record.body!.negative_prompt)).toContain('camera cut');
  });

  it('resolution casing follows the selected model family, not a blanket toUpperCase', () => {
    // wan-2.6/2.7 pages document 720P/1080P; wan-2.2 pages document 480p/720p/1080p.
    expect(normalizeWanResolution('atlascloud/wan-2.7-spicy/image-to-video', '1080p')).toBe('1080P');
    expect(normalizeWanResolution('atlascloud/wan-2.6-spicy/image-to-video', '720p')).toBe('720P');
    expect(normalizeWanResolution('atlascloud/wan-2.2-turbo-spicy/image-to-video', '720p')).toBe('720p');
    expect(normalizeWanResolution('atlascloud/wan-2.2-turbo-spicy/image-to-video', '720P')).toBe('720p');
    expect(normalizeWanResolution('some/unknown-model', '720P')).toBe('720p'); // catalogue majority
    expect(normalizeWanResolution('atlascloud/wan-2.2-turbo-spicy/image-to-video', '720p', 'upper')).toBe('720P'); // explicit override wins
  });

  it('uses the model-appropriate casing on the wire for the cheap screening model', async () => {
    const record: { body?: Record<string, unknown> } = {};
    const atlas = createAtlasProviders({
      contractConfirmed: true,
      fetchImpl: videoFetch(record),
      pollIntervalMs: 1,
      videoModel: 'atlascloud/wan-2.2-turbo-spicy/image-to-video',
      videoUnitCostPerSecondUsd: 0.02,
    });
    const result = await atlas.video.imageToVideo({
      referenceImagePath: LUNA_JPG,
      prompt: 'p',
      durationSeconds: 5,
      resolution: '720p',
      outputPath: join(root, 'v2.mp4'),
    });
    expect(record.body!.resolution).toBe('720p');
    expect(result.estimatedCostUsd).toBeCloseTo(0.1, 6); // 5s × $0.02 screening tier
  });

  it('refuses a duration the model does not support BEFORE any network call or spend', async () => {
    let called = false;
    const atlas = createAtlasProviders({
      contractConfirmed: true,
      videoModel: 'atlascloud/wan-2.2-turbo-spicy/image-to-video',
      fetchImpl: async () => {
        called = true;
        return new Response('{}', { status: 200 });
      },
    });
    // wan-2.2 turbo accepts 5s or 8s only.
    await expect(
      atlas.video.imageToVideo({
        referenceImagePath: LUNA_JPG,
        prompt: 'p',
        durationSeconds: 6,
        resolution: '720p',
        outputPath: join(root, 'never3.mp4'),
      }),
    ).rejects.toMatchObject({ kind: 'unsupported_request' });
    expect(called).toBe(false);
    expect(existsSync(join(root, 'never3.mp4'))).toBe(false);

    expect(() => validateWanDuration('atlascloud/wan-2.7-spicy/image-to-video', 16)).toThrow(/2-15s/);
    expect(() => validateWanDuration('atlascloud/wan-2.7-spicy/image-to-video', 5)).not.toThrow();
    expect(() => validateWanDuration('atlascloud/wan-2.2-turbo-spicy/image-to-video', 8)).not.toThrow();
    expect(() => validateWanDuration('some/unknown-model', 7)).not.toThrow(); // stale knowledge never blocks a new model
    expect(() => validateWanDuration('some/unknown-model', 5.5)).toThrow(/whole number/);
  });

  it('an upload response without a usable URL is malformed — no video call is attempted', async () => {
    let generateCalled = false;
    const atlas = createAtlasProviders({
      contractConfirmed: true,
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.endsWith('/model/uploadMedia')) return new Response(JSON.stringify({ ok: true }), { status: 200 });
        generateCalled = true;
        return new Response('{}', { status: 200 });
      },
    });
    await expect(
      atlas.video.imageToVideo({
        referenceImagePath: LUNA_JPG,
        prompt: 'p',
        durationSeconds: 5,
        resolution: '720p',
        outputPath: join(root, 'never4.mp4'),
      }),
    ).rejects.toMatchObject({ kind: 'malformed_response' });
    expect(generateCalled).toBe(false);
  });

  it('never leaks the key through the upload path', async () => {
    const seen: string[] = [];
    const atlas = createAtlasProviders({
      contractConfirmed: true,
      fetchImpl: async (input, init) => {
        seen.push(String(init?.body ?? ''));
        return new Response(`upload exploded for ${String(input)}`, { status: 500 });
      },
    });
    await expect(
      atlas.video.imageToVideo({
        referenceImagePath: LUNA_JPG,
        prompt: 'p',
        durationSeconds: 5,
        resolution: '720p',
        outputPath: join(root, 'never5.mp4'),
      }),
    ).rejects.toSatisfy((err: Error) => !err.message.includes(FAKE_KEY));
    expect(seen.join('')).not.toContain(FAKE_KEY);
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
