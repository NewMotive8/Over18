import { join } from 'node:path';
import { CostLedger } from './cost-ledger.js';
import { createAtlasProviders } from './atlas-adapter.js';
import { createMockProviders } from './mock-adapter.js';
import { qaImage, qaVideo } from './media-qa.js';
import { MediaPipeline, PipelineRefusal } from './pipeline.js';
import type { MediaProviders } from './types.js';

/**
 * US-16E CLI — offline media pipeline runner.
 *
 *   npx tsx src/media-pipeline/cli.ts <command> [options]
 *   (or: node scripts/media-pipeline.mjs <command> [options])
 *
 * Commands:
 *   gen-images     --character <slug> --prompt "<text>" --count N
 *                  [--provider mock|atlas] [--budget USD]
 *   select         --character <slug> --image <candidatePath> [--replace]
 *   gen-videos     --character <slug> --prompt "<motion text>" --count N
 *                  [--duration 5] [--resolution 1080p] [--provider mock|atlas] [--budget USD]
 *                  [--video-model <id>] [--video-cost <usdPerSecond>]
 *                  [--reference <imagePath>]  I2V reference override; uses this
 *                                             still instead of the canonical
 *                                             WITHOUT promoting it (canonical
 *                                             untouched). Held to the same
 *                                             technical image-QA as select.
 *   qa             --file <path> [--poster <path>]
 *   reject         --character <slug> --file <path> --reason "<why>"
 *   approve        --character <slug> --video <candidatePath> --approved-by "<name>"
 *                  [--as hero] [--replace]
 *   status         [--character <slug>]
 *
 * Env: MEDIA_OUT_DIR (default media-out/), MEDIA_LEDGER_FILE
 * (default <out>/sprint-ledger.json), MEDIA_SPRINT_CEILING / MEDIA_HARD_STOP /
 * MEDIA_SOFT_WARN, ATLASCLOUD_API_KEY (atlas only; never stored or printed).
 * Atlas additionally requires --confirm-contract until its live API contract
 * has been probed once (US-36 step 0).
 */

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
function required(name: string): string {
  const v = arg(name);
  if (!v) {
    console.error(`missing required --${name}`);
    process.exit(2);
  }
  return v;
}

/** Cost overrides must be positive numbers — a bad value must never silently
 * become 0 and defeat budget authorization. */
function positiveCost(name: string): number | undefined {
  const raw = arg(name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    console.error(`--${name} must be a positive number, got "${raw}"`);
    process.exit(2);
  }
  return value;
}

const OUT_ROOT = process.env.MEDIA_OUT_DIR ?? 'media-out';
const LEDGER_FILE = process.env.MEDIA_LEDGER_FILE ?? join(OUT_ROOT, 'sprint-ledger.json');

function providers(): MediaProviders {
  const which = arg('provider') ?? 'mock';
  if (which === 'atlas') {
    // Optional overrides so the cheapest contract probe (Flux Schnell,
    // ~$0.003/image) can be selected without touching adapter defaults.
    const imageModel = arg('image-model');
    const videoModel = arg('video-model');
    const imageUnitCostUsd = positiveCost('image-cost');
    // Per-second video price. Model-specific ($0.10/s for wan-2.7-spicy,
    // $0.02/s for the wan-2.2-turbo screening tier), so selecting a cheaper
    // model WITHOUT its price would make the ledger wrong — which is why both
    // flags exist together.
    const videoUnitCostPerSecondUsd = positiveCost('video-cost');
    return createAtlasProviders({
      contractConfirmed: flag('confirm-contract'),
      ...(imageModel ? { imageModel } : {}),
      ...(videoModel ? { videoModel } : {}),
      ...(imageUnitCostUsd !== undefined ? { imageUnitCostUsd } : {}),
      ...(videoUnitCostPerSecondUsd !== undefined ? { videoUnitCostPerSecondUsd } : {}),
    });
  }
  if (which === 'mock') {
    // Real approved assets as fixtures so QA runs against representative media.
    return createMockProviders({
      imageFixturePath: join('..', 'web', 'public', 'media', 'luna', 'profile-04.jpg'),
      videoFixturePath: join('..', 'web', 'public', 'media', 'luna', 'profile-04.mp4'),
    });
  }
  console.error(`unknown provider "${which}" (mock | atlas)`);
  process.exit(2);
}

function pipeline(): MediaPipeline {
  const character = required('character');
  const budgetRaw = arg('budget');
  const budget = budgetRaw === undefined ? undefined : Number(budgetRaw);
  return new MediaPipeline(OUT_ROOT, character, providers(), new CostLedger(LEDGER_FILE), budget);
}

function printQa(report: ReturnType<typeof qaVideo>): void {
  for (const c of report.checks) {
    const mark = c.ok ? (c.warning ? '~' : 'ok') : 'FAIL';
    console.log(`  [${mark}] ${c.name}: ${c.value} (expected ${c.expected})`);
  }
  console.log(report.pass ? 'TECHNICAL QA: PASS' : 'TECHNICAL QA: FAIL');
}

const command = process.argv[2];
try {
  switch (command) {
    case 'gen-images': {
      const files = await pipeline().generateImageCandidates(required('prompt'), Number(arg('count') ?? 1));
      files.forEach((f) => console.log(`candidate: ${f}`));
      break;
    }
    case 'select': {
      console.log(`canonical: ${pipeline().selectCanonical(required('image'), { replace: flag('replace') })}`);
      break;
    }
    case 'gen-videos': {
      const referenceOverride = arg('reference');
      const files = await pipeline().generateVideoCandidates(required('prompt'), Number(arg('count') ?? 1), {
        durationSeconds: Number(arg('duration') ?? 5),
        resolution: (arg('resolution') as '480p' | '720p' | '1080p') ?? '1080p',
        ...(referenceOverride ? { referenceImagePath: referenceOverride } : {}),
      });
      files.forEach((f) => console.log(`candidate: ${f}`));
      break;
    }
    case 'qa': {
      const file = required('file');
      const report = file.endsWith('.mp4') ? qaVideo(file, arg('poster')) : qaImage(file);
      printQa(report);
      process.exit(report.pass ? 0 : 1);
      break;
    }
    case 'reject': {
      pipeline().reject(required('file'), required('reason'));
      console.log('rejection recorded');
      break;
    }
    case 'approve': {
      const { video, poster, qa } = pipeline().approveVideo(required('video'), {
        as: arg('as'),
        replace: flag('replace'),
        humanApproval: required('approved-by'),
      });
      printQa(qa);
      console.log(`approved video: ${video}`);
      console.log(`poster: ${poster}`);
      break;
    }
    case 'status': {
      const ledger = new CostLedger(LEDGER_FILE);
      const s = ledger.summary();
      console.log(
        `sprint spend: $${s.cumulativeUsd.toFixed(3)} of ceiling $${s.sprintCeilingUsd.toFixed(2)} (soft warn $${s.softWarnUsd.toFixed(2)}, hard stop $${s.hardStopUsd.toFixed(2)}; ${s.entries} entries)`,
      );
      const character = arg('character');
      if (character) console.log(`character "${character}" spend: $${ledger.characterSpentUsd(character).toFixed(3)}`);
      break;
    }
    default:
      console.error('usage: media-pipeline <gen-images|select|gen-videos|qa|reject|approve|status> [options] — see header comment');
      process.exit(2);
  }
} catch (err) {
  if (err instanceof PipelineRefusal) {
    console.error(`REFUSED: ${err.message}`);
    process.exit(3);
  }
  console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
