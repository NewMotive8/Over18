import { Navigate, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useAuth } from './AuthContext';

/**
 * Route guard: renders children only for authenticated users.
 * Unauthenticated visitors are redirected to /login, remembering where they
 * came from so login can send them back.
 */
export default function RequireAuth({ children }: { children: ReactNode }) {
  const { status } = useAuth();
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

  return <>{children}</>;
}
