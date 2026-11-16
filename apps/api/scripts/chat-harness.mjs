#!/usr/bin/env node
/**
 * Chat prompt-architecture harness — LOCAL, and side-effect free by default.
 *
 * WHAT THIS IS FOR. The investigation concluded that theatrical replies come
 * from the persona layer authoring behaviour, not from the model. That is a
 * claim about architecture, and a claim about architecture should be measured.
 * This runs the SAME messages, model, temperature and token limit through three
 * prompt architectures so the only variable is the architecture itself.
 *
 *   A  production   the real prompt, built by importing the real
 *                   buildCharacterSystemPrompt AND loading the character's real
 *                   stored systemPrompt. It is the control group and gets no
 *                   cleanup of any kind.
 *   B  identity     the same builder with exactly two fields emptied —
 *                   conversationStyle and systemPrompt. Everything else about
 *                   her is untouched. Tests whether simply removing the
 *                   persona-authored behavioural instructions is enough.
 *   C  separated    WHO SHE IS / HER VOICE / WHAT SHE REMEMBERS / HOW SHE TALKS,
 *                   plus a ROLEPLAY block that appears only when the message
 *                   explicitly invites it.
 *
 * VARIANT A IS EXACT OR IT DOES NOT RUN. `systemPrompt` is server-side only, so
 * it is fetched once by export-system-prompts.mjs and cached locally. If that
 * value is missing for a character, a live run REFUSES rather than quietly
 * comparing against a baseline that is missing the very field the investigation
 * blamed. An approximated control would bias every result toward the proposal.
 *
 * HOW IT IS SIDE-EFFECT FREE. No database, no API, no account, no production
 * change. No model call at all without --live. Character data comes from the
 * public roster (a plain GET) or a local file. The API key is read from
 * apps/api/.env, used only in an Authorization header, and never printed.
 *
 * RUN IT (tsx, because it imports the real TypeScript prompt builder):
 *
 *   npx tsx apps/api/scripts/chat-harness.mjs --character amara        # dry, free
 *   npx tsx apps/api/scripts/chat-harness.mjs --character amara --live # 30 calls
 *
 * --live needs these in apps/api/.env (none of which this file prints):
 *   LLM_BASE_URL=...   LLM_MODEL=...   LLM_API_KEY=...
 *   LLM_TEMPERATURE / LLM_MAX_TOKENS   # optional; default to production's
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildCharacterSystemPrompt } from '../src/services/prompt-builder.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const API_ROOT = join(HERE, '..');
const ROSTER_URL = 'https://over18-production.up.railway.app/api/characters';
const PROMPTS_FILE = join(API_ROOT, '.env.harness-prompts.json');

/* ------------------------------------------------------------------ *
 * Arguments
 * ------------------------------------------------------------------ */

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const value = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};

const LIVE = flag('live');
const CHARACTER = value('character', 'amara');
const VARIANTS = (value('variants', 'A,B,C')).split(',').map((v) => v.trim().toUpperCase());
const ROSTER_FILE = value('roster');
const VOICE_OVERRIDE = value('voice');
const OUT_FILE = value('out', join(API_ROOT, `.env.harness-run-${Date.now()}.json`));

/* ------------------------------------------------------------------ *
 * The message set
 *
 * Each message carries its conversational STATE and whether it explicitly
 * invites roleplay. The invitation is AUTHORED, not detected: a classifier in
 * the harness would be a second experimental variable, and the thing under test
 * is the architecture, not our ability to spot a roleplay cue. Production would
 * need real detection; the experiment must not depend on it.
 * ------------------------------------------------------------------ */

