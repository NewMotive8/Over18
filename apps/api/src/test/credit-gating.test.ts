import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { buildApp } from '../app.js';
import { createDb } from '../db/client.js';
import { seedCharacters } from '../db/seed.js';
import { SEED_CHARACTERS } from '../db/seed-data.js';
import { users } from '../db/schema.js';
import { LlmError } from '../llm/types.js';
import type { ReplyProvider } from '../services/character-reply.js';
import {
  CallCreditError,
  canStartCall,
  chargeCallMinute,
  withFirstCallMinute,
} from '../services/paid-call-service.js';
import { CREDITS_CURRENCY, grantCredits, readCommercialWallet } from '../services/wallet-service.js';
import {
  TEST_DATABASE_URL,
  createTestContext,
  destroyTestContext,
  extractSessionCookie,
  migrateTestDb,
  testEnv,
  truncateAll,
  type TestContext,
} from './helpers.js';

/**
 * CREDIT GATING for text chat and live voice calls.
 *
 * The two rules these exist to hold:
 *
 *   NOBODY GETS SOMETHING FOR NOTHING. An exchange or a call minute costs
 *   Credits, Premium does not exempt anyone (Premium is access, Credits are
 *   consumption), and a missing economy configuration is refused rather than
 *   given away.
 *
 *   NOBODY PAYS FOR NOTHING. A failed generation costs nothing, and an
 *   unaffordable call never becomes a billable provider session -- the provider
 *   bills a created session whether or not anyone speaks, and offers no way to
 *   cancel one.
 *
 * Every price here is test configuration, published through the same P1 tables
 * the admin screens write.
 */

let ctx: TestContext;
let seq = 0;
const PASSWORD = 'gating-test-pass1';
const ACTOR = '00000000-0000-4000-8000-000000000001';
const LUNA_ID = SEED_CHARACTERS.find((c) => c.name === 'luna')!.id;

const q = <T = Record<string, unknown>>(text: string, params: unknown[] = []) =>
  ctx.pool.query<T & import('pg').QueryResultRow>(text, params);

beforeAll(async () => {
  migrateTestDb();
  // The economy ON: chat and calls are paid actions.
  const { db, pool } = createDb(TEST_DATABASE_URL);
  ctx = {
    app: await buildApp(
      {
        ...testEnv,
        commerce: { ...testEnv.commerce, enabled: true },
        // Voice on, so the call-start preflight is reachable: `startCall` gates
        // on this BEFORE it asks whether anyone can pay.
        voice: { provider: 'spicyapi', apiKey: 'test-not-a-real-key', timeoutMs: 1_000, maxSeconds: 780 },
        voiceCalls: { enabled: true },
      },
      db,
      {
        replyProvider: (context) => replyImpl(context),
        // Never reached by these tests: the preflight refuses before a session
        // is claimed, and a passing preflight is asserted without connecting.
        voiceProvider: {
          name: 'fake',
          createSession: async () => {
            throw new Error('no test may reach the provider');
          },
        },
      },
    ),
    db,
    pool,
  };
});
afterAll(async () => destroyTestContext(ctx));

/** Swapped per test: the model's behaviour is what several of these are about. */
let replyImpl: ReplyProvider = () => 'A reply.';

beforeEach(async () => {
  await truncateAll(ctx);
  await seedCharacters(ctx.db);
  replyImpl = () => 'A reply.';
});

/* ---- the P1 ruleset, as a fixture ---- */

/**
 * Publishes a ruleset that prices the actions named. Written straight to the P1
 * tables because that is what an operator's publish produces; the resolver reads
 * it exactly as it reads a real one.
 */
