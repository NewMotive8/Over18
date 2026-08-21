import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import AppCategoriesPage from './AppCategoriesPage';
import { ADMIN_DESTINATIONS, activeAdminDestination } from '../../admin/adminNav';

/**
 * US-102.1 workspace — the states reachable without effects.
 *
 * The repo's web tests render statically in node, so effects never run and the
 * only reachable render is the INITIAL one: the loading state. That is worth
 * pinning anyway, because "no loading state" is a real defect the US-102 brief
 * calls out by name, and because a workspace that throws on first paint would
 * fail here.
 *
 * The loaded list, the create form, the drag interaction and the delete
 * confirmation all need effects and a live API. Their LOGIC is covered in
 * admin/categoryBoard.test.ts and their BEHAVIOUR end-to-end in the API suite.
 */

function render() {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={['/admin/publishing']}>
      <AppCategoriesPage />
    </MemoryRouter>,
  );
}

describe('Categories & Publishing is no longer a placeholder', () => {
  it('the admin navigation lists it as available at /admin/publishing', () => {
    const publishing = ADMIN_DESTINATIONS.find((d) => d.key === 'publishing')!;
    expect(publishing.status).toBe('available');
    expect(publishing.path).toBe('/admin/publishing');
  });

  it('routes the whole US-102 publishing family under one prefix', () => {
    expect(activeAdminDestination('/admin/publishing')).toBe('publishing');
    // Siblings from US-102.2/.3/.4 will land beneath it and stay selected.
    expect(activeAdminDestination('/admin/publishing/banners')).toBe('publishing');
  });
});

describe('first paint', () => {
  const markup = render();

  it('renders a loading state rather than an empty screen', () => {
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain('Loading app categories…');
  });

  it('names the workspace and says what these categories are', () => {
    expect(markup).toContain('App categories');
    expect(markup).toContain('Categories &amp; Publishing');
    // The distinction that must never blur.
    expect(markup).toContain('separate from the content requirements');
  });

  it('does not invent a Draft or Published badge for a decision that does not exist', () => {
    // Publishing states arrive with US-102.4; claiming them now would be a lie.
    expect(markup).not.toContain('Published');
    expect(markup).not.toContain('Draft');
  });

  it('renders no category data of its own', () => {
    // Nothing is hard-coded: an empty database means an empty workspace.
    for (const invented of ['Trending', 'Girlfriend', 'Cosplay', 'Fantasy']) {
      expect(markup).not.toContain(invented);
    }
  });
});
