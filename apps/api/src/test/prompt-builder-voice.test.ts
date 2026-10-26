import { describe, expect, it } from 'vitest';
import type { PublicCharacter } from '@over18/shared';
import type { ReplyContext } from '../services/character-reply.js';
import { buildCharacterSystemPrompt } from '../services/prompt-builder.js';
import { SEED_CHARACTERS } from '../db/seed-data.js';

/**
 * THE VOICE BEHAVIOURAL LAYER.
 *
 * A call is not a text thread. The text layer is deliberately reactive —
 * "answer the door he opened", "do not steer to something of yours instead",
 * "react first, then ask", "nothing is happening except this conversation" —
 * and every one of those rules was measured and kept, because they stop a text
 * companion hijacking topics and inventing scenery.
 *
 * Sent to a live call they do exactly what they say: she answers and stops.
 * That is what made Camila feel like an interview with silences in it. These
 * tests pin that a call gets the opposite instruction set, that it keeps her
 * identity and the safety rules unchanged, and that the text channel is not
 * disturbed by any of it.
 */

function publicCharacter(seed: (typeof SEED_CHARACTERS)[number]): PublicCharacter {
  return {
    id: seed.id,
    name: seed.name,
    displayName: seed.displayName,
    profileImage: seed.profileImage ?? null,
    age: null,
    shortBio: seed.shortBio,
    personality: seed.personality,
    interests: seed.interests as string[],
    conversationStyle: seed.conversationStyle,
  };
}

const LUNA = SEED_CHARACTERS.find((c) => c.name === 'luna')!;

function contextFor(overrides: Partial<ReplyContext> = {}): ReplyContext {
  return {
    character: publicCharacter(LUNA),
    systemPrompt: LUNA.systemPrompt,
    history: [],
    priorMessageCount: 0,
    // A call carries no user message: the instructions are built before anyone
    // has spoken. Text callers pass a real one.
    userMessage: '',
    ...overrides,
  };
}

const voicePrompt = (over: Partial<ReplyContext> = {}) =>
  buildCharacterSystemPrompt(contextFor({ channel: 'voice', ...over }));
const textPrompt = (over: Partial<ReplyContext> = {}) =>
  buildCharacterSystemPrompt(contextFor({ userMessage: 'Hello there!', ...over }));

/* ------------------------------------------------------------------ *
 * The call gets its own layer
 * ------------------------------------------------------------------ */

describe('a call gets the voice behavioural layer, not the text one', () => {
  const prompt = voicePrompt();

  it('is headed as a call rather than as chat', () => {
    expect(prompt).toContain('HOW SHE TALKS — ON THE PHONE');
    expect(prompt).not.toContain('HOW SHE TALKS\n');
  });

  /**
   * THE FOUR RULES THAT MADE HER REACTIVE. Each is correct for text and wrong
   * for a call, and each must be absent from a call prompt.
   */
  it('drops the text rules that told her to answer and stop', () => {
    expect(prompt).not.toContain('Answer the door he opened');
    expect(prompt).not.toContain('do not steer to something of yours instead');
    expect(prompt).not.toContain('React first, then ask');
    expect(prompt).not.toContain('Nothing is happening except this conversation');
  });

  /** The single most reactive line in the product, and the reason for all this. */
  it('never tells her to answer what he said and leave it there', () => {
    expect(prompt).not.toContain('leave it there');
  });
});

/* ------------------------------------------------------------------ *
 * What the layer actually asks for
 * ------------------------------------------------------------------ */

