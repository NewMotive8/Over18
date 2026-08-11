#!/usr/bin/env node
/**
 * Post-deployment LIVE QA: real-LLM smoke + production memory-recall test.
 *
 * Drives the DEPLOYED API over plain REST exactly like the browser does —
 * no database access, no credentials beyond a throwaway QA account, and the
 * provider key never leaves the server. Two results are reported, each with
 * an explicit verdict:
 *
 *   LIVE SMOKE: PASS | FAIL | BLOCKED
 *     A chat send returns a real in-character completion (in production the
 *     deterministic fallback is forbidden, so any 201 reply proves the real
 *     provider).
 *
 *   LIVE MEMORY RECALL: PASS | FAIL | BLOCKED
 *     A fact is introduced, then pushed OUT of the model's context window by
 *     filler traffic (there is deliberately no history-delete API), then a
 *     recall question must surface the fact — which at that point can only
 *     come from persisted memory. This exercises the REAL model, so wording
 *     varies: the check is keyword-based and retried once. It is
 *     post-deployment EVIDENCE, not a deployment gate.
 *
 * Verdict semantics:
 *   PASS    — the behaviour was demonstrated.
 *   FAIL    — the app responded but the behaviour was not demonstrated.
 *   BLOCKED — the check could not run to a verdict (unreachable host,
 *             ai_not_configured, setup step failed). Never report BLOCKED
 *             as either pass or fail.
 *
 * Usage:
 *   node scripts/qa-memory.mjs --base-url https://over18-production.up.railway.app
 *   (or QA_API_BASE_URL env var). Optional: QA_CONTEXT_MAX_CHARS if the
 *   deployment overrides LLM_CONTEXT_MAX_CHARS (default 16000).
 *
 * Exit codes: 0 = all PASS, 1 = at least one FAIL, 2 = at least one BLOCKED.
 * QA accounts are named qa-mem-<timestamp>@qa.over18.local so they are easy
 * to identify; the PoC has no user-deletion endpoint, so they persist.
 */

const argIdx = process.argv.indexOf('--base-url');
const BASE_URL = (argIdx > -1 ? process.argv[argIdx + 1] : process.env.QA_API_BASE_URL)?.replace(/\/+$/, '');
const CONTEXT_MAX_CHARS = Number(process.env.QA_CONTEXT_MAX_CHARS ?? 16_000);
const TIMEOUT_MS = Number(process.env.QA_REQUEST_TIMEOUT_MS ?? 60_000);

const verdicts = { smoke: 'BLOCKED', recall: 'BLOCKED' };
const evidence = [];

function note(line) {
  evidence.push(line);
  console.log(`  · ${line}`);
}

function finish() {
  console.log('');
  console.log(`LIVE SMOKE: ${verdicts.smoke}`);
  console.log(`LIVE MEMORY RECALL: ${verdicts.recall}`);
  const codes = Object.values(verdicts);
  process.exit(codes.includes('BLOCKED') ? 2 : codes.includes('FAIL') ? 1 : 0);
}

if (!BASE_URL) {
  console.error('BLOCKED: no target. Pass --base-url <api url> or set QA_API_BASE_URL.');
  finish();
}

let cookie = null;

async function api(method, path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) {
    const m = setCookie.match(/over18_session=[^;]+/);
    if (m) cookie = m[0];
  }
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* non-JSON body — callers decide */
  }
  return { status: res.status, json };
}

class Blocked extends Error {}

