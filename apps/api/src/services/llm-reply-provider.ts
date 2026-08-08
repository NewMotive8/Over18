import { LlmError, type LlmClient, type LlmMessage } from '../llm/types.js';
import type { Env } from '../env.js';
import { createOpenAiCompatibleClient } from '../llm/openai-compatible.js';
import { deterministicReplyProvider, type ReplyContext, type ReplyProvider } from './character-reply.js';

export interface LlmReplyOptions {
  maxTokens: number;
  temperature: number;
}

/**
 * US-08 reply provider: turns the conversation into an inference request
 * via the injected LlmClient. The client is the swappable part — this
 * function contains no provider-, model-, or vendor-specific logic.
 *
 * Prompt assembly:
 * - system: the character's internal system_prompt (server-side only)
 * - history: prior messages mapped user→user / character→assistant
 * - the new user message last
 * Context-window management is deliberately NOT done here (US-10).
 */
export function createLlmReplyProvider(client: LlmClient, options: LlmReplyOptions): ReplyProvider {
  return async (context: ReplyContext): Promise<string> => {
    const messages: LlmMessage[] = [
      { role: 'system', content: context.systemPrompt },
      ...context.history.map(
        (message): LlmMessage => ({
          role: message.sender === 'user' ? 'user' : 'assistant',
          content: message.content,
        }),
      ),
      { role: 'user', content: context.userMessage },
    ];

    // Errors (LlmError) propagate: the message-service transaction rolls the
    // whole exchange back and the route maps the failure to a clean 502.
    return client.generate({
      messages,
      maxTokens: options.maxTokens,
      temperature: options.temperature,
    });
  };
}

/**
 * Production guard: used when NODE_ENV=production but no inference endpoint
 * is configured. Every send fails fast with a clear, distinct error — the
 * deterministic fallback must never impersonate AI in production. Throwing
 * inside the message transaction also means nothing is persisted.
 */
export const unconfiguredReplyProvider: ReplyProvider = () => {
  throw new LlmError('not_configured', 'No LLM inference endpoint is configured.');
};

/**
 * Environment-based provider selection (used by server.ts, unit-testable):
 * - LLM configured        → real inference provider
 * - unset, development    → deterministic fallback (demoable without a model)
 * - unset, production     → unconfiguredReplyProvider (fail clearly, never fake)
 */
export function selectReplyProvider(env: Env): ReplyProvider {
  if (env.llm) {
    return createLlmReplyProvider(createOpenAiCompatibleClient(env.llm), {
      maxTokens: env.llm.maxTokens,
      temperature: env.llm.temperature,
    });
  }
  return env.isProduction ? unconfiguredReplyProvider : deterministicReplyProvider;
}
