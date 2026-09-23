import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * THE PERSONA INTEGRATION MERGE, PINNED.
 *
 * `AdminCharacterDetailPage.tsx` is the one file where the avatar-derived
 * persona work (ported from the chatbotP2 fork) and OVER18's own newer work
 * genuinely collided: the fork added a 436-line persona section while OVER18
 * had, on the same page, removed the Publishability card, added Clip access
 * and added identity lineage to the load chain.
 *
 * Both sides were kept by hand. A hand-resolved conflict is exactly the kind
 * of thing that silently drops one side months later, and nothing else in the
 * suite renders this page -- it is a large data-fetching component and this
 * repo's idiom for those is to assert against the SOURCE (see
 * `mediaTiles.test.tsx`, which does the same for the Review queue).
 *
 * So these are deliberately structural. They do not test behaviour; they
 * test that four features still coexist in one file, and that the two halves
 * of the load chain that were literally in conflict are both still there.
 */

const source = readFileSync(
  fileURLToPath(new URL('./AdminCharacterDetailPage.tsx', import.meta.url)),
  'utf8',
);

describe("OVER18's own sections survived the persona port", () => {
  it('still renders the readiness panel', () => {
    expect(source).toContain("import CharacterEligibilityPanel from '../../admin/CharacterEligibilityPanel'");
    expect(source).toContain('<CharacterEligibilityPanel readiness={detail.readiness} />');
  });

  it('still renders Clip access (P4.D2)', () => {
    expect(source).toContain("import CharacterAccessSection from './CharacterAccessPanel'");
    expect(source).toContain('<CharacterAccessSection characterId={characterId} />');
  });

  it('still keeps the original Persona editor', () => {
    expect(source).toContain('>Persona<');
  });

  /**
   * One half of the merge conflict. The fork's version of this `.then` did
   * not carry it, so taking the fork's side wholesale would have silently
   * stopped the identity lineage loading.
   */
  it('still loads identity lineage in the content chain', () => {
    expect(source).toContain('setLineage(res.identityLineage)');
  });
});

describe('the ported persona feature is present', () => {
  it('has its own section, named so it cannot be confused with Persona', () => {
    expect(source).toContain('Life details from her photo');
    // The fork renamed this after an operator mis-clicked the two "persona"
    // sections twice in one sitting. Never name it "Persona" again.
    expect(source).not.toContain('Avatar-derived persona');
  });

  /** The other half of the same conflict. */
  it('loads the persona alongside the content, not instead of it', () => {
    expect(source).toContain('adminCharactersApi.getPersona(characterId)');
    expect(source).toContain('setAvatarPersona(persona)');
  });

  it('imports the persona view type as well as OVER18s own types', () => {
    for (const type of ['type CharacterPersonaView', 'type IdentityLineage', 'type AssetAction']) {
      expect({ type, found: source.includes(type) }, type).toEqual({ type, found: true });
    }
  });
});

describe('the page holds all four features at once', () => {
  it('has exactly one of each section, in one file', () => {
    for (const marker of ['<CharacterEligibilityPanel', '<CharacterAccessSection']) {
      expect(source.split(marker).length - 1, marker).toBe(1);
    }
    // The persona section's name appears twice on purpose -- once labelling
    // the JSX block in a comment, once as the heading itself -- so this pins
    // the HEADING rather than the raw string.
    const headings = source.match(/^\s*Life details from her photo\s*$/gm) ?? [];
    expect(headings).toHaveLength(1);
  });

  it('left no conflict markers behind', () => {
    for (const marker of ['<<<<<<<', '>>>>>>>', '\n=======\n']) {
      expect({ marker, found: source.includes(marker) }, marker).toEqual({ marker, found: false });
    }
  });
});
