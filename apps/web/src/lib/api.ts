import type { ApiError, AuthCredentials, AuthUser, HealthResponse } from '@over18/shared';

/**
 * Single entry point for talking to the Over18 REST API.
 * The frontend never accesses the database directly — everything goes through
 * this client. All requests are credentialed so the HttpOnly session cookie
 * flows automatically; no tokens are ever stored in localStorage.
 */
export const API_URL: string = import.meta.env.VITE_API_URL ?? 'http://localhost:3001';

/** Error carrying the API's error envelope plus HTTP status. */
export class ApiRequestError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    credentials: 'include',
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
    ...init,
  });
  if (!res.ok) {
    let code = 'request_failed';
    let message = `Request failed (${res.status}).`;
    try {
      const body = (await res.json()) as Partial<ApiError>;
      if (body.error) code = body.error;
      if (body.message) message = body.message;
    } catch {
      // Non-JSON error body — keep the generic message.
    }
    throw new ApiRequestError(res.status, code, message);
  }
  return (await res.json()) as T;
}

export function fetchHealth(): Promise<HealthResponse> {
  return request<HealthResponse>('/health');
}

export const authApi = {
  register(credentials: AuthCredentials): Promise<AuthUser> {
    return request<AuthUser>('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify(credentials),
    });
  },
  login(credentials: AuthCredentials): Promise<AuthUser> {
    return request<AuthUser>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify(credentials),
    });
  },
  logout(): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>('/api/auth/logout', { method: 'POST' });
  },
  me(): Promise<AuthUser> {
    return request<AuthUser>('/api/auth/me');
  },
};
