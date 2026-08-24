/**
 * Which video codec is actually inside an uploaded file.
 *
 * WHY THE MIME TYPE IS NOT ENOUGH. The upload gate accepted `video/mp4` and
 * stopped there — but a container is not a codec. An HEVC/H.265 file declares
 * itself `video/mp4`, passes that check, is stored, is approved, and then fails
 * to decode in Chrome on Android and most desktop Chrome. The operator sees a
 * clip that works in their player; visitors see a tile that never starts. One
 * such file was found in the content library (`Main.mp4`, 480x848 hevc), which
 * is how this stopped being hypothetical.
 *
 * NO EXTERNAL BINARY. The obvious implementation shells out to ffprobe, and
 * that would be a production outage: the API image does not ship ffmpeg or
 * ffprobe, so every upload would start failing the moment this shipped. So the
 * codec is read out of the container bytes directly. It is a small amount of
 * parsing for a check that runs on data the caller already holds in memory.
 *
 * FAIL-OPEN ON UNCERTAINTY, NEVER FAIL-CLOSED. If the container cannot be
 * parsed — an unfamiliar layout, a truncated header — this reports no codecs
 * and the upload proceeds exactly as it does today. Refusing a file because a
 * parser did not recognise it would turn a best-effort safety net into a new
 * way to lose work. It only ever rejects a codec it POSITIVELY identified as
 * unplayable.
 */

/** Codecs a mainstream browser can be relied on to decode. */
const SUPPORTED = new Set(['h264', 'vp8', 'vp9', 'av1']);

/**
 * MP4 sample-description four-character codes, mapped to a codec name.
 *
 * `avc1`/`avc3` are H.264. `hvc1`/`hev1` are HEVC — the ones this exists to
 * catch. `av01`, `vp08`, `vp09` appear in MP4 too and are fine.
 */
const MP4_FOURCC: Record<string, string> = {
  avc1: 'h264',
  avc3: 'h264',
  hvc1: 'hevc',
  hev1: 'hevc',
  hvc2: 'hevc',
  dvh1: 'hevc',
  dvhe: 'hevc',
  av01: 'av1',
  vp08: 'vp8',
  vp09: 'vp9',
  mp4v: 'mpeg4',
};

/** Boxes that contain other boxes on the path from the file root to `stsd`. */
const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl']);

/**
 * Walks the MP4 box tree collecting sample-description codes.
 *
 * BOUNDED ON PURPOSE. Depth and iteration are capped, and every offset is
 * checked against the buffer length, because this parses attacker-supplied
 * bytes: a malformed size field must end the walk, not spin or read out of
 * bounds.
 */
function mp4Codecs(bytes: Buffer): string[] {
  const found = new Set<string>();
  let guard = 0;

  const walk = (start: number, end: number, depth: number): void => {
    let offset = start;
    while (offset + 8 <= end && guard < 4096) {
      guard += 1;
      let size = bytes.readUInt32BE(offset);
      const type = bytes.toString('latin1', offset + 4, offset + 8);
      let header = 8;

      if (size === 1) {
        // 64-bit largesize. Anything beyond 2^53 is not a real file.
        if (offset + 16 > end) return;
        const hi = bytes.readUInt32BE(offset + 8);
        const lo = bytes.readUInt32BE(offset + 12);
        size = hi * 2 ** 32 + lo;
        header = 16;
      } else if (size === 0) {
        size = end - offset; // extends to the end of the file
      }

      if (size < header || offset + size > end) return; // malformed: stop
      const bodyStart = offset + header;
      const bodyEnd = offset + size;

      if (type === 'stsd') {
        // version(1) + flags(3) + entry_count(4), then sized entries.
        let entry = bodyStart + 8;
        while (entry + 8 <= bodyEnd) {
          const entrySize = bytes.readUInt32BE(entry);
          const fourcc = bytes.toString('latin1', entry + 4, entry + 8);
          const codec = MP4_FOURCC[fourcc.toLowerCase()];
          if (codec) found.add(codec);
          if (entrySize < 8) break;
          entry += entrySize;
        }
      } else if (CONTAINERS.has(type) && depth < 8) {
        walk(bodyStart, bodyEnd, depth + 1);
      }

      offset = bodyEnd;
    }
  };

  try {
    walk(0, bytes.length, 0);
  } catch {
    return []; // unparseable — fail open, see the module note
  }
  return [...found];
}

/**
 * Matroska/WebM codec IDs.
 *
 * Read by scanning for the CodecID strings rather than walking EBML: the IDs
 * are self-delimiting ASCII (`V_VP9`, `V_AV1`, `V_MPEGH/ISO/HEVC`), and a full
 * EBML parser would be a great deal of machinery for one string. Ordered
 * longest-first so `V_MPEGH/ISO/HEVC` is not shadowed by a shorter prefix.
 */
const WEBM_CODEC_IDS: Array<[string, string]> = [
  ['V_MPEGH/ISO/HEVC', 'hevc'],
  ['V_MPEG4/ISO/AVC', 'h264'],
  ['V_AV1', 'av1'],
  ['V_VP9', 'vp9'],
  ['V_VP8', 'vp8'],
];

function webmCodecs(bytes: Buffer): string[] {
  const found = new Set<string>();
  // The CodecID lives in the Tracks element, near the head of the file.
  const head = bytes.subarray(0, Math.min(bytes.length, 262144)).toString('latin1');
  for (const [id, codec] of WEBM_CODEC_IDS) {
    if (head.includes(id)) found.add(codec);
  }
  return [...found];
}

export interface VideoCodecInspection {
  /** Every video codec positively identified. Empty when nothing was recognised. */
  codecs: string[];
  /** Those a browser cannot be relied on to play. */
  unsupported: string[];
}

/**
 * Inspects a video upload's container for its codec.
 *
 * Returns empty arrays for images, for unrecognised containers, and for
 * anything unparseable — all of which mean "no opinion", never "reject".
 */
export function inspectVideoCodec(bytes: Buffer, mimeType: string): VideoCodecInspection {
  let codecs: string[] = [];
  if (mimeType === 'video/mp4' || mimeType === 'video/quicktime') codecs = mp4Codecs(bytes);
  else if (mimeType === 'video/webm') codecs = webmCodecs(bytes);

  return {
    codecs,
    unsupported: codecs.filter((c) => !SUPPORTED.has(c)),
  };
}

/** Human-readable names, for a message an operator can act on. */
export const CODEC_LABELS: Record<string, string> = {
  hevc: 'HEVC / H.265',
  mpeg4: 'MPEG-4 Part 2',
};

export function codecLabel(codec: string): string {
  return CODEC_LABELS[codec] ?? codec.toUpperCase();
}