async function publishRuleset(costs: { actionType: string; unit: string; creditCost: number }[]) {
  // Drafted, then published -- the lifecycle the triggers enforce. A row cannot
  // be inserted already published, which is exactly how a real publish works.
  const { rows } = await q<{ id: string }>(
    `INSERT INTO economy_rulesets (version) VALUES (1) RETURNING id`,
  );
  const rulesetId = rows[0]!.id;
  for (const cost of costs) {
    await q(
      `INSERT INTO economy_ruleset_action_costs (ruleset_id, action_type, unit, credit_cost, enabled)
       VALUES ($1, $2, $3, $4, true)`,
      [rulesetId, cost.actionType, cost.unit, cost.creditCost],
    );
  }
  for (const key of [
    'free_first_conversation_messages',
    'free_daily_messages',
    'signup_grant_credits',
    'grace_period_days',
    'reward_monthly_cap_credits',
  ]) {
    await q(`INSERT INTO economy_ruleset_allowances (ruleset_id, key, value) VALUES ($1, $2, 0)`, [rulesetId, key]);
  }
  await q(
    `UPDATE economy_rulesets SET status = 'published', published_by = $2, publish_reason = 'test' WHERE id = $1`,
    [rulesetId, ACTOR],
  );
  return rulesetId;
}

const priceChatAndCalls = () =>
  publishRuleset([
    { actionType: 'text_message', unit: 'per_action', creditCost: 1 },
    { actionType: 'voice_call', unit: 'per_minute', creditCost: 1 },
  ]);

/* ---- accounts ---- */

interface Account {
  id: string;
  cookies: Record<string, string>;
  conversationId: string;
}

async function account(credits: number, over: { premium?: boolean } = {}): Promise<Account> {
  const email = `gating-${process.pid}-${++seq}@example.com`;
  const reg = await ctx.app.inject({ method: 'POST', url: '/api/auth/register', payload: { email, password: PASSWORD } });
  expect(reg.statusCode).toBe(201);
  const cookie = extractSessionCookie(reg)!;
  const cookies = { [cookie.name]: cookie.value };
  const [row] = await ctx.db.select({ id: users.id }).from(users).where(eq(users.email, email));
  const id = row!.id;

  if (credits > 0) {
    await grantCredits(ctx.db, {
      userId: id,
      currency: CREDITS_CURRENCY,
      amount: credits,
      creditClass: 'purchased',
      idempotencyKey: `seed:${id}`,
      source: { type: 'test', id },
      reason: 'Test balance',
    });
  }
  if (over.premium) await givePremium(id);

  const conv = await ctx.app.inject({
    method: 'POST',
    url: '/api/conversations',
    payload: { characterId: LUNA_ID },
    cookies,
  });
  expect(conv.statusCode, conv.body).toBe(201);
  return { id, cookies, conversationId: conv.json().id as string };
}

/** An active Premium subscription, written as the subscription service records one. */
async function givePremium(userId: string) {
  const plan = await q<{ id: string }>(
    `INSERT INTO economy_plans (code) VALUES ('premium_monthly') ON CONFLICT (code) DO UPDATE SET code = EXCLUDED.code RETURNING id`,
  );
  const version = await q<{ id: string }>(
    `INSERT INTO economy_plan_versions
       (plan_id, version, display_name, billing_period_months, price_minor, currency, monthly_included_credits, is_purchasable)
     VALUES ($1, 1, 'Premium Monthly', 1, 1299, 'USD', 200, true) RETURNING id`,
    [plan.rows[0]!.id],
  );
  // Drafted then published, as the triggers require.
  await q(
    `UPDATE economy_plan_versions SET status = 'published', published_by = $2, publish_reason = 'test' WHERE id = $1`,
    [version.rows[0]!.id, ACTOR],
  );
  await q(
    `INSERT INTO subscriptions (user_id, plan_version_id, status, current_period_end)
     VALUES ($1, $2, 'active', now() + interval '30 days')`,
    [userId, version.rows[0]!.id],
  );
}

const send = (who: Account, content = 'Hello there.') =>
  ctx.app.inject({
    method: 'POST',
    url: `/api/conversations/${who.conversationId}/messages`,
    payload: { content },
    cookies: who.cookies,
  });

const spendable = async (userId: string) =>
  (await readCommercialWallet(ctx.db, userId, CREDITS_CURRENCY))?.spendable ?? 0;

const messageCount = async (conversationId: string) =>
  (await q<{ n: number }>('SELECT count(*)::int AS n FROM messages WHERE conversation_id = $1', [conversationId]))
    .rows[0]!.n;

/* ------------------------------------------------------------------ *
 * Text chat
 * ------------------------------------------------------------------ */

