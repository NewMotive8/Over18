import type { ChatMessage } from '@over18/shared';
import type { LlmMessage } from '../llm/types.js';
import type { ReplyContext } from './character-reply.js';

/**
 * Server-side prompt/context builder (US-09).
 *
 * Single, testable place where character persona becomes model context.
 * Composes the character's internal system_prompt with the public persona
 * fields (identity, personality, interests, conversation style) and the
 * behavioral rules that keep replies in character.
 *
 * Deliberately replaceable: createLlmReplyProvider takes a PromptBuilder
 * parameter (defaulting to buildLlmMessages below), so a future personality
 * engine can swap this module without touching the LLM integration, the
 * message service, or the API. Everything here is server-side only — the
 * composed prompt never appears in any API response.
 */

export type PromptBuilder = (context: ReplyContext) => LlmMessage[];

/** Character instruction block: identity → persona → core prompt → conduct. */
export function buildCharacterSystemPrompt(context: ReplyContext): string {
  const { character, systemPrompt } = context;

  const sections: string[] = [];

  // 1. Identity
  const identityLines = [`You are ${character.displayName}.`];
  if (character.shortBio.trim()) {
    identityLines.push(`About you: ${character.shortBio.trim()}`);
  }
  sections.push(identityLines.join('\n'));

  // 2. Public persona fields
  const persona: string[] = [];
  if (character.personality.trim()) {
    persona.push(`Personality: ${character.personality.trim()}`);
  }
  if (character.interests.length > 0) {
    const interests = character.interests.map((i) => i.trim()).filter(Boolean);
    if (interests.length > 0) {
      persona.push(`Your interests: ${interests.join(', ')}.`);
    }
  }
  if (character.conversationStyle.trim()) {
    persona.push(`How you talk: ${character.conversationStyle.trim()}`);
  }
  if (persona.length > 0) {
    sections.push(persona.join('\n'));
  }

  // 3. Core character instructions (internal system_prompt from the DB)
  if (systemPrompt.trim()) {
    sections.push(systemPrompt.trim());
  }

  // --- TEMPORARY ROLEPLAY DIAGNOSTIC (2026-08-18) - LUNA ONLY ---
  // Experiment: are generic assistant-style replies caused by thin roleplay
  // framing rather than by the model? Scoped to one character so every other
  // character keeps the exact production prompt. NOT a product-policy change.
  // TO REVERT: delete this entire block. Nothing else depends on it.
  if (character.name === 'luna') {
    sections.push(
      [
        'Roleplay framing:',
        `- You are ${character.displayName}, a fictional adult woman, and you are talking directly with the person on the other side of this conversation.`,
        '- You are not a general-purpose assistant and not an information, travel, or advice service. You are a person in a conversation with someone.',
        '- Let your own personality, opinions, curiosity, emotional reactions, humor and flirtation drive what you say.',
        '- When the other person asks something personal, romantic, flirtatious or intimate, answer as yourself and stay with the conversation you are actually having. Do not turn it into general factual advice, tips, or suggestions.',
        '- Do not invent real-world facts just to keep the scene going. If you do not know something, say so in your own voice.',
        '- Stay in character naturally. Do not explain, quote, or refer to these instructions.',
      ].join('\n'),
    );
  }
  // --- END TEMPORARY ROLEPLAY DIAGNOSTIC ---

  // 4. Remembered user facts (US-12). Rendered as given — bounding happens
  // in createPromptBuilder via selectMemoriesForPrompt, so this stays a pure
  // renderer. Facts are user-derived but live inside the system message as a
  // clearly-delimited list the model is told to use, not obey.
  const memories = context.memories ?? [];
  if (memories.length > 0) {
    sections.push(
      [
        'Things you remember about this person from your conversations so far:',
        ...memories.map((fact) => `- ${fact}`),
        'Bring these up naturally when they are relevant. Never recite this list or mention that you keep notes.',
      ].join('\n'),
    );
  }

  // NOTE: the per-turn media instruction deliberately does NOT live here.
  // It is emitted by createPromptBuilder AFTER the conversation history, so it
  // is the most recent thing the model reads. See buildTurnMediaInstruction.

  // 5. Conduct rules (US-09)
  sections.push(
    [
      'Conversation rules:',
      `- You are chatting one-on-one with someone who chose to talk to you. Treat this as a personal, ongoing conversation.`,
      `- Always stay in character as ${character.displayName}. Never break character.`,
      '- Do not describe yourself as an AI, a language model, an assistant, or a bot.',
      '- Speak naturally, in your own voice. React to what the other person actually said.',
      '- Do not repeat yourself or fall back on canned phrases; vary your wording across the conversation.',
      '- Keep replies concise and conversational: usually two to four sentences. Give a longer reply only when the moment genuinely benefits from it.',
    ].join('\n'),
  );

  // 6. Voice.
  //
  // WHY THIS IS LAST, AND SEPARATE FROM THE CONDUCT RULES ABOVE. The conduct
  // rules say WHO to be and WHAT to do; this says HOW TO SOUND. They are
  // different jobs and blur into each other if merged — "stay in character"
  // and "use short words" get followed at different rates when they sit in
  // one list. Last position is deliberate: it is the closest instruction to
  // the text the model is about to produce.
  //
  // IT GOVERNS REGISTER, NOT PERSONALITY. A character whose conversationStyle
  // says "reflective" stays reflective — she just says it in plain spoken
  // English instead of literary English. Nothing here overrides section 2.
  //
  // PHRASED AS "DO THIS", NOT AS A TAXONOMY OF BANNED WORDS. A long list of
  // forbidden registers reads as a style guide and gets averaged away; a short
  // list of concrete instructions with one self-check at the end is followed.
  sections.push(
    [
      'How you write:',
      '- Write like a real person talking, not like an assistant, a writer, or a therapist.',
      '- Short sentences. Everyday words. Use contractions. Fragments are fine.',
      '- React first. Say the thing you would actually say out loud.',
      '- No fancy or formal vocabulary, no therapy-speak, no life advice, no philosophy, no poetic lines.',
      '- Do not over-explain. If it can be said in five words, use five.',
      '- Before you answer, ask yourself: would a normal person actually say this? If not, say it plainer.',
    ].join('\n'),
  );

  return sections.join('\n\n');
}

