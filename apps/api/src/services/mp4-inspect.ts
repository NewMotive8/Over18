/**
 * Structural reader for a stored MP4 — the facts a derivative must match.
 *
 * WHY THIS IS NOT `video-codec.ts`. That module answers "is this codec one a
 * browser refuses to play?" and it FAILS OPEN on purpose: an unparseable
 * container yields no opinion and the upload proceeds, because refusing a file
 * a parser did not recognise would turn a safety net into a way to lose work.
 *
 * This module answers a different question — "is this derivative safe to serve
 * INSTEAD of the operator's original?" — and it must FAIL CLOSED. Anything it
 * cannot read with certainty returns null, which the verifier treats as "do not
 * adopt", which leaves the original serving. The two contracts are opposite, so
 * they live in two files rather than sharing one and drifting.
 *
 * NO EXTERNAL BINARY. ffprobe would be the obvious implementation and it is not
 * available: the API image ships neither ffmpeg nor ffprobe, and adding them is
 * a build-configuration decision this work is explicitly not taking. So the
 * facts are read out of the container's own box tree, which is a bounded amount
 * of parsing for a file format that states all of them in its header.
 *
 * WHAT IT CANNOT DO, stated plainly: it does not decode. A file can be
 * structurally perfect and still fail in a decoder. This proves that the
 * container says what it should; it does not prove the pictures come out. That
 * gap is covered by encoding with a known-good encoder and by a human looking
 * at the result before adoption.
 *
 * BOUNDED EVERYWHERE. Every offset is checked against the buffer, depth and
 * iteration are capped, and a malformed size ends the walk. This parses bytes
 * that arrived over the wire.
 */

import { openSync, readSync, closeSync, fstatSync } from 'node:fs';

/** Boxes on the path from the file root down to the sample tables. */
const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl']);

/** MP4 sample-description codes mapped to a codec name. */
const FOURCC: Record<string, string> = {
  avc1: 'h264',
  avc3: 'h264',
  hvc1: 'hevc',
  hev1: 'hevc',
  hvc2: 'hevc',
  av01: 'av1',
  vp08: 'vp8',
  vp09: 'vp9',
  mp4v: 'mpeg4',
};

export interface Mp4Facts {
  /** Total file size in bytes. */
  bytes: number;
  /** Top-level box types, in file order. */
  topLevel: string[];
  /** True when `moov` precedes `mdat` — the browser can start before the end. */
  faststart: boolean;
  /** Video codec name, or null when no video track was identified. */
  videoCodec: string | null;
  width: number | null;
  height: number | null;
  /** Video-track duration in seconds, from its own media header. */
  durationSeconds: number | null;
  /** Number of video samples — frames. */
  frameCount: number | null;
  /** How many audio tracks the container declares. */
  audioStreams: number;
  /** How many video tracks the container declares. */
  videoStreams: number;
}

