import { describe, expect, it } from 'vitest';
import type { CharacterLocation, PublicCharacter } from '@over18/shared';
import type { ReplyContext } from '../services/character-reply.js';
import { buildCharacterSystemPrompt, locationSentences } from '../services/prompt-builder.js';
import { isValidTimezone, localTimeIn } from '../services/timezone.js';
import { SEED_CHARACTERS } from '../db/seed-data.js';

/**
 * WHERE SHE IS, AND WHAT TIME IT IS THERE.
 *
 * She used to be placeless: asked where she lived she invented somewhere, and
 * invented somewhere else next time. These pin that she now states what an
 * operator recorded and NOTHING MORE -- no country she was not given, no clock
 * from the wrong zone, and no block at all for a character with no location,
 * who must behave exactly as she did before this existed.
 */

const LUNA = SEED_CHARACTERS.find((c) => c.name === 'luna')!;

const publicCharacter = (): PublicCharacter => ({
  id: LUNA.id,
  name: LUNA.name,
  displayName: LUNA.displayName,
  profileImage: null,
  shortBio: LUNA.shortBio,
  personality: LUNA.personality,
  interests: LUNA.interests as string[],
  conversationStyle: LUNA.conversationStyle,
});

const context = (over: Partial<ReplyContext> = {}): ReplyContext => ({
  character: publicCharacter(),
  systemPrompt: LUNA.systemPrompt,
  history: [],
  priorMessageCount: 0,
  userMessage: 'Hello there!',
  ...over,
});

const place = (over: Partial<CharacterLocation> = {}): CharacterLocation => ({
  countryCode: 'PL',
  region: 'Masovian',
  city: 'Warsaw',
  timezone: 'Europe/Warsaw',
  ...over,
});

/** A fixed instant, so "what time is it there" is an assertion and not a race. */
const NOON_UTC = new Date('2026-10-05T12:00:00.000Z');

/* ------------------------------------------------------------------ *
 * The sentences themselves
 * ------------------------------------------------------------------ */

describe('what she is told about where she lives', () => {
  it('names the place from narrowest to widest, as a person answers it', () => {
    expect(locationSentences(place(), NOON_UTC)[0]).toBe('She lives in Warsaw, Masovian, Poland.');
  });

  /** The country CODE is stored; a person says the country's name. */
  it('says the country name, not the ISO code', () => {
    const lines = locationSentences(place({ region: null, city: null }), NOON_UTC);
    expect(lines[0]).toBe('She lives in Poland.');
    expect(lines[0]).not.toContain('PL');
  });

  it('states the zone and the time it is there', () => {
    const lines = locationSentences(place(), NOON_UTC).join('\n');
    expect(lines).toContain('Europe/Warsaw');
    // Warsaw is UTC+2 in October: noon UTC is 14:00 there.
    expect(lines).toContain('14:00');
    expect(lines).toContain('Monday');
    expect(lines).toContain('5 October 2026');
  });

  /** The same instant in another zone is a different clock, which is the point. */
  it('computes the clock from her zone, not the server’s', () => {
    const tokyo = locationSentences(place({ timezone: 'Asia/Tokyo' }), NOON_UTC).join('\n');
    expect(tokyo).toContain('21:00');
    expect(tokyo).not.toContain('14:00');
  });

  it('tells her the place is hers to use, not to recite', () => {
    expect(locationSentences(place(), NOON_UTC).join('\n')).toContain('leave them alone when they do not');
  });
});

describe('a partial or missing location invents nothing', () => {
  it('says nothing at all when there is no location', () => {
    expect(locationSentences(null)).toEqual([]);
    expect(locationSentences(undefined)).toEqual([]);
    expect(locationSentences(place({ countryCode: null, region: null, city: null, timezone: null }))).toEqual([]);
  });

  it('names only the parts it was given', () => {
    const lines = locationSentences(place({ region: null, timezone: null }), NOON_UTC);
    expect(lines).toEqual(['She lives in Warsaw, Poland.']);
    expect(lines.join('\n')).not.toContain('Masovian');
    expect(lines.join('\n')).not.toContain('time');
  });

  it('gives a city with no zone no clock, rather than the server’s', () => {
    const lines = locationSentences(place({ timezone: null }), NOON_UTC).join('\n');
    expect(lines).toContain('Warsaw');
    expect(lines).not.toMatch(/currently/);
  });

  /**
   * A zone this runtime does not know must produce NOTHING. Falling back to the
   * server clock would place her in a time zone she is not in and state it as
   * fact.
   */
  it('says no time at all for a zone it does not recognise', () => {
    const lines = locationSentences(place({ timezone: 'Mars/Olympus' }), NOON_UTC).join('\n');
    expect(lines).toContain('Warsaw');
    expect(lines).not.toContain('Mars/Olympus');
    expect(lines).not.toMatch(/currently/);
  });
});

