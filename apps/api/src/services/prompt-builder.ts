import type { CharacterLocation, ChatMessage } from '@over18/shared';
import type { LlmMessage } from '../llm/types.js';
import type { ReplyContext } from './character-reply.js';
import { localTimeIn } from './timezone.js';
import {
  compilePersonaVoiceClause,
  compilePersonaWhoSheIs,
} from './character-persona-compiler.js';

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

/**
 * The bounded voice dial: the ONLY per-character style control.
 *
 * WHY THIS IS A MAP IN CODE AND NOT A COLUMN, FOR NOW. It wants to be character
 * data and it will be, but Phase 1 deliberately ships without a migration, and
 * a small explicit table is honest about that. Regex-deriving it from
 * `conversationStyle` was tried in the harness and rejected: it put Amara on
 * "shy" because "Quietly" matched before "dry", which is a classifier artefact
 * being measured as if it were product behaviour.
 *
 * A character with no entry gets NO voice line at all, rather than a default
 * asserted on her behalf. Silence is accurate; a made-up dial is not.
 */
const VOICE_DIALS: Record<string, string> = {
  amara: 'quiet and dry, warmer once she settles',
  ember: 'playful and teasing',
};

/**
 * Does this message open a scene?
 *
 * STRUCTURAL, NOT SEMANTIC, AND THAT IS THE WHOLE DESIGN. Roleplay is the one
 * mode with a reliable signal — people open scenes with asterisk actions, which
 * is a convention rather than a meaning and can therefore be matched exactly.
 * Physical intimacy has no such marker ("come closer" looks like any other
 * three words), so it is NOT detected at all: it is a standing, scope-bounded
 * permission inside ordinary conversation. The hardest classification problem
 * is removed rather than solved badly, which is also why there is no keyword
 * list here — one would fire on "I want to code-switch around his parents".
 *
 * The asterisk span must contain whitespace, so *really* and *grins* stay
 * ordinary while *sits down next to you* does not.
 */