describe('a chat exchange costs Credits', () => {
  it('refuses a customer with no Credits, and writes no messages', async () => {
    await priceChatAndCalls();
    const broke = await account(0);

    const res = await send(broke);

    expect(res.statusCode).toBe(402);
    expect(res.json()).toMatchObject({ error: 'insufficient_credits' });
    // Nothing was said by either side: the exchange never happened.
    expect(await messageCount(broke.conversationId)).toBe(0);
    expect(await spendable(broke.id)).toBe(0);
  });

  it('charges exactly the configured cost when the customer can pay', async () => {
    await priceChatAndCalls();
    const payer = await account(3);

    const res = await send(payer);

    expect(res.statusCode, res.body).toBe(201);
    expect(await spendable(payer.id)).toBe(2);
    // His message and her reply.
    expect(await messageCount(payer.conversationId)).toBe(2);
  });

  /**
   * PREMIUM IS ACCESS, CREDITS ARE CONSUMPTION. A Premium customer with an empty
   * wallet is refused exactly like anyone else -- the commercial rule the
   * Credits Store is built on.
   */
  it('refuses a Premium customer with no Credits', async () => {
    await priceChatAndCalls();
    const premium = await account(0, { premium: true });

    const res = await send(premium);

    expect(res.statusCode).toBe(402);
    expect(await messageCount(premium.conversationId)).toBe(0);
  });

  it('charges a Premium customer who has Credits, like anyone else', async () => {
    await priceChatAndCalls();
    const premium = await account(2, { premium: true });

    expect((await send(premium)).statusCode).toBe(201);

    expect(await spendable(premium.id)).toBe(1);
  });

  /**
   * THE REFUND NOBODY SHOULD HAVE TO ASK FOR. The Credits are reserved before
   * the model is called; a failed generation releases the reservation, so the
   * balance is exactly what it was.
   */
  it('consumes nothing when generation fails', async () => {
    await priceChatAndCalls();
    const payer = await account(3);
    replyImpl = () => {
      throw new LlmError('http', 'The model is unavailable.', 502);
    };

    const res = await send(payer);

    expect(res.statusCode).toBe(502);
    expect(await spendable(payer.id)).toBe(3);
    // The whole exchange rolled back, as it did before Credits existed.
    expect(await messageCount(payer.conversationId)).toBe(0);
  });

  /**
   * FAIL CLOSED. The economy is on and nothing prices a chat exchange, so chat
   * is refused -- never silently given away.
   */
  it('refuses when no ruleset prices a chat exchange, rather than making it free', async () => {
    // No ruleset at all.
    const payer = await account(5);

    const res = await send(payer);

    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: 'chat_unavailable' });
    expect(await spendable(payer.id)).toBe(5);
    expect(await messageCount(payer.conversationId)).toBe(0);
  });

  it('refuses when a ruleset exists but prices no chat exchange', async () => {
    await publishRuleset([{ actionType: 'voice_call', unit: 'per_minute', creditCost: 1 }]);
    const payer = await account(5);

    expect((await send(payer)).statusCode).toBe(503);

    expect(await spendable(payer.id)).toBe(5);
  });

  /** A conversation that is not yours costs nothing, even to probe. */
  it('charges nothing for someone else’s conversation', async () => {
    await priceChatAndCalls();
    const mine = await account(3);
    const theirs = await account(3);

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/conversations/${theirs.conversationId}/messages`,
      payload: { content: 'Hello.' },
      cookies: mine.cookies,
    });

    expect(res.statusCode).toBe(404);
    expect(await spendable(mine.id)).toBe(3);
  });

  /**
   * An automatic greeting is not something the visitor asked for, so it is never
   * charged. It also never reaches the charging path at all.
   */
  it('never charges for the automatic opening greeting', async () => {
    await priceChatAndCalls();
    const visitor = await account(2);

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/conversations/${visitor.conversationId}/opening`,
      cookies: visitor.cookies,
    });

    expect(res.statusCode).toBe(200);
    expect(await spendable(visitor.id)).toBe(2);
  });
});

/* ------------------------------------------------------------------ *
 * Live voice calls
 * ------------------------------------------------------------------ */

const commerceOn = { enabled: true };
const callInput = (userId: string) => ({ userId, callSessionId: '22222222-2222-4222-8222-222222222222' });

