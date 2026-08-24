import { describe, expect, it } from 'vitest';
import { inspectVideoCodec, codecLabel } from '../services/video-codec.js';

/**
 * Codec detection, and the reason it exists.
 *
 * The upload gate checked the MIME type and stopped. A container is not a
 * codec: an HEVC/H.265 file declares itself `video/mp4`, passed that check, and
 * would be stored, approved and published — then fail to decode in Chrome on
 * Android and most desktop Chrome. One such file was found in the real content
 * library, so this is a measured risk, not a theoretical one.
 *
 * The fixtures below are hand-built MP4 box trees rather than real media,
 * because the thing under test is the parsing, and a synthetic tree can
 * exercise the shapes real files rarely have: moov at the end, 64-bit sizes,
 * truncation, nonsense.
 */

/** Builds one MP4 box: [size][type][body]. */
function box(type: string, body: Buffer = Buffer.alloc(0)): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length + 8, 0);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, body]);
}

/** A minimal stsd holding one sample entry with the given codec fourcc. */
function stsd(fourcc: string): Buffer {
  const entry = box(fourcc, Buffer.alloc(78)); // a real entry is larger; size is what matters
  const body = Buffer.concat([
    Buffer.from([0, 0, 0, 0]), // version + flags
    Buffer.from([0, 0, 0, 1]), // entry_count
    entry,
  ]);
  return box('stsd', body);
}

/** moov > trak > mdia > minf > stbl > stsd */
const moovWith = (fourcc: string) =>
  box('moov', box('trak', box('mdia', box('minf', box('stbl', stsd(fourcc))))));

const ftyp = box('ftyp', Buffer.from('isomiso2avc1mp41', 'latin1'));
const mdat = (n = 512) => box('mdat', Buffer.alloc(n, 7));

describe('the codec inside the container is what gets checked', () => {
  it('identifies H.264 as supported', () => {
    const file = Buffer.concat([ftyp, moovWith('avc1'), mdat()]);
    expect(inspectVideoCodec(file, 'video/mp4')).toEqual({ codecs: ['h264'], unsupported: [] });
  });

  it('identifies HEVC and marks it unplayable — the case this exists for', () => {
    const file = Buffer.concat([ftyp, moovWith('hvc1'), mdat()]);
    const r = inspectVideoCodec(file, 'video/mp4');
    expect(r.codecs).toEqual(['hevc']);
    expect(r.unsupported).toEqual(['hevc']);
  });

  it('catches every HEVC fourcc variant, including Dolby Vision', () => {
    for (const fourcc of ['hvc1', 'hev1', 'hvc2', 'dvh1', 'dvhe']) {
      const file = Buffer.concat([ftyp, moovWith(fourcc), mdat()]);
      expect(inspectVideoCodec(file, 'video/mp4').unsupported).toEqual(['hevc']);
    }
  });

  it('accepts AV1, VP9 and avc3 in MP4', () => {
    for (const [fourcc, codec] of [['av01', 'av1'], ['vp09', 'vp9'], ['avc3', 'h264']] as const) {
      const file = Buffer.concat([ftyp, moovWith(fourcc), mdat()]);
      expect(inspectVideoCodec(file, 'video/mp4')).toEqual({ codecs: [codec], unsupported: [] });
    }
  });

  it('finds the codec when moov is at the END — the layout every CMS upload has', () => {
    // Not faststart: mdat first. The parser must walk past it, not give up.
    const file = Buffer.concat([ftyp, mdat(4096), moovWith('hvc1')]);
    expect(inspectVideoCodec(file, 'video/mp4').unsupported).toEqual(['hevc']);
  });

  it('handles a 64-bit largesize box without losing its place', () => {
    const inner = moovWith('avc1');
    const head = Buffer.alloc(16);
    head.writeUInt32BE(1, 0);             // size == 1 => largesize follows
    head.write('mdat', 4, 'latin1');
    head.writeUInt32BE(0, 8);             // high 32 bits
    head.writeUInt32BE(16 + 256, 12);     // low 32 bits
    const big = Buffer.concat([head, Buffer.alloc(256, 3)]);
    expect(inspectVideoCodec(Buffer.concat([ftyp, big, inner]), 'video/mp4').codecs).toEqual(['h264']);
  });

  it('reads Matroska/WebM codec ids', () => {
    const webm = (id: string) => Buffer.from(`\x1aE\xdf\xa3....${id}....`, 'latin1');
    expect(inspectVideoCodec(webm('V_VP9'), 'video/webm').codecs).toEqual(['vp9']);
    expect(inspectVideoCodec(webm('V_AV1'), 'video/webm').codecs).toEqual(['av1']);
    const hevc = inspectVideoCodec(webm('V_MPEGH/ISO/HEVC'), 'video/webm');
    expect(hevc.unsupported).toEqual(['hevc']);
  });
});

describe('it never rejects out of ignorance', () => {
  it('has no opinion about images', () => {
    expect(inspectVideoCodec(Buffer.from('\x89PNG\r\n\x1a\n'), 'image/png')).toEqual({
      codecs: [],
      unsupported: [],
    });
  });

  it('has no opinion about an unrecognised container', () => {
    expect(inspectVideoCodec(Buffer.alloc(4096, 9), 'video/mp4')).toEqual({
      codecs: [],
      unsupported: [],
    });
  });

  it('fails OPEN on a truncated file rather than blocking the upload', () => {
    const file = Buffer.concat([ftyp, moovWith('hvc1')]).subarray(0, 20);
    expect(inspectVideoCodec(file, 'video/mp4').unsupported).toEqual([]);
  });

  it('fails OPEN on a malformed box size instead of looping', () => {
    const bad = Buffer.alloc(64);
    bad.writeUInt32BE(0xffffffff, 0);
    bad.write('moov', 4, 'latin1');
    expect(() => inspectVideoCodec(bad, 'video/mp4')).not.toThrow();
    expect(inspectVideoCodec(bad, 'video/mp4').unsupported).toEqual([]);
  });

  it('survives an empty buffer', () => {
    expect(inspectVideoCodec(Buffer.alloc(0), 'video/mp4')).toEqual({ codecs: [], unsupported: [] });
  });
});

describe('the operator is told what to do about it', () => {
  it('names HEVC in words rather than a fourcc', () => {
    expect(codecLabel('hevc')).toBe('HEVC / H.265');
  });
});
