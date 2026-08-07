import type { HealthResponse } from '@over18/shared';

/**
 * Single entry point for talking to the Over18 REST API.
 * The frontend never accesses the database directly — everything
 * goes through this API client.
 */
export const API_URL: string = import.meta.env.VITE_API_URL ?? 'http://localhost:3001';

export async function fetchHealth(): Promise<HealthResponse> {
  const res = await fetch(`${API_URL}/health`);
  if (!res.ok) {
    throw new Error(`API health check failed: ${res.status}`);
  }
  return (await res.json()) as HealthResponse;
}
