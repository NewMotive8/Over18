#!/usr/bin/env node
/**
 * Writes the cached Grok voice samples onto the media volume.
 *
 * The Admin voice picker plays one short MP3 per voice. Nothing generates them
 * on boot or on deploy, so an environment has no previews until this is run
 * there — the picker still works, it just says "No preview available" until
 * the files exist.
 *
 * IT MUST RUN WHERE THE VOLUME IS. The files go to MEDIA_STORAGE_DIR, so on
 * Railway this belongs inside the service (`railway ssh`), not in a local
 * `railway run`, which would only fill a directory on your own machine.
 *
 *   railway ssh -e staging -s "Over18 API Staging"
 *   node scripts/generate-voice-samples.mjs
 *
 * Locally, build first (this imports the compiled module) and pass the same
 * two variables the API reads:
 *
 *   npm run build -w @over18/api
 *   VOICE_GROK_API_KEY=xai-... MEDIA_STORAGE_DIR=./var/media \
 *     node apps/api/scripts/generate-voice-samples.mjs
 *
 * A SECOND RUN BILLS NOTHING. Only missing voices are generated; everything
 * already on the volume is skipped. Pass --force to regenerate the lot, which
 * is only wanted after the sample sentence itself changes.
 *
 * The key is read from the environment, never printed and never written down.
 */

import { generateMissingVoiceSamples } from '../dist/voice/grok-voice-samples.js';

const apiKey = process.env.VOICE_GROK_API_KEY;
const mediaDir = process.env.MEDIA_STORAGE_DIR;
const force = process.argv.includes('--force');

if (!apiKey || !mediaDir) {
  console.error(
    'FATAL: set VOICE_GROK_API_KEY and MEDIA_STORAGE_DIR. Nothing was sent and nothing was written.',
  );
  process.exit(1);
}

const result = await generateMissingVoiceSamples({ apiKey, storage: { mediaDir }, force });

console.log(`generated: ${result.generated.length}`, result.generated.join(', '));
console.log(`skipped:   ${result.skipped.length}`);
console.log(`billed:    ${result.charactersBilled} characters`);
if (result.failed.length > 0) {
  console.error(`failed:    ${result.failed.length}`);
  for (const { voice, reason } of result.failed) console.error(`  ${voice}: ${reason}`);
  // A partial roster is usable, so this is reported rather than thrown -- but
  // the exit code says a retry is wanted.
  process.exit(2);
}
