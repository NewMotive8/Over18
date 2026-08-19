import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import AdminCharactersPage, { profileNoteOf, readinessOf, slugify } from './AdminCharactersPage';
import { ADMIN_DESTINATIONS } from '../../admin/adminNav';
import type { AdminCharacterListItem } from '../../lib/api';

/**
 * US-101 admin UI states. The repo's node static-rendering setup renders the
 * INITIAL state only (effects never run), so these cover the states reachable
 * without a fetch — the loading state, the readiness wording, and the
 * navigation status — plus the pure readiness function that drives every row.
 *
 * What they cannot do: exercise the loaded list, the create form submit, or
 * activation, all of which need effects and a live API. Those paths are
 * covered end-to-end by the API suite instead.
 */

const base: AdminCharacterListItem = {
  id: 'c1',
  name: 'nova',
  displayName: 'Nova',
  profileImage: null,
  shortBio: 'bio',
  personality: 'p',
  interests: [],
  conversationStyle: 's',
  systemPrompt: 'sp',
  status: 'active',
  createdAt: '2026-08-19T00:00:00.000Z',
  updatedAt: '2026-08-19T00:00:00.000Z',
  profileComplete: true,
  missingProfileFields: [],
  activeIdentityVersion: null,
  identityVersionCount: 0,
  primaryReferenceCount: 0,
};

describe('Characters is no longer a placeholder', () => {
  it('the admin navigation lists Characters as available', () => {
    const characters = ADMIN_DESTINATIONS.find((d) => d.key === 'characters')!;
    expect(characters.status).toBe('available');
    expect(characters.path).toBe('/admin/characters');
  });

  it('asks only for a name and a photo, not the whole persona', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <AdminCharactersPage />
      </MemoryRouter>,
    );
    // The create form is collapsed initially, so what matters here is that the
    // long-form fields are gone from the module's rendered output entirely.
    expect(html).not.toContain('System prompt');
    expect(html).not.toContain('Conversation style');
  });

  it('renders the catalogue, not a "not built yet" placeholder', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <AdminCharactersPage />
      </MemoryRouter>,
    );
    expect(html).not.toContain('Not built yet');
    expect(html).toContain('Characters');
    expect(html).toContain('Create character');
  });

  it('shows a loading state before the list arrives', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <AdminCharactersPage />
      </MemoryRouter>,
    );
    expect(html).toContain('Loading');
  });

  it('explains what the screen is for, in plain words', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <AdminCharactersPage />
      </MemoryRouter>,
    );
    expect(html).toContain('visual identity');
    expect(html).toContain('primary references');
  });
});

describe('slug derivation', () => {
  it('turns what an operator types into a valid slug, so they never meet the rule', () => {
    expect(slugify('Nova')).toBe('nova');
    expect(slugify('  Luna Rae  ')).toBe('luna-rae');
    expect(slugify("Zoë's Alt #2")).toBe('zo-s-alt-2');
    expect(slugify('!!!')).toBe('');
    expect(slugify('a'.repeat(80)).length).toBe(50);
  });
});

describe('readiness wording', () => {
  it('states the blocker rather than implying it with a colour', () => {
    expect(readinessOf(base)).toBe('No visual identity yet');
    expect(readinessOf({ ...base, identityVersionCount: 2 })).toBe(
      'Identity drafted, none active',
    );
    expect(
      readinessOf({ ...base, identityVersionCount: 2, activeIdentityVersion: 2 }),
    ).toBe('v2 active · no primary references');
  });

  it('reports a ready character with its version and reference count', () => {
    expect(
      readinessOf({
        ...base,
        identityVersionCount: 2,
        activeIdentityVersion: 2,
        primaryReferenceCount: 3,
      }),
    ).toBe('v2 active · 3 primary references');
  });

  it('names the profile gap separately from the visual one', () => {
    // Two different blockers with two different fixes — never merged into one
    // vague "not ready".
    expect(profileNoteOf(base)).toBeNull();
    expect(
      profileNoteOf({ ...base, profileComplete: false, missingProfileFields: ['shortBio'] }),
    ).toBe('Profile incomplete — 1 field to fill');
    expect(
      profileNoteOf({
        ...base,
        profileComplete: false,
        missingProfileFields: ['shortBio', 'personality', 'systemPrompt'],
      }),
    ).toBe('Profile incomplete — 3 fields to fill');
  });

  it('singularises one reference', () => {
    expect(
      readinessOf({
        ...base,
        identityVersionCount: 1,
        activeIdentityVersion: 1,
        primaryReferenceCount: 1,
      }),
    ).toBe('v1 active · 1 primary reference');
  });
});