try {
  // ── Reachability ─────────────────────────────────────────────────────────
  const health = await api('GET', '/health');
  if (health.status !== 200 || health.json?.status !== 'ok') {
    throw new Blocked(`health check returned ${health.status}`);
  }
  note(`target ${BASE_URL} healthy`);

  // ── Throwaway QA account + Luna conversation ─────────────────────────────
  const stamp = Date.now();
  const email = `qa-mem-${stamp}@qa.over18.local`;
  const reg = await api('POST', '/api/auth/register', { email, password: `QaMem-${stamp}-x1` });
  if (reg.status !== 201 || !cookie) throw new Blocked(`register returned ${reg.status}`);
  note(`registered QA user ${email}`);

  const chars = await api('GET', '/api/characters');
  if (chars.status !== 200 || !Array.isArray(chars.json) || chars.json.length === 0) {
    throw new Blocked(`characters list returned ${chars.status}`);
  }
  const luna = chars.json.find((c) => c.name === 'luna') ?? chars.json[0];
  const conv = await api('POST', '/api/conversations', { characterId: luna.id });
  if (conv.status !== 201 && conv.status !== 200) throw new Blocked(`conversation returned ${conv.status}`);
  const conversationId = conv.json.id;

  async function send(content) {
    const t0 = Date.now();
    const res = await api('POST', `/api/conversations/${conversationId}/messages`, { content });
    return { ...res, ms: Date.now() - t0 };
  }

  // ── LIVE SMOKE: one real completion through the deployed backend ─────────
  const fact = await send('I have a cat named Orion. He naps on my desk while I work.');
  if (fact.status === 503 && fact.json?.error === 'ai_not_configured') {
    verdicts.smoke = 'BLOCKED';
    note('smoke BLOCKED: deployment reports ai_not_configured (LLM_* vars not set)');
    throw new Blocked('provider not configured — recall cannot run either');
  }
  const reply = fact.json?.characterMessage?.content;
  if (fact.status === 201 && typeof reply === 'string' && reply.trim().length > 0) {
    verdicts.smoke = 'PASS';
    note(`smoke PASS: real completion in ${fact.ms}ms (${reply.trim().length} chars)`);
  } else {
    verdicts.smoke = 'FAIL';
    note(`smoke FAIL: send returned ${fact.status}${fact.json?.error ? ` (${fact.json.error})` : ''}`);
    throw new Blocked('no working completion path — recall setup impossible');
  }

  // ── Push the fact out of the context window with neutral filler ──────────
  // Whole-message window, newest-first (US-10): once newer history exceeds
  // LLM_CONTEXT_MAX_CHARS, the fact-bearing exchange is no longer sent.
  const filler = 'The harbour is calm tonight and the ferries drift by slowly under a wide pale sky. '
    .repeat(30)
    .slice(0, 1_900);
  const fillerCount = Math.ceil((CONTEXT_MAX_CHARS + 500) / filler.length);
  note(`sending ${fillerCount} filler messages (~${filler.length} chars each) to overflow the ${CONTEXT_MAX_CHARS}-char window`);
  for (let i = 0; i < fillerCount; i++) {
    let r = await send(filler);
    if (r.status !== 201) r = await send(filler); // tolerate one transient provider hiccup
    if (r.status !== 201) throw new Blocked(`filler send ${i + 1}/${fillerCount} returned ${r.status}`);
  }

  // ── LIVE MEMORY RECALL: the fact can now only come from persisted memory ─
  const questions = ['What is the name of my cat?', 'Do you remember the name of my cat?'];
  for (const [attempt, question] of questions.entries()) {
    const r = await send(question);
    const text = r.status === 201 ? (r.json?.characterMessage?.content ?? '') : '';
    if (/orion/i.test(text)) {
      verdicts.recall = 'PASS';
      note(`recall PASS on attempt ${attempt + 1}: reply mentions Orion (${r.ms}ms)`);
      break;
    }
    verdicts.recall = 'FAIL';
    note(`recall attempt ${attempt + 1}: no mention of Orion (status ${r.status})`);
  }
} catch (err) {
  if (!(err instanceof Blocked)) {
    note(`BLOCKED by unexpected error: ${err instanceof Error ? err.message : String(err)}`);
  } else if (err.message) {
    note(`BLOCKED: ${err.message}`);
  }
}

finish();
