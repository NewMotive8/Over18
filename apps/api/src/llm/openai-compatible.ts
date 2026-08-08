import { LlmError, type LlmClient, type LlmRequest } from './types.js';

export interface OpenAiCompatibleConfig {
  /** Base URL of the inference endpoint, e.g. https://<host>/v1 */
  baseUrl: string;
  /** Model identifier as known by the endpoint. */
  model: string;
  /** Optional bearer token — self-hosted endpoints may be keyless. */
  apiKey?: string;
  timeoutMs: number;
}

/**
 * Adapter for the OpenAI-compatible chat-completions wire protocol.
 *
 * This is a PROTOCOL choice, not a vendor choice: it is the de-facto
 * standard interface exposed by self-hosted and dedicated inference stacks
 * (vLLM, TGI, llama.cpp server, Ollama, and most GPU-cloud endpoints), so
 * whichever model/provider is selected later will almost certainly work by
 * setting environment variables alone. If the chosen stack speaks a
 * different protocol, it gets its own adapter next to this one.
 */
export function createOpenAiCompatibleClient(config: OpenAiCompatibleConfig): LlmClient {
  const url = `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`;

  return {
    async generate(request: LlmRequest): Promise<string> {
      let response: Response;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
          },
          body: JSON.stringify({
            model: config.model,
            messages: request.messages,
            max_tokens: request.maxTokens,
            temperature: request.temperature,
          }),
          signal: AbortSignal.timeout(config.timeoutMs),
        });
      } catch (err) {
        if (err instanceof Error && err.name === 'TimeoutError') {
          throw new LlmError('timeout', `Inference request timed out after ${config.timeoutMs}ms.`);
        }
        throw new LlmError('network', 'Could not reach the inference endpoint.');
      }

      if (!response.ok) {
        // Never include the response body in the error — it could echo the prompt.
        throw new LlmError('http', `Inference endpoint returned HTTP ${response.status}.`, response.status);
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new LlmError('invalid_response', 'Inference endpoint returned non-JSON output.');
      }

      const content = (body as { choices?: Array<{ message?: { content?: unknown } }> })
        ?.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || content.trim().length === 0) {
        throw new LlmError('invalid_response', 'Inference endpoint returned an empty completion.');
      }
      return content.trim();
    },
  };
}
