import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import BannersPage from './BannersPage';
import BannerEditorPage from './BannerEditorPage';
import { activeAdminDestination } from '../../admin/adminNav';
import { activePublishingTab } from '../../admin/PublishingTabs';

/**
 * US-102.3 banner workspace — the states reachable without effects.
 *
 * Static node rendering reaches only the first paint, which is the loading
 * state. Its logic is covered in admin/bannerBoard.test.ts and its behaviour
 * end-to-end in the API suite; what is worth pinning here is that the screens
 * mount, sit inside the existing CMS shell rather than beside it, and say the
 * things this ticket requires them to say.
 */

function renderList() {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={['/admin/publishing/banners']}>
      <BannersPage />
    </MemoryRouter>,
  );
}

function renderEditor(path = '/admin/publishing/banners/new') {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/admin/publishing/banners/:bannerId" element={<BannerEditorPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('one CMS shell, not two', () => {
  it('every banner path keeps Categories & Publishing selected in the admin nav', () => {
    expect(activeAdminDestination('/admin/publishing/banners')).toBe('publishing');
    expect(activeAdminDestination('/admin/publishing/banners/abc')).toBe('publishing');
  });

  it('banner paths select the Banners tab and nothing else does', () => {
    expect(activePublishingTab('/admin/publishing/banners')).toBe('banners');
    expect(activePublishingTab('/admin/publishing/banners/abc')).toBe('banners');
    expect(activePublishingTab('/admin/publishing')).toBe('categories');
    // A category's merchandising screen is still Categories, not Banners.
    expect(activePublishingTab('/admin/publishing/trending')).toBe('categories');
  });
});

describe('banner list — first paint', () => {
  const markup = renderList();

  it('renders a loading state rather than an empty screen', () => {
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain('Loading banners…');
  });

  it('renders the shared publishing tabs', () => {
    expect(markup).toContain('Publishing sections');
    expect(markup).toContain('Categories');
    expect(markup).toContain('Banners');
  });

  it('says Home composition is decided elsewhere', () => {
    // US-102.4 owns carousel-vs-single and placement; this screen must not imply
    // it decides them.
    expect(markup).toContain('How Home arranges them');
  });

  it('invents no banner data of its own', () => {
    for (const invented of ['Autumn', 'Summer sale', 'Trending']) {
      expect(markup).not.toContain(invented);
    }
  });
});

describe('banner editor — first paint', () => {
  const markup = renderEditor();

  it('renders a loading state', () => {
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain('Loading the banner editor…');
  });

  it('names the new banner and offers a way back', () => {
    expect(markup).toContain('New banner');
    expect(markup).toContain('All banners');
    expect(markup).toContain('/admin/publishing/banners');
  });

  it('renders no storage path or internal key', () => {
    expect(markup).not.toContain('storagePath');
    expect(markup).not.toContain('/app/var/media');
  });
});
