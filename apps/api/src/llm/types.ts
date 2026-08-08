/**
 * Provider-agnostic LLM client abstraction (US-08).
 *
 * The product will run on an open-source / self-hosted / dedicated-inference
 * model that has not been selected yet, so nothing in this module names a
 * vendor, model, or GPU host. Swapping infrastructure later means adding a
 * new LlmClient adapter — conversations, messages, and the API contract
 * never change.
 */

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmRequest {
  messages: LlmMessage[];
  maxTokens: number;
  temperature: number;
}

/** The single contract every inference adapter implements. */
export interface LlmClient {
  /** Returns the assistant's reply text, or throws LlmError. */
  generate(request: LlmRequest): Promise<string>;
}

export type LlmErrorKind = 'timeout' | 'http' | 'invalid_response' | 'network' | 'not_configured';

/** Normalized provider failure — route layer maps any kind to a clean 502. */
export class LlmError extends Error {
  constructor(
    public readonly kind: LlmErrorKind,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}