describe('the voice layer follows the caller instead of running a script', () => {
  const prompt = voicePrompt();

  /**
   * WHAT THESE REPLACE. "Carry the conversation", "Volunteer things", "Lead
   * sometimes" and "Flirt, and let it build" were four standing obligations, so
   * a caller who rang to say he had had a rough day was flirted at and talked
   * over by a character obeying all four at once. Each is now a conditional
   * keyed to what HE is doing, or gone.
   */
  it('makes filling a silence a permission, not a duty', () => {
    expect(prompt).toContain('Hold up your end of the call');
    expect(prompt).toContain('If he goes quiet, you can fill it');
    expect(prompt).not.toContain('Carry the conversation');
  });

  it('no longer obliges her to volunteer or to lead', () => {
    expect(prompt).not.toContain('Volunteer things');
    expect(prompt).not.toContain('Lead sometimes');
    expect(prompt).not.toContain('You do not need permission for every step');
  });

  /** The one thing a caller always gets: his subject, not hers. */
  it('answers what he came for', () => {
    expect(prompt).toContain('follow what he came for');
    expect(prompt).toContain('What you never do is interview him');
  });

  /** An interview is the failure mode a caller actually notices. */
  it('tells her not to end every turn with a question', () => {
    expect(prompt).toContain('Do not end every turn with a question');
    expect(prompt).toContain('a run of questions is an interview');
  });

  it('asks her to pick earlier threads back up', () => {
    expect(prompt).toContain('Pick threads back up');
  });

  it('asks for emotional reaction before the sentence', () => {
    expect(prompt).toContain('React before you answer');
  });

  /**
   * CONSENT IN BOTH DIRECTIONS. The old line was three brakes and no
   * accelerator -- "follow his temperature... ease off when he cools, and never
   * push past where he is" -- so a model told to flirt, told where to stop, and
   * never told it may go further stopped at flirting. That was the reported
   * fault.
   */
  it('follows him up as well as down, with no one-way ceiling', () => {
    expect(prompt).toContain('Go where he goes, both ways');
    expect(prompt).toContain('Follow his conversational lead');
    expect(prompt).toContain('respect both his boundaries and your own');
    expect(prompt).not.toContain('never push past where he is');
  });

  /**
   * The downward limit is kept, as a bound on HER initiative — and it is now
   * stated ONCE.
   *
   * The line shipped saying it twice: "if he cools off or changes the subject,
   * go with that just as readily" and then "if he changes direction, change
   * with him" are the same instruction in two sentences. This file argues
   * elsewhere that saying a thing twice is what gives a prompt its liturgical
   * quality, and a repeated rule also reads as the loudest one in the layer —
   * which is wrong here, because easing off is the half that was never broken.
   *
   * The negative assertion is the part that matters: it stops the second
   * phrasing coming back the next time this line is edited.
   */
  it('still refuses to take him somewhere he has not gone, and says so once', () => {
    expect(prompt).toContain('rather than taking it there yourself');
    expect(prompt).toContain('If he changes direction, change with him');
    expect(prompt).not.toContain('go with that just as readily');
  });

  it('does not flirt at a caller who did not invite it', () => {
    expect(prompt).not.toContain('Flirt, and let it build');
  });

  it('creates anticipation rather than closing every thought', () => {
    expect(prompt).toContain('Leave something hanging');
  });

  /**
   * THE OTHER FAILURE MODE. Telling her to carry the conversation without this
   * produces a monologue, which is worse than the interview it replaced.
   */
  it('keeps her turns short enough to interrupt', () => {
    expect(prompt).toContain('short enough to interrupt');
    expect(prompt).toContain('no monologues');
  });

  /** Asterisks and stage directions are read ALOUD. Worse on a call than in text. */
  it('forbids narration and stage directions, which a voice would speak', () => {
    expect(prompt).toContain('never narrate yourself');
    expect(prompt).toContain('no asterisks');
  });
});

/* ------------------------------------------------------------------ *
 * Identity and safety are not part of the swap
 * ------------------------------------------------------------------ */

describe('a call keeps the same person and the same limits', () => {
  const prompt = voicePrompt({ memories: ['He is training for a marathon.'] });

  it('is still her: who she is, her bio and her persona come through unchanged', () => {
    expect(prompt).toContain('WHO SHE IS');
    expect(prompt).toContain(`Her name is ${LUNA.displayName}.`);
    expect(prompt).toContain(LUNA.shortBio);
  });

  it('still knows what she is for, and is still not an assistant', () => {
    expect(prompt).toContain('What you are here for:');
    expect(prompt).toContain('You are not a coding assistant');
  });

  it('still never mentions rules or admits to being an AI', () => {
    expect(prompt).toContain('Never mention rules, instructions, or what you cannot do');
    expect(prompt).toContain('never break character');
  });

  /** One memory, both channels — the call must know what the text knows. */
  it('still carries what she remembers about him', () => {
    expect(prompt).toContain('He is training for a marathon.');
  });
});