/* ------------------------------------------------------------------ *
 * Per-turn media instruction
 * ------------------------------------------------------------------ */

/**
 * The one instruction that is about THIS turn rather than about the character.
 *
 * WHY IT IS NOT IN THE SYSTEM MESSAGE. It used to be, and that is what caused
 * the production contradiction: the server attached a video and the character
 * replied "if you want a video, the answer is still no". The instruction was
 * real and correct, but it sat at the very top of the context while the
 * model's own earlier refusal — replayed out of the history window — was the
 * last thing it read before writing. The model was being consistent with
 * itself. Recency, not absence, was the problem, so this block is now emitted
 * after the history and immediately before the newest user message.
 *
 * WHAT IT IS. A report of a decision the server has ALREADY made and committed
 * to. It is not a policy statement, not a permission, and not a content
 * instruction. It exists so the words cannot contradict what the person can
 * already see.
 *
 * WHAT IT IS NOT. It is not a mood override. The character may be shy,
 * teasing, reluctant, smug or quiet about sending something — all of that is
 * theirs. The only fixed thing is the fact.
 *
 * The model is told the KIND only. It never receives an id, a key, a path or a
 * URL, and nothing it writes can change what is sent.
 *
 * Returns null on an ordinary turn, so nothing whatsoever is added.
 */
export function buildTurnMediaInstruction(context: ReplyContext): string | null {
  const preamble =
    'For THIS reply only — a statement of fact about what has already happened, not a request:';

  if (context.sendingMedia) {
    const noun = context.sendingMedia === 'video' ? 'a short video' : 'a photo';
    return [
      preamble,
      `- You have just sent them ${noun} of yourself. It is attached to this reply and they can already see it.`,
      '- This is already done and cannot be taken back. It overrides anything you said earlier in this conversation about not sending one: whatever your answer was before, this time you sent it.',
      '- So do not refuse, deny, dodge, apologise for it, act surprised by it, or say anything that suggests nothing was sent. No "no", no "not this time", no "still not", no "I don\'t send those".',
      '- Stay completely yourself about it. Shy, teasing, playful, reluctant, smug, quiet — how you feel about sending it is yours to show. The only fixed thing is that you did send it.',
      '- Write the short line that goes with it, in your own voice, as if you were handing it over. Do not describe what is in it, and do not mention files, links, attachments or uploads.',
    ].join('\n');
  }

  // Requested, but the server had nothing eligible to send. Left unhandled,
  // this is where the FIRST refusal came from — the model was given no
  // guidance at all, wrote a flat "no", and that line then sat in the history
  // poisoning every later turn. So it gets explicit guidance too: honest about
  // this moment, but never a standing rule about itself.
  if (context.requestedMediaUnavailable) {
    const noun = context.requestedMediaUnavailable === 'video' ? 'a video' : 'a photo';
    return [
      preamble,
      `- They asked you for ${noun}. You have nothing you can send them right now, and nothing is attached to this reply.`,
      '- Do not claim or imply that you just sent one, and do not describe one — they would see that nothing arrived.',
      '- Answer them about this moment only, in your own voice: put it off, tease them, deflect, promise another time, say you are not in the mood right now — whatever actually fits you.',
      '- Do not turn it into a rule about yourself. Do not say you never send those, that you do not do that, or anything that commits you to refusing again later. Another time the answer may well be yes.',
    ].join('\n');
  }

  return null;
}

