#!/usr/bin/env node
/**
 * Exports each character's stored systemPrompt, so the harness's variant A is
 * the REAL production prompt rather than a reconstruction of it.
 *
 * WHY THIS EXISTS. `systemPrompt` is server-side only by design: the public
 * roster deliberately omits it, which is correct and should stay that way. But
 * variant A's entire job is to be a true production baseline, and a baseline
 * assembled from the fields that happen to be public is not one — it is missing
 * a second, imperative copy of the same style directives. An approximated
 * baseline would make every A/B/C comparison meaningless in the direction that
 * flatters the proposal, which is the worst way to be wrong.
 *
 * WHY IT GOES THROUGH THE ADMIN API AND NOT THE DATABASE. `GET /admin/characters`
 * is the application's own sanctioned read of this field, already admin-gated
 * and already the exact value the prompt builder loads. Reading the production
 * database directly would need the production credentials on this machine to
 * answer a question the app already answers.
 *
 * WHAT IT DOES TO PRODUCTION: one login, one GET, one logout. It creates no
 * account, writes no character data, and changes nothing. The only trace is a
 * session row, which the logout at the end removes.
 *
 * CREDENTIALS ARE NEVER STORED, PRINTED OR LOGGED. They are read from the
 * environment for the duration of one login and are not written anywhere.
 *
 *   OVER18_ADMIN_EMAIL=you@example.com \
 *   OVER18_ADMIN_PASSWORD='...' \
 *   node apps/api/scripts/export-system-prompts.mjs
 *
 *   --api <url>   target a different deployment (default: production)
 *
 * OUTPUT: apps/api/.env.harness-prompts.json — a { name: systemPrompt } map.
 * The `.env.` prefix is deliberate and not cosmetic: .gitignore already ignores
 * `.env.*`, so internal prompt text cannot be committed by accident. Nothing
 * else in scripts/ has that protection.
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', '.env.harness-prompts.json');

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
};
const API = (arg('api', 'https://over18-production.up.railway.app')).replace(/\/+$/, '');

const email = process.env.OVER18_ADMIN_EMAIL;
const password = process.env.OVER18_ADMIN_PASSWORD;

if (!email || !password) {
  console.error(
    [
      'BLOCKED: no admin credentials in the environment.',
      '',
      'This script needs an existing admin account. It creates nothing.',
      '',
      "  OVER18_ADMIN_EMAIL='you@example.com' \\",
      "  OVER18_ADMIN_PASSWORD='...' \\",
      '  node apps/api/scripts/export-system-prompts.mjs',
      '',
      'Neither value is stored, printed or logged.',
    ].join('\n'),
  );
  process.exit(2);
}

async function main() {
  const login = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!login.ok) {
    // Never echo the body: the login route is deliberately vague about which
    // half was wrong, and there is no reason to widen that here.
    console.error(`BLOCKED: login failed (HTTP ${login.status}). Check the credentials.`);
    process.exit(2);
  }

  // Replay whatever session cookie the server set, without needing to know its
  // name — one less thing to drift when the cookie is renamed.
  const cookie = (login.headers.getSetCookie?.() ?? [])
    .map((c) => c.split(';')[0])
    .join('; ');
  if (!cookie) {
    console.error('BLOCKED: login succeeded but set no session cookie.');
    process.exit(2);
  }

  const res = await fetch(`${API}/admin/characters`, { headers: { cookie } });
  if (res.status === 403) {
    console.error('BLOCKED: that account is not an admin, so it cannot read character profiles.');
    process.exit(2);
  }
  if (!res.ok) {
    console.error(`BLOCKED: /admin/characters returned HTTP ${res.status}.`);
    process.exit(2);
  }
  const characters = await res.json();

  const map = {};
  for (const c of characters) {
    // Recorded even when empty. A key that is present and blank is a VERIFIED
    // empty prompt; a missing key means "never fetched", and the harness has to
    // be able to tell those apart or it is approximating again.
    map[c.name] = typeof c.systemPrompt === 'string' ? c.systemPrompt : '';
  }

  writeFileSync(OUT, `${JSON.stringify(map, null, 2)}\n`, 'utf8');

  // Tidy up: the session was only needed for one GET.
  await fetch(`${API}/api/auth/logout`, { method: 'POST', headers: { cookie } }).catch(() => {});

  // Lengths only. The prompt text itself stays in the file.
  console.log(`Exported ${Object.keys(map).length} character prompts -> ${OUT}\n`);
  for (const [name, prompt] of Object.entries(map)) {
    const n = prompt.trim().length;
    console.log(`  ${name.padEnd(12)} ${n === 0 ? 'EMPTY (verified)' : `${n} chars`}`);
  }
  console.log('\nVariant A is now exact for these characters. The file is gitignored.');
}

main().catch((error) => {
  console.error(`export failed: ${error.message}`);
  process.exit(1);
});