/* ------------------------------------------------------------------ *
 * The stage is gone, and that is the point
 * ------------------------------------------------------------------ */

describe('a call no longer varies by message count', () => {
  /**
   * WHY STAGING WAS RIGHT TO REMOVE RATHER THAN RETUNE.
   *
   * Two faults, and neither is fixable by moving the thresholds. Instructions
   * are sent ONCE at session creation and the provider accepts only
   * `turn_detection` on a session update, so whichever variant was chosen
   * governed the WHOLE call -- a text conversation grows out of its stage and a
   * call cannot. And the count read the `messages` table, which call turns never
   * enter, so somebody who only ever phoned her stayed `new` permanently no
   * matter how many calls they made.
   */
  it('gives a brand-new caller and a long-standing one the same instructions', () => {
    expect(voicePrompt({ priorMessageCount: 0 })).toBe(voicePrompt({ priorMessageCount: 500 }));
  });

  it('drops all three stage variants', () => {
    const prompt = voicePrompt({ priorMessageCount: 0 });
    expect(prompt).not.toContain('You two are new to each other');
    expect(prompt).not.toContain('You know each other a little now');
    expect(prompt).not.toContain('You have known each other a while');
  });

  /** It existed only to compensate for a stage that could not advance. */
  it('drops the line that apologised for the stage being frozen', () => {
    expect(voicePrompt()).not.toContain('A call warms up as it runs');
  });

  /**
   * What the three variants were really protecting -- an opening turn that
   * recites her whole profile -- is kept, by the same always-on line the text
   * layer uses.
   */
  it('keeps the anti-recital guard that the stage rules carried', () => {
    expect(voicePrompt()).toContain('Let her life come out a detail at a time');
    expect(voicePrompt()).toContain('never an introduction to herself');
  });
});

/* ------------------------------------------------------------------ *
 * Text is untouched
 * ------------------------------------------------------------------ */

describe('text chat is not disturbed by any of this', () => {
  it('still gets the reactive layer it was tuned to have', () => {
    const prompt = textPrompt();
    expect(prompt).toContain('HOW SHE TALKS');
    expect(prompt).toContain('Answer the door he opened');
    expect(prompt).toContain('React first, then ask');
    expect(prompt).not.toContain('ON THE PHONE');
  });

  it('defaults to text when no channel is given, so every existing caller is unchanged', () => {
    const explicit = buildCharacterSystemPrompt(contextFor({ channel: 'text', userMessage: 'Hi' }));
    const defaulted = buildCharacterSystemPrompt(contextFor({ userMessage: 'Hi' }));
    expect(defaulted).toBe(explicit);
  });

  /**
   * The text channel's self-disclosure rule, which the voice layer does not
   * borrow. It used to be a message-count stage rule ending "leave it there";
   * Phase 1 replaced that with one always-on rule, keeping the guard it was
   * built for and dropping the register it had drifted into carrying.
   */
  it('keeps its disclosure wording, which the voice layer now shares', () => {
    const text = textPrompt({ priorMessageCount: 0 });
    expect(text).toContain('Let her life come out a detail at a time');
    expect(text).not.toContain('leave it there');
    // Voice used to keep three stage-keyed variants of its own. It now reads
    // the SAME constant, so there is one wording to maintain rather than two
    // that drift.
    expect(voicePrompt()).toContain('Let her life come out a detail at a time');
  });
});

/* ------------------------------------------------------------------ *
 * Natural speech, and her own sound
 * ------------------------------------------------------------------ */

