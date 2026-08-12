#!/usr/bin/env node
/**
 * US-16E — thin launcher for the offline media pipeline (src/media-pipeline/).
 *
 *   node scripts/media-pipeline.mjs <command> [options]
 *
 * Runs the TypeScript CLI through the repo's tsx dev dependency. tsx is
 * resolved to its JS entry and executed with THIS node binary directly —
 * never via `npx`/a `.cmd` shim — because on Windows Node's spawn cannot
 * launch `.cmd` files without a shell (EINVAL since the CVE-2024-27980 fix),
 * which made the original `spawnSync('npx', ...)` version exit silently
 * with no output and no work done. Any spawn failure is now surfaced loudly.
 *
 * NOTE: the pipeline runs with apps/api as its working directory, so outputs
 * land in apps/api/media-out/ (override with MEDIA_OUT_DIR).
 *
 * See src/media-pipeline/cli.ts for commands, env vars, and budget controls.
 * This is OFFLINE tooling: the application never imports the pipeline, and no
 * credential is stored anywhere — ATLASCLOUD_API_KEY is read from the
 * environment by the Atlas adapter only when --provider atlas is used.
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const apiDir = join(dirname(fileURLToPath(import.meta.url)), '..');

let tsxCli;
try {
  // Resolve tsx's package root from THIS file's location (works with the
  // workspace-hoisted node_modules), then use its JS CLI entry directly.
  const require = createRequire(import.meta.url);
  tsxCli = join(dirname(require.resolve('tsx/package.json')), 'dist', 'cli.mjs');
} catch {
  console.error('ERROR: could not resolve the "tsx" dev dependency. Run `npm install` at the repo root first.');
  process.exit(1);
}

const result = spawnSync(process.execPath, [tsxCli, join('src', 'media-pipeline', 'cli.ts'), ...process.argv.slice(2)], {
  cwd: apiDir,
  stdio: 'inherit',
});

if (result.error) {
  // A spawn failure means the CLI NEVER ran — say so loudly, never silently.
  console.error(`ERROR: failed to launch the pipeline CLI (${result.error.code ?? result.error.message}). No command was executed.`);
  process.exit(1);
}

// Exit-code mapping hardened for Windows: after a provider error the tsx child
// can abort during teardown (libuv "UV_HANDLE_CLOSING" assertion) with a
// signal or a large NTSTATUS code. Raw NTSTATUS values truncate mod 256 on
// exit and could masquerade as success. Rules: exact 0 = success; 1-255
// preserved verbatim (usage=2, refusal=3, etc.); anything else — signal,
// null, or out-of-range — is reported and mapped to failure. The child's real
// error output has already been shown above via stdio: 'inherit'.
if (result.signal) {
  console.error(`NOTE: pipeline CLI terminated by signal ${result.signal} after the output above; treating as failure (exit 1).`);
  process.exit(1);
}
const status = result.status;
if (status === 0) process.exit(0);
if (Number.isInteger(status) && status >= 1 && status <= 255) process.exit(status);
console.error(`NOTE: pipeline CLI terminated abnormally (status ${status}) after the output above; treating as failure (exit 1).`);
process.exit(1);
