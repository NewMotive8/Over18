#!/usr/bin/env node
/**
 * US-33 real-provider smoke test.
 *
 * Sends ONE real chat-completion request using the exact wire shape of the
 * production adapter (src/llm/openai-compatible.ts): same endpoint path,
 * same headers (Content-Type + optional Authorization bearer), same body
 * fields (model, messages, max_tokens, temperature), same timeout handling.
 * A green run therefore validates the real integration path — config,
 * credentials, protocol, and the failure/timeout envelope — without
 * touching the application or any database.
 *
 * Configuration comes from the SAME environment variables the API reads
 * (src/env.ts), so a passing invocation doubles as a check of the values
 * you are about to set on the API service:
 *
 *   cd apps/api
 *   LLM_BASE_URL=https://openrouter.ai/api/v1 \
 *   LLM_MODEL=nousresearch/hermes-3-llama-3.1-70b \
 *   LLM_API_KEY=sk-or-... \
 *   node scripts/llm-smoke.mjs
 *
 * The key is read from the environment only — it is never printed, never
 * written to disk, and never included in error output.
 */

const baseUrl = process.env.LLM_BASE_URL;
const model = process.env.LLM_MODEL;
const apiKey = process.env.LLM_API_KEY || undefined;
const timeoutMs = Number(process.env.LLM_TIMEOUT_MS ?? 30_000);
const maxTokens = Number(process.env.LLM_MAX_TOKENS ?? 512);
const temperature = Number(process.env.LLM_TEMPERATURE ?? 0.8);

if (!baseUrl || !model) {
  console.error('FATAL: set LLM_BASE_URL and LLM_MODEL (see apps/api/.env.example). Nothing was sent.');
  process.exit(1);
}

// Minimal in-character probe — enough to prove the seam end-to-end without
// depending on the database or seed data.
const messages = [
  {
    role: 'system',
    content:
      'You are Luna, a dreamy astronomy graduate student. Always stay in character as Luna. ' +
      'Do not describe yourself as an AI, a language model, an assistant, or a bot. ' +
      'Keep replies conversational — a few warm sentences.',
  },
  { role: 'user', content: "hey Luna… couldn't sleep. what are you looking at tonight?" },
];

const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;

const t0 = Date.now();
let response;
try {
  response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature }),
    signal: AbortSignal.timeout(timeoutMs),
  });
} catch (err) {
  if (err instanceof Error && err.name === 'TimeoutError') {
    console.error(`FAIL: request timed out after ${timeoutMs}ms (the API would answer a clean 502).`);
  } else {
    console.error('FAIL: could not reach the inference endpoint (the API would answer a clean 502).');
  }
  process.exit(1);
}
const ms = Date.now() - t0;

if (!response.ok) {
  // Mirror the adapter: status only — never echo the response body, which
  // could contain prompt material, and never echo any credential.
  console.error(`FAIL: endpoint returned HTTP ${response.status} (the API would answer a clean 502).`);
  process.exit(1);
}

let body;
try {
  body = await response.json();
} catch {
  console.error('FAIL: endpoint returned non-JSON output.');
  process.exit(1);
}

const content = body?.choices?.[0]?.message?.content;
if (typeof content !== 'string' || content.trim().length === 0) {
  console.error('FAIL: endpoint returned an empty completion.');
  process.exit(1);
}

const reply = content.trim();
console.log(`OK: real completion from ${model} in ${ms}ms`);
console.log(`    reply (${reply.length} chars): ${reply.slice(0, 200)}${reply.length > 200 ? '…' : ''}`);
console.log('    settings were environment-driven: ' +
  `timeout ${timeoutMs}ms, max_tokens ${maxTokens}, temperature ${temperature}.`);
process.exit(0);