describe('a live call costs a Credit per started minute', () => {
  /**
   * THE ONE THAT COSTS REAL MONEY IF IT IS WRONG. A created provider session is
   * billable and cannot be cancelled, so an unaffordable call must be refused
   * before the provider is touched at all.
   */
  it('never creates a provider session when the caller cannot afford the first minute', async () => {
    await priceChatAndCalls();
    const broke = await account(0);
    let providerCalls = 0;

    await expect(
      withFirstCallMinute(ctx.db, commerceOn, callInput(broke.id), async () => {
        providerCalls += 1;
        return { providerSessionId: 'should-never-exist' };
      }),
    ).rejects.toMatchObject({ name: 'CallCreditError', code: 'insufficient_credits' });

    expect(providerCalls).toBe(0);
  });

  it('charges the first minute once the session is really created', async () => {
    await priceChatAndCalls();
    const caller = await account(3);

    const session = await withFirstCallMinute(ctx.db, commerceOn, callInput(caller.id), async () => ({
      providerSessionId: 'sess_1',
    }));

    expect(session).toEqual({ providerSessionId: 'sess_1' });
    expect(await spendable(caller.id)).toBe(2);
  });

  /** A session that was never created was never worth a Credit. */
  it('charges nothing when creating the provider session fails', async () => {
    await priceChatAndCalls();
    const caller = await account(3);

    await expect(
      withFirstCallMinute(ctx.db, commerceOn, callInput(caller.id), async () => {
        throw new Error('provider exploded');
      }),
    ).rejects.toThrow('provider exploded');

    expect(await spendable(caller.id)).toBe(3);
  });

  it('refuses a Premium caller with no Credits, and calls no provider', async () => {
    await priceChatAndCalls();
    const premium = await account(0, { premium: true });
    let providerCalls = 0;

    await expect(
      withFirstCallMinute(ctx.db, commerceOn, callInput(premium.id), async () => {
        providerCalls += 1;
        return { providerSessionId: 'nope' };
      }),
    ).rejects.toMatchObject({ code: 'insufficient_credits' });

    expect(providerCalls).toBe(0);
  });

  it('charges each later minute as it starts', async () => {
    await priceChatAndCalls();
    const caller = await account(3);
    await withFirstCallMinute(ctx.db, commerceOn, callInput(caller.id), async () => ({ providerSessionId: 's' }));

    expect(await chargeCallMinute(ctx.db, commerceOn, callInput(caller.id), 2)).toEqual({ charged: true });
    expect(await spendable(caller.id)).toBe(1);
    expect(await chargeCallMinute(ctx.db, commerceOn, callInput(caller.id), 3)).toEqual({ charged: true });
    expect(await spendable(caller.id)).toBe(0);
  });

  /** The call ends rather than running on unpaid. */
  it('reports that the Credits ran out instead of continuing the call', async () => {
    await priceChatAndCalls();
    const caller = await account(2);
    await withFirstCallMinute(ctx.db, commerceOn, callInput(caller.id), async () => ({ providerSessionId: 's' }));
    expect(await chargeCallMinute(ctx.db, commerceOn, callInput(caller.id), 2)).toEqual({ charged: true });

    // The third minute cannot be paid for.
    expect(await chargeCallMinute(ctx.db, commerceOn, callInput(caller.id), 3)).toEqual({
      charged: false,
      reason: 'insufficient_credits',
    });
    expect(await spendable(caller.id)).toBe(0);
  });

  /** A redelivered tick must not charge the same minute twice. */
  it('charges one minute once, however many times it is asked for', async () => {
    await priceChatAndCalls();
    const caller = await account(3);
    await withFirstCallMinute(ctx.db, commerceOn, callInput(caller.id), async () => ({ providerSessionId: 's' }));

    await chargeCallMinute(ctx.db, commerceOn, callInput(caller.id), 2);
    await chargeCallMinute(ctx.db, commerceOn, callInput(caller.id), 2);

    expect(await spendable(caller.id)).toBe(1);
  });

  it('fails closed when no ruleset prices a call', async () => {
    const caller = await account(5);
    let providerCalls = 0;

    await expect(
      withFirstCallMinute(ctx.db, commerceOn, callInput(caller.id), async () => {
        providerCalls += 1;
        return { providerSessionId: 'nope' };
      }),
    ).rejects.toMatchObject({ code: 'not_priced' });

    expect(providerCalls).toBe(0);
    expect(await spendable(caller.id)).toBe(5);
  });
});

