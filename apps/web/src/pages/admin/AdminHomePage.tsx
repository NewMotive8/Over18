import { Link } from 'react-router-dom';
import { ADMIN_DESTINATIONS } from '../../admin/adminNav';

/**
 * Admin entry point (US-99).
 *
 * Deliberately NOT a dashboard: no counts, no charts, no analytics. It is a
 * directory of the content-operations areas, because US-99 delivers the shell
 * and any number shown here today would be invented.
 */
export default function AdminHomePage() {
  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-xl font-semibold text-white">Content operations</h1>
      <p className="mt-1 text-sm text-zinc-400">
        Review, manage and publish character content.
      </p>

      <ul className="mt-8 grid gap-3 sm:grid-cols-2">
        {ADMIN_DESTINATIONS.map((dest) => (
          <li key={dest.key}>
            <Link
              to={dest.path}
              className="block h-full rounded-lg border border-zinc-800 bg-zinc-900/40 px-5 py-4 transition-colors hover:border-zinc-700 hover:bg-zinc-900"
            >
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-zinc-100">{dest.label}</span>
                {dest.status === 'not-implemented' && (
                  <span className="rounded border border-zinc-700 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-zinc-500">
                    Soon
                  </span>
                )}
              </div>
              <p className="mt-1 text-xs text-zinc-500">{dest.description}</p>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
