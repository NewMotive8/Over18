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

/** A single chat message inside a conversation (US-07). */
export interface ChatMessage {
  id: string;
  sender: 'user' | 'character';
  content: string;
  createdAt: string;
}

/** Result of sending a message: both persisted messages, in order. */
export interface SendMessageResult {
  userMessage: ChatMessage;
  characterMessage: ChatMessage;
}

/** Message content limits shared by client- and server-side validation. */
export const MESSAGE_MAX_LENGTH = 2000;

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

/**
 * Visual DNA (US-16A) — the IDENTITY-only description of a character's visual
 * self. Deliberately flexible: individual attributes are open-ended strings /
 * nested shapes because the taxonomy is not yet proven. Two rules are firm:
 *  1. `apparentAgeBand` is required and must denote an adult.
 *  2. PRESENTATION attributes (hairstyle, makeup, clothing, accessories, pose,
 *     expression, environment, lighting, camera, composition, photographicStyle)
 *     must NEVER appear here — they are a generation-time concern recorded in a
 *     generated asset's provenance. This identity-vs-presentation separation is
 *     a core architectural principle.
 *
 * This is identity metadata used to compose future generation requests; it is
 * NOT itself secret, but it is not exposed through any existing public wire
 * mapper in US-16A (no visual endpoints exist yet).
 */
export interface VisualDna {
  /** Required. Must denote an adult (e.g. "adult", "adult-20s"). Non-adult is rejected. */
  apparentAgeBand: string;
  face?: unknown;
  eyes?: unknown;
  nose?: unknown;
  lips?: unknown;
  skin?: unknown;
  hair?: unknown;
  body?: unknown;
  distinctiveFeatures?: unknown;
  /** Open-ended room for additional identity attributes as the taxonomy matures. */
  [key: string]: unknown;
}
