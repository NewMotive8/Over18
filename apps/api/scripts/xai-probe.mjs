#!/usr/bin/env node
/**
 * Local xAI image-API probe — reproduces one production request exactly.
 *
 * WHAT THIS IS FOR. Production reported "The image provider returned HTTP 400."
 * for M02-03 and two 120s timeouts for M02-01/02. a7c12e2 now surfaces xAI's
 * reason code, but only on a NEW request — the already-failed rows still hold
 * the old message. Rather than retry a production batch to learn why, this
 * sends the identical request from here and reads the answer.
 *
 * IT SENDS EXACTLY WHAT PRODUCTION SENDS. The body below is copied field for
 * field from xai-image-provider.ts: model, prompt, n, aspect_ratio, resolution,
 * quality, response_format. Nothing is tuned, and none of it is configurable
 * from the command line, because a probe that quietly differs from production
 * answers a question nobody asked.
 *
 * IT REPORTS WHAT PRODUCTION WOULD REPORT. The reason is extracted with the
 * REAL xaiErrorReason from the deployed client, so what you read here is what
 * the Admin UI would now say — the same allowlist, the same sweeping of the key
 * and the prompt out of the message.
 *
 * WHAT IT NEVER DOES: touch production, the database, a batch, or a Railway
 * variable. It makes one HTTP request per probe and prints a verdict.
 *
 * THE PROMPT IS READ FROM A FILE AND NEVER PRINTED. It is operator content; the
 * probe needs it, a terminal does not.
 *
 * CREDENTIALS come from apps/api/.env (XAI_API_KEY) and are used only in an
 * Authorization header. Never printed, never written.
 *
 *   npx tsx apps/api/scripts/xai-probe.mjs --prompt-file "C:/.../M02-03_imagine.txt"
 *   npx tsx apps/api/scripts/xai-probe.mjs --prompt-file <f> --ablate
 *   npx tsx apps/api/scripts/xai-probe.mjs --control            # 4-word prompt
 *
 * COST: a REFUSED request is not billed. A request that SUCCEEDS generates
 * n images and is billed at the normal rate. --control and --ablate are
 * therefore not free if the prompt is accepted; each prints its own warning.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';
import { xaiErrorReason } from '../src/prompt-generation/xai-image-provider.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const API_ROOT = join(HERE, '..');
const RAW_LOG = join(API_ROOT, '.env.xai-probe-raw.json');

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const value = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};

/**
 * Production's exact parameters, from env.ts defaults. None of these are
 * command-line configurable ON PURPOSE — see the header.
 */
const REQUEST = {
  baseUrl: 'https://api.x.ai/v1',
  model: 'grok-imagine-image-2.0',
  n: 2,
  aspect_ratio: '2:3',
  resolution: '2k',
  quality: 'medium',
  response_format: 'b64_json',
  /**
   * 300s HERE ONLY — the one deliberate difference from production.
   *
   * Production waits 120s (XAI_TIMEOUT_MS unset, so env.ts's default), and that
   * is UNCHANGED and not touched by this file. But moderation verdicts on these
   * prompts arrive around 100-120s, so at 120s the same request returns a clean
   * `imagine:content-moderated` on a fast run and an opaque timeout on a slow
   * one — the identical baseline did both, twenty minutes apart. Three of four
   * cells in the first experiment were lost to that coin-flip.
   *
   * A timeout is not a verdict: it cannot separate "refused" from "still
   * rendering", so at 120s a null result is unreadable. Waiting longer changes
   * nothing about what xAI decides, only whether we get to hear it. Every other
   * parameter above stays byte-identical to production.
   */
  timeoutMs: 300_000,
};

