import { describe, expect, it } from 'vitest';
import type { PublicCharacter } from '@over18/shared';
import type { ReplyContext } from '../services/character-reply.js';
import { buildCharacterSystemPrompt, conversationStage } from '../services/prompt-builder.js';
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

describe('the voice layer asks her to carry the conversation', () => {
  const prompt = voicePrompt();

  it('makes keeping it going her job too', () => {
    expect(prompt).toContain('Carry the conversation');
    expect(prompt).toContain('If it goes quiet, fill it');
  });

  it('asks her to volunteer things rather than wait to be asked', () => {
    expect(prompt).toContain('Volunteer things');
    expect(prompt).toContain('instead of waiting to be asked');
  });

  /** An interview is the failure mode a caller actually notices. */
  it('tells her not to end every turn with a question', () => {
    expect(prompt).toContain('Do not end every turn with a question');
    expect(prompt).toContain('a run of questions is an interview');
  });

  it('asks her to pick earlier threads back up', () => {
    expect(prompt).toContain('Pick threads back up');
  });

  it('lets her lead without asking permission for every step', () => {
    expect(prompt).toContain('Lead sometimes');
    expect(prompt).toContain('You do not need permission for every step');
  });

  it('asks for emotional reaction before the sentence', () => {
    expect(prompt).toContain('React before you answer');
  });

  /** Intimacy that follows him, never one that pushes. */
  it('lets her flirt and build, and pins it to his engagement', () => {
    expect(prompt).toContain('Flirt, and let it build');
    expect(prompt).toContain('follow his temperature');
    expect(prompt).toContain('never push past where he is');
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
 * The stage, which was frozen at `new` on every call ever made
 * ------------------------------------------------------------------ */

describe('the conversational stage', () => {
  /**
   * The bug: `priorMessageCount` was hardcoded to 0 in the call path, so
   * `conversationStage` returned `new` for every call a customer ever made,
   * however long they had known each other.
   */
  it('moves through the three stages as the relationship grows', () => {
    expect(conversationStage(0)).toBe('new');
    expect(conversationStage(3)).toBe('new');
    expect(conversationStage(4)).toBe('early');
    expect(conversationStage(19)).toBe('early');
    expect(conversationStage(20)).toBe('established');
  });

  it('is new and curious for two people who have just met', () => {
    const prompt = voicePrompt({ priorMessageCount: 0 });
    expect(prompt).toContain('You two are new to each other');
    // Even at the start she carries the call; "new" is not "guarded".
    expect(prompt).toContain('New does not mean guarded');
  });

  it('gives more of herself once they know each other a little', () => {
    const prompt = voicePrompt({ priorMessageCount: 10 });
    expect(prompt).toContain('You know each other a little now');
    expect(prompt).not.toContain('You two are new to each other');
  });

  it('is direct and comfortable with someone she has known a while', () => {
    const prompt = voicePrompt({ priorMessageCount: 200 });
    expect(prompt).toContain('You have known each other a while');
    expect(prompt).toContain('Be direct about what you think and what you want');
  });

  /**
   * Instructions are sent once and cannot be re-sent mid-call, so the layer
   * says in words what it cannot express by re-staging.
   */
  it('tells her a call warms up as it runs, since the stage cannot be re-sent', () => {
    expect(voicePrompt()).toContain('A call warms up as it runs');
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

  it('still keeps its own stage wording, which the voice layer does not borrow', () => {
    expect(textPrompt({ priorMessageCount: 0 })).toContain('leave it there');
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

  /** It is the only per-character line in the layer, so it goes nearest the speech. */
  it('places it last, closest to the words she is about to say', () => {
    const prompt = buildCharacterSystemPrompt(
      contextFor({
        channel: 'voice',
        character: { ...publicCharacter(LUNA), conversationStyle: STYLE },
      }),
    );
    expect(prompt.indexOf(STYLE)).toBeGreaterThan(prompt.indexOf('Let it breathe'));
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

  it('still carries every behaviour the voice layer already had', () => {
    for (const rule of [
      'Carry the conversation',
      'Volunteer things',
      'Do not end every turn with a question',
      'Pick threads back up',
      'Lead sometimes',
      'React before you answer',
      'Flirt, and let it build',
      'short enough to interrupt',
      'Leave something hanging',
      'A call warms up as it runs',
    ]) {
      expect(prompt).toContain(rule);
    }
  });

  it('still keeps the stage, identity and safety lines', () => {
    expect(prompt).toContain('You two are new to each other');
    expect(prompt).toContain('WHO SHE IS');
    expect(prompt).toContain('What you are here for:');
    expect(prompt).toContain('never break character');
  });
});
