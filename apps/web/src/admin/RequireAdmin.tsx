import { Navigate, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useAuth } from '../auth/AuthContext';

/**
 * Admin route guard (US-99).
 *
 * Reuses the EXISTING session auth — no parallel auth system. It layers one
 * authorization check on top of the user the session already resolved.
 *
 * This guard is a usability measure, not the security boundary. The real
 * boundary is server-side (`requireAuth` + `requireAdmin` on the API); hiding
 * a link in the client would protect nothing on its own.
 */
export default function RequireAdmin({ children }: { children: ReactNode }) {
  const { status, user } = useAuth();
  const location = useLocation();

  if (status === 'loading') {
    return (
      <div className="flex justify-center py-16">
        <span className="text-sm text-zinc-400">Checking session…</span>
      </div>
    );
  }

  if (status === 'unauthenticated') {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  if (user?.role !== 'admin') {
    return (
      <div className="mx-auto max-w-md px-6 py-20 text-center">
        <h1 className="text-lg font-semibold text-white">Administrator access required</h1>
        <p className="mt-2 text-sm text-zinc-400">
          Your account is signed in but does not have operator permissions.
        </p>
        <a href="/characters" className="mt-6 inline-block text-sm text-rose-500 hover:text-rose-400">
          Return to the app
        </a>
      </div>
    );
  }

  return <>{children}</>;
}