/** Reads the whole file into memory. These are short clips; simplicity wins. */
function readAll(path: string): Buffer {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const buf = Buffer.alloc(size);
    let read = 0;
    while (read < size) {
      const n = readSync(fd, buf, read, size - read, read);
      if (n <= 0) break;
      read += n;
    }
    return read === size ? buf : buf.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

interface Box {
  type: string;
  bodyStart: number;
  bodyEnd: number;
}

/** Immediate children of the byte range, or null if anything is malformed. */
function children(bytes: Buffer, start: number, end: number): Box[] | null {
  const out: Box[] = [];
  let offset = start;
  let guard = 0;
  while (offset + 8 <= end) {
    if (++guard > 4096) return null;
    let size = bytes.readUInt32BE(offset);
    const type = bytes.toString('latin1', offset + 4, offset + 8);
    let header = 8;
    if (size === 1) {
      if (offset + 16 > end) return null;
      const hi = bytes.readUInt32BE(offset + 8);
      const lo = bytes.readUInt32BE(offset + 12);
      size = hi * 2 ** 32 + lo;
      header = 16;
    } else if (size === 0) {
      size = end - offset;
    }
    if (size < header || offset + size > end) return null;
    out.push({ type, bodyStart: offset + header, bodyEnd: offset + size });
    offset += size;
  }
  return out;
}

/** Depth-first search for the first descendant of `type`. */
function find(bytes: Buffer, boxes: Box[], type: string, depth = 0): Box | null {
  if (depth > 8) return null;
  for (const box of boxes) {
    if (box.type === type) return box;
    if (CONTAINERS.has(box.type)) {
      const kids = children(bytes, box.bodyStart, box.bodyEnd);
      if (kids) {
        const hit = find(bytes, kids, type, depth + 1);
        if (hit) return hit;
      }
    }
  }
  return null;
}

/** `tkhd` width/height — 16.16 fixed point, at a version-dependent offset. */
function trackGeometry(bytes: Buffer, tkhd: Box): { width: number; height: number } | null {
  const version = bytes.readUInt8(tkhd.bodyStart);
  const at = tkhd.bodyStart + (version === 1 ? 88 : 76);
  if (at + 8 > tkhd.bodyEnd) return null;
  return {
    width: Math.round(bytes.readUInt32BE(at) / 65536),
    height: Math.round(bytes.readUInt32BE(at + 4) / 65536),
  };
}

/** `mdhd` timescale + duration — the track's own clock. */
function trackDuration(bytes: Buffer, mdhd: Box): number | null {
  const version = bytes.readUInt8(mdhd.bodyStart);
  if (version === 1) {
    const at = mdhd.bodyStart + 20;
    if (at + 12 > mdhd.bodyEnd) return null;
    const timescale = bytes.readUInt32BE(at);
    const hi = bytes.readUInt32BE(at + 4);
    const lo = bytes.readUInt32BE(at + 8);
    const duration = hi * 2 ** 32 + lo;
    return timescale > 0 ? duration / timescale : null;
  }
  const at = mdhd.bodyStart + 12;
  if (at + 8 > mdhd.bodyEnd) return null;
  const timescale = bytes.readUInt32BE(at);
  const duration = bytes.readUInt32BE(at + 4);
  return timescale > 0 ? duration / timescale : null;
}

/** `stts` sample counts summed — how many frames the track holds. */
function sampleCount(bytes: Buffer, stts: Box): number | null {
  const at = stts.bodyStart + 4;
  if (at + 4 > stts.bodyEnd) return null;
  const entries = bytes.readUInt32BE(at);
  if (entries > 1_000_000) return null;
  let total = 0;
  let offset = at + 4;
  for (let i = 0; i < entries; i++) {
    if (offset + 8 > stts.bodyEnd) return null;
    total += bytes.readUInt32BE(offset);
    offset += 8;
  }
  return total;
}

/** First sample-description fourcc, mapped to a codec name. */
function codecOf(bytes: Buffer, stsd: Box): string | null {
  const at = stsd.bodyStart + 8;
  if (at + 8 > stsd.bodyEnd) return null;
  const fourcc = bytes.toString('latin1', at + 4, at + 8).toLowerCase();
  return FOURCC[fourcc] ?? null;
}

/**
 * Everything the verifier needs, or null when the container cannot be read
 * with certainty. Null is always "do not adopt", never "assume it is fine".
 */
export function inspectMp4(path: string): Mp4Facts | null {
  let bytes: Buffer;
  try {
    bytes = readAll(path);
  } catch {
    return null;
  }
  if (bytes.length < 16) return null;

  try {
    const top = children(bytes, 0, bytes.length);
    if (!top) return null;
    const topLevel = top.map((b) => b.type);
    const moovIndex = topLevel.indexOf('moov');
    const mdatIndex = topLevel.indexOf('mdat');
    if (moovIndex === -1) return null;

    const moov = top[moovIndex]!;
    const moovKids = children(bytes, moov.bodyStart, moov.bodyEnd);
    if (!moovKids) return null;

    let audioStreams = 0;
    let videoStreams = 0;
    let videoCodec: string | null = null;
    let width: number | null = null;
    let height: number | null = null;
    let durationSeconds: number | null = null;
    let frameCount: number | null = null;

    for (const trak of moovKids.filter((b) => b.type === 'trak')) {
      const trakKids = children(bytes, trak.bodyStart, trak.bodyEnd);
      if (!trakKids) return null;
      const hdlr = find(bytes, trakKids, 'hdlr');
      if (!hdlr || hdlr.bodyStart + 12 > hdlr.bodyEnd) return null;
      const handler = bytes.toString('latin1', hdlr.bodyStart + 8, hdlr.bodyStart + 12);

      if (handler === 'soun') {
        audioStreams += 1;
        continue;
      }
      if (handler !== 'vide') continue;

      videoStreams += 1;
      // Facts come from the FIRST video track; a second one is recorded in the
      // count so the verifier can refuse a shape it was not asked to produce.
      if (videoStreams > 1) continue;

      const tkhd = find(bytes, trakKids, 'tkhd');
      if (tkhd) {
        const geo = trackGeometry(bytes, tkhd);
        if (geo) {
          width = geo.width;
          height = geo.height;
        }
      }
      const mdhd = find(bytes, trakKids, 'mdhd');
      if (mdhd) durationSeconds = trackDuration(bytes, mdhd);
      const stts = find(bytes, trakKids, 'stts');
      if (stts) frameCount = sampleCount(bytes, stts);
      const stsd = find(bytes, trakKids, 'stsd');
      if (stsd) videoCodec = codecOf(bytes, stsd);
    }

    return {
      bytes: bytes.length,
      topLevel,
      faststart: mdatIndex === -1 ? true : moovIndex < mdatIndex,
      videoCodec,
      width,
      height,
      durationSeconds,
      frameCount,
      audioStreams,
      videoStreams,
    };
  } catch {
    return null;
  }
}
