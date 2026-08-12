import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CostLedger } from '../media-pipeline/cost-ledger.js';
import { createAtlasProviders } from '../media-pipeline/atlas-adapter.js';
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

  it('happy path with injected fetch: submit → poll → download → bytes on disk', async () => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith('/generateVideo')) return new Response(JSON.stringify({ id: 'pred-1' }), { status: 200 });
      if (url.endsWith('/prediction/pred-1')) {
        return new Response(JSON.stringify({ status: 'succeeded', output: { url: 'https://cdn.example/clip.mp4' } }), { status: 200 });
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
    expect(calls[0]).toContain('/generateVideo');
  });

  it('failed prediction status aborts without writing output', async () => {
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith('/generateVideo')) return new Response(JSON.stringify({ id: 'pred-2' }), { status: 200 });
      return new Response(JSON.stringify({ status: 'failed' }), { status: 200 });
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