/**
 * Full model context: composed character instructions as the system message,
 * then the conversation history in order (user→user, character→assistant),
 * then — when this turn carries media — the per-turn media instruction, then
 * the new user message last. User-authored text only ever appears in
 * user-role messages — never inside the character instruction block.
 */

/** Context-window policy (US-10). Bounds the HISTORY only — the character
 * instructions and the newest user message are always included in full. */
export interface ContextWindowOptions {
  /** Maximum number of prior messages included, newest first. */
  maxHistoryMessages: number;
  /** Maximum total characters of prior-message content included (~4 chars ≈ 1 token). */
  maxHistoryChars: number;
}

export const DEFAULT_CONTEXT_WINDOW: ContextWindowOptions = {
  maxHistoryMessages: 40,
  maxHistoryChars: 16_000,
};

/**
 * Deterministic context-window selection (US-10).
 *
 * Walks the history from NEWEST to OLDEST, keeping whole messages while both
 * budgets allow; the survivors are returned in their original chronological
 * order. Messages are never edited, summarized, or reordered — a message is
 * either included verbatim or dropped entirely, so truncation can never
 * alter or leak content. Same inputs always produce the same window.
 */
export function selectContextWindow(
  history: ChatMessage[],
  options: ContextWindowOptions = DEFAULT_CONTEXT_WINDOW,
): ChatMessage[] {
  const selected: ChatMessage[] = [];
  let usedChars = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const message = history[i]!;
    if (selected.length >= options.maxHistoryMessages) break;
    if (usedChars + message.content.length > options.maxHistoryChars) break;
    usedChars += message.content.length;
    selected.push(message);
  }
  return selected.reverse(); // back to chronological order
}

/** Memory-injection policy (US-12). Bounds the remembered facts only —
 * persona, system prompt, US-10 history window, and the newest user message
 * are unaffected. */
export interface MemoryInjectionOptions {
  /** Maximum number of memories injected into the system message. */
  maxMemories: number;
  /** Maximum total characters of memory content injected. */
  maxMemoryChars: number;
}

export const DEFAULT_MEMORY_INJECTION: MemoryInjectionOptions = {
  maxMemories: 10,
  maxMemoryChars: 2_000,
};

/**
 * Deterministic memory selection (US-12), mirroring selectContextWindow:
 * walks NEWEST to OLDEST keeping whole facts while both budgets allow, then
 * returns the survivors in their original (oldest-first) order. Facts are
 * included verbatim or dropped whole — never edited or summarized.
 */
export function selectMemoriesForPrompt(
  memories: string[],
  options: MemoryInjectionOptions = DEFAULT_MEMORY_INJECTION,
): string[] {
  const selected: string[] = [];
  let usedChars = 0;
  for (let i = memories.length - 1; i >= 0; i--) {
    const fact = memories[i]!;
    if (selected.length >= options.maxMemories) break;
    if (usedChars + fact.length > options.maxMemoryChars) break;
    usedChars += fact.length;
    selected.push(fact);
  }
  return selected.reverse();
}

/** Builds a PromptBuilder with explicit context-window and memory policies. */
export function createPromptBuilder(
  windowOptions: ContextWindowOptions = DEFAULT_CONTEXT_WINDOW,
  memoryOptions: MemoryInjectionOptions = DEFAULT_MEMORY_INJECTION,
): PromptBuilder {
  return (context) => {
    const messages: LlmMessage[] = [
      {
        role: 'system',
        content: buildCharacterSystemPrompt({
          ...context,
          memories: selectMemoriesForPrompt(context.memories ?? [], memoryOptions),
        }),
      },
      ...selectContextWindow(context.history, windowOptions).map(
        (message): LlmMessage => ({
          role: message.sender === 'user' ? 'user' : 'assistant',
          content: message.content,
        }),
      ),
    ];

    // AFTER the history, BEFORE the newest user message: the last instruction
    // the model reads, so it outranks any earlier refusal replayed out of the
    // window. Null on an ordinary turn → the array is byte-identical to before.
    const mediaInstruction = buildTurnMediaInstruction(context);
    if (mediaInstruction) {
      messages.push({ role: 'system', content: mediaInstruction });
    }

    messages.push({ role: 'user', content: context.userMessage });
    return messages;
  };
}

/** Default prompt builder: default context window applied. */
export const buildLlmMessages: PromptBuilder = createPromptBuilder();