/* ------------------------------------------------------------------ *
 * While the economy is off
 * ------------------------------------------------------------------ */

describe('while the economy is off, nothing is charged', () => {
  let dark: TestContext;
  beforeAll(async () => {
    dark = await createTestContext();
  });
  afterAll(async () => destroyTestContext(dark));

  it('a call runs without touching the wallet', async () => {
    const caller = await account(0);
    const session = await withFirstCallMinute(
      ctx.db,
      { enabled: false },
      callInput(caller.id),
      async () => ({ providerSessionId: 'free' }),
    );
    expect(session).toEqual({ providerSessionId: 'free' });
    expect(await chargeCallMinute(ctx.db, { enabled: false }, callInput(caller.id), 2)).toEqual({ charged: true });
    expect(await spendable(caller.id)).toBe(0);
  });

  it('a chat exchange is not a paid action', async () => {
    const reg = await dark.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: `dark-${process.pid}-${++seq}@example.com`, password: PASSWORD },
    });
    const cookie = extractSessionCookie(reg)!;
    const cookies = { [cookie.name]: cookie.value };
    await seedCharacters(dark.db);
    const conv = await dark.app.inject({
      method: 'POST',
      url: '/api/conversations',
      payload: { characterId: LUNA_ID },
      cookies,
    });
    const res = await dark.app.inject({
      method: 'POST',
      url: `/api/conversations/${conv.json().id}/messages`,
      payload: { content: 'Hello.' },
      cookies,
    });
    expect(res.statusCode, res.body).toBe(201);
  });
});

/* ------------------------------------------------------------------ *
 * The refusal is the right shape
 * ------------------------------------------------------------------ */

describe('CallCreditError', () => {
  it('names the cause without quoting the wallet’s numbers to the caller', () => {
    const error = new CallCreditError('insufficient_credits', 'Not enough Credits for this call.', 'wallet_not_found');
    expect(error.message).not.toMatch(/\d/);
    expect(error.reason).toBe('wallet_not_found');
  });
});

/* ------------------------------------------------------------------ *
 * Telling someone before they press Call
 * ------------------------------------------------------------------ */

describe('starting a call is refused up front when the Credits are not there', () => {
  const START = (conversationId: string) => `/api/conversations/${conversationId}/call`;

  const callSessionCount = async () =>
    (await q<{ n: number }>('SELECT count(*)::int AS n FROM call_sessions')).rows[0]!.n;

  const startCallFor = (who: Account) =>
    ctx.app.inject({ method: 'POST', url: START(who.conversationId), cookies: who.cookies });

  /**
   * THE WHOLE POINT. Before this, a caller with nothing claimed a session, the
   * socket opened, the first-minute reservation refused them, and they were
   * shown "the call ended unexpectedly" -- which describes a fault, and nothing
   * had faulted.
   */
  it('answers 402 and creates no call session', async () => {
    await priceChatAndCalls();
    const broke = await account(0);

    const res = await startCallFor(broke);

    expect(res.statusCode).toBe(402);
    expect(res.json()).toMatchObject({ error: 'insufficient_credits', creditsRequired: 1 });
    // Nothing was claimed, so there is nothing to resume and nothing to settle.
    expect(await callSessionCount()).toBe(0);
    expect(await spendable(broke.id)).toBe(0);
  });

  /** Premium is access, Credits are consumption — the same rule as everywhere. */
  it('refuses a Premium caller with no Credits, and creates no call session', async () => {
    await priceChatAndCalls();
    const premium = await account(0, { premium: true });

    const res = await startCallFor(premium);

    expect(res.statusCode).toBe(402);
    expect(res.json()).toMatchObject({ error: 'insufficient_credits' });
    expect(await callSessionCount()).toBe(0);
  });

  /** Exactly the price of one minute is enough to begin. */
  it('lets a caller with one Credit through the preflight', async () => {
    await priceChatAndCalls();
    const payer = await account(1);

    const res = await startCallFor(payer);

    expect(res.statusCode).not.toBe(402);
    // The preflight reserves nothing: the first minute is still the relay's.
    expect(await spendable(payer.id)).toBe(1);
  });

  /** Fail closed, and say the right thing: buying Credits would not help here. */
  it('reports calls as unavailable, not unaffordable, when nothing prices one', async () => {
    const payer = await account(5);

    const res = await startCallFor(payer);

    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: 'voice_unavailable' });
    expect(await callSessionCount()).toBe(0);
  });

  /**
   * THE PREFLIGHT IS NOT THE GUARD. It narrows the window and improves the
   * message; `withFirstCallMinute` is still the only thing that moves Credits,
   * and it still refuses someone who spent their last Credit after the
   * preflight said yes. Simulated here by draining the wallet between the two.
   */
  it('still refuses at the reservation when the Credits go after the preflight', async () => {
    await priceChatAndCalls();
    const caller = await account(1);
    expect(await canStartCall(ctx.db, commerceOn, caller.id)).toEqual({ ok: true });

    // Spent elsewhere in the meantime.
    await chargeCallMinute(ctx.db, commerceOn, callInput(caller.id), 99);
    expect(await spendable(caller.id)).toBe(0);

    let providerCalls = 0;
    await expect(
      withFirstCallMinute(ctx.db, commerceOn, callInput(caller.id), async () => {
        providerCalls += 1;
        return { providerSessionId: 'never' };
      }),
    ).rejects.toMatchObject({ code: 'insufficient_credits' });
    expect(providerCalls).toBe(0);
  });

  it('asks nothing of the wallet while the economy is off', async () => {
    const broke = await account(0);
    expect(await canStartCall(ctx.db, { enabled: false }, broke.id)).toEqual({ ok: true });
  });
});