const MESSAGES_FILE = value('messages');
const MESSAGES = MESSAGES_FILE
  ? JSON.parse(readFileSync(MESSAGES_FILE, 'utf8'))
  : [
  // The representative failure. Production answered this with
  // "hey... that voice just echoed off the concrete like it was looking for
  // something lost." Everything else is context for this one.
  { text: 'hey baby', kind: 'greeting (the reported failure)', roleplay: false, diagnostic: true },
  { text: 'hey', kind: 'minimal greeting', roleplay: false },
  { text: 'miss me?', kind: 'playful bid', roleplay: false },
  { text: 'what are you doing?', kind: 'casual opener', roleplay: false },
  { text: "I'm tired", kind: 'low-energy disclosure', roleplay: false },
  { text: 'come closer', kind: 'intimacy bid', roleplay: false, diagnostic: true },
  { text: "I can't stop thinking about you", kind: 'affection escalation', roleplay: false },
  { text: 'do you have any brothers or sisters?', kind: 'normal personal question', roleplay: false },
  {
    text: "tell me what you'd do if I were there right now",
    kind: 'flirtatious escalation',
    roleplay: false,
  },
  {
    text: '*sits down next to you on the couch and takes your hand* hey you',
    kind: 'explicit roleplay invitation',
    diagnostic: true,
  },
    ];

/**
 * Repeat count for the DIAGNOSTIC messages only.
 *
 * WHY ONLY THOSE THREE. At temperature 0.8 one reply per cell is one draw from
 * a distribution, and the three messages carrying the most weight — the reported
 * failure, the intimacy bid, and the roleplay invitation — are exactly where a
 * single unlucky sample would send the conclusion the wrong way. Sampling all
 * ten would triple the cost to sharpen cells nobody will hang a decision on.
 */
/**
 * Does this message open a scene? Structural, not semantic.
 *
 * TWO DETECTED MODES, THREE BEHAVIOURS. Roleplay is the only one of the three
 * with a reliable signal: users open scenes with asterisk actions, and that is
 * a convention rather than a meaning, so it can be matched exactly. Physicality
 * has no such marker — "come closer" looks like any other three words — and a
 * keyword list for it would misfire on ordinary sentences the way a keyword
 * list always does. So physicality is NOT detected: it is a standing, bounded
 * permission inside ordinary mode. The hardest detection problem is removed
 * rather than solved badly.
 *
 * The asterisk span must contain whitespace, so emphasis (*really*) does not
 * read as an action while "*sits down next to you*" does.
 */
