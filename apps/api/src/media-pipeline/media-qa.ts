import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';

/**
 * US-16E measurable media QA — OBJECTIVE technical checks only.
 *
 * The benchmark values come from the actual approved Luna/Ember assets
 * (measured with ffprobe): H.264 MP4, 24 fps, 5.04 s, portrait
 * (1080x1920 hero / 1056x1956 profile / 1240x1668), same-dimension JPG poster
 * as first-frame still, hard-cut restart loop.
 *
 * Deliberately NOT here: any automated "beauty"/attractiveness score.
 * Subjective visual quality (identity, photorealism, sensuality-within-bounds,
 * artifact judgment) is HUMAN review, recorded in the run record — see
 * QA_CHECKLIST.md. A file that fails these technical checks cannot be
 * approved by the pipeline at all.
 */

export interface QaCheck {
  name: string;
  ok: boolean;
  value: string;
  expected: string;
  /** warnings don't fail QA, they inform human review */
  warning?: boolean;
}

export interface QaReport {
  file: string;
  pass: boolean;
  checks: QaCheck[];
}

export const VIDEO_BENCHMARK = {
  codec: 'h264',
  minDurationS: 4.0,
  maxDurationS: 6.5,
  minFps: 23,
  maxFps: 31,
  minWidth: 720,
  minHeight: 1280,
  // portrait ratios seen in approved set: 0.54 (1056x1956) … 0.74 (1240x1668)
  minAspect: 0.5,
  maxAspect: 0.8,
  // first-vs-last frame RMSE (0..1) — restart-loop harshness, WARN only.
  loopRmseWarn: 0.25,
};

function ffprobe(file: string, args: string[]): string {
  return execFileSync('ffprobe', ['-v', 'error', ...args, file], { encoding: 'utf8' }).trim();
}

function check(name: string, ok: boolean, value: string, expected: string, warning = false): QaCheck {
  return { name, ok: warning ? true : ok, value, expected, warning: warning && !ok ? true : undefined };
}

export function qaImage(file: string, opts?: { minWidth?: number; minHeight?: number }): QaReport {
  const checks: QaCheck[] = [];
  const minWidth = opts?.minWidth ?? 720;
  const minHeight = opts?.minHeight ?? 1280;
  if (!existsSync(file) || statSync(file).size === 0) {
    return { file, pass: false, checks: [check('file integrity', false, 'missing or empty', 'non-empty file')] };
  }
  try {
    const [w, h] = ffprobe(file, ['-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0'])
      .split(',')
      .map(Number);
    checks.push(check('decodable image', true, `${w}x${h}`, 'ffprobe-readable'));
    checks.push(check('portrait orientation', h! > w!, `${w}x${h}`, 'height > width'));
    checks.push(check('minimum resolution', w! >= minWidth && h! >= minHeight, `${w}x${h}`, `>= ${minWidth}x${minHeight}`));
  } catch {
    checks.push(check('file integrity', false, 'not decodable', 'valid image file'));
  }
  return { file, pass: checks.every((c) => c.ok), checks };
}

export function qaVideo(file: string, posterFile?: string): QaReport {
  const b = VIDEO_BENCHMARK;
  const checks: QaCheck[] = [];
  if (!existsSync(file) || statSync(file).size === 0) {
    return { file, pass: false, checks: [check('file integrity', false, 'missing or empty', 'non-empty file')] };
  }
  let width = 0;
  let height = 0;
  try {
    const raw = ffprobe(file, [
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=codec_name,width,height,r_frame_rate',
      '-show_entries',
      'format=duration',
      '-of',
      'csv=p=0',
    ]);
    const lines = raw.split('\n');
    const [codec, w, h, fpsRaw] = lines[0]!.split(',');
    const duration = Number(lines[1]);
    width = Number(w);
    height = Number(h);
    const [num, den] = (fpsRaw ?? '0/1').split('/').map(Number);
    const fps = den ? num! / den : Number(fpsRaw);

    checks.push(check('codec H.264', codec === b.codec, String(codec), b.codec));
    checks.push(
      check('duration ~5s', duration >= b.minDurationS && duration <= b.maxDurationS, `${duration.toFixed(2)}s`, `${b.minDurationS}-${b.maxDurationS}s`),
    );
    checks.push(check('frame rate ~24fps', fps >= b.minFps && fps <= b.maxFps, `${fps.toFixed(1)}fps`, `${b.minFps}-${b.maxFps}fps`));
    checks.push(check('portrait orientation', height > width, `${width}x${height}`, 'height > width'));
    checks.push(check('minimum resolution', width >= b.minWidth && height >= b.minHeight, `${width}x${height}`, `>= ${b.minWidth}x${b.minHeight}`));
    const aspect = width / height;
    checks.push(
      check('9:16-ish aspect', aspect >= b.minAspect && aspect <= b.maxAspect, aspect.toFixed(3), `${b.minAspect}-${b.maxAspect} (9:16 = 0.5625)`),
    );
  } catch {
    return { file, pass: false, checks: [check('file integrity', false, 'not decodable', 'valid H.264 MP4')] };
  }

  if (posterFile !== undefined) {
    if (!existsSync(posterFile) || statSync(posterFile).size === 0) {
      checks.push(check('poster present', false, 'missing or empty', 'poster JPG next to video'));
    } else {
      try {
        const [pw, ph] = ffprobe(posterFile, ['-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0'])
          .split(',')
          .map(Number);
        checks.push(
          check('poster matches video dimensions', pw === width && ph === height, `${pw}x${ph}`, `${width}x${height}`),
        );
      } catch {
        checks.push(check('poster present', false, 'not decodable', 'valid poster image'));
      }
    }
  }

  // Loop/restart harshness: first vs last frame difference. The approved set
  // uses hard-cut restarts, so this is a WARNING metric for human review, not
  // a pass/fail gate.
  try {
    const rmse = firstLastFrameRmse(file);
    checks.push(check('loop restart delta (warn-only)', rmse <= b.loopRmseWarn, rmse.toFixed(3), `<= ${b.loopRmseWarn} (RMSE 0..1)`, true));
  } catch {
    checks.push(check('loop restart delta (warn-only)', false, 'unmeasurable', 'measurable', true));
  }

  return { file, pass: checks.every((c) => c.ok), checks };
}

/** Normalized RMSE between the first and last frame (0 = identical). */
function firstLastFrameRmse(file: string): number {
  // Extract first and last frame as 64x64 grayscale raw and compare directly.
  const run = execFileSync;
  const first = run(
    'ffmpeg',
    ['-v', 'error', '-i', file, '-vf', 'select=eq(n\\,0),scale=64:64,format=gray', '-frames:v', '1', '-f', 'rawvideo', '-'],
    { maxBuffer: 1 << 20 },
  );
  const last = run(
    'ffmpeg',
    ['-v', 'error', '-sseof', '-0.1', '-i', file, '-vf', 'scale=64:64,format=gray', '-frames:v', '1', '-f', 'rawvideo', '-'],
    { maxBuffer: 1 << 20 },
  );
  const n = Math.min(first.length, last.length);
  if (n === 0) throw new Error('no frame data');
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const d = (first[i]! - last[i]!) / 255;
    sum += d * d;
  }
  return Math.sqrt(sum / n);
}