/* ------------------------------------------------------------------ *
 * The catalogue tells a customer what things cost
 * ------------------------------------------------------------------ */

describe('the customer catalogue publishes the action costs', () => {
  const catalogFor = async (who: Account) => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/economy/catalog', cookies: who.cookies });
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as { actionCosts: { actionType: string; unit: string; creditCost: number }[] };
  };

  /**
   * SO THE INTERFACE NEED NOT GUESS. Before this, nothing customer-facing
   * carried a price, so any "1 Credit per message" on screen would have been a
   * second pricing configuration nothing kept in step with the ruleset.
   */
  it('serves the enabled costs from the published ruleset', async () => {
    await priceChatAndCalls();
    const customer = await account(5);

    const { actionCosts } = await catalogFor(customer);

    expect(actionCosts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ actionType: 'text_message', unit: 'per_action', creditCost: 1 }),
        expect.objectContaining({ actionType: 'voice_call', unit: 'per_minute', creditCost: 1 }),
      ]),
    );
  });

  it('serves whatever the ruleset says, not a constant', async () => {
    await publishRuleset([
      { actionType: 'text_message', unit: 'per_action', creditCost: 2 },
      { actionType: 'voice_call', unit: 'per_minute', creditCost: 3 },
    ]);
    const customer = await account(5);

    const { actionCosts } = await catalogFor(customer);

    expect(actionCosts.find((c) => c.actionType === 'text_message')?.creditCost).toBe(2);
    expect(actionCosts.find((c) => c.actionType === 'voice_call')?.creditCost).toBe(3);
  });

  /** Fail closed: an absence, never a zero and never a default. */
  it('is empty when no ruleset is published', async () => {
    const customer = await account(5);
    expect((await catalogFor(customer)).actionCosts).toEqual([]);
  });

  it('omits an action the ruleset does not price', async () => {
    await publishRuleset([{ actionType: 'voice_call', unit: 'per_minute', creditCost: 1 }]);
    const customer = await account(5);

    const { actionCosts } = await catalogFor(customer);

    expect(actionCosts.map((c) => c.actionType)).toEqual(['voice_call']);
  });

  /** Premium changes what you may do, never what an action costs. */
  it('quotes a Premium customer exactly the same costs', async () => {
    await priceChatAndCalls();
    const free = await account(5);
    const premium = await account(5, { premium: true });

    expect((await catalogFor(premium)).actionCosts).toEqual((await catalogFor(free)).actionCosts);
  });
});