function apiKey() {
  const path = join(API_ROOT, '.env');
  if (!existsSync(path)) return null;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = /^\s*XAI_API_KEY\s*=\s*(.*)$/.exec(line);
    if (m) return m[1].trim().replace(/^["']|["']$/g, '') || null;
  }
  return process.env.XAI_API_KEY || null;
}

/** One request. Returns a verdict; never throws for an HTTP failure. */
async function probe(label, prompt, key) {
  const started = Date.now();
  let response;
  try {
    response = await fetch(`${REQUEST.baseUrl}/images/generations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: REQUEST.model,
        prompt,
        n: REQUEST.n,
        aspect_ratio: REQUEST.aspect_ratio,
        resolution: REQUEST.resolution,
        quality: REQUEST.quality,
        response_format: REQUEST.response_format,
      }),
      signal: AbortSignal.timeout(REQUEST.timeoutMs),
    });
  } catch (error) {
    const ms = Date.now() - started;
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    return {
      label,
      promptChars: prompt.length,
      status: null,
      outcome: timedOut ? `TIMEOUT after ${REQUEST.timeoutMs}ms` : `NETWORK: ${error.message}`,
      ms,
      images: 0,
    };
  }

  const ms = Date.now() - started;
  const bodyText = await response.text().catch(() => '');

  if (!response.ok) {
    // The REAL deployed reader, so this matches what the Admin UI now shows.
    const detail = xaiErrorReason(bodyText, [key, prompt]);
    return {
      label,
      promptChars: prompt.length,
      status: response.status,
      code: detail.code,
      description: detail.description,
      outcome: 'REFUSED',
      ms,
      images: 0,
      raw: bodyText.slice(0, 4000),
    };
  }

  let images = 0;
  try {
    const parsed = JSON.parse(bodyText);
    images = Array.isArray(parsed?.data)
      ? parsed.data.filter((d) => typeof d?.b64_json === 'string' && d.b64_json.length > 0).length
      : 0;
  } catch {
    /* counted as zero */
  }
  return { label, promptChars: prompt.length, status: 200, outcome: 'ACCEPTED', ms, images };
}

function report(v) {
  console.log(`\n  ${v.label}`);
  console.log(`    prompt        ${v.promptChars} chars`);
  console.log(`    http status   ${v.status ?? '(no response)'}`);
  console.log(`    outcome       ${v.outcome}`);
  if (v.code) console.log(`    reason code   ${v.code}`);
  if (v.description) console.log(`    reason        ${v.description}`);
  console.log(`    elapsed       ${(v.ms / 1000).toFixed(1)}s`);
  console.log(`    images        ${v.images}${v.images > 0 ? '  (BILLED)' : ''}`);
}

/**
 * Step 4: one prompt element at a time.
 *
 * Every probe below sends the SAME model, n, resolution, quality and aspect
 * ratio. The prompt is the only thing that moves, so whatever separates a
 * refusal from an acceptance is a property of the prompt.
 *
 * Ordered cheapest-signal-first: the control establishes that the request shape
 * and the account are fine, then halves localise which part of the text carries
 * the problem.
 */
function ablations(prompt) {
  const half = Math.floor(prompt.length / 2);
  const sentences = prompt.split(/(?<=[.!?])\s+/).filter(Boolean);
  return [
    ['control: unrelated benign prompt', 'a red apple on a wooden table'],
    ['first half only', prompt.slice(0, half)],
    ['second half only', prompt.slice(half)],
    ['first sentence only', sentences[0] ?? prompt.slice(0, 200)],
    ['first 3 sentences', sentences.slice(0, 3).join(' ') || prompt.slice(0, 400)],
    ['last sentence only', sentences[sentences.length - 1] ?? prompt.slice(-200)],
  ];
}

async function main() {
  const key = apiKey();
  if (!key) {
    console.error(
      [
        'BLOCKED: no XAI_API_KEY available locally.',
        '',
        'Add it to apps/api/.env (already gitignored). In PowerShell, copy the value',
        'from Railway -> Over18 -> Variables, then run:',
        '',
        '  cd C:\\Users\\tantu\\Documents\\OVER18\\apps\\api',
        '  Add-Content -Path .env -Value ""',
        '  Add-Content -Path .env -Value ("XAI_API_KEY=" + (Get-Clipboard).Trim())',
        '',
        'The value is never displayed, and this script never prints it.',
      ].join('\n'),
    );
    process.exit(2);
  }

  if (flag('control')) {
    console.log('\nCONTROL PROBE — a benign prompt, to prove the request shape and account work.');
    console.log('If this is ACCEPTED it generates 2 images and IS billed (~$0.16).');
    report(await probe('control: unrelated benign prompt', 'a red apple on a wooden table', key));
    return;
  }

  const promptFile = value('prompt-file');
  if (!promptFile || !existsSync(promptFile)) {
    console.error('BLOCKED: pass --prompt-file <path to the exact production prompt .txt>');
    process.exit(2);
  }
  // Read, use, never print.
  const prompt = readFileSync(promptFile, 'utf8').replace(/^\uFEFF/, '');

  console.log(`\n${'='.repeat(70)}`);
  console.log('EXACT PRODUCTION REQUEST — nothing changed');
  console.log(`${'='.repeat(70)}`);
  console.log(`  model ${REQUEST.model} · n ${REQUEST.n} · ${REQUEST.resolution} · ${REQUEST.quality} · ${REQUEST.aspect_ratio} · ${REQUEST.response_format}`);
  // Label from the file actually sent, not a hard-coded string: an earlier run
  // printed "M02-03 exact reproduction" while sending M01-15, which is exactly
  // the kind of mislabelled evidence that gets believed later.
  const baseline = await probe(basename(promptFile), prompt, key);
  report(baseline);

  const log = [baseline];

  /**
   * ONE EDIT AT A TIME, applied to the ORIGINAL prompt.
   *
   * Every variant differs from the baseline by exactly one contiguous
   * substitution and by nothing else — same model, n, resolution, quality,
   * aspect ratio and timeout. An edit whose `find` is not present is REPORTED
   * AND SKIPPED rather than silently no-oping, because a no-op would look like
   * a passing variant and would be read as evidence that the edit helped.
   *
   * Run strictly in sequence: two moderation calls in flight at once would make
   * elapsed times uninterpretable.
   */
  const editsFile = value('edits');
  if (editsFile) {
    const edits = JSON.parse(readFileSync(editsFile, 'utf8'));
    console.log(`\n${'='.repeat(70)}`);
    console.log('SINGLE-EDIT COMPARISON — one change each, everything else identical');
    console.log(`${'='.repeat(70)}`);
    for (const edit of edits) {
      if (!prompt.includes(edit.find)) {
        console.log(`\n  ${edit.label}\n    SKIPPED — target text not present in the prompt.`);
        log.push({ label: edit.label, skipped: 'target text not found' });
        continue;
      }
      const variant = prompt.replace(edit.find, edit.replace);
      const v = await probe(edit.label, variant, key);
      v.note = edit.note;
      report(v);
      log.push(v);
    }
  }

  if (flag('ablate')) {
    if (baseline.outcome !== 'REFUSED') {
      console.log('\nBaseline did not reproduce a refusal — ablations would explain nothing. Stopping.');
    } else {
      console.log(`\n${'='.repeat(70)}`);
      console.log('ABLATIONS — one prompt element at a time, everything else identical');
      console.log('Any probe that is ACCEPTED generates 2 images and IS billed.');
      console.log(`${'='.repeat(70)}`);
      for (const [label, variant] of ablations(prompt)) {
        const v = await probe(label, variant, key);
        report(v);
        log.push(v);
      }
    }
  }

  // Raw bodies to a gitignored file, not to the terminal: an error body can
  // echo the prompt back, and that belongs in a file rather than a transcript.
  writeFileSync(RAW_LOG, `${JSON.stringify(log, null, 2)}\n`, 'utf8');
  console.log(`\nRaw response bodies written to ${RAW_LOG} (gitignored).\n`);
}

main().catch((error) => {
  console.error(`probe failed: ${error.message}`);
  process.exit(1);
});
