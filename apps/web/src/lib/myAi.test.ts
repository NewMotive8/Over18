import { describe, it, expect } from 'vitest';
import {
  MY_AI_CHOICES,
  MY_AI_ETHNICITIES,
  MY_AI_INTERESTS,
  MY_AI_MAX_INTERESTS,
  MY_AI_MIN_AGE,
  MY_AI_PHOTO_FIELDS,
  myAiDraftProblems,
  myAiEthnicityTileUrl,
  myAiTileUrl,
  type MyAiDraft,
  type MyAiEthnicity,
} from '@over18/shared';

const COMPLETE: MyAiDraft = {
  ethnicity: 'latina',
  hairColour: 'blonde',
  hairStyle: 'wavy',
  eyeColour: 'green',
  figure: 'curvy',
  breasts: 'large',
  butt: 'medium',
  personality: 'flirty',
  relationship: 'girlfriend',
  age: 24,
  name: 'Lisa',
  voice: 'Serena',
  job: 'nurse',
  interests: ['yoga', 'travel'],
};

/**
 * THE ETHNICITY RULE.
 *
 * "The selections throughout the creation flow correspond to the ethnicity
 * selection" is the product requirement this whole asset layout exists for, so
 * it is asserted directly rather than left to the component that happens to
 * call these functions today.
 */
describe('tiles follow the chosen ethnicity', () => {
  it('resolves every attribute tile inside the chosen ethnicity', () => {
    for (const ethnicity of MY_AI_ETHNICITIES) {
      for (const field of MY_AI_PHOTO_FIELDS) {
        for (const option of MY_AI_CHOICES[field]) {
          const url = myAiTileUrl(field, option.id, ethnicity.id);
          expect(url).toContain(`/create/realistic/${ethnicity.id}/`);
        }
      }
    }
  });

  it('changes every tile when the ethnicity changes, and nothing else', () => {
    const before = MY_AI_PHOTO_FIELDS.flatMap((field) =>
      MY_AI_CHOICES[field].map((o) => myAiTileUrl(field, o.id, 'white')),
    );
    const after = MY_AI_PHOTO_FIELDS.flatMap((field) =>
      MY_AI_CHOICES[field].map((o) => myAiTileUrl(field, o.id, 'asian')),
    );

    expect(before).toHaveLength(after.length);
    // Not one tile survives the switch — there is no shared/default set.
    expect(before.some((url) => after.includes(url))).toBe(false);
    // The option a user already picked is untouched by the switch: a choice is
    // a value, the photograph is only a view of it.
    expect(after[0].endsWith('hairColour-blonde.jpg')).toBe(true);
  });

  it('offers an identical option set whichever ethnicity is chosen', () => {
    // No ethnicity may be a narrower flow than another.
    for (const field of MY_AI_PHOTO_FIELDS) {
      const ids = MY_AI_CHOICES[field].map((o) => o.id);
      for (const ethnicity of MY_AI_ETHNICITIES) {
        const urls = ids.map((id) => myAiTileUrl(field, id, ethnicity.id));
        expect(new Set(urls).size).toBe(ids.length);
      }
    }
  });

  it('gives each ethnicity its own step-2 tile', () => {
    const urls = MY_AI_ETHNICITIES.map((e) => myAiEthnicityTileUrl(e.id));
    expect(new Set(urls).size).toBe(MY_AI_ETHNICITIES.length);
  });
});

describe('option lists', () => {
  it('has unique ids within every group', () => {
    for (const [field, options] of Object.entries(MY_AI_CHOICES)) {
      const ids = options.map((o) => o.id);
      expect(new Set(ids).size, `${field} has a duplicate id`).toBe(ids.length);
    }
    const interestIds = MY_AI_INTERESTS.map((o) => o.id);
    expect(new Set(interestIds).size).toBe(interestIds.length);
  });
});

describe('draft validation', () => {
  it('accepts a complete draft', () => {
    expect(myAiDraftProblems(COMPLETE)).toEqual([]);
  });

  it('reports every missing field on an empty draft', () => {
    // 11 single-choice fields + name + age + interests.
    expect(myAiDraftProblems({})).toHaveLength(Object.keys(MY_AI_CHOICES).length + 3);
  });

  it('refuses an id that is not on the list', () => {
    expect(myAiDraftProblems({ ...COMPLETE, breasts: 'enormous' })).toEqual(['breasts']);
    expect(myAiDraftProblems({ ...COMPLETE, ethnicity: 'martian' })).toEqual(['ethnicity']);
  });

  /*
   * The provider refuses under 21 server-side, so the wizard must refuse it
   * too — otherwise the flow fails at the last step for a reason the user was
   * never shown.
   */
  it('holds the 21 floor', () => {
    expect(myAiDraftProblems({ ...COMPLETE, age: MY_AI_MIN_AGE - 1 })).toEqual(['age']);
    expect(myAiDraftProblems({ ...COMPLETE, age: MY_AI_MIN_AGE })).toEqual([]);
    expect(myAiDraftProblems({ ...COMPLETE, age: 24.5 })).toEqual(['age']);
  });

  it('caps and de-duplicates interests, and allows none', () => {
    const tooMany = MY_AI_INTERESTS.slice(0, MY_AI_MAX_INTERESTS + 1).map((o) => o.id);
    expect(myAiDraftProblems({ ...COMPLETE, interests: tooMany })).toEqual(['interests']);
    expect(myAiDraftProblems({ ...COMPLETE, interests: ['yoga', 'yoga'] })).toEqual(['interests']);
    expect(myAiDraftProblems({ ...COMPLETE, interests: ['nothing-like-this'] })).toEqual([
      'interests',
    ]);
    expect(myAiDraftProblems({ ...COMPLETE, interests: [] })).toEqual([]);
  });

  it('requires a name with something in it', () => {
    expect(myAiDraftProblems({ ...COMPLETE, name: '   ' })).toEqual(['name']);
    expect(myAiDraftProblems({ ...COMPLETE, name: 'x'.repeat(200) })).toEqual(['name']);
  });
});

describe('asset addressing', () => {
  it('maps eye colour to the eyes- file stem', () => {
    // The draft field and the filename differ here and only here; a rename on
    // either side without the other silently 404s 25 tiles.
    expect(myAiTileUrl('eyeColour', 'blue', 'white' as MyAiEthnicity)).toBe(
      '/create/realistic/white/eyes-blue.jpg',
    );
  });
});
