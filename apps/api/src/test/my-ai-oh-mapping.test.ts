import { describe, it, expect } from 'vitest';
import type { MyAiAttributes } from '@over18/shared';
import {
  MY_AI_BREASTS,
  MY_AI_BUTTS,
  MY_AI_ETHNICITIES,
  MY_AI_EYE_COLOURS,
  MY_AI_FIGURES,
  MY_AI_HAIR_COLOURS,
  MY_AI_HAIR_STYLES,
  MY_AI_INTERESTS,
  MY_AI_JOBS,
  MY_AI_PERSONALITIES,
  MY_AI_RELATIONSHIPS,
} from '@over18/shared';
import {
  PORTRAIT_OUTFIT,
  PORTRAIT_SCENES,
  dateOfBirthForAge,
  openingPhotoPrompt,
  portraitSceneFor,
  toOhPayload,
} from '../services/my-ai/oh-mapping.js';

/**
 * The provider vocabulary, which is the one part of My AI that cannot be
 * checked by reading it.
 *
 * These values were read from OhAPI's live lookup endpoints, and the whole
 * risk is that one of them is subtly wrong — `Medium` where OH says `Average`,
 * a capital L in `loving` — because the failure mode is a 400 at the end of a
 * flow the user has already finished. No database here: this is pure mapping.
 */

const BASE: MyAiAttributes = {
  ethnicity: 'latina',
  hairColour: 'blonde',
  hairStyle: 'wavy',
  eyeColour: 'green',
  figure: 'curvy',
  breasts: 'huge',
  butt: 'medium',
  personality: 'loving',
  relationship: 'girlfriend',
  job: 'nurse',
  interests: ['anime', 'netflix', 'wine'],
};

const build = (over: Partial<MyAiAttributes> = {}, age = 24) =>
  toOhPayload({ name: 'Lisa', age, attributes: { ...BASE, ...over } });

describe('every option the wizard can produce is mappable', () => {
  /*
   * THE POINT OF THIS TEST. The wizard offers these lists; the mapping must
   * cover all of them. A missing entry throws, which is far better than being
   * dropped, but it still only shows up when a user happens to pick it — so
   * every value is exercised here instead.
   */
  const everyOption: [keyof MyAiAttributes, readonly { id: string }[]][] = [
    ['ethnicity', MY_AI_ETHNICITIES],
    ['hairColour', MY_AI_HAIR_COLOURS],
    ['hairStyle', MY_AI_HAIR_STYLES],
    ['eyeColour', MY_AI_EYE_COLOURS],
    ['figure', MY_AI_FIGURES],
    ['breasts', MY_AI_BREASTS],
    ['butt', MY_AI_BUTTS],
    ['personality', MY_AI_PERSONALITIES],
    ['relationship', MY_AI_RELATIONSHIPS],
    ['job', MY_AI_JOBS],
  ];

  for (const [field, options] of everyOption) {
    it(`maps every ${field}`, () => {
      for (const option of options) {
        expect(() => build({ [field]: option.id } as Partial<MyAiAttributes>)).not.toThrow();
      }
    });
  }

  it('maps every interest', () => {
    for (const interest of MY_AI_INTERESTS) {
      const payload = build({ interests: [interest.id] });
      expect(payload.interests).toHaveLength(1);
    }
  });

  it('throws rather than silently dropping an unknown id', () => {
    // A dropped attribute is a companion who comes back subtly wrong with
    // nothing in the logs to say why.
    expect(() => build({ breasts: 'enormous' })).toThrow(/breasts/);
    expect(() => build({ interests: ['quidditch'] })).toThrow(/quidditch/);
  });
});

describe('the values OhAPI actually uses', () => {
  it('sends the exact strings, oddities included', () => {
    const payload = build({
      breasts: 'huge',
      butt: 'medium',
      hairColour: 'black',
      hairStyle: 'bob',
      personality: 'loving',
    });
    expect(payload.breastSize).toBe('Huge Boobs');
    expect(payload.buttSize).toBe('Average'); // NOT "Medium"
    expect(payload.hairColour).toBe('Black Hair');
    expect(payload.hairLength).toBe('Chin-length bob');
    expect(payload.personality).toEqual(['loving']); // lower-case, on purpose
  });

  it('corrects the two interest values that do not exist in OH', () => {
    // "Anime & manga" and "Netflix nights" would 400 the create.
    const payload = build({ interests: ['anime', 'netflix'] });
    expect(payload.interests).toEqual(['Anime', 'Netflix']);
  });

  it('carries the required fields OH refuses a create without', () => {
    const payload = build();
    expect(payload.firstName).toBe('Lisa');
    expect(payload.lastName).toBeTruthy(); // OH requires one; the flow asks for a single name
    expect(payload.gender).toBe('Female');
    expect(payload.ethnicity).toBe('Latina');
    expect(payload.nationality).toBeTruthy();
    expect(payload.dateOfBirth).toMatch(/^\d{4}-01-01$/);
  });
});

