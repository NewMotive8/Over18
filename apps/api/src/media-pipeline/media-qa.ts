import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';

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

/**
 * Raised when a QA TOOL (ffprobe/ffmpeg) cannot be executed at all — as opposed
 * to running and judging an asset invalid. Conflating the two is exactly the
 * bug this module previously had: on a host without ffprobe on PATH, a valid
 * JPEG was reported as "not decodable" (an asset verdict) when the truth was
 * "the inspector could not run" (an environment error). Callers must surface
 * this as an actionable ERROR and MUST NOT treat it as either a pass or a
 * normal QA failure — never proceed on an unverifiable asset.
 */
export class QaToolingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QaToolingError';
  }
}

export type ImageFormat = 'jpeg' | 'png' | 'webp';

/**
 * Provider-agnostic magic-byte format sniff — no external tool, no extension
 * trust. Recognizes the raster formats image generators actually emit.
 */
export function sniffImageFormat(buf: Buffer): ImageFormat | undefined {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
  ) {
    return 'png';
  }
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return undefined;
}

export interface ImageInfo {
  format: ImageFormat;
  width: number;
  height: number;
  /** end-of-image marker present, i.e. the file was not truncated on download */
  complete: boolean;
}

/**
 * Pure-JS image inspection: recognizes the format by magic bytes, reads the
 * true pixel dimensions from the header, and confirms structural completeness
 * (the end-of-image marker is present). This deliberately REPLACES the previous
 * `ffprobe` shell-out for images, so image QA no longer depends on an external
 * media toolchain being installed — the failure mode that made a valid JPEG
 * report as "not decodable" on a host without ffprobe. Throws on unrecognized
 * or malformed input; callers treat that as a genuine ASSET failure, never a
 * tooling error. ffprobe's own `stream=width,height` read is likewise
 * header-level, so rigor is equivalent — plus this adds a truncation check.
 */
export function readImageInfo(file: string): ImageInfo {
  const buf = readFileSync(file);
  const format = sniffImageFormat(buf);
  if (!format) throw new Error('unrecognized image format (not jpeg/png/webp)');
  if (format === 'jpeg') return readJpeg(buf);
  if (format === 'png') return readPng(buf);
  return readWebp(buf);
}

function readJpeg(buf: Buffer): ImageInfo {
  let o = 2; // past SOI (ff d8)
  let width = 0;
  let height = 0;
  while (o + 9 < buf.length) {
    if (buf[o] !== 0xff) {
      o++;
      continue;
    }
    const marker = buf[o + 1]!;
    // Standalone markers carry no length payload.
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      o += 2;
      continue;
    }
    const len = (buf[o + 2]! << 8) | buf[o + 3]!;
    if (len < 2) throw new Error('malformed JPEG segment length');
    // SOF0..SOF15 carry dimensions, EXCEPT DHT(c4), JPG(c8), DAC(cc).
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      height = (buf[o + 5]! << 8) | buf[o + 6]!;
      width = (buf[o + 7]! << 8) | buf[o + 8]!;
      break;
    }
    if (marker === 0xda) break; // start of scan reached before any SOF
    o += 2 + len;
  }
  if (width <= 0 || height <= 0) throw new Error('JPEG dimensions not found');
  const complete = buf.length >= 2 && buf[buf.length - 2] === 0xff && buf[buf.length - 1] === 0xd9;
  return { format: 'jpeg', width, height, complete };
}

function readPng(buf: Buffer): ImageInfo {
  // IHDR is always the first chunk: [len(4)][type(4)='IHDR'][width(4)][height(4)]
  if (buf.length < 24 || buf.toString('ascii', 12, 16) !== 'IHDR') throw new Error('malformed PNG (missing IHDR)');
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (width <= 0 || height <= 0) throw new Error('PNG dimensions invalid');
  const complete = buf.length >= 8 && buf.toString('ascii', buf.length - 8, buf.length - 4) === 'IEND';
  return { format: 'png', width, height, complete };
}

function readWebp(buf: Buffer): ImageInfo {
  if (buf.length < 30) throw new Error('WEBP too short');
  const variant = buf.toString('ascii', 12, 16);
  let width = 0;
  let height = 0;
  if (variant === 'VP8 ') {
    width = ((buf[27]! << 8) | buf[26]!) & 0x3fff;
    height = ((buf[29]! << 8) | buf[28]!) & 0x3fff;
  } else if (variant === 'VP8L') {
    const b0 = buf[21]!, b1 = buf[22]!, b2 = buf[23]!, b3 = buf[24]!;
    width = 1 + (((b1 & 0x3f) << 8) | b0);
    height = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
  } else if (variant === 'VP8X') {
    width = 1 + (buf[24]! | (buf[25]! << 8) | (buf[26]! << 16));
    height = 1 + (buf[27]! | (buf[28]! << 8) | (buf[29]! << 16));
  } else {
    throw new Error('unknown WEBP variant');
  }
  if (width <= 0 || height <= 0) throw new Error('WEBP dimensions invalid');
  const complete = buf.readUInt32LE(4) === buf.length - 8; // RIFF chunk size vs file size
  return { format: 'webp', width, height, complete };
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

/** The ffprobe binary — overridable via env so operators (and tests) can point
 * at a specific install or a deliberately missing one. */
function ffprobeBin(): string {
  return process.env.FFPROBE_BIN || 'ffprobe';
}

function ffprobe(file: string, args: string[]): string {
  try {
    return execFileSync(ffprobeBin(), ['-v', 'error', ...args, file], { encoding: 'utf8' }).trim();
  } catch (err) {
    // ENOENT = the binary could not be spawned at all (not installed / not on
    // PATH). That is a TOOLING error, not a verdict on the asset — surface it
    // truthfully instead of mislabeling the file as "not decodable".
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new QaToolingError(
        `media QA tool not found: "${ffprobeBin()}". Install ffmpeg/ffprobe and ensure it is on PATH (or set FFPROBE_BIN).`,
      );
    }
    // Otherwise ffprobe RAN and exited non-zero — a real "cannot decode" signal.
    throw err;
  }
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
  let info: ImageInfo;
  try {
    // Pure-JS inspection — no external tool, so a valid image passes regardless
    // of whether ffprobe is installed. A throw here means the ASSET is not a
    // recognized/parseable image, which IS a real QA failure.
    info = readImageInfo(file);
  } catch {
    return { file, pass: false, checks: [check('file integrity', false, 'not decodable', 'valid image file')] };
  }
  const dims = `${info.width}x${info.height}`;
  checks.push(check('decodable image', true, `${info.format} ${dims}`, 'recognized image (jpeg/png/webp)'));
  checks.push(check('complete (not truncated)', info.complete, info.complete ? 'ok' : 'truncated', 'end-of-image marker present'));
  checks.push(check('portrait orientation', info.height > info.width, dims, 'height > width'));
  checks.push(check('minimum resolution', info.width >= minWidth && info.height >= minHeight, dims, `>= ${minWidth}x${minHeight}`));
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
  } catch (err) {
    if (err instanceof QaToolingError) throw err; // inspector missing != asset invalid
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
      } catch (err) {
        if (err instanceof QaToolingError) throw err;
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
