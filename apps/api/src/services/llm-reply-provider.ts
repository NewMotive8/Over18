import { LlmError, type LlmClient } from '../llm/types.js';
import type { Env } from '../env.js';
import { createOpenAiCompatibleClient } from '../llm/openai-compatible.js';
import { deterministicReplyProvider, type ReplyContext, type ReplyProvider } from './character-reply.js';
import {
  buildLlmMessages,
  buildOpeningMessages,
  createPromptBuilder,
  type PromptBuilder,
} from './prompt-builder.js';

export interface LlmReplyOptions {
  maxTokens: number;
  temperature: number;
}

/**
 * US-08 reply provider: turns the conversation into an inference request
 * via the injected LlmClient. The client is the swappable part — this
 * function contains no provider-, model-, or vendor-specific logic.
 *
 * Prompt/context assembly lives in the injectable PromptBuilder (US-09,
 * prompt-builder.ts): character persona + system_prompt as the system
 * message, role-mapped windowed history (US-10 context window), new user
 * message last.
 */
export function createLlmReplyProvider(
  client: LlmClient,
  options: LlmReplyOptions,
  promptBuilder: PromptBuilder = buildLlmMessages,
): ReplyProvider {
  return async (context: ReplyContext): Promise<string> => {
    // Errors (LlmError) propagate: the message-service transaction rolls the
    // whole exchange back and the route maps the failure to a clean 502.
    return client.generate({
      messages: promptBuilder(context),
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
 * - chat LLM configured   → real inference provider
 * - unset, development    → deterministic fallback (demoable without a model)
 * - unset, production     → unconfiguredReplyProvider (fail clearly, never fake)
 *
 * PREFERS `chatLlm`, FALLS BACK TO `llm`. That is the whole point of the split:
 * which model SHE speaks through is a product decision, while memory extraction
 * and Admin Autofill stay on `llm` whatever she is speaking through.
 *
 * The fallback is not belt-and-braces, it is the compatibility contract.
 * `loadEnv` already sets `chatLlm = llm` when `CHAT_LLM_PROVIDER` is unset, but
 * Env is also BUILT BY HAND in dozens of tests and callers that know only about
 * `llm`. Without `?? env.llm` every one of those silently lost its provider and
 * fell through to the deterministic fallback -- which is precisely the invisible
 * downgrade this whole feature exists to make impossible. Adding a field must
 * never be able to switch a model off.
 */
export function chatInferenceConfig(env: Env) {
  return env.chatLlm ?? env.llm;
}

export function selectReplyProvider(env: Env): ReplyProvider {
  const chat = chatInferenceConfig(env);
  if (chat) {
    return createLlmReplyProvider(
      createOpenAiCompatibleClient(chat),
      { maxTokens: chat.maxTokens, temperature: chat.temperature },
      // US-10: bound the history sent to the model via env-configured window.
      // US-12: bound injected memories the same way.
      createPromptBuilder(
        {
          maxHistoryMessages: chat.contextMaxMessages,
          maxHistoryChars: chat.contextMaxChars,
        },
        {
          maxMemories: env.memory.maxInjected,
          maxMemoryChars: env.memory.maxInjectedChars,
        },
      ),
    );
  }
  return env.isProduction ? unconfiguredReplyProvider : deterministicReplyProvider;
}

/**
 * The provider that writes her opening line.
 *
 * Same client, same model, same token and temperature limits as an ordinary
 * reply -- the ONLY difference is the prompt builder, which ends with an
 * instruction instead of a user turn. Anything else (a cheaper model, a lower
 * limit) would make her first sentence sound unlike every sentence after it,
 * and the first sentence is the one that decides whether he keeps talking.
 *
 * So this reads `chatLlm` too. Her greeting IS character chat; leaving it on
 * `llm` while her replies moved would reintroduce exactly the mismatch this
 * comment was written to prevent.
 *
 * The fallbacks are deliberately the same too:
 * - unset, development → the deterministic provider, whose first template is
 *   already a greeting, so an unconfigured dev environment still demonstrates
 *   the feature.
 * - unset, production  → throws `not_configured`, which the route turns into a
 *   quiet "no greeting". Never a fake one: the rule that the fallback must not
 *   impersonate AI applies to her first words most of all.
 */
export function selectOpeningProvider(env: Env): ReplyProvider {
  const chat = chatInferenceConfig(env);
  if (chat) {
    return createLlmReplyProvider(
      createOpenAiCompatibleClient(chat),
      { maxTokens: chat.maxTokens, temperature: chat.temperature },
      buildOpeningMessages,
    );
  }
  return env.isProduction ? unconfiguredReplyProvider : deterministicReplyProvider;
}
