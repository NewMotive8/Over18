import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import type { AuthCredentials, AuthUser } from '@over18/shared';
import { ApiRequestError, authApi } from '../lib/api';

type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated';

interface AuthContextValue {
  user: AuthUser | null;
  status: AuthStatus;
  login: (credentials: AuthCredentials) => Promise<void>;
  register: (credentials: AuthCredentials) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/**
 * Authentication state for the whole app.
 * State is derived from GET /api/auth/me on load — the HttpOnly cookie is the
 * single source of truth; nothing auth-related is kept in localStorage.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [status, setStatus] = useState<AuthStatus>('loading');

  useEffect(() => {
    let cancelled = false;
    authApi
      .me()
      .then((me) => {
        if (!cancelled) {
          setUser(me);
          setStatus('authenticated');
        }
      })
      .catch(() => {
        if (!cancelled) {
          setUser(null);
          setStatus('unauthenticated');
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async (credentials: AuthCredentials) => {
    const me = await authApi.login(credentials);
    setUser(me);
    setStatus('authenticated');
  }, []);

  const register = useCallback(async (credentials: AuthCredentials) => {
    const me = await authApi.register(credentials);
    setUser(me);
    setStatus('authenticated');
  }, []);

  const logout = useCallback(async () => {
    try {
      await authApi.logout();
    } catch (err) {
      // Even if the network call fails, drop local state; the cookie/session
      // remains server-side but the UI should not pretend to be logged in.
      if (!(err instanceof ApiRequestError)) console.error('Logout failed');
    }
    setUser(null);
    setStatus('unauthenticated');
  }, []);

  return (
    <AuthContext.Provider value={{ user, status, login, register, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
