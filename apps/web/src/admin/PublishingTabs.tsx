import { Link, useLocation } from 'react-router-dom';

/**
 * Sub-navigation inside the one CMS workspace (US-102.3).
 *
 * Banners are a tab, not a new top-level destination: `/admin/publishing` is
 * already the App CMS, and `activeAdminDestination` keeps the Categories &
 * Publishing entry selected for everything beneath it. Adding a second shell
 * or a parallel nav would split one product surface in two.
 */

const TABS = [
  { key: 'categories', label: 'Categories', to: '/admin/publishing' },
  { key: 'banners', label: 'Banners', to: '/admin/publishing/banners' },
] as const;

/**
 * Which tab a path belongs to.
 *
 * Anything under /banners is Banners — including the editor at
 * /banners/:id — and everything else under /admin/publishing, including a
 * category's merchandising screen, is Categories.
 */
export function activePublishingTab(pathname: string): 'categories' | 'banners' {
  return pathname.startsWith('/admin/publishing/banners') ? 'banners' : 'categories';
}

export default function PublishingTabs() {
  const { pathname } = useLocation();
  const active = activePublishingTab(pathname);

  return (
    <nav aria-label="Publishing sections" className="mb-5 border-b border-neutral-800">
      <ul className="flex gap-1">
        {TABS.map((tab) => {
          const isActive = tab.key === active;
          return (
            <li key={tab.key}>
              <Link
                to={tab.to}
                aria-current={isActive ? 'page' : undefined}
                className={`inline-block px-3 py-2 text-sm transition ${
                  isActive
                    ? 'border-b-2 border-neutral-100 font-medium text-neutral-100'
                    : 'border-b-2 border-transparent text-neutral-400 hover:text-neutral-200'
                }`}
              >
                {tab.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