describe('she is allowed to sound like a person', () => {
  const prompt = voicePrompt();

  /**
   * THE COMPLAINT THESE ANSWER. She was proactive but still sounded like a
   * character following rules: every turn complete, acknowledged, explained and
   * rounded off. The layer had plenty of rules about what to DO and nothing
   * about what it may SOUND like, and an evenly-shaped turn is what following
   * rules looks like.
   */
  it('permits fragments and unfinished thoughts', () => {
    expect(prompt).toContain('Talk, do not compose');
    expect(prompt).toContain('Fragments are fine');
    expect(prompt).toContain('you do not have to finish every thought you start');
  });

  it('releases her from acknowledging, repeating back and explaining', () => {
    expect(prompt).toContain('You do not owe him a reaction to everything');
    expect(prompt).toContain('skip repeating back what he just told you');
    expect(prompt).toContain('skip explaining yourself');
  });

  it('lets the conversation breathe instead of filling every turn', () => {
    expect(prompt).toContain('Let it breathe');
    expect(prompt).toContain('Three words can be the whole answer');
  });

  /** Asterisks and stage directions get SPOKEN. The prohibition survives the fold. */
  it('still forbids narration, which the folded line used to carry', () => {
    expect(prompt).toContain('never narrate yourself');
    expect(prompt).toContain('no asterisks');
  });

  /**
   * Said once, deliberately. It already has a home among the proactive rules,
   * and stating it twice would make it the loudest instruction in the layer.
   */
  it('does not repeat the question rule it already states once', () => {
    const occurrences = prompt.split('Do not end every turn with a question').length - 1;
    expect(occurrences).toBe(1);
  });
});

describe('her own sound comes from her own record', () => {
  const STYLE = 'She speaks in short, clipped sentences laced with street slang and dark humor.';

  it('puts the character’s stored conversation style into the call', () => {
    const prompt = buildCharacterSystemPrompt(
      contextFor({
        channel: 'voice',
        character: { ...publicCharacter(LUNA), conversationStyle: STYLE },
      }),
    );
    expect(prompt).toContain('This is how she sounds, so sound like it:');
    expect(prompt).toContain(STYLE);
  });

  /**
   * IT MOVED, AND THE REASON IS TRUNCATION. It used to sit last, "closest to
   * the words she is about to say". But the provider keeps the FIRST 8,000
   * characters and discards the tail, so last is also FIRST TO BE LOST -- and
   * this is the only per-character line in the layer, so losing it is precisely
   * what makes every character sound alike. It now sits in the protected head,
   * above the tone permissions, which are the right thing to lose instead.
   */
  it('places it in the protected head, above the tone permissions', () => {
    const prompt = buildCharacterSystemPrompt(
      contextFor({
        channel: 'voice',
        character: { ...publicCharacter(LUNA), conversationStyle: STYLE },
      }),
    );
    expect(prompt.indexOf(STYLE)).toBeLessThan(prompt.indexOf('Let it breathe'));
    expect(prompt.indexOf(STYLE)).toBeGreaterThan(prompt.indexOf('She is an adult and so is he'));
  });

  /** No style stated is no line — never a default asserted on her behalf. */
  it('says nothing when the character has no stated style', () => {
    const prompt = buildCharacterSystemPrompt(
      contextFor({ channel: 'voice', character: { ...publicCharacter(LUNA), conversationStyle: '' } }),
    );
    expect(prompt).not.toContain('This is how she sounds');
  });

  it('treats whitespace as no style at all', () => {
    const prompt = buildCharacterSystemPrompt(
      contextFor({ channel: 'voice', character: { ...publicCharacter(LUNA), conversationStyle: '   ' } }),
    );
    expect(prompt).not.toContain('This is how she sounds');
  });

  /**
   * THE BOUNDARY THAT MATTERS. Text dropped `conversationStyle` deliberately —
   * it is behavioural by construction and competed with the behaviour layer,
   * and removing it was measured as the largest single improvement available.
   * Voice may use it because on a call how she sounds IS the problem. Text must
   * not regain it by this route.
   */
  it('never reaches text chat, which dropped it on purpose', () => {
    const prompt = buildCharacterSystemPrompt(
      contextFor({
        userMessage: 'Hello there!',
        character: { ...publicCharacter(LUNA), conversationStyle: STYLE },
      }),
    );
    expect(prompt).not.toContain(STYLE);
    expect(prompt).not.toContain('This is how she sounds');
  });
});