/* ------------------------------------------------------------------ *
 * In the prompt, on both channels
 * ------------------------------------------------------------------ */

describe('the prompt carries it on both channels', () => {
  it('reaches the text prompt', () => {
    const prompt = buildCharacterSystemPrompt(context({ location: place() }));
    expect(prompt).toContain('WHERE SHE IS');
    expect(prompt).toContain('She lives in Warsaw, Masovian, Poland.');
  });

  /** One character, one set of facts: the call reads the same block. */
  it('reaches the voice prompt', () => {
    const prompt = buildCharacterSystemPrompt(context({ channel: 'voice', userMessage: '', location: place() }));
    expect(prompt).toContain('WHERE SHE IS');
    expect(prompt).toContain('She lives in Warsaw, Masovian, Poland.');
    expect(prompt).toContain('Europe/Warsaw');
  });

  /**
   * THE REGRESSION GUARD. Every character has no location today, and must be
   * byte-identical to how she was before this feature existed.
   */
  it('leaves a character with no location exactly as she was', () => {
    const withNothing = buildCharacterSystemPrompt(context({ location: null }));
    const withoutTheField = buildCharacterSystemPrompt(context());
    expect(withNothing).toBe(withoutTheField);
    expect(withNothing).not.toContain('WHERE SHE IS');
  });
});

/* ------------------------------------------------------------------ *
 * Profession and education: already stated, now also USED
 * ------------------------------------------------------------------ */

describe('her work and her schooling', () => {
  const persona = { occupation: 'a sound archivist', education: 'a conservatoire dropout' };

  it('still states them as facts, exactly as before', () => {
    const prompt = buildCharacterSystemPrompt(context({ persona }));
    expect(prompt).toContain('She works as a sound archivist.');
    expect(prompt).toContain("Educationally, she's a conservatoire dropout.");
  });

  /**
   * What was missing: the facts were stated and never put to use, so she
   * announced her job and then knew nothing about it.
   */
  it('tells her to let the knowledge show rather than state the credential', () => {
    const prompt = buildCharacterSystemPrompt(context({ persona }));
    expect(prompt).toContain('shows in how she talks about things');
    expect(prompt).toContain('not in stating her job or her qualifications');
  });

  it('says it on a call too', () => {
    const prompt = buildCharacterSystemPrompt(context({ channel: 'voice', userMessage: '', persona }));
    expect(prompt).toContain('shows in how she talks about things');
  });

  it('says nothing when she has neither', () => {
    expect(buildCharacterSystemPrompt(context())).not.toContain('shows in how she talks about things');
  });

  it('says it when she has only one of the two', () => {
    expect(buildCharacterSystemPrompt(context({ persona: { occupation: 'a chef' } }))).toContain(
      'shows in how she talks about things',
    );
  });
});

/* ------------------------------------------------------------------ *
 * The timezone helpers
 * ------------------------------------------------------------------ */

describe('time zones are checked against the platform’s own database', () => {
  it('accepts real IANA zones', () => {
    for (const zone of ['Europe/Warsaw', 'Asia/Tokyo', 'America/New_York', 'UTC']) {
      expect(isValidTimezone(zone)).toBe(true);
    }
  });

  it('refuses anything it does not know', () => {
    for (const zone of ['Mars/Olympus', 'Warsaw', 'GMT+2:00 ish', '', '   ']) {
      expect(isValidTimezone(zone)).toBe(false);
    }
  });

  it('formats the wall clock in the zone asked for', () => {
    expect(localTimeIn('UTC', NOON_UTC)).toContain('12:00');
    expect(localTimeIn('Asia/Tokyo', NOON_UTC)).toContain('21:00');
  });

  it('returns null rather than guessing for an unknown zone', () => {
    expect(localTimeIn('Mars/Olympus', NOON_UTC)).toBeNull();
  });

  /** Derived, never stored: the same zone reads differently at a later instant. */
  it('moves with the clock', () => {
    const morning = localTimeIn('UTC', new Date('2026-10-05T08:00:00.000Z'));
    const evening = localTimeIn('UTC', new Date('2026-10-05T20:00:00.000Z'));
    expect(morning).not.toBe(evening);
  });
});
