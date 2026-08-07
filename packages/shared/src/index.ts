/**
 * @over18/shared
 *
 * Shared TypeScript types used by both the web frontend and the API.
 * Domain types (User, Character, Conversation, Message, ...) will be added
 * here in later stories so that web and api never drift apart.
 */

/** Response shape of GET /health on the API. */
export interface HealthResponse {
  status: 'ok';
  service: string;
  timestamp: string;
}

/** Generic API error envelope (will be formalised in later stories). */
export interface ApiError {
  error: string;
  message: string;
}

/** Safe, public representation of an authenticated user. Never includes password_hash. */
export interface AuthUser {
  id: string;
  email: string;
}

/** Request body for POST /api/auth/register and POST /api/auth/login. */
export interface AuthCredentials {
  email: string;
  password: string;
}

/** Password policy shared by client-side and server-side validation. */
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 72; // bcrypt input limit