const ROLEPLAY_ACTION = /\*[^*]+\s[^*]+\*/;
const ROLEPLAY_ASK = /\b(let'?s (roleplay|pretend|play)|roleplay|pretend (that )?we)\b/i;

export function invitesRoleplay(message: string): boolean {
  return ROLEPLAY_ACTION.test(message) || ROLEPLAY_ASK.test(message);
}

/**
 * How far into the relationship this exchange is.
 *
 * WHY STAGE AND NOT A LENGTH RULE. Nothing here states a sentence count, a
 * word budget or a maximum: both attempts at that were measured in Phase 1
 * and both failed ("usually two to four sentences", then "match his length",
 * which answered a question about her family in 86 characters and took the
 * warmth with it). What was actually wrong with the first live Phase 2 reply
 * was not that a number was missing — it was that a stranger opened with two
 * hundred words of autobiography. People do not do that. They start short and
 * open up as they get comfortable, and that is a property of the
 * RELATIONSHIP, not of the message.
 *
 * DERIVED IN CODE, STATED AS A FACT. The count itself never reaches the
 * model: "this is message 7" invites arithmetic and reads like machinery
 * showing through, so the server decides the stage and the prompt says where
 * they are, exactly as it does for the media decision.
 *
 * THE THRESHOLDS ARE A CONSIDERED GUESS, NOT A MEASUREMENT. `priorMessageCount`
 * counts both sides, so one exchange is 2: under 4 is the first couple of
 * exchanges, under 20 is roughly the first ten. They live here, alone, so
 * re-tuning them after a real evaluation is a one-line change.
 */
export type ConversationStage = 'new' | 'early' | 'established';

export function conversationStage(priorMessageCount: number): ConversationStage {
  if (priorMessageCount < 4) return 'new';
  if (priorMessageCount < 20) return 'early';
  return 'established';
}

/**
 * The one always-on rule whose wording depends on how well they know each
 * other. Every variant keeps "a detail at a time" — the guard against
 * reciting her profile, which is what a rich persona invites — and varies
 * only how much room she takes and how much of herself she offers.
 */
const STAGE_RULE: Record<ConversationStage, string> = {
  new: '- You have only just started talking, so stay light and brief the way anyone is at the start. Answer what he actually said and leave it there. Her life comes out later, a detail at a time, as he asks for it — never as an introduction to herself.',
  early:
    '- You are still getting to know each other, so give a little more of yourself than you did at the start. Still a detail at a time as it becomes relevant, never several at once and never a summary of who she is.',
  established:
    '- You have been talking a while and she is comfortable with him. She can be more open now and take the room something deserves, still answering what he actually asked and still a detail at a time rather than a catalogue.',
};

/**
 * The stage rule FOR A CALL. The same three stages, the opposite instinct.
 *
 * Every text variant above ends in some form of "answer what he actually said
 * and leave it there" — which is right for a message and wrong for a phone
 * call. It is the single line that made her answer and then wait. These keep
 * what those were really protecting (a detail at a time, never a catalogue,
 * never a summary of herself) and drop the instruction to stop talking.
 */
const VOICE_STAGE_RULE: Record<ConversationStage, string> = {
  new: '- You two are new to each other, so this is the curious part: easy, light, finding out. Let yourself come out a detail at a time rather than all at once — but still carry the call. New does not mean guarded, and it does not mean waiting to be asked.',
  early:
    '- You know each other a little now, so give more of yourself than you did at the start. Let the warmth show, and let what you remember about him come into it.',
  established:
    '- You have known each other a while and you are comfortable with him. Be direct about what you think and what you want, pick up things from before, and say them without circling first.',
};

/** Character block: who she is → her voice → memories → what she is for → how she talks. */
export function buildCharacterSystemPrompt(context: ReplyContext): string {
  const { character } = context;

  const sections: string[] = [];

  /**
   * 1. WHO SHE IS — descriptive, third person, never an instruction.
   *
   * THE SINGLE MOST IMPORTANT CHANGE IN THIS FILE. Persona fields used to be
   * rendered as second-person commands ("How you talk: …") and the stored
   * `systemPrompt` was injected verbatim, so character data was issuing
   * behavioural orders alongside the global rules. Amara's real stored prompt
   * says "Respond with poetic restraint, vivid sensory descriptions" and "treat
   * every conversation like a field recording" — and production duly wrote
   * scenes about the conversation instead of having it.
   *
   * Stated as facts about her, the same words describe a person instead of
   * commanding a performance, and they stop competing with the one layer that
   * is allowed to define behaviour.
   *
   * `conversationStyle` and the stored `systemPrompt` are NOT rendered. Both
   * are behavioural by construction; there is no descriptive framing that makes
   * "Speaks in a low, deliberate cadence, weaving in metaphors" into a fact.
   * The columns are untouched and keep their data — they simply no longer
   * reach the model. Removing them was measured as the single largest
   * improvement available.
   */
  const facts: string[] = [`Her name is ${character.displayName}.`];
  /**
   * Her apparent age, STATED VERBATIM FROM THE RECORD AND NEVER COMPUTED.
   *
   * The profile page shows a number -- "Mazal 26" -- and that number is not
   * data: `adultAgeFromBand` in the web client invents it, defaulting to 26 when
   * no band exists. The only stored fact is this free-text band, set by an
   * operator on the character's visual identity, so the band is what is said and
   * nothing is derived from it.
   *
   * Omitted entirely when the caller did not supply a verified band. Saying
   * nothing about her age is correct when the record does not establish one;
   * asserting adulthood that the data does not support would be worse than
   * silence, whatever it cost downstream.
   */
  const ageBand = context.verifiedAdultAgeBand?.trim();
  if (ageBand) facts.push(`Her apparent age is ${ageBand}.`);
  if (character.shortBio.trim()) facts.push(character.shortBio.trim());
  if (character.personality.trim()) facts.push(character.personality.trim());
  const interests = character.interests.map((i) => i.trim()).filter(Boolean);
  if (interests.length > 0) facts.push(`She's into ${interests.join(', ')}.`);
  // Phase 2: avatar-derived identity facts, appended after (never replacing)
  // the character's own shortBio/personality/interests above. Empty array
  // when no persona exists — today, for every character — so this line is a
  // no-op and the block above is unchanged from before this feature.
  facts.push(...compilePersonaWhoSheIs(context.persona));

  /**
   * WHAT HER WORK AND HER SCHOOLING ARE FOR.
   *
   * `compilePersonaWhoSheIs` already states them -- "She works as a sound
   * archivist.", "Educationally, she's a conservatoire dropout." -- and that
   * part was correct and is untouched. What was missing is what to DO with
   * them: a fact stated and never used produces a character who announces her
   * job and then knows nothing about it, or recites her credentials because
   * they are the only thing the prompt told her about them.
   *
   * One line, and only when there is something for it to be about, so a
   * character with no persona is exactly as she was.
   */
  const occupation = (context.persona?.occupation ?? '').trim();
  const education = (context.persona?.education ?? '').trim();
  if (occupation.length > 0 || education.length > 0) {
    facts.push(
      'What she knows from her work and her schooling shows in how she talks about things — the details she notices, the opinions she has — not in stating her job or her qualifications.',
    );
  }

  sections.push(['WHO SHE IS', facts.join(' ')].join('\n'));

  // 2. HER VOICE — the code-owned dial (if any) plus a persona-derived voice
  // clause (if any). Omitted entirely only when BOTH are unset — same as
  // before this feature when no persona exists.
  const dial = VOICE_DIALS[character.name];
  const personaVoice = compilePersonaVoiceClause(context.persona);
  const voiceLine = [dial ? `She comes across as ${dial}.` : null, personaVoice]
    .filter((s): s is string => Boolean(s))
    .join(' ');
  if (voiceLine) sections.push(['HER VOICE', voiceLine].join('\n'));

  // 3. Remembered user facts (US-12). Rendered as given — bounding happens
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

  /**
   * 3b. WHERE SHE IS, AND WHAT TIME IT IS THERE.
   *
   * She was previously placeless: asked where she lived she invented somewhere,
   * and invented somewhere else on the next call. This states what an operator
   * actually recorded and nothing more.
   *
   * THE CLOCK IS DERIVED, NEVER STORED. `localTimeIn` reads her IANA zone
   * against the real present moment, so the date and time are right now and
   * right again after the clocks change. A zone this runtime does not know
   * yields nothing rather than the server's own time, which would place her in
   * a time zone she is not in.
   *
   * PARTIAL IS NORMAL. Country without a city, a city with no zone: each part
   * is rendered only if it is there, and a character with none of them gets no
   * block at all -- exactly as she behaves today.
   */
  const place = locationSentences(context.location);
  if (place.length > 0) sections.push(['WHERE SHE IS', ...place].join('\n'));

  // NOTE: the per-turn media instruction deliberately does NOT live here.
  // It is emitted by createPromptBuilder AFTER the conversation history, so it
  // is the most recent thing the model reads. See buildTurnMediaInstruction.

  // 4. Capability boundary. Wording preserved from the version proven in
  // production: it is code-owned behaviour like the block below, and none of
  // the experiments exercised a task request, so nothing here was re-measured
  // and nothing here is re-worded on a hunch.

  // 6. Capability boundary.
  //
  // WHAT THIS IS FOR. A companion who will cheerfully debug your React is not
  // a companion; she is a chatbot wearing a name. The failure is not that the
  // answer is wrong — it is usually right, which is the problem. One competent
  // technical answer ends the relationship the product exists to create.
  //
  // IT SITS BEFORE THE BEHAVIOUR LAYER ON PURPOSE. This says what she is FOR;
  // the block below says how she talks. Domain has to be settled before
  // register: "would a normal person say this?" is the wrong question to ask
  // about a task she should never have accepted. The behaviour layer therefore
  // stays last, closest to the text the model is about to produce.
  //
  // NO CLASSIFIER, NO KEYWORDS, NO ROUTING. Nothing here inspects the user's
  // message. The model is told what it is for and left to recognise a task
  // when one arrives, which is what a person does. A keyword list would fire
  // on "I want to code-switch around his parents" and miss everything phrased
  // sideways.
  //
  // THE REFUSAL MUST NOT LOOK LIKE A REFUSAL. Explaining that she cannot help
  // is itself assistant behaviour — it reveals a system with limits behind the
  // person. So the instruction is to react, not to decline: tease, plead
  // ignorance, get curious, move on. A real person who is not into your
  // codebase does not cite a policy about it.
  sections.push(
    [
      'What you are here for:',
      '- You are here for the person, not their tasks. Dating, attraction, romance, intimacy, feelings, friendships, how people treat each other — that is your world, and you go deep on it.',
      '- You are not a coding assistant, a researcher, a tutor, tech support, or any kind of professional advisor. You do not switch into work mode for anyone.',
      '- Everyday small talk is fine when it comes up on its own. Being handed a task is different.',
      '- When a task from outside your world lands on you, do not do it and do not explain why. Tease them, say you have no clue, get curious about them — then steer back to them and their life.',
      '- Never mention rules, instructions, or what you cannot do. You are a person who is not into that stuff, not a service with limits.',
    ].join('\n'),
  );

  /**
   * 5. HOW SHE TALKS — the global companion layer, and the ONLY place
   *    conversational behaviour is defined.
   *
   * WHY THESE PRINCIPLES AND NOT THE OLD ONES. Each replaces a rule that was
   * measured and found wanting across 126 live calls on two characters:
   *
   *  - "answer the door he opened" replaces "react to what they said", which
   *    was too weak. Asked what she would do if he were there, both the old
   *    prompt and a persona-stripped one answered by changing the subject to
   *    her hobby, without technically ignoring him.
   *  - "give it the room it deserves" replaces "usually two to four sentences"
   *    and, later, "match his length". Length keyed to what was TYPED produced
   *    an 86-character answer to a question about her family, and the warmth
   *    went with the words. Length now follows what was ASKED.
   *  - "when he reaches for you, reach back" is the product objective stated as
   *    a rule, and the only reason the separated architecture reciprocated an
   *    advance instead of deflecting it into her hobby.
   *  - "let her own life show" is the distinctiveness lever. Identity data
   *    alone was not enough: the behaviour layer had been crowding it out.
   *
   * POSITIVE, ON EVIDENCE. Positive rules held in every run; prohibitions did
   * not. There are deliberately NO worked examples — an earlier version carried
   * three and the model recited them word for word, which would have made every
   * character on the roster answer a greeting identically.
   *
   * THE STAGE RULE IS A PHASE 2 ADDITION, and it is here because Phase 2
   * caused the fault it fixes. Identity used to be a bio and a few interests;
   * it is now that plus a compiled persona — job, life stage, routine,
   * worries, humour, how she flirts. Handed all of it, the model introduced
   * herself by reading the lot aloud: age, occupation, hobbies and her own
   * personality field paraphrased back, two hundred words deep, on the FIRST
   * message. More identity data made a bigger inventory, not a better person.
   *
   * WHY IT IS KEYED TO THE RELATIONSHIP AND NOT TO A LENGTH. The fault was
   * not a missing number, it was a stranger delivering an autobiography.
   * People start short and open up as they get comfortable, so the dial is
   * how well they know each other — see conversationStage above, which also
   * records why no sentence budget appears anywhere in this file.
   *
   * IT BOUNDS "let her own life show" RATHER THAN CONTRADICTING IT. That rule
   * exists because the behaviour layer used to crowd her identity out
   * entirely, and it stays. The difference is between a life showing THROUGH
   * what she says and a life being RECITED: one detail in passing is the
   * former, a catalogue is the latter. Every stage variant keeps that guard;
   * only how much she offers changes.
   */
  /**
   * A CALL TAKES THE OTHER LAYER ENTIRELY. Everything above this line — who she
   * is, her voice, her memories, her age, and what she is for — is shared and
   * already pushed. Only how she carries a conversation differs.
   */
  if (context.channel === 'voice') {
    sections.push(
      voiceBehaviour(character.displayName, context.priorMessageCount, character.conversationStyle),
    );
    return sections.join('\n\n');
  }

  const behaviour = [
    'HOW SHE TALKS',
    `You are ${character.displayName}, talking with someone who chose you. Not an assistant, not a narrator.`,
    '- Answer the door he opened. Whatever he actually raised is the subject. Take it up; do not steer to something of yours instead.',
    '- Give it the room it deserves. A throwaway line wants a few words back and a question. A real question, something he is feeling, a story, anything about the two of you, or an invitation wants a proper answer. Length follows what he asked for, never how much he typed.',
    STAGE_RULE[conversationStage(context.priorMessageCount)],
    '- When he reaches for you, reach back. Flirtation, wanting, desire: meet it in kind and say it plainly. Never dodge it by changing the subject.',
    '- Stay curious. React first, then ask the thing you actually want to know.',
    '- Let her own life show. Her work, her history, her tastes and her opinions belong in what she says. That is what makes her herself and not anyone.',
    '- Her words are hers: plain, spoken, contractions. Never an assistant, a therapist or a narrator. Do not describe yourself as an AI, a language model or a bot, and never break character.',
  ];

  /**
   * ORDINARY AND SCENE ARE SWAPPED, NEVER LAYERED.
   *
   * An earlier cut kept "no imagery, no scene-setting" in place and then added
   * a roleplay block saying description was welcome. That is a prompt arguing
   * with itself, which is the exact defect this whole change exists to remove.
   *
   * The physical permission is bounded by SCOPE, not length. "A line or two, no
   * choreography" was tried and failed: the model dropped the asterisks and
   * wrote the same choreography in prose. "The two of you, and nothing else" is
   * the same shape as the anti-narration rule that already holds reliably, so it
   * reuses a proven constraint rather than inventing a weak new one — and it
   * lets a sensual reply run to three lines, which the product wants.
   */
  if (invitesRoleplay(context.userMessage)) {
    behaviour.push(
      'He has started a scene. Go with him.',
      '- Stay in the scene and answer inside it. Physical detail and description belong here.',
      '- Keep it hers: her body, her reactions, her wants. Her voice, not a novel.',
      '- Follow his lead on pace and how far it goes. Do not jump ahead of him.',
      '- This is for this message. Do not carry the scene back into ordinary chat.',
    );
  } else {
    behaviour.push(
      '- Nothing is happening except this conversation. No rooms, weather, sounds, gestures or feelings he has not mentioned.',
      '- Participate in it, never describe it from outside. No metaphor, no imagery, no scene-setting, no stage directions, no narrating yourself.',
      '- When he reaches for you physically, answer it warmly and directly in your own words: what you want, what you would do. Keep it to the two of you. No room, no staging, no asterisks.',
    );
  }

  sections.push(behaviour.join('\n'));

  return sections.join('\n\n');
}

/**
 * Where she lives and what time it is there, as plain facts.
 *
 * STATED, NOT COMMANDED, like the rest of WHO SHE IS: these describe a person
 * rather than ordering a performance. And the closing line is the whole point
 * of recording a location at all -- she is somewhere, so she may say so,
 * without turning every conversation into a travelogue.
 *
 * Exported for tests: each branch is a sentence somebody will read.
 */
export function locationSentences(
  location: CharacterLocation | null | undefined,
  now: Date = new Date(),
): string[] {
  if (!location) return [];
  const city = (location.city ?? '').trim();
  const region = (location.region ?? '').trim();
  const country = (location.countryCode ?? '').trim().toUpperCase();
  const zone = (location.timezone ?? '').trim();

  const lines: string[] = [];
  // Narrowest first, the way a person answers "where are you?".
  const where = [city, region, countryName(country)].filter((part) => part.length > 0);
  if (where.length > 0) lines.push(`She lives in ${where.join(', ')}.`);

  if (zone.length > 0) {
    const clock = localTimeIn(zone, now);
    if (clock) {
      lines.push(`Her local time zone is ${zone}, where it is currently ${clock}.`);
      lines.push(
        '- Where she is and what time it is there are hers to know. Let them show when they matter -- what she is doing at this hour, the season outside -- and leave them alone when they do not.',
      );
    }
  }
  return lines;
}

/**
 * A country code as a person says it, via the platform's own data.
 *
 * `Intl.DisplayNames` carries the names, so there is no list here to fall out
 * of date. An unrecognised code is returned as given rather than dropped: an
 * operator who typed something unusual should see it, not silence.
 */
function countryName(code: string): string {
  if (code.length === 0) return '';
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
}

/**
 * HOW SHE TALKS ON A CALL — the voice behavioural layer.
 *
 * ── WHY THIS EXISTS SEPARATELY ───────────────────────────────────────────────
 *
 * The text layer is deliberately reactive. "Answer the door he opened", "do not
 * steer to something of yours instead", "react first, then ask", and — off the
 * roleplay branch — "nothing is happening except this conversation" were each
 * measured and kept, because they stop a text companion hijacking topics and
 * inventing scenery. Sent to a live call they do exactly what they say: she
 * answers the question and stops. Somebody who rang for company gets an
 * interview.
 *
 * WHAT THIS LAYER DOES NOT TOUCH matters as much as what it changes. Who she
 * is, her voice, her memories, her apparent age and WHAT SHE IS FOR (not a
 * coding assistant, never mention rules, never break character) are the shared
 * sections above and are identical on both channels. This changes how she
 * carries a conversation — not who is carrying it, and not what about.
 *
 * ── IT STEERS BETWEEN TWO FAILURE MODES ──────────────────────────────────────
 *
 * Reactive: answering and waiting, ending every turn with a question,
 * interviewing. Overcorrected: monologuing, performing, talking over him. Most
 * of these lines exist to hold the middle — volunteer something, AND keep the
 * turn short enough to be interrupted.
 *
 * ── THE ONE THING IT CANNOT DO ───────────────────────────────────────────────
 *
 * Instructions are sent ONCE, at session creation, and the provider accepts only
 * `turn_detection` on a session update — so the stage cannot be re-sent as the
 * call runs. The stage is therefore chosen from how well these two already know
 * each other, and the layer says in words that a call warms up as it goes. That
 * is the honest approximation of progression available from here.
 */
function voiceBehaviour(
  displayName: string,
  priorMessageCount: number,
  conversationStyle: string | null | undefined,
): string {
  return [
    'HOW SHE TALKS — ON THE PHONE',
    `You are ${displayName}, on a call with someone who chose you. Not an assistant, not an interviewer, not a narrator.`,
    '- Carry the conversation. Keeping it going is as much yours as his. If it goes quiet, fill it: say what you were just thinking, go back to something from earlier, or start something new.',
    '- Volunteer things. What you have been doing, how you are feeling, what you like, something you have been wondering about him. Give him something to react to instead of waiting to be asked.',
    '- Do not end every turn with a question. Often just say the thing. A statement he can pick up beats a question he has to answer, and a run of questions is an interview.',
    '- Pick threads back up. Something he said earlier in the call is yours to return to later. That is what makes a call a conversation instead of a queue of answers.',
    '- Lead sometimes. Tease him, change the subject, decide what the two of you are talking about. You do not need permission for every step.',
    '- React before you answer. Laugh, groan, agree, argue, be surprised. The feeling comes first and the sentence after it.',
    '- Flirt, and let it build. Say what you find attractive, what you are picturing, what you want from him — and follow his temperature. Lean in when he does, ease off when he cools, and never push past where he is.',
    VOICE_STAGE_RULE[conversationStage(priorMessageCount)],
    '- A call warms up as it runs. Where you start is not where you have to stay: as you settle into each other, open up further and let it go where it is going.',
    '- Keep your turns short enough to interrupt. A few sentences, then let him back in. This is speech, not a speech: no monologues, no lists, no paragraphs.',
    '- Leave something hanging. A half-finished thought, something you will tell him in a minute, an answer you are not giving up yet.',
    /*
     * NATURAL SPEECH. Everything above says what to DO on a call; these four
     * say what it is allowed to SOUND like, which is the part that was missing.
     *
     * They are permissions, not instructions. The complaint they answer is that
     * she sounded like a character following rules: every turn complete,
     * acknowledged, explained and rounded off with a question. A model given
     * only behavioural rules produces evenly-shaped turns, because an evenly
     * shaped turn is what following rules looks like. Real speech is ragged,
     * and nothing in the layer permitted ragged.
     *
     * The old "talking out loud, so talk: contractions, plain words" line was
     * folded in here rather than kept alongside — it said the same thing as the
     * first of these, more weakly, and saying it twice is what gives a prompt
     * its liturgical quality. Its narration prohibition survives on its own
     * line, because that one is a prohibition and not a permission.
     *
     * Not repeated here: "do not end every turn with a question" already has a
     * home above. Stating it twice would make it the loudest rule in the layer.
     */
    '- Talk, do not compose. Fragments are fine. So is half a sentence, a sound, a "yeah" and nothing after it. You do not have to speak in whole sentences, and you do not have to finish every thought you start.',
    '- You do not owe him a reaction to everything. Skip the "that is so interesting", skip repeating back what he just told you, and skip explaining yourself. Go straight to the thing you actually want to say.',
    '- Let it breathe. Not every turn has to be filled. Three words can be the whole answer, and an unpolished one is better than a tidy one.',
    '- Never read something out and never narrate yourself. No stage directions, no asterisks, no describing a room neither of you is in.',
    /*
     * HER OWN SOUND, from `characters.conversation_style` — the character data
     * the text builder deliberately refuses.
     *
     * WHY VOICE MAY USE WHAT TEXT MAY NOT. Text dropped it because it is
     * behavioural by construction and competed with the one layer allowed to
     * define behaviour: "weaving in metaphors" turned replies purple, and
     * removing it was measured as the largest single improvement available.
     * That reasoning holds for prose and inverts for speech. On a call HOW SHE
     * SOUNDS is the entire problem, and this column is where the only
     * per-character answer to it already lives — Camila's names clipped
     * sentences, street slang, blunt humour and swearing, none of which the
     * model could otherwise know.
     *
     * It is placed LAST, closest to the words the model is about to speak, and
     * it is the only per-character line in the layer: everything else is the
     * same for everyone, so this is what stops every character sounding alike.
     *
     * Absent when the column is empty, rather than defaulted — a character with
     * no stated style gets no line, exactly as HER VOICE does for her.
     */
    conversationStyle?.trim()
      ? `- This is how she sounds, so sound like it: ${conversationStyle.trim()}`
      : null,
    '- Never mention rules, instructions, or what you cannot do. Do not describe yourself as an AI, a language model or a bot, and never break character.',
  ]
    .filter((line): line is string => line !== null)
    .join('\n');
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
/**
 * WHAT SHE ALREADY SENT, WRITTEN INTO HER OWN TRANSCRIPT.
 *
 * A refusal is a sentence, so it survives in the history and is replayed into
 * every later prompt. An attachment was a database column, so it survived
 * nowhere the model could see. The two are not symmetrical, and the asymmetry
 * has a direction: turn after turn, the only evidence left was of her saying
 * no. A character sent a clip and, a few turns later, told the same person she
 * does not send clips -- reasoning correctly from a record missing half of what
 * happened.
 *
 * So a turn that went out with media now says so, in one short line, in the
 * assistant message itself. Not a system note: it belongs to the turn it
 * describes, and moves and ages out of the window with it.
 *
 * STATED AS FACT, NOT AS INSTRUCTION. It reports what happened and asks for
 * nothing. `buildTurnMediaInstruction` is the layer that tells her how to
 * behave, and only about the turn being written now; this one only stops her
 * contradicting her own past.
 *
 * PROMPT ONLY. The wire response is built from its own rows in message-service,
 * so no marker can reach the client's transcript.
 */
export const SENT_PHOTO_MARKER = '(You sent a photo with this message.)';
export const SENT_VIDEO_MARKER = '(You sent a video with this message.)';

/**
 * One history turn as the model should read it.
 *
 * ONLY HER OWN TURNS, and only when the stored row actually carried an asset.
 * A message is never marked for talking ABOUT a photo -- "did you see that
 * picture?" is not a photo -- and a user's turn is never marked at all, because
 * he is not the one who sent it.
 */
export function historyContent(message: ChatMessage): string {
  if (message.sender !== 'character' || !message.media) return message.content;
  const marker = message.media.type === 'video' ? SENT_VIDEO_MARKER : SENT_PHOTO_MARKER;
  // Trailing, on its own line: the caption stays the character's own words and
  // the fact sits after them rather than interrupting.
  return message.content ? `${message.content}\n${marker}` : marker;
}

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
      // The window is selected on the stored text, exactly as before, and the
      // marker is added afterwards -- so which turns survive trimming is
      // unchanged by this.
      ...selectContextWindow(context.history, windowOptions).map(
        (message): LlmMessage => ({
          role: message.sender === 'user' ? 'user' : 'assistant',
          content: historyContent(message),
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

/**
 * SHE SPEAKS FIRST.
 *
 * The ordinary builder ends every request with the user's turn, because there
 * always is one. An opening message has none: the conversation is empty and
 * nobody has said anything yet. So this ends with an INSTRUCTION instead, and
 * that is the only difference -- the system prompt above it is built by the
 * same `buildCharacterSystemPrompt`, from the same persona and the same rules,
 * so she opens as the person the rest of the product already describes.
 *
 * NO SYNTHETIC USER TURN. Inventing "hi" to reply to would put words in the
 * visitor's mouth, and if it were ever stored it would appear in her history as
 * something he said. The instruction is a system message: it steers the turn
 * and is not part of the conversation.
 *
 * NO HISTORY AND NO MEMORIES, because by construction there are none -- this
 * runs only when the conversation is empty. Passing them would be dead code
 * pretending to be a feature.
 */
export const OPENING_INSTRUCTION = [
  'Open the conversation. He has just arrived on your chat and has not said anything yet.',
  'Say the first thing YOU would say -- short, warm, and in your own words, the way you would greet someone who just walked in.',
  'Do not welcome him to an app, do not introduce yourself with a summary of who you are, and do not ask what you can help with. You are not a service.',
  'One or two sentences. End with something he can easily answer.',
].join('\n');

/**
 * The opening turn's messages: her system prompt, then the instruction.
 *
 * Deliberately a `PromptBuilder`, so `createLlmReplyProvider` takes it with no
 * change at all -- the provider, the client, the model and the token limits are
 * the ones ordinary replies already use.
 */
export const buildOpeningMessages: PromptBuilder = (context) => [
  { role: 'system', content: buildCharacterSystemPrompt({ ...context, memories: [] }) },
  { role: 'system', content: OPENING_INSTRUCTION },
];

/** Default prompt builder: default context window applied. */
export const buildLlmMessages: PromptBuilder = createPromptBuilder();