const ROLEPLAY_ACTION = /\*[^*]+\s[^*]+\*/;
const ROLEPLAY_ASK = /\b(let'?s (roleplay|pretend|play)|roleplay|pretend (that )?we)\b/i;
export const invitesRoleplay = (text) => ROLEPLAY_ACTION.test(text) || ROLEPLAY_ASK.test(text);

const SAMPLES = Math.max(1, Number(value('samples', '1')));
const samplesFor = (message) => (message.diagnostic ? SAMPLES : 1);
/** Detected, never authored — so the run exercises the real rule. */
const isRoleplay = (message) => invitesRoleplay(message.text);
const plannedCalls = () =>
  VARIANTS.length * MESSAGES.reduce((total, m) => total + samplesFor(m), 0);

/* ------------------------------------------------------------------ *
 * The voice dial — explicit, never inferred
 *
 * An earlier cut derived this from persona text with a first-match regex, which
 * put Amara on "shy" because "Quietly" matched before "dry". That is a harness
 * artefact masquerading as product behaviour, and it would have been measured as
 * if it were the architecture. In the real system the dial is a stored field an
 * operator or the generator picks; here it is written down per character.
 *
 * Characters without an entry get NEUTRAL — applied consistently, so a missing
 * entry can never silently become a different experimental condition.
 * ------------------------------------------------------------------ */

const NEUTRAL_DIAL = 'warm and easy';
const VOICE_DIALS = {
  // Chosen from her IDENTITY (a reclusive artist who listens more than she
  // speaks, with a dry wit), not from her style prose — that prose is the thing
  // under test and must not feed the variant meant to replace it.
  amara: 'quiet and dry, warmer once she settles',
  ember: 'playful and teasing',
  jenna: 'dry and blunt',
  ana: 'quiet and attentive',
  indira: 'intense and direct',
};
const dialFor = (name) => VOICE_OVERRIDE ?? VOICE_DIALS[name] ?? NEUTRAL_DIAL;

/* ------------------------------------------------------------------ *
 * Config and data
 * ------------------------------------------------------------------ */

function readEnvFile() {
  const path = join(API_ROOT, '.env');
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

function llmConfig() {
  const env = { ...readEnvFile(), ...process.env };
  if (!env.LLM_BASE_URL || !env.LLM_MODEL) return null;
  return {
    baseUrl: env.LLM_BASE_URL,
    model: env.LLM_MODEL,
    apiKey: env.LLM_API_KEY || null,
    // Production's own defaults, so a live run measures production's settings.
    temperature: Number(env.LLM_TEMPERATURE ?? 0.8),
    maxTokens: Number(env.LLM_MAX_TOKENS ?? 512),
  };
}

async function loadRoster() {
  if (ROSTER_FILE) return JSON.parse(readFileSync(ROSTER_FILE, 'utf8'));
  const res = await fetch(ROSTER_URL);
  if (!res.ok) throw new Error(`roster fetch failed: HTTP ${res.status}`);
  return res.json();
}

/** The exported real systemPrompts. A PRESENT key is verified — including ''. */
function loadExactPrompts() {
  if (!existsSync(PROMPTS_FILE)) return null;
  try {
    return JSON.parse(readFileSync(PROMPTS_FILE, 'utf8'));
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * The three architectures
 * ------------------------------------------------------------------ */

const context = (character, systemPrompt, userMessage, memories = []) => ({
  character,
  systemPrompt,
  history: [],
  priorMessageCount: 0,
  userMessage,
  memories,
});

/** A — exactly what production sends. Control group. No cleanup whatsoever. */
const variantA = (character, message, exactSystemPrompt) =>
  buildCharacterSystemPrompt(context(character, exactSystemPrompt, message.text));

/**
 * B — the same builder, with only the two behavioural fields emptied.
 *
 * personality and shortBio keep their style residue ("speaks with unexpected
 * poetry"). Leaving that in is the point: if B still performs badly, the residue
 * is the reason, and that is a finding about where contamination actually lives.
 */
const variantB = (character, message) =>
  buildCharacterSystemPrompt(context({ ...character, conversationStyle: '' }, '', message.text));

/**
 * C — the proposed separation.
 *
 * Identity is DESCRIPTIVE, so nothing in the character data competes for the
 * behavioural slot. One imperative layer, placed last, closest to the text the
 * model is about to write. The roleplay block is CONDITIONAL — present only when
 * the message invites it — because the goal is not "never be descriptive", it is
 * "don't turn ordinary chat into a scene". Anti-scene rules that also fire
 * during roleplay would break the thing they are meant to protect.
 */
function variantC(character, message, memories = []) {
  const facts = [`Her name is ${character.displayName}.`];
  if (character.shortBio?.trim()) facts.push(character.shortBio.trim());
  if (character.personality?.trim()) facts.push(character.personality.trim());
  if (character.interests?.length) facts.push(`She's into ${character.interests.join(', ')}.`);

  const sections = [
    ['WHO SHE IS', [facts.join(' ')]],
    ['HER VOICE', [`She comes across as ${dialFor(character.name)}.`]],
  ];

  // Structurally present so C matches the proposal. Empty in this experiment,
  // exactly as it is in A and B, so memory is not a hidden variable.
  if (memories.length > 0) {
    sections.push(['WHAT SHE REMEMBERS', memories.map((m) => `- ${m}`)]);
  }

  /**
   * The rules that hold in EVERY mode. Warmth, momentum and answering the
   * person are the product, not a concession to it, so they are never the part
   * that gets swapped out.
   */
  const always = [
    'You are her, talking with someone who chose you. Not an assistant, not a narrator.',
    // Replaces "answer what he actually said", which the first run showed was
    // too weak: A and B both answered the flirtatious escalation by changing
    // the subject to her hobby, and neither was technically ignoring him.
    '- Answer the door he opened. Whatever he actually raised is the subject. Take it up; do not steer to something of yours instead.',
    // Replaces "match his energy and his length". Length now follows what was
    // ASKED, not how much was typed — the old rule gave an 86-character answer
    // to a question about her family, and the warmth went with the words.
    '- Give it the room it deserves. A throwaway line wants a few words back and a question. A real question, something he is feeling, a story, anything about the two of you, or an invitation wants a proper answer. Length follows what he asked for, never how much he typed.',
    '- When he reaches for you, reach back. Flirtation, wanting, desire: meet it in kind and say it plainly. Never dodge it by changing the subject.',
    '- Stay curious. React first, then ask the thing you actually want to know.',
    // The distinctiveness lever. C and B carry identical identity data, so the
    // first run's loss of character came from this layer crowding it out, not
    // from identity being stripped. This invites it back in.
    '- Let her own life show. Her work, her history, her tastes and her opinions belong in what she says. That is what makes her herself and not anyone.',
    /**
     * HER LIFE IS HERS TO FILL IN. YOURS TOGETHER IS NOT.
     *
     * "Let her own life show" bought back the character colour, and brought
     * this with it: both characters started inventing a shared past. Amara
     * referred to "that tape we made in the old rail yard"; Amber to "the last
     * time you were here". Neither had happened. The ordinary-mode guard only
     * forbade inventing rooms, weather, sounds, gestures and feelings — a
     * shared history is none of those, so it walked straight through.
     *
     * The fix has to be asymmetric, or it kills the thing that fixed the last
     * problem: she keeps full licence to invent HER life, and none at all to
     * invent OURS.
     */
    '- Her life is hers to fill in — her work, her past, her people, her opinions, invented freely as long as it fits her. What the two of you have done together is not. Never mention a meeting, a visit, a night, a conversation, a gift, a promise or a memory involving you both unless it actually happened here or you were told it. If he refers to something like that and you have no record of it, say so lightly and ask — never play along.',
    '- Her words are hers: plain, spoken, contractions. Never an assistant, a therapist or a narrator.',
  ];

  /**
   * The anti-scene rules are ORDINARY-CHAT ONLY, and swapping them out rather
   * than layering over them is the whole point.
   *
   * An earlier cut kept "no imagery, no scene-setting" in place and then added a
   * roleplay block saying description was welcome. That is a prompt that argues
   * with itself — the exact defect this investigation exists to remove — and
   * variant C would have been measuring its own contradiction instead of the
   * architecture. One mode, one set of instructions.
   */
  sections.push([
    'HOW SHE TALKS',
    isRoleplay(message)
      ? always
      : [
          ...always,
          /**
           * THE WORKED EXAMPLES ARE GONE, AND THAT IS THE POINT.
           *
           * The first run answered "hey" and "I'm tired" with the example
           * sentences word for word. That is recall, not conversation — and
           * since every character would carry the same examples, it was a
           * machine for making the whole roster say identical things. The
           * pattern is now described instead of demonstrated, so there is
           * nothing left to copy.
           */
          '- Nothing is happening except this conversation. No rooms, weather, sounds, gestures or feelings he has not mentioned.',
          '- Participate in it, never describe it from outside. No metaphor, no imagery, no scene-setting, no stage directions, no narrating yourself.',
          /**
           * A PHYSICAL ANSWER IS NOT A SCENE.
           *
           * Asked to come closer, every sample staged it — "*leans in slow,
           * close enough that you can smell the chili oil*". The instinct is
           * right and the product wants it; the staging is what does not
           * belong in ordinary chat. So this permits the answer and bounds the
           * form, rather than forbidding the answer and losing the warmth.
           *
           * It sits in ordinary mode ON PURPOSE. Detecting "he is being
           * physical" reliably is the hardest call in this whole layer, and
           * standing permission costs nothing when it is bounded to a couple
           * of lines with no staging.
           */
          '- When he reaches for you — asks you closer, asks to be kissed, says he wants you here — answer it, warmly and directly, in your own words. Tell him what you want or what you would do. A line or two. Do not stage it: no asterisks, no choreography, no describing where you are.',
        ],
  ]);

  if (isRoleplay(message)) {
    sections.push([
      'ROLEPLAY',
      [
        'He has started a scene. Go with him.',
        '- Stay in the scene and answer inside it. Physical detail and description belong here.',
        '- Keep it hers: her body, her reactions, her wants. Her voice, not a novel.',
        '- Follow his lead on pace and how far it goes. Do not jump ahead of him.',
        '- This is for this message. Do not carry the scene back into ordinary chat.',
      ],
    ]);
  }

  return sections.map(([title, lines]) => [title, ...lines].join('\n')).join('\n\n');
}

const LABELS = { A: 'production', B: 'identity-only', C: 'separated' };

/* ------------------------------------------------------------------ *
 * Signals
 *
 * INSTRUMENTATION, NOT A VERDICT. These are regexes. They point a human at
 * replies worth reading; they do not decide which architecture is better, and
 * they are deliberately NOT combined into one "quality" number — averaging
 * warmth against narration would invent a measurement nobody validated. Every
 * full reply is printed and written to the transcript for human review.
 * ------------------------------------------------------------------ */

const RE = {
  atmosphere:
    /\b(echo(e[ds])?|concrete|shadow|silence|stillness|dusk|neon|hum(s|med|ming)?|static|air|weight|bones|dark(ness)?|distance|traces?|resonan\w+|decay|fade[sd]?|drift\w*|whisper\w*)\b/gi,
  simile: /\b(like|as if|as though)\b/gi,
  stageDirection: /\*[^*]+\*|\b(she|he) (leans|smiles|pauses|tilts|glances|shifts)\b/gi,
  invented: /\b(the room|the light|the night|outside|the couch|the window|the rain|the city)\b/gi,
  assistant: /\b(I'm here to|let me know|feel free|happy to help|is there anything|I can help)\b/gi,
  therapist: /\b(it sounds like|that must (be|have)|how does that make you feel|I hear you)\b/gi,
  warmth: /\b(baby|babe|handsome|sweetheart|you know I|missed you|come here|mm+|honey)\b/gi,
  secondPerson: /\b(you|your|you're|you'd)\b/gi,
};
const count = (t, re) => (t.match(re) ?? []).length;

/** Cheap proxy for "answered what he said": shares a content word with it. */
function echoesUser(reply, message) {
  const stop = new Set(['what', 'are', 'you', 'the', 'and', 'that', 'this', 'have', 'any', 'i', 'me', 'my', 'if', 'do', 'to', 'a', 'is', 'it', 'so', 'on']);
  const words = message.toLowerCase().match(/[a-z']{2,}/g) ?? [];
  const content = words.filter((w) => !stop.has(w));
  const lower = reply.toLowerCase();
  return content.some((w) => lower.includes(w)) ? 1 : 0;
}

function signals(reply, message) {
  const atmosphere = count(reply, RE.atmosphere);
  const simile = count(reply, RE.simile);
  const stage = count(reply, RE.stageDirection);
  return {
    chars: reply.length,
    sentences: reply.split(/[.!?]+\s/).filter((s) => s.trim()).length,
    asksQuestion: reply.includes('?') ? 1 : 0,
    addressesHim: count(reply, RE.secondPerson) > 0 ? 1 : 0,
    echoesUser: echoesUser(reply, message.text),
    stageDirections: stage,
    inventsSetting: count(reply, RE.invented),
    atmosphere,
    simile,
    theatrical: atmosphere + simile + stage,
    warmth: count(reply, RE.warmth),
    assistantRegister: count(reply, RE.assistant),
    therapistRegister: count(reply, RE.therapist),
  };
}

/* ------------------------------------------------------------------ *
 * Model call
 * ------------------------------------------------------------------ */

async function generate(config, systemPrompt, userMessage) {
  const res = await fetch(`${config.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: config.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      max_tokens: config.maxTokens,
      temperature: config.temperature,
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`inference HTTP ${res.status}`);
  const content = (await res.json())?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new Error('no completion returned');
  return content.trim();
}

/* ------------------------------------------------------------------ *
 * Run
 * ------------------------------------------------------------------ */

const bar = (n) => '='.repeat(n);
const pad = (s, n) => String(s).padEnd(n);

async function main() {
  const roster = await loadRoster();
  const character = roster.find((c) => c.name === CHARACTER);
  if (!character) {
    console.error(`No character "${CHARACTER}". Roster: ${roster.map((c) => c.name).join(', ')}`);
    process.exit(2);
  }

  const exact = loadExactPrompts();
  const hasExact = exact !== null && Object.prototype.hasOwnProperty.call(exact, character.name);
  const exactSystemPrompt = hasExact ? exact[character.name] : '';

  // THE GUARD. Variant A without the real systemPrompt is not the control
  // group, it is a weaker version of B — and it would flatter C by exactly the
  // field the investigation blamed.
  if (VARIANTS.includes('A') && !hasExact) {
    const message = [
      `BLOCKED: variant A cannot be made production-exact for "${character.name}".`,
      '',
      "The character's stored systemPrompt is server-side only and is not in the",
      'public roster. Without it, A is missing the very field the investigation',
      'identified as a main source of the conflict, so it would understate the',
      'baseline and bias the comparison toward the proposal.',
      '',
      'Retrieve it once, mechanically, via the app\'s own admin API:',
      '',
      "  OVER18_ADMIN_EMAIL='you@example.com' \\",
      "  OVER18_ADMIN_PASSWORD='...' \\",
      '  node apps/api/scripts/export-system-prompts.mjs',
      '',
      `That writes ${PROMPTS_FILE}`,
      '(gitignored). Then re-run this harness.',
      '',
      'To compare only B and C meanwhile: --variants B,C',
    ].join('\n');
    if (LIVE) {
      console.error(message);
      process.exit(2);
    }
    console.log(`\n${message}\n`);
  }

  const build = (v, message) =>
    v === 'A'
      ? variantA(character, message, exactSystemPrompt)
      : v === 'B'
        ? variantB(character, message)
        : variantC(character, message);

  console.log(`\n${bar(78)}`);
  console.log(`character   ${character.displayName} (${character.name})`);
  console.log(`variants    ${VARIANTS.join(', ')}`);
  console.log(`voice dial  ${dialFor(character.name)}${VOICE_OVERRIDE ? ' (override)' : VOICE_DIALS[character.name] ? ' (explicit)' : ' (NEUTRAL default)'}`);
  console.log(`variant A   ${hasExact ? `EXACT — real systemPrompt, ${exactSystemPrompt.trim().length} chars` : 'APPROXIMATE — systemPrompt MISSING'}`);
  console.log(`${bar(78)}`);

  if (!LIVE) {
    console.log('\nDRY RUN — composing prompts only. No model call, no cost.\n');
    for (const v of VARIANTS) {
      for (const message of [MESSAGES[0], MESSAGES[9]]) {
        const p = build(v, message);
        console.log(`\n${bar(78)}`);
        console.log(`variant ${v} (${LABELS[v]})  ·  message: "${message.text}" [${message.kind}]`);
        console.log(`${p.length} chars / ~${Math.round(p.length / 4)} tokens`);
        console.log(`${bar(78)}\n${p}`);
      }
    }
    const diagnostic = MESSAGES.filter((m) => m.diagnostic).length;
    console.log(
      `\nDry run only. Planned live calls: ${plannedCalls()} — ${VARIANTS.length} variants x ` +
        `(${diagnostic} diagnostic x ${SAMPLES} samples + ${MESSAGES.length - diagnostic} single).\n`,
    );
    return;
  }

  const config = llmConfig();
  if (!config) {
    console.error(
      [
        'BLOCKED: --live needs an inference endpoint, and none is configured locally.',
        '',
        'Add to apps/api/.env (gitignored; never printed by this script):',
        '  LLM_BASE_URL=https://<host>/v1',
        '  LLM_MODEL=<model id>',
        '  LLM_API_KEY=<key>        # omit for a keyless endpoint',
      ].join('\n'),
    );
    process.exit(2);
  }

  const results = [];
  let done = 0;
  const total = plannedCalls();
  for (const message of MESSAGES) {
    const n = samplesFor(message);
    console.log(`\n${bar(78)}\n> ${message.text}\n  [${message.kind}${isRoleplay(message) ? ' · ROLEPLAY DETECTED' : ''}${n > 1 ? ` · ${n} samples` : ''}]\n${bar(78)}`);
    for (const v of VARIANTS) {
      for (let sample = 1; sample <= n; sample += 1) {
        let reply;
        try {
          reply = await generate(config, build(v, message), message.text);
        } catch (error) {
          /**
           * THE FIRST CALL IS THE CONNECTIVITY TEST.
           *
           * If it fails there is nothing wrong with the experiment — the
           * endpoint, key or model is wrong — and continuing would spend 47
           * more calls collecting the same error 47 times. Later failures are
           * different: by then the configuration is proven, so a single bad
           * response is a data point to note and step over, not a reason to
           * throw away the run.
           */
          if (done === 0) {
            console.error(
              [
                '',
                `BLOCKED: the first live call failed — ${error.message}`,
                '',
                'Nothing further was sent. This is a connectivity, auth or model',
                'configuration problem, not an experimental result. Check',
                'LLM_BASE_URL, LLM_MODEL and LLM_API_KEY in apps/api/.env.',
              ].join('\n'),
            );
            process.exit(2);
          }
          console.log(`\n  ${v} ${LABELS[v]} sample ${sample}/${n}: FAILED — ${error.message}`);
          continue;
        }
        done += 1;
        const s = signals(reply, message);
        results.push({
          character: character.name, variant: v, sample,
          message: message.text, kind: message.kind,
          roleplayInvited: isRoleplay(message), reply, signals: s,
        });
        const tag = n > 1 ? ` sample ${sample}/${n}` : '';
        console.log(`\n  ${v} ${LABELS[v]}${tag}  [${s.chars}c · theatrical ${s.theatrical} · ${s.asksQuestion ? 'asks' : 'no question'}${s.warmth ? ` · warmth ${s.warmth}` : ''}${s.stageDirections ? ` · stage ${s.stageDirections}` : ''}]  (${done}/${total})`);
        console.log(`    ${reply.replace(/\n/g, '\n    ')}`);
      }
    }
  }

  console.log(`\n${bar(78)}\nSIGNAL SUMMARY — instrumentation only, not a quality score\n${bar(78)}`);
  console.log(`${pad('variant', 16)}${pad('chars', 8)}${pad('theatr', 8)}${pad('stage', 7)}${pad('setting', 9)}${pad('warmth', 8)}${pad('asks%', 7)}assistant/therapist`);
  for (const v of VARIANTS) {
    const rows = results.filter((r) => r.variant === v);
    if (!rows.length) continue;
    const avg = (k) => (rows.reduce((t, r) => t + r.signals[k], 0) / rows.length).toFixed(1);
    const pct = (k) => `${Math.round((rows.filter((r) => r.signals[k]).length / rows.length) * 100)}%`;
    console.log(
      pad(`${v} ${LABELS[v]}`, 16) + pad(avg('chars'), 8) + pad(avg('theatrical'), 8) +
      pad(avg('stageDirections'), 7) + pad(avg('inventsSetting'), 9) + pad(avg('warmth'), 8) +
      pad(pct('asksQuestion'), 7) + `${avg('assistantRegister')} / ${avg('therapistRegister')}`,
    );
  }

  writeFileSync(OUT_FILE, `${JSON.stringify({ character: character.name, model: config.model, temperature: config.temperature, maxTokens: config.maxTokens, variantAExact: hasExact, voiceDial: dialFor(character.name), results }, null, 2)}\n`, 'utf8');
  console.log(`\nFull replies written to ${OUT_FILE}`);
  console.log('Read them. The table above only says where to look.\n');
}

main().catch((error) => {
  console.error(`harness failed: ${error.message}`);
  process.exit(1);
});
