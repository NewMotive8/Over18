import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { CharacterPersona, PublicCharacter } from '@over18/shared';
import { buildCharacterSystemPrompt, conversationStage } from '../services/prompt-builder.js';
import type { ReplyContext } from '../services/character-reply.js';

/**
 * STAGING VALIDATION (Task 3B, step 8) — Nova's REAL generated persona,
 * through the REAL compiler and prompt-builder.
 *
 * The unit tests beside this one prove the compiler's rules with fixtures.
 * This proves the thing those cannot: that the persona a live vision model
 * actually produced for a real character compiles into the two sections it
 * is allowed to touch, and nowhere else.
 *
 * The persona JSON was pulled from the Staging admin API and is committed
 * alongside as a fixture so this is reproducible without network access.
 */

const persona = JSON.parse(
  readFileSync(new URL('./fixtures/nova-persona.json', import.meta.url), 'utf8'),
) as CharacterPersona;

const NOVA_BIO =
  "I'm Nova, an eccentric ex-planetarium curator turned deep-space astrophotographer who spends months in remote observatories chasing cosmic phenomena.";
const NOVA_PERSONALITY =
  'Enthusiastic yet quietly intense, with a dry cosmic wit. She sees patterns and poetry in chaos, often coming across as otherworldly herself, like she\'s half in this world and half somewhere beyond the event horizon.';

const character = (over: Partial<PublicCharacter> = {}): PublicCharacter => ({
  id: '113648a6-817e-46c7-bd7c-3fdaa6a80be0',
  name: 'nova',
  displayName: 'Nova',
  profileImage: null,
  shortBio: NOVA_BIO,
  personality: NOVA_PERSONALITY,
  interests: ['astrophotography', 'pulsars', 'abandoned observatories'],
  conversationStyle: 'warm and curious',
  ...over,
});

const context = (over: Partial<ReplyContext> = {}): ReplyContext =>
  ({ character: character(), history: [], priorMessageCount: 0, ...over }) as ReplyContext;

const section = (prompt: string, heading: string): string => {
  const start = prompt.indexOf(heading);
  if (start === -1) return '';
  const rest = prompt.slice(start + heading.length);
  const next = rest.search(/\n[A-Z][A-Z ]{3,}\n/);
  return next === -1 ? rest : rest.slice(0, next);
};

describe("Nova's real generated persona reaches the prompt", () => {
  const withPersona = buildCharacterSystemPrompt(context({ persona }));
  const withoutPersona = buildCharacterSystemPrompt(context({ persona: null }));

  it('renders persona facts into WHO SHE IS', () => {
    const who = section(withPersona, 'WHO SHE IS');
    expect(who).toContain(persona.occupation!);
    expect(who.length).toBeGreaterThan(section(withoutPersona, 'WHO SHE IS').length);
  });

  it('keeps her own bio and personality ahead of the persona facts', () => {
    const who = section(withPersona, 'WHO SHE IS');
    expect(who).toContain(NOVA_BIO);
    expect(who.indexOf(NOVA_BIO)).toBeLessThan(who.indexOf(persona.occupation!));
  });

  it('renders a HER VOICE clause from the persona', () => {
    expect(withPersona).toContain('HER VOICE');
    expect(section(withPersona, 'HER VOICE').trim().length).toBeGreaterThan(0);
  });

  /** The persona must never become an instruction the model can follow. */
  it('puts no persona field into HOW SHE TALKS', () => {
    const how = section(withPersona, 'HOW SHE TALKS');
    for (const value of [persona.occupation, persona.flirtingStyle, persona.humorStyle]) {
      if (value) expect(how).not.toContain(value);
    }
  });

  it('never renders sourceSummary anywhere — it is admin-review only', () => {
    expect(persona.sourceSummary, 'the fixture must actually have one to prove this').toBeTruthy();
    expect(withPersona).not.toContain(persona.sourceSummary!);
  });

  /**
   * Nova has no VOICE_DIALS entry, so without a persona she has no HER VOICE
   * section at all. Gaining exactly that one section is the documented
   * behaviour of this feature -- and it must be the ONLY heading gained.
   */
  it('adds HER VOICE and no other section', () => {
    const headings = (text: string) =>
      (text.match(/\n[A-Z][A-Z ]{3,}\n/g) ?? []).map((h) => h.trim()).sort();
    const gained = headings(withPersona).filter((h) => !headings(withoutPersona).includes(h));
    const lost = headings(withoutPersona).filter((h) => !headings(withPersona).includes(h));
    expect(gained).toEqual(['HER VOICE']);
    expect(lost).toEqual([]);
  });

  it('leaves HOW SHE TALKS byte-identical with and without the persona', () => {
    expect(section(withPersona, 'HOW SHE TALKS')).toBe(section(withoutPersona, 'HOW SHE TALKS'));
  });

  it('keeps the relationship-stage rule working alongside a real persona', () => {
    expect(conversationStage(0)).toBe('new');
    expect(conversationStage(10)).toBe('early');
    expect(conversationStage(40)).toBe('established');
    const newTalk = section(buildCharacterSystemPrompt(context({ persona, priorMessageCount: 0 })), 'HOW SHE TALKS');
    const oldTalk = section(buildCharacterSystemPrompt(context({ persona, priorMessageCount: 40 })), 'HOW SHE TALKS');
    expect(newTalk).not.toBe(oldTalk);
    expect(newTalk).toContain('only just started talking');
  });
});
