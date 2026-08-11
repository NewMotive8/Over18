import { Link, useNavigate } from 'react-router-dom';
import PageContainer from '../components/PageContainer';
import PageHeader from '../components/PageHeader';
import { useAuth } from '../auth/AuthContext';
import { ProfileIcon } from '../components/icons';

/**
 * Profile / Account (US-18) — the third primary destination.
 *
 * UI foundation only: a coherent home for future account info, membership,
 * settings, notifications and preferences. Auth that used to live in the shell
 * nav now lives here (sign in / sign out). Everything not yet real is shown as a
 * clearly-marked placeholder row — no billing, no backend, no invented APIs.
 */
function PlaceholderRow({ label, hint }: { label: string; hint: string }) {
  return (
    <div className="flex items-center justify-between rounded-2xl border border-zinc-800 bg-zinc-900/50 px-4 py-3">
      <span className="text-sm text-zinc-200">{label}</span>
      <span className="text-[11px] uppercase tracking-wide text-zinc-500">{hint}</span>
    </div>
  );
}

export default function ProfilePage() {
  const { user, status, logout } = useAuth();
  const navigate = useNavigate();

  async function handleLogout() {
    await logout();
    navigate('/characters', { replace: true });
  }

  return (
    <PageContainer>
      <PageHeader eyebrow="Account" title="Profile" subtitle="Manage your account and preferences." />

      {/* Identity / auth card */}
      <div className="flex items-center gap-4 rounded-3xl border border-zinc-800 bg-gradient-to-b from-zinc-900/70 to-zinc-950 p-4">
        <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl border border-zinc-800 bg-zinc-900 text-rose-400">
          <ProfileIcon className="h-7 w-7" />
        </div>
        <div className="min-w-0 flex-1">
          {status === 'authenticated' && user ? (
            <>
              <p className="truncate text-sm font-semibold text-white" title={user.email}>
                {user.email}
              </p>
              <p className="text-xs text-zinc-400">Signed in</p>
            </>
          ) : status === 'loading' ? (
            <p className="text-sm text-zinc-400">Checking your session…</p>
          ) : (
            <>
              <p className="text-sm font-semibold text-white">You're browsing as a guest</p>
              <Link to="/login" className="text-xs font-medium text-rose-500 hover:underline">
                Sign in or create an account →
              </Link>
            </>
          )}
        </div>
      </div>

      {/* Membership (placeholder — no billing in US-18) */}
      <div className="rounded-3xl border border-zinc-800 bg-zinc-900/50 p-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Membership</h3>
            <p className="mt-1 text-sm text-zinc-200">Free plan</p>
          </div>
          <Link
            to="/subscription"
            className="rounded-xl bg-rose-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-rose-500"
          >
            Go Premium
          </Link>
        </div>
      </div>

      {/* Future account surfaces — clearly marked placeholders */}
      <div className="flex flex-col gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Settings</h3>
        <PlaceholderRow label="Notifications" hint="Coming soon" />
        <PlaceholderRow label="Preferences" hint="Coming soon" />
        <PlaceholderRow label="Privacy & data" hint="Coming soon" />
      </div>

      {status === 'authenticated' && (
        <button
          type="button"
          onClick={handleLogout}
          className="mt-1 w-full rounded-xl border border-zinc-800 py-3 text-sm font-medium text-zinc-300 transition-colors hover:bg-zinc-900 hover:text-white"
        >
          Sign out
        </button>
      )}
    </PageContainer>
  );
}
