import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import CategoryMerchandisingPage from './CategoryMerchandisingPage';
import { activeAdminDestination } from '../../admin/adminNav';

/**
 * US-102.2 merchandising workspace — the states reachable without effects.
 *
 * Static node rendering means only the FIRST paint is reachable: the two
 * loading grids and the filter controls. The loaded grids, selection, drag,
 * bulk add/remove and the preview all need effects and a live API; their logic
 * is covered in admin/merchandising.test.ts and their behaviour end-to-end in
 * the API suite.
 */

function render(slug = 'trending') {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[`/admin/publishing/${slug}`]}>
      <Routes>
        <Route path="/admin/publishing/:categorySlug" element={<CategoryMerchandisingPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('routing', () => {
  it('lives under the publishing prefix, so the nav stays selected', () => {
    expect(activeAdminDestination('/admin/publishing/trending')).toBe('publishing');
  });
});

describe('first paint', () => {
  const markup = render();

  it('renders loading states for both grids rather than empty panes', () => {
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain('Loading approved library…');
    expect(markup).toContain('Loading this category…');
  });

  it('says plainly that only approved content can be added', () => {
    expect(markup).toContain('Only approved content can be added');
    expect(markup).toContain('Items still in Review are not shown');
  });

  it('offers the search and filter controls', () => {
    expect(markup).toContain('Search by character');
    expect(markup).toContain('All characters');
    expect(markup).toContain('Images and video');
    expect(markup).toContain('Any rating');
    expect(markup).toContain('Hide items already in this category');
  });

  it('names both workspaces and the preview', () => {
    expect(markup).toContain('Approved library');
    expect(markup).toContain('In this category');
    expect(markup).toContain('How this category looks in the app');
  });

  it('documents the accessible reordering path', () => {
    expect(markup).toContain('Alt +');
  });

  it('states that featuring is a badge and never reorders', () => {
    // The rule the read ordering now enforces: position is the sole authority.
    expect(markup).toContain('never changes the order');
    expect(markup).toContain('in exactly the order shown above');
    expect(markup).not.toContain('featured first');
    expect(markup).not.toContain('Featured items show first');
  });

  it('offers a way back to the categories list', () => {
    expect(markup).toContain('All categories');
    expect(markup).toContain('/admin/publishing');
  });

  it('never renders a storage key or a filesystem path', () => {
    expect(markup).not.toContain('storageKey');
    expect(markup).not.toContain('/app/var/media');
    expect(markup).not.toContain('/tmp/');
  });

  it('renders no invented content of its own', () => {
    // Everything on this screen comes from the API; nothing is hard-coded.
    for (const invented of ['Trending', 'Girlfriend', 'Cosplay']) {
      expect(markup).not.toContain(invented);
    }
  });
});
