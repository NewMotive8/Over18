import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
  MY_AI_CHOICES,
  MY_AI_ETHNICITIES,
  MY_AI_INTERESTS,
  MY_AI_MAX_INTERESTS,
  MY_AI_MAX_AGE,
  MY_AI_MIN_AGE,
  MY_AI_PHOTO_FIELDS,
  myAiDraftProblems,
  myAiEthnicityTileUrl,
  myAiTileUrl,
  type MyAiDraft,
  type MyAiEthnicity,
} from '@over18/shared';
import { API_URL } from './api';
import { absoluteMediaUrl } from './media';

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

describe('her portrait is fetched from the API, not the web host', () => {
  /*
   * THE FIRST FINISHED COMPANION CAME OUT AS A BROKEN-IMAGE ICON.
   *
   * Her picture had downloaded and her row said ready; the card asked the
   * WEB host for `/api/my-ai/:id/image`, which is a static server with no
   * such route, and got HTML back. Every image in this app is addressed
   * through `absoluteMediaUrl` for exactly this reason, and the one new
   * surface that forgot is the one that broke.
   */
  it('the My AI card puts her through absoluteMediaUrl', () => {
    const page = readFileSync(new URL('../pages/MyAiPage.tsx', import.meta.url), 'utf8');
    expect(page).toContain("import { absoluteMediaUrl } from '../lib/media'");
    expect(page).toContain('src={absoluteMediaUrl(companion.imageUrl)}');
    // Never the bare path, which is what resolved against the wrong origin.
    expect(page).not.toContain('src={companion.imageUrl}');
  });

  it('the helper keeps an /api/ path pointed at the API', () => {
    // Guards the assumption above: the route the server hands back starts
    // with /api/, which is the only prefix the helper rewrites.
    expect(absoluteMediaUrl('/api/my-ai/abc/image')).toBe(`${API_URL}/api/my-ai/abc/image`);
  });
});

describe('her age', () => {
  it('runs from 21 to 55', () => {
    expect(MY_AI_MIN_AGE).toBe(21);
    expect(MY_AI_MAX_AGE).toBe(55);
    expect(myAiDraftProblems({ ...COMPLETE, age: MY_AI_MAX_AGE })).toEqual([]);
    expect(myAiDraftProblems({ ...COMPLETE, age: MY_AI_MAX_AGE + 1 })).toEqual(['age']);
  });
});

describe('naming her is a step, not a row on the review', () => {
  /*
   * Name and age were pre-filled tap-to-expand rows on the confirm screen,
   * and the flow read as having no way to name her at all -- reported after
   * using it. A decision the user is meant to make needs a heading.
   */
  it('step 5 asks for both, and will not continue without a name', () => {
    const flow = readFileSync(
      new URL('../components/my-ai/CreateFlow.tsx', import.meta.url),
      'utf8',
    );
    expect(flow).toContain("['name', 'age', 'personality', 'relationship'],");
    expect(flow).toContain('id="my-ai-name"');
    expect(flow).toContain('id="my-ai-age"');
  });

  it('an empty name is a problem the step can see', () => {
    // Which is what makes Continue go dim rather than failing at the end.
    expect(myAiDraftProblems({ ...COMPLETE, name: '' })).toEqual(['name']);
  });
});

describe('deleting a companion', () => {
  /*
   * Permanent, and taking her picture with her — so it is asked ON HER CARD,
   * over her own photograph, rather than in a dialog floating above a two-up
   * grid where "which one did I just tap?" is a question with a permanent
   * answer.
   */
  it('asks first, on the card, and says what is lost', () => {
    const page = readFileSync(new URL('../pages/MyAiPage.tsx', import.meta.url), 'utf8');
    expect(page).toContain('aria-label={`Delete ${companion.name}`}');
    expect(page).toContain('onClick={() => setConfirming(true)}');
    expect(page).toContain('Delete {companion.name}?');
    expect(page).toContain('Her picture goes too. This cannot be undone.');
    expect(page).toContain('Keep her');
  });

  it('has a client call for it', () => {
    const api = readFileSync(new URL('./api.ts', import.meta.url), 'utf8');
    expect(api).toContain('remove(id: string): Promise<void>');
  });
});

describe('the review step shows its choices instead of hiding them', () => {
  /*
   * Voice, job and interests were collapsed rows: a pre-filled value and a
   * chevron. Reported twice over, in two different forms -- "there is no way
   * to name her", then "I cannot see that I can edit these". A chevron says
   * something is hidden; it does not invite anyone to look.
   */
  const flow = () =>
    readFileSync(new URL('../components/my-ai/CreateFlow.tsx', import.meta.url), 'utf8');

  it('lays voice, job and interests out in the open', () => {
    const source = flow();
    expect(source).toContain('<VoicePicker value={draft.voice}');
    expect(source).toContain('<OptionChips label="Job"');
    expect(source).toContain('label="Interests"');
    // None of the three is behind a fold any more.
    expect(source).not.toContain("term=\"Voice\"");
    expect(source).not.toContain("term=\"Job\"");
    expect(source).not.toContain("term=\"Interests\"");
  });

  it('plays the sample from the API, by the name the wizard shows', () => {
    const picker = readFileSync(
      new URL('../components/my-ai/VoicePicker.tsx', import.meta.url),
      'utf8',
    );
    // The API host, not the web host -- same trap as her portrait.
    expect(picker).toContain('`${API_URL}/api/voice-samples/${encodeURIComponent(voice)}`');
    // Choosing and hearing are one tap: a separate play button makes hearing
    // the voice an optional extra step, and optional extra steps go untaken.
    expect(picker).toContain('onClick={() => pick(voice.id)}');
    expect(picker).toContain('onChange(voice);');
    // A voice with no sample stays selectable.
    expect(picker).toContain('setSilent((prev) => new Set(prev).add(voice));');
  });
});
