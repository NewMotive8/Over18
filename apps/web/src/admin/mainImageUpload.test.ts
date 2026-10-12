import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * HER MAIN IMAGE CAN ALWAYS BE SUPPLIED.
 *
 * A character saved without a photo gets no visual identity version — that is
 * deliberate, and quick-create says so. But the Primary references control was
 * rendered only `{activeIdentity && …}`, and the only upload route was scoped
 * to an identity id. So for exactly the character who needed it, there was no
 * button, no route to call, and an empty state telling her operator to
 * "activate a visual identity version first" when she had none to activate.
 *
 * Reaching it meant finding "Create v1" in a different section, filling in a
 * required field, and then noticing that a new version is a DRAFT and has to
 * be activated separately before the button comes back.
 *
 * These read the source rather than render the page: the defect was which
 * JSX existed at all, which is what they pin.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const page = read('../pages/admin/AdminCharacterDetailPage.tsx');
const api = read('../lib/api.ts');

/** Just the Primary references section, so nothing elsewhere can satisfy these. */
const section = page.slice(
  page.indexOf('Primary references (persona source)'),
  page.indexOf('---------------- Persona ----------------'),
);

describe('the Primary references control', () => {
  it('is present whether or not she has a visual identity', () => {
    expect(section.length).toBeGreaterThan(0);
    expect(section).toContain('Add reference');
    // The gate that hid it is gone.
    expect(section).not.toContain('{activeIdentity && (');
  });

  it('uploads against the CHARACTER, so there is no identity id to need', () => {
    expect(section).toContain('adminCharactersApi.uploadCharacterReference(characterId, file)');
    expect(section).not.toContain('uploadReference(activeIdentity.id');
  });

  /**
   * The old copy named a step that could not be taken. Whatever it says now,
   * it must not send the operator looking for an Activate button.
   */
  it('no longer tells her operator to activate something that does not exist', () => {
    expect(section).not.toMatch(/Activate a visual identity version first/i);
    expect(section).toMatch(/first visual identity version/i);
  });
});

describe('the character-scoped upload in the API client', () => {
  it('posts to the character, not to an identity version', () => {
    expect(api).toContain('uploadCharacterReference:');
    expect(api).toContain('/admin/characters/${encodeURIComponent(characterId)}/references');
  });

  /**
   * The identity-scoped upload is NOT removed: it is still the right call when
   * a caller genuinely means one specific version, and the server route it
   * uses is unchanged. Only the admin page stopped depending on it.
   */
  it('keeps the identity-scoped upload available for callers that mean one version', () => {
    expect(api).toContain('uploadReference: (identityId: string, file: File)');
  });
});