describe('hair style, which OhAPI has no field for', () => {
  it('uses a real hairLength where one exists and adds no prose at all', () => {
    for (const id of ['straight', 'bob', 'pixie']) {
      const payload = build({ hairStyle: id });
      expect(payload.hairLength).toBeTruthy();
      expect(payload.additionalDescription).toBeUndefined();
    }
  });

  it('falls back to a length plus description for the rest', () => {
    const payload = build({ hairStyle: 'ponytail' });
    expect(payload.hairLength).toBe('Long');
    expect(payload.additionalDescription).toContain('ponytail');
  });

  it('keeps the free text well inside OH’s 1,000-character limit', () => {
    const payload = build({ hairStyle: 'braids' });
    expect((payload.additionalDescription ?? '').length).toBeLessThan(1000);
  });
});

describe('relationship', () => {
  it('uses a real relationshipStyle for the three OH models', () => {
    expect(build({ relationship: 'girlfriend' }).relationshipStyle).toBe('Monogamous girlfriend');
    expect(build({ relationship: 'wife' }).relationshipStyle).toBe('Newlywed wife');
    expect(build({ relationship: 'fwb' }).relationshipStyle).toBe('Casual FWB');
  });

  it('puts the other six in backstory and claims no relationshipStyle', () => {
    // Pretending OH models "roommate" is how you end up explaining why she
    // does not behave like one.
    const payload = build({ relationship: 'roommate' });
    expect(payload.relationshipStyle).toBeUndefined();
    expect(payload.backstory).toContain('roommate');
  });
});

describe('date of birth', () => {
  const now = new Date('2026-11-15T00:00:00Z');

  it('produces the age the user chose', () => {
    expect(dateOfBirthForAge(24, now)).toBe('2002-01-01');
    expect(dateOfBirthForAge(21, now)).toBe('2005-01-01');
  });

  it('dates to 1 January so no birthday can pass and change her age', () => {
    // The number beside her name and the date we send are one fact. A DOB
    // with a real birthday makes them disagree the day after it.
    expect(dateOfBirthForAge(30, now).endsWith('-01-01')).toBe(true);
  });

  it('never yields a date OH would reject as under 21', () => {
    const year = Number(dateOfBirthForAge(21, now).slice(0, 4));
    expect(now.getUTCFullYear() - year).toBe(21);
  });
});

describe('what she wears, and where she stands', () => {
  /*
   * HONDA CAME BACK NAKED, with `contentLevel: 'Sexy'` and "wearing a bikini"
   * in `additionalDescription`. Neither dresses anybody: that field is
   * documented as traits the structured fields cannot express — a piercing,
   * freckles, a tattoo — and contentLevel is a ceiling on what she will
   * ENGAGE with, not an instruction about what to draw.
   *
   * So the outfit left the character request entirely. It lives on the image
   * request, which is the only one that takes a description of a picture.
   */
  it('puts no outfit and no setting on the character request', () => {
    const text = build().additionalDescription ?? '';
    expect(text).not.toContain('bikini');
    for (const scene of PORTRAIT_SCENES) expect(text).not.toContain(scene);
  });

  it('keeps the ceiling low on the character, which is all it is for', () => {
    expect(build().contentLevel).toBe('Sexy');
  });

  it('dresses every companion in her OPENING PHOTO instead', () => {
    for (const name of ['Maya', 'Honda', 'Zara']) {
      const prompt = openingPhotoPrompt({ name, age: 24, attributes: BASE } as never);
      expect(prompt).toContain(PORTRAIT_OUTFIT);
      expect(PORTRAIT_SCENES.some((scene) => prompt.includes(scene))).toBe(true);
      // The two things worth guaranteeing on a card.
      expect(prompt).toContain('full body');
      expect(prompt).toContain('face clearly visible');
    }
  });

  it('gives the same companion the same setting every time', () => {
    const once = openingPhotoPrompt({ name: 'Maya', attributes: BASE });
    expect(openingPhotoPrompt({ name: 'Maya', attributes: BASE })).toBe(once);
    expect(portraitSceneFor('maya|curvy|blonde|flirty')).toBe(
      portraitSceneFor('maya|curvy|blonde|flirty'),
    );
  });

  it('does not put every companion in the same place', () => {
    const seen = new Set(
      ['Maya', 'Lisa', 'Nora', 'Zara', 'Elena', 'Ivy', 'Sofia', 'Luna', 'Jade', 'Mia'].map(
        (name) => openingPhotoPrompt({ name, attributes: BASE }),
      ),
    );
    expect(seen.size).toBeGreaterThan(1);
  });

  it('stays inside the provider’s 1,000-character limit with everything on', () => {
    expect((build({ hairStyle: 'braids' }).additionalDescription ?? '').length).toBeLessThan(1000);
  });
});