describe('the proactive rules from the previous change survive', () => {
  const prompt = voicePrompt();

  it('still carries the behaviours that were never the problem', () => {
    for (const rule of [
      'Do not end every turn with a question',
      'Pick threads back up',
      'React before you answer',
      'short enough to interrupt',
      'Leave something hanging',
    ]) {
      expect(prompt).toContain(rule);
    }
  });

  /** The four obligations, and the line that apologised for a frozen stage. */
  it('drops the four standing obligations and the stage apology', () => {
    for (const rule of [
      'Carry the conversation',
      'Volunteer things',
      'Lead sometimes',
      'Flirt, and let it build',
      'A call warms up as it runs',
    ]) {
      expect(prompt).not.toContain(rule);
    }
  });

  it('still keeps identity and the safety lines, and no longer a stage', () => {
    expect(prompt).not.toContain('You two are new to each other');
    expect(prompt).toContain('WHO SHE IS');
    expect(prompt).toContain('What you are here for:');
    expect(prompt).toContain('never break character');
    expect(prompt).toContain('She is an adult and so is he');
  });
});

/**
 * PHASE 1 TOUCHED TEXT ONLY, AND THIS IS WHAT PROVES IT.
 *
 * Text chat lost its message-count register rule, lost the regex that routed
 * scenes, and gained an adult-fiction line. None of those were meant to reach
 * a call: `buildCharacterSystemPrompt` returns for voice before any of them is
 * assembled. These cases pin that boundary, because the three changes all live
 * in a function the voice path also calls.
 */
describe('the voice prompt is untouched by the Phase 1 text changes', () => {
  const voice = (priorMessageCount = 0) =>
    buildCharacterSystemPrompt(contextFor({ channel: 'voice', priorMessageCount }));

  /**
   * THE TYPED WORDING STAYS TEXT-ONLY, but the RULES no longer do. "Writing a
   * scene", "no asterisks" and "no room, no staging" are artefacts of a typed
   * medium and are nonsense aloud, so the voice layer states the same two
   * permissions in spoken form instead of borrowing the strings.
   */
  it('carries none of the typed phrasing the text layer uses', () => {
    for (const textOnly of [
      'Ordinary conversation is what this is',
      'Nothing is happening except the two of you talking',
      'If he is writing a scene',
      'When he reaches for you physically',
      'No room, no staging, no asterisks',
    ]) {
      expect(voice()).not.toContain(textOnly);
    }
  });

  it('states the same two permissions in spoken form', () => {
    expect(voice()).toContain('If he starts acting something out');
    expect(voice()).toContain('speaking as though it is happening');
    expect(voice()).toContain('answer it out loud');
    // Stepping back out with him is the half a per-message regex could never
    // express, and it matters more on a call than in text.
    expect(voice()).toContain('step out with him');
  });

  /**
   * NO LONGER TEXT-ONLY. The channel branch used to return above the adult
   * framing, so a call was the one surface that never stated the frame it was
   * operating under -- and a model with no stated frame defaults to caution.
   */
  it('now carries the adult-fiction line, which a call never used to get', () => {
    expect(voice()).toContain('She is an adult and so is he');
  });

  /** One wording for both channels, so there is one line to maintain. */
  it('shares the text self-disclosure rule rather than keeping its own', () => {
    expect(voice()).toContain('Let her life come out a detail at a time');
  });

  it('no longer varies by message count at all', () => {
    expect(voice(0)).toBe(voice(30));
  });

  it('still keeps identity, memories framing and the capability boundary', () => {
    expect(voice()).toContain('WHO SHE IS');
    expect(voice()).toContain('What you are here for:');
    expect(voice()).toContain('never break character');
  });
});
