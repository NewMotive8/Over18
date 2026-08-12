#!/usr/bin/env node
/**
 * US-16E — thin launcher for the offline media pipeline (src/media-pipeline/).
 * Runs the TypeScript CLI via the repo's existing tsx dev dependency:
 *
 *   node scripts/media-pipeline.mjs <command> [options]
 *
 * See src/media-pipeline/cli.ts for commands, env vars, and budget controls.
 * This is OFFLINE tooling: the application never imports the pipeline, and no
 * credential is stored anywhere — ATLASCLOUD_API_KEY is read from the
 * environment by the Atlas adapter only when --provider atlas is used.
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const apiDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const result = spawnSync('npx', ['tsx', join('src', 'media-pipeline', 'cli.ts'), ...process.argv.slice(2)], {
  cwd: apiDir,
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
