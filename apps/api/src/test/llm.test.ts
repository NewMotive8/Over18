import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { messages } from '../db/schema.js';
import { SEED_CHARACTERS } from '../db/seed-data.js';
import { seedCharacters } from '../db/seed.js';
import { createOpenAiCompatibleClient } from '../llm/openai-compatible.js';
import { LlmError, type LlmClient, type LlmRequest } from '../llm/types.js';
import { deterministicReplyProvider } from '../services/character-reply.js';
import {
  createLlmReplyProvider,
  selectReplyProvider,
  unconfiguredReplyProvider,
} from '../services/llm-reply-provider.js';
import { testEnv } from './helpers.js';
import {
  createTestContext,
  destroyTestContext,
  extractSessionCookie,
  migrateTestDb,
  truncateAll,
  type TestContext,
} from './helpers.js';

const LUNA = SEED_CHARACTERS.find((c) => c.name === 'luna')!;

/** Fake in-memory LlmClient — captures requests, returns or throws on demand. */
function createFakeClient() {
  const captured: LlmRequest[] = [];
  let behavior: { reply: string } | { error: LlmError } = { reply: 'A reply from the fake model.' };
  const client: LlmClient = {
    async generate(request) {
      captured.push(request);
      if ('error' in behavior) throw behavior.error;
      return behavior.reply;
    },
  };
  return {
    client,
    captured,
    setReply: (reply: string) => (behavior = { reply }),
    setError: (error: LlmError) => (behavior = { error }),
  };
}

describe('LLM reply provider through the API (fake client)', () => {
  let ctx: TestContext;
  const fake = createFakeClient();

  beforeAll(async () => {
    migrateTestDb();
    ctx = await createTestContext({
      replyProvider: createLlmReplyProvider(fake.client, { maxTokens: 256, temperature: 0.7 }),
    });
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  beforeEach(async () => {
    await truncateAll(ctx);
    await seedCharacters(ctx.db);
    fake.captured.length = 0;
    fake.setReply('A reply from the fake model.');
  });

  async function setup(email: string) {
    const reg = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email, password: 'llm-test-password1' },
    });
    const cookie = extractSessionCookie(reg)!;
    const cookies = { [cookie.name]: cookie.value };
    const conv = await ctx.app.inject({
      method: 'POST',
      url: '/api/conversations',
      payload: { characterId: LUNA.id },
      cookies,
    });
    return { cookies, conversationId: conv.json().id as string };
  }

  function send(cookies: Record<string, string>, conversationId: string, content: string) {
    return ctx.app.inject({
      method: 'POST',
      url: `/api/conversations/${conversationId}/messages`,
      payload: { content },
      cookies,
    });
  }

  it('returns and persists the model reply on success', async () => {
    const { cookies, conversationId } = await setup('llm.ok@example.com');
    fake.setReply('The stars are especially clear tonight.');
    const res = await send(cookies, conversationId, 'Hi Luna!');
    expect(res.statusCode).toBe(201);
    expect(res.json().characterMessage.content).toBe('The stars are especially clear tonight.');

    const rows = await ctx.db.select().from(messages);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.sender === 'character')!.content).toBe(
      'The stars are especially clear tonight.',
    );
  });

  it('sends the character system_prompt and full history to the model — but never to the client', async () => {
    const { cookies, conversationId } = await setup('llm.prompt@example.com');
    const first = await send(cookies, conversationId, 'First message');
    const second = await send(cookies, conversationId, 'Second message');

    // Request 1: composed character context + the new user message. Since the
    // Phase 1 separation the stored systemPrompt is deliberately NOT injected —
    // identity is described, and behaviour comes from the one code-owned layer.
    const req1 = fake.captured[0]!;
    expect(req1.messages[0]!.role).toBe('system');
    expect(req1.messages[0]!.content).not.toContain(LUNA.systemPrompt);
    expect(req1.messages[0]!.content).toContain('Her name is Luna.');
    expect(req1.messages[0]!.content).toContain(LUNA.personality);
    expect(req1.messages[0]!.content).toContain('HOW SHE TALKS');
    expect(req1.messages.at(-1)).toEqual({ role: 'user', content: 'First message' });
    expect(req1.maxTokens).toBe(256);
    expect(req1.temperature).toBe(0.7);

    // Request 2: history includes the first exchange, correctly role-mapped.
    const req2 = fake.captured[1]!;
    expect(req2.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(req2.messages[1]!.content).toBe('First message');
    expect(req2.messages.at(-1)!.content).toBe('Second message');

    // The wire responses never contain the system prompt.
    for (const res of [first, second]) {
      expect(JSON.stringify(res.json())).not.toContain(LUNA.systemPrompt);
      expect(JSON.stringify(res.json())).not.toContain('You are Luna');
    }
  });

  it('rolls back the entire exchange when the provider fails (502, nothing persisted)', async () => {
    const { cookies, conversationId } = await setup('llm.fail@example.com');
    fake.setError(new LlmError('http', 'Inference endpoint returned HTTP 500.', 500));
    const res = await send(cookies, conversationId, 'this must not persist');
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe('ai_unavailable');
    expect(await ctx.db.select().from(messages)).toHaveLength(0);
  });

  it('maps provider timeouts to the same clean 502 with full rollback', async () => {
    const { cookies, conversationId } = await setup('llm.timeout@example.com');
    fake.setError(new LlmError('timeout', 'Inference request timed out after 30000ms.'));
    const res = await send(cookies, conversationId, 'slow model');
    expect(res.statusCode).toBe(502);
    expect(await ctx.db.select().from(messages)).toHaveLength(0);
  });
});

