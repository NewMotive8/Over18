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

/**
 * A user's conversation with a character, as returned by the conversations
 * API. Always scoped to the authenticated user — never contains other
 * users' data.
 */
export interface ConversationSummary {
  id: string;
  character: PublicCharacter;
  createdAt: string;
}

/**
 * Public representation of a character, as returned by GET /api/characters.
 * Internal fields (system_prompt, status) are never included.
 */
export interface PublicCharacter {
  id: string;
  name: string;
  displayName: string;
  profileImage: string | null;
  shortBio: string;
  personality: string;
  interests: string[];
  conversationStyle: string;
}
