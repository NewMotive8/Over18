import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  GROK_VOICE_CATALOGUE,
  GROK_VOICE_SAMPLE_TEXT,
  isKnownGrokVoice,
  type GrokVoice,
} from '@over18/shared';

/**
 * Cached voice samples: one short MP3 per Grok voice, generated once.
 *
 * ── WHY CACHED AND NOT LIVE ──────────────────────────────────────────────────
 *
 * An operator wants to HEAR a voice before assigning it, and the honest way to
 * do that is to play that voice. Doing it live would bill a synthesis on every
 * click of a dropdown somebody is browsing; doing it once bills 28 short
 * sentences in total and then costs nothing for ever. xAI prices TTS by the
 * character ($15 per million), so the whole set is roughly 1,700 characters --
 * about three cents, once.
 *
 * ── WHY THE REALTIME API IS NOT USED HERE ────────────────────────────────────
 *
 * The call path speaks to `/v1/realtime`, which has no "say this sentence"
 * request: it is a conversation. `/v1/tts` renders one line in one voice and
 * returns the bytes, which is exactly what a sample is. The two share the voice
 * roster -- verified against `GET /v1/tts/voices`, which returned precisely the
 * 28 ids in GROK_VOICE_CATALOGUE -- so the sample is the voice the caller will
 * hear, rendered by a different engine. The UI says "sample" rather than
 * implying it is a recording of a call.
 *
 * ── NEVER REGENERATED AUTOMATICALLY ──────────────────────────────────────────
 *
 * `generateMissingVoiceSamples` writes only what is absent. Nothing calls it on
 * boot or on deploy; it is run deliberately, and a second run is a no-op that
 * bills nothing. A voice whose file is missing simply has no preview -- the
 * option stays selectable, because being unable to audition a voice is not a
 * reason to be unable to choose it.
 */

export const XAI_TTS_URL = 'https://api.x.ai/v1/tts';

/** Where samples live under the media volume. One flat directory, 28 files. */
export const VOICE_SAMPLE_DIR = 'voice-samples';

/** Served and stored as MP3 — xAI's default output, and universally playable. */
export const VOICE_SAMPLE_CONTENT_TYPE = 'audio/mpeg';

export interface VoiceSampleStorage {
  /** Absolute path of the media root (MEDIA_STORAGE_DIR). */
  mediaDir: string;
}

/** The file one voice's sample occupies. Lower-cased, so it cannot collide. */
export function voiceSamplePath(storage: VoiceSampleStorage, voice: string): string {
  return join(storage.mediaDir, VOICE_SAMPLE_DIR, `${voice.trim().toLowerCase()}.mp3`);
}

/** Whether a playable sample exists for this voice right now. */
export function hasVoiceSample(storage: VoiceSampleStorage, voice: string): boolean {
  if (!isKnownGrokVoice(voice)) return false;
  return existsSync(voiceSamplePath(storage, voice));
}

/** Every voice that currently has a sample, in catalogue order. */
export function availableVoiceSamples(storage: VoiceSampleStorage): GrokVoice[] {
  return GROK_VOICE_CATALOGUE.filter((voice) => hasVoiceSample(storage, voice));
}

/**
 * Reads one sample. Null when there is none, which the route turns into a 404
 * rather than an error: a missing sample is an ordinary state, not a fault.
 */
export async function readVoiceSample(
  storage: VoiceSampleStorage,
  voice: string,
): Promise<Buffer | null> {
  if (!isKnownGrokVoice(voice)) return null;
  try {
    return await readFile(voiceSamplePath(storage, voice));
  } catch {
    return null;
  }
}

export interface GenerateSamplesResult {
  generated: GrokVoice[];
  skipped: GrokVoice[];
  failed: Array<{ voice: GrokVoice; reason: string }>;
  charactersBilled: number;
}

export interface GenerateSamplesOptions {
  apiKey: string;
  storage: VoiceSampleStorage;
  /** Test seam. Production passes nothing and the real endpoint is used. */
  fetchImpl?: typeof fetch;
  /** Overwrite existing files. Off by default -- regeneration is deliberate. */
  force?: boolean;
  text?: string;
}

/**
 * Generates the samples that are missing, and only those.
 *
 * One voice failing does not stop the rest: a roster that is 27/28 playable is
 * better than none, and the failure is reported per voice so a retry can be
 * targeted. The reason is a status or a short message -- never a response body,
 * which could echo the request.
 */
export async function generateMissingVoiceSamples(
  options: GenerateSamplesOptions,
): Promise<GenerateSamplesResult> {
  const doFetch = options.fetchImpl ?? fetch;
  const text = options.text ?? GROK_VOICE_SAMPLE_TEXT;
  const result: GenerateSamplesResult = {
    generated: [], skipped: [], failed: [], charactersBilled: 0,
  };

  await mkdir(join(options.storage.mediaDir, VOICE_SAMPLE_DIR), { recursive: true });

  for (const voice of GROK_VOICE_CATALOGUE) {
    if (!options.force && hasVoiceSample(options.storage, voice)) {
      result.skipped.push(voice);
      continue;
    }
    try {
      const res = await doFetch(XAI_TTS_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${options.apiKey}`,
        },
        body: JSON.stringify({ text, voice_id: voice, language: 'en' }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) {
        // Status only. A body can quote the request back.
        result.failed.push({ voice, reason: `HTTP ${res.status}` });
        continue;
      }
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.length === 0) {
        result.failed.push({ voice, reason: 'empty audio' });
        continue;
      }
      await writeFile(voiceSamplePath(options.storage, voice), bytes);
      result.generated.push(voice);
      result.charactersBilled += text.length;
    } catch (error) {
      result.failed.push({
        voice,
        reason: error instanceof Error ? error.name : 'unexpected',
      });
    }
  }
  return result;
}

/**
 * A stable fingerprint of the sample sentence.
 *
 * Lets an operator tell "these samples were made from the current sentence"
 * from "these are older", without storing the sentence beside every file.
 */
export function sampleTextFingerprint(text: string = GROK_VOICE_SAMPLE_TEXT): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 12);
}