describe('openai-compatible adapter against a local mock endpoint', () => {
  let server: Server;
  let baseUrl: string;
  let mode: 'ok' | 'slow' | 'http500' | 'garbage' | 'empty' = 'ok';

  beforeAll(async () => {
    server = createServer((_req, res) => {
      const respond = () => {
        if (mode === 'http500') {
          res.writeHead(500).end('boom');
        } else if (mode === 'garbage') {
          res.writeHead(200, { 'Content-Type': 'application/json' }).end('not json');
        } else if (mode === 'empty') {
          res
            .writeHead(200, { 'Content-Type': 'application/json' })
            .end(JSON.stringify({ choices: [] }));
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' }).end(
            JSON.stringify({ choices: [{ message: { content: '  Hello from the mock model.  ' } }] }),
          );
        }
      };
      if (mode === 'slow') setTimeout(respond, 2_000);
      else respond();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${address.port}/v1`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  function client(timeoutMs = 5_000) {
    return createOpenAiCompatibleClient({ baseUrl, model: 'test-model', timeoutMs });
  }
  const REQUEST = { messages: [{ role: 'user' as const, content: 'hi' }], maxTokens: 8, temperature: 0 };

  it('parses a successful completion (trimmed)', async () => {
    mode = 'ok';
    await expect(client().generate(REQUEST)).resolves.toBe('Hello from the mock model.');
  });

  it('times out slow endpoints with LlmError(timeout)', async () => {
    mode = 'slow';
    await expect(client(300).generate(REQUEST)).rejects.toMatchObject({
      name: 'LlmError',
      kind: 'timeout',
    });
  });

  it('maps HTTP errors, invalid JSON, and empty completions to LlmError', async () => {
    mode = 'http500';
    await expect(client().generate(REQUEST)).rejects.toMatchObject({ kind: 'http', status: 500 });
    mode = 'garbage';
    await expect(client().generate(REQUEST)).rejects.toMatchObject({ kind: 'invalid_response' });
    mode = 'empty';
    await expect(client().generate(REQUEST)).rejects.toMatchObject({ kind: 'invalid_response' });
  });

  it('fails with LlmError(network) when the endpoint is unreachable', async () => {
    const dead = createOpenAiCompatibleClient({
      baseUrl: 'http://127.0.0.1:1/v1',
      model: 'test-model',
      timeoutMs: 2_000,
    });
    await expect(dead.generate(REQUEST)).rejects.toMatchObject({ kind: 'network' });
  });
});

describe('provider selection by environment', () => {
  it('development without LLM config → deterministic fallback', () => {
    expect(selectReplyProvider({ ...testEnv, isProduction: false, llm: null })).toBe(
      deterministicReplyProvider,
    );
  });

  it('production without LLM config → unconfigured provider (never deterministic)', () => {
    const provider = selectReplyProvider({ ...testEnv, isProduction: true, llm: null });
    expect(provider).toBe(unconfiguredReplyProvider);
    expect(provider).not.toBe(deterministicReplyProvider);
  });

  it('configured LLM → inference provider in both environments', () => {
    const llm = {
      provider: 'openai-compatible' as const,
      baseUrl: 'http://127.0.0.1:9/v1',
      model: 'anything',
      timeoutMs: 1000,
      maxTokens: 64,
      temperature: 0.5,
      contextMaxMessages: 40,
      contextMaxChars: 16_000,
    };
    for (const isProduction of [true, false]) {
      const provider = selectReplyProvider({ ...testEnv, isProduction, llm });
      expect(provider).not.toBe(deterministicReplyProvider);
      expect(provider).not.toBe(unconfiguredReplyProvider);
    }
  });
});

describe('production without LLM configuration (unconfigured provider through the API)', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    migrateTestDb();
    ctx = await createTestContext({ replyProvider: unconfiguredReplyProvider });
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  beforeEach(async () => {
    await truncateAll(ctx);
    await seedCharacters(ctx.db);
  });

  it('send fails with a clear 503 ai_not_configured and persists nothing', async () => {
    const reg = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'llm.unconfigured@example.com', password: 'llm-test-password1' },
    });
    const cookie = extractSessionCookie(reg)!;
    const cookies = { [cookie.name]: cookie.value };
    const conv = await ctx.app.inject({
      method: 'POST',
      url: '/api/conversations',
      payload: { characterId: LUNA.id },
      cookies,
    });
    const conversationId = conv.json().id as string;

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/conversations/${conversationId}/messages`,
      payload: { content: 'hello?' },
      cookies,
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('ai_not_configured');
    // No deterministic reply was generated and nothing persisted (rollback).
    expect(JSON.stringify(res.json())).not.toContain("I'm Luna");
    expect(await ctx.db.select().from(messages)).toHaveLength(0);

    // Reading history still works and is empty.
    const history = await ctx.app.inject({
      method: 'GET',
      url: `/api/conversations/${conversationId}/messages`,
      cookies,
    });
    expect(history.statusCode).toBe(200);
    expect(history.json()).toEqual([]);
  });
});
