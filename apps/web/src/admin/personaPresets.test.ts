import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CONVERSATION_STYLES,
  CUSTOM_STYLE,
  canPublish,
  defaultSystemPrompt,
  missingInDraft,
  missingToPublish,
  publishNextStep,
  publishPatch,
  styleKeyOf,
  styleLabelOf,
  styleTextOf,
  systemPromptToSave,
} from './personaPresets';

const page = readFileSync(new URL('../pages/admin/AdminCharacterDetailPage.tsx', import.meta.url), 'utf8');

describe('how she talks -- a choice, stored as the same conversation style text', () => {
  it('every option has a name and a sentence, and none repeats', () => {
    expect(CONVERSATION_STYLES.length).toBeGreaterThanOrEqual(5);
    for (const preset of CONVERSATION_STYLES) {
      expect(preset.label.length).toBeGreaterThan(3);
      expect(preset.text).toMatch(/\.$/);
    }
    expect(new Set(CONVERSATION_STYLES.map((p) => p.key)).size).toBe(CONVERSATION_STYLES.length);
    expect(new Set(CONVERSATION_STYLES.map((p) => p.text)).size).toBe(CONVERSATION_STYLES.length);
  });

  it('round-trips: choosing an option stores its sentence, and that sentence reads back as the option', () => {
    for (const preset of CONVERSATION_STYLES) {
      expect(styleTextOf(preset.key)).toBe(preset.text);
      expect(styleKeyOf(preset.text)).toBe(preset.key);
      expect(styleKeyOf(`  ${preset.text} `)).toBe(preset.key);
      expect(styleLabelOf(preset.text)).toBe(preset.label);
    }
  });

  it("keeps a character's own wording: it reads as custom and is never rewritten", () => {
    const own = 'Speaks in a low, deliberate cadence.';
    expect(styleKeyOf(own)).toBe(CUSTOM_STYLE);
    expect(styleLabelOf(own)).toBe(own);
    expect(styleTextOf(CUSTOM_STYLE)).toBeNull();
    expect([styleKeyOf(''), styleKeyOf('   '), styleLabelOf('')]).toEqual(['', '', '']);
  });
});

describe('the system prompt is filled in for the operator', () => {
  it('an empty one is saved as a standard line; a written one is left alone', () => {
    expect(defaultSystemPrompt(' Rosie ')).toBe('You are Rosie.');
    expect(systemPromptToSave('', 'Rosie')).toBe('You are Rosie.');
    expect(systemPromptToSave('   ', 'Rosie')).toBe('You are Rosie.');
    expect(systemPromptToSave('You are Rosie, an optometrist.', 'Rosie')).toBe('You are Rosie, an optometrist.');
  });
});

describe('what stops her being published, by the name on screen', () => {
  const rosie = { displayName: 'Rosie', missingProfileFields: ['conversationStyle', 'systemPrompt'] };

  it('names what the operator must add, and never the system prompt', () => {
    expect(missingToPublish(rosie.missingProfileFields)).toEqual(['How she talks']);
    expect(missingToPublish(['shortBio', 'personality', 'conversationStyle', 'systemPrompt'])).toEqual(['Short bio', 'Personality', 'How she talks']);
    expect(publishNextStep(rosie)).toBe('To publish, add: How she talks.');
    expect(canPublish(rosie)).toBe(false);
  });

  it('an empty system prompt alone does not block: publishing sends the standard line with it', () => {
    const almost = { displayName: 'Rosie', missingProfileFields: ['systemPrompt'] };
    expect(canPublish(almost)).toBe(true);
    expect(publishNextStep(almost)).toBe('Ready — press Publish to make her public.');
    expect(publishPatch(almost)).toEqual({ status: 'active', systemPrompt: 'You are Rosie.' });
    expect(publishPatch({ displayName: 'Rosie', missingProfileFields: [] })).toEqual({ status: 'active' });
  });

  it('the editor says what is still needed before it will save', () => {
    const draft = { displayName: 'Rosie', shortBio: 'An optometrist.', personality: 'Composed.', conversationStyle: '' };
    expect(missingInDraft(draft)).toEqual(['How she talks']);
    expect(missingInDraft({ ...draft, conversationStyle: 'Warm.' })).toEqual([]);
  });
});

describe('the character page uses them', () => {
  it('offers the options as a dropdown, with writing her own as the last choice', () => {
    expect(page).toContain('data-testid="conversation-style-select"');
    expect(page).toContain('CONVERSATION_STYLES.map((preset) =>');
    expect(page).toContain('<option value={CUSTOM_STYLE}>Write my own…</option>');
  });

  it('keeps the system prompt out of the way, under Advanced, and fills it on save', () => {
    expect(page).toMatch(/<details[^>]*>\s*<summary[^>]*>Advanced<\/summary>[\s\S]*System prompt/);
    expect(page).toContain('systemPrompt: systemPromptToSave(personaDraft.systemPrompt, personaDraft.displayName)');
  });

  it('names what is missing beside Publish, instead of "Write her profile first"', () => {
    expect(page).toContain("Missing: {missingToPublish(character.missingProfileFields).join(', ')}");
    expect(page).not.toContain('Write her profile first');
    expect(page).not.toContain('Her profile is not written yet');
    expect(page).toContain("disabled={busy || (character.status !== 'active' && !canPublish(character))}");
    expect(page).toContain('publishPatch(character)');
  });
});
