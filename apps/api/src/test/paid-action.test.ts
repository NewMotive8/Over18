import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  beginPaidAction,
  capturePaidAction,
  priceOn,
  quotePaidAction,
  readPaidAction,
  readPaidActionRuleset,
  refundPaidAction,
  releasePaidAction,
  runPaidAction,
  type PaidActionRequest,
} from '../services/paid-action-service.js';
import { reconcileWallet } from '../services/wallet-reconciliation.js';
import { createTestContext, destroyTestContext, migrateTestDb, truncateAll, type TestContext } from './helpers.js';

/**
 * PRD v1.2 P7.1 -- the generic paid-action framework: hold before the work,
 * capture exactly what was held when it succeeds, release or refund when it
 * does not, all against ONE pinned economy version and under one idempotency
 * key. No particular paid action is implemented or tested here, deliberately:
 * the work is always a stand-in callback.
 *
 * Every Credit figure is an arbitrary test amount.
 */

let on: TestContext;
const ACTOR = randomUUID();
const ON = { enabled: true };
const OFF = { enabled: false };

beforeAll(async () => {
  migrateTestDb();
  on = await createTestContext();
});
afterAll(async () => destroyTestContext(on));
beforeEach(async () => truncateAll(on));

const q = <T extends Record<string, unknown> = Record<string, unknown>>(text: string, params: unknown[] = []) =>
  on.pool.query<T>(text, params);

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

/** A user with a Credits wallet, funded by a raw P2.1 grant (granting is not a wallet operation). */
async function funded(credits = 100): Promise<string> {
  const email = `${randomUUID()}@test.local`;
  const id = (await q<{ id: string }>("INSERT INTO users (email, password_hash) VALUES ($1, 'not-a-hash') RETURNING id", [email])).rows[0]!.id;
  await q("INSERT INTO wallets (user_id, currency) VALUES ($1, 'credits')", [id]);
  if (credits > 0) {
    await q(
      `INSERT INTO wallet_transactions (user_id, currency, entry_type, direction, amount, credit_class, idempotency_key)
       VALUES ($1, 'credits', 'grant', 'credit', $2, 'purchased', $3)`,
      [id, credits, `fixture:${randomUUID()}`],
    );
  }
  return id;
}

interface CostRow {
  action?: string;
  tier?: string;
  maxDuration?: number | null;
  credits: number;
  unit?: 'per_action' | 'per_minute';
  enabled?: boolean;
}

/**
 * A ruleset with the given action costs. Published and in effect now unless
 * `publish` says otherwise: `'draft'` leaves it unpublished, and an interval
 * schedules it for the future, on the database clock.
 */
async function ruleset(
  version: number,
  costs: CostRow[],
  publish: 'now' | 'draft' | { inInterval: string } = 'now',
): Promise<{ id: string; version: number }> {
  const id = (await q<{ id: string }>('INSERT INTO economy_rulesets (version) VALUES ($1) RETURNING id', [version])).rows[0]!.id;
  for (const c of costs) {
    await q(
      `INSERT INTO economy_ruleset_action_costs (ruleset_id, action_type, quality_tier, max_duration_seconds, unit, credit_cost, enabled)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, c.action ?? 'image_generate', c.tier ?? 'standard', c.maxDuration ?? null, c.unit ?? 'per_action', c.credits, c.enabled ?? true],
    );
  }
  if (publish !== 'draft') {
    const effectiveFrom = publish === 'now' ? 'NULL' : `clock_timestamp() + interval '${publish.inInterval}'`;
    await q(
      `UPDATE economy_rulesets SET status = 'published', effective_from = ${effectiveFrom}, published_by = $2, publish_reason = 'test' WHERE id = $1`,
      [id, ACTOR],
    );
  }
  return { id, version };
}

const walletOf = async (userId: string) =>
  (await q<{ balance: number; held: number }>("SELECT balance, held FROM wallets WHERE user_id = $1 AND currency = 'credits'", [userId])).rows[0]!;

const ledgerCount = async (userId: string) =>
  (await q<{ n: number }>('SELECT count(*)::int AS n FROM wallet_transactions WHERE user_id = $1', [userId])).rows[0]!.n;

const actionCount = async () => (await q<{ n: number }>('SELECT count(*)::int AS n FROM paid_actions')).rows[0]!.n;

const request = (userId: string, over: Partial<PaidActionRequest> = {}): PaidActionRequest => ({
  userId,
  actionType: 'image_generate',
  idempotencyKey: 'req-1',
  requestId: 'corr-1',
  ...over,
});

/* ------------------------------------------------------------------ *
 * 1. The server prices it, from the configuration alone
 * ------------------------------------------------------------------ */

describe('pricing comes from the economy configuration, never from the caller', () => {
  it('prices a per-action cost outright', async () => {
    await ruleset(1, [{ credits: 7 }]);
    const user = await funded();
    expect(await quotePaidAction(on.db, request(user))).toMatchObject({ amount: 7, currency: 'credits', qualityTier: 'standard' });
  });

  it('charges every started minute of a per-minute cost -- 70 seconds is two minutes, not one', () => {
    const snapshot = {
      ref: { kind: 'ruleset', id: randomUUID(), version: 1 } as const,
      actionCosts: [{ actionType: 'voice_call', qualityTier: 'standard', maxDurationSeconds: null, unit: 'per_minute' as const, creditCost: 5, enabled: true }],
    };
    const price = (durationSeconds: number | null) => priceOn(snapshot, { actionType: 'voice_call', qualityTier: 'standard', durationSeconds });
    expect(price(60)).toEqual({ ok: true, amount: 5 });
    expect(price(61)).toEqual({ ok: true, amount: 10 });
    expect(price(70)).toEqual({ ok: true, amount: 10 });
    expect(price(120)).toEqual({ ok: true, amount: 10 });
    // Rounding down would give part of the work away; a partial Credit cannot be held.
    expect(price(1)).toEqual({ ok: true, amount: 5 });
    expect(price(null)).toEqual({ ok: false, reason: 'duration_required' });
  });

  it('uses the smallest duration tier that covers the work, and refuses one beyond every tier', async () => {
    await ruleset(1, [
      { action: 'video_generate', maxDuration: 10, credits: 20 },
      { action: 'video_generate', maxDuration: 30, credits: 50 },
    ]);
    const user = await funded(500);
    const quote = (durationSeconds: number) => quotePaidAction(on.db, request(user, { actionType: 'video_generate', durationSeconds }));
    expect((await quote(5)).amount).toBe(20);
    expect((await quote(10)).amount).toBe(20);
    expect((await quote(11)).amount).toBe(50);
    await expect(quote(31)).rejects.toMatchObject({ code: 'not_priced', reason: 'duration_exceeds_tiers' });
  });

  it.each([
    ['an action the ruleset does not name', { actionType: 'not_configured' }, 'unknown_action'],
    ['a quality tier it does not name', { qualityTier: 'ultra' }, 'unknown_quality_tier'],
  ])('refuses %s rather than guessing a price', async (_label, over, reason) => {
    await ruleset(1, [{ credits: 7 }]);
    const user = await funded();
    await expect(quotePaidAction(on.db, request(user, over))).rejects.toMatchObject({ name: 'PaidActionError', code: 'not_priced', reason });
  });

  it('a disabled cost stops the action -- it is not a free one', async () => {
    await ruleset(1, [{ credits: 7, enabled: false }]);
    const user = await funded();
    await expect(beginPaidAction(on.db, ON, request(user))).rejects.toMatchObject({ code: 'not_priced', reason: 'action_disabled' });
    expect(await actionCount()).toBe(0);
    expect(await ledgerCount(user)).toBe(1);
  });

  it('with nothing published there is no price and no charge -- never a default or a zero', async () => {
    const user = await funded();
    await expect(beginPaidAction(on.db, ON, request(user))).rejects.toMatchObject({ code: 'not_priced', reason: 'no_effective_ruleset' });
    expect(await walletOf(user)).toMatchObject({ balance: 100, held: 0 });
  });

  it.each([
    ['a drafted ruleset', 'draft' as const],
    ['one scheduled but not yet in effect', { inInterval: '1 hour' }],
  ])('is never charged against %s', async (_label, publish) => {
    await ruleset(1, [{ credits: 7 }], publish);
    const user = await funded();
    await expect(beginPaidAction(on.db, ON, request(user))).rejects.toMatchObject({ code: 'not_priced', reason: 'no_effective_ruleset' });
    expect(await actionCount()).toBe(0);
    expect(await walletOf(user)).toMatchObject({ balance: 100, held: 0 });
  });

  it('prices against the version in effect, not a newer one scheduled for later', async () => {
    await ruleset(1, [{ credits: 7 }]);
    const scheduled = await ruleset(2, [{ credits: 99 }], { inInterval: '1 hour' });
    const user = await funded();
    const { action } = await beginPaidAction(on.db, ON, request(user));
    expect(action.amount).toBe(7);
    expect(action.ruleset.id).not.toBe(scheduled.id);
  });
});

/* ------------------------------------------------------------------ *
 * 2. The hold: atomic, before any work
 * ------------------------------------------------------------------ */

describe('starting a paid action holds the Credits before any work runs', () => {
  it('reserves exactly the priced amount, and records what it reserved', async () => {
    await ruleset(1, [{ credits: 7 }]);
    const user = await funded();
    const { action, replayed } = await beginPaidAction(on.db, ON, request(user));

    expect(replayed).toBe(false);
    expect(action).toMatchObject({ status: 'held', amount: 7, currency: 'credits', settlementTransactionId: null, refundTransactionId: null });
    // Spendable Credits are down and held Credits are up: the money is out of reach but not spent.
    expect(await walletOf(user)).toMatchObject({ balance: 93, held: 7 });
  });

  it('pins the exact version it priced against, and re-reads THAT one afterwards', async () => {
    const first = await ruleset(1, [{ credits: 7 }]);
    const user = await funded();
    const { action } = await beginPaidAction(on.db, ON, request(user));
    expect(action.ruleset).toEqual({ kind: 'ruleset', id: first.id, version: 1 });

    // A newer version takes over; the recorded action still reads its own.
    await ruleset(2, [{ credits: 99 }]);
    const reread = (await readPaidAction(on.db, user, 'req-1'))!;
    expect(reread.ruleset).toEqual(action.ruleset);
    expect(reread.amount).toBe(7);
    const pinned = await readPaidActionRuleset(on.db, reread);
    expect(pinned?.ref).toEqual({ kind: 'ruleset', id: first.id, version: 1 });
    expect(pinned?.actionCosts.map((c) => c.creditCost)).toEqual([7]);
  });

  it('refuses when the wallet cannot cover it, and writes nothing at all', async () => {
    await ruleset(1, [{ credits: 500 }]);
    const user = await funded(100);
    await expect(beginPaidAction(on.db, ON, request(user))).rejects.toMatchObject({ name: 'WalletError', code: 'insufficient_credits' });
    expect(await actionCount()).toBe(0);
    expect(await walletOf(user)).toMatchObject({ balance: 100, held: 0 });
    expect(await ledgerCount(user)).toBe(1);
  });

  it('holds nothing for a user who has no wallet', async () => {
    await ruleset(1, [{ credits: 7 }]);
    const id = (await q<{ id: string }>("INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id", [`${randomUUID()}@t.local`]))
      .rows[0]!.id;
    await expect(beginPaidAction(on.db, ON, request(id))).rejects.toMatchObject({ code: 'wallet_not_found' });
    expect(await actionCount()).toBe(0);
  });

  it.each([
    ['a user id that is not one', { userId: 'nobody' }],
    ['an action type outside the ruleset shape', { actionType: 'Not A Code' }],
    ['a fractional duration', { durationSeconds: 1.5 }],
    ['a blank idempotency key', { idempotencyKey: '  ' }],
  ])('refuses %s before touching the database', async (_label, over) => {
    await ruleset(1, [{ credits: 7 }]);
    const user = await funded();
    await expect(beginPaidAction(on.db, ON, request(user, over))).rejects.toMatchObject({ code: 'invalid_request' });
    expect(await actionCount()).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * 3. The economy gate
 * ------------------------------------------------------------------ */

describe('nothing is charged while the economy is off', () => {
  it('refuses to start one, and writes nothing', async () => {
    await ruleset(1, [{ credits: 7 }]);
    const user = await funded();
    await expect(beginPaidAction(on.db, OFF, request(user))).rejects.toMatchObject({ name: 'PaidActionError', code: 'economy_disabled' });
    expect(await actionCount()).toBe(0);
    expect(await walletOf(user)).toMatchObject({ balance: 100, held: 0 });
  });

  it('refuses every settlement too, so a held action cannot be quietly finished', async () => {
    await ruleset(1, [{ credits: 7 }]);
    const user = await funded();
    const { action } = await beginPaidAction(on.db, ON, request(user));
    const selector = { actionId: action.id };
    for (const settle of [capturePaidAction, releasePaidAction, refundPaidAction]) {
      await expect(settle(on.db, OFF, selector)).rejects.toMatchObject({ code: 'economy_disabled' });
    }
    expect((await readPaidAction(on.db, user, 'req-1'))!.status).toBe('held');
  });

  it('still lets a past action and its configuration be read', async () => {
    await ruleset(1, [{ credits: 7 }]);
    const user = await funded();
    await beginPaidAction(on.db, ON, request(user));
    expect((await readPaidAction(on.db, user, 'req-1'))!.amount).toBe(7);
  });
});

/* ------------------------------------------------------------------ *
 * 4. Idempotency and correlation across the whole operation
 * ------------------------------------------------------------------ */

describe('one request is one charge, however many times it arrives', () => {
  it('a replay returns the action already started and holds nothing more', async () => {
    await ruleset(1, [{ credits: 7 }]);
    const user = await funded();
    const first = await beginPaidAction(on.db, ON, request(user));
    const again = await beginPaidAction(on.db, ON, request(user));

    expect(again.replayed).toBe(true);
    expect(again.action).toEqual(first.action);
    expect(await actionCount()).toBe(1);
    expect(await walletOf(user)).toMatchObject({ balance: 93, held: 7 });
  });

  it('concurrent duplicates start exactly one action, and every caller gets it', async () => {
    await ruleset(1, [{ credits: 7 }]);
    const user = await funded();
    const results = await Promise.all(Array.from({ length: 6 }, () => beginPaidAction(on.db, ON, request(user))));

    expect(new Set(results.map((r) => r.action.id)).size).toBe(1);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(await actionCount()).toBe(1);
    // One grant and one hold: the same Credits were never held twice.
    expect(await ledgerCount(user)).toBe(2);
    expect(await walletOf(user)).toMatchObject({ balance: 93, held: 7 });
  });

  it('a replay after capture returns the captured action -- it does not start a second one', async () => {
    await ruleset(1, [{ credits: 7 }]);
    const user = await funded();
    const { action } = await beginPaidAction(on.db, ON, request(user));
    await capturePaidAction(on.db, ON, { actionId: action.id });

    const again = await beginPaidAction(on.db, ON, request(user));
    expect(again).toMatchObject({ replayed: true, action: { status: 'captured' } });
    expect(await actionCount()).toBe(1);
  });

  it('the same key for a materially different action is refused, and writes nothing', async () => {
    await ruleset(1, [{ credits: 7 }, { action: 'voice_note', credits: 3 }]);
    const user = await funded();
    await beginPaidAction(on.db, ON, request(user));
    await expect(beginPaidAction(on.db, ON, request(user, { actionType: 'voice_note' }))).rejects.toMatchObject({
      name: 'PaidActionError',
      code: 'idempotency_conflict',
    });
    expect(await actionCount()).toBe(1);
    expect(await walletOf(user)).toMatchObject({ balance: 93, held: 7 });
  });

  it('a refused start does not use up its key: a retry is evaluated afresh', async () => {
    await ruleset(1, [{ credits: 500 }]);
    const user = await funded(100);
    await expect(beginPaidAction(on.db, ON, request(user))).rejects.toMatchObject({ code: 'insufficient_credits' });

    await ruleset(2, [{ credits: 7 }]);
    const retried = await beginPaidAction(on.db, ON, request(user));
    expect(retried.replayed).toBe(false);
    expect(retried.action.amount).toBe(7);
  });

  it("one user's key never reaches another user's action", async () => {
    await ruleset(1, [{ credits: 7 }]);
    const [alice, bob] = [await funded(), await funded()];
    const a = await beginPaidAction(on.db, ON, request(alice));
    const b = await beginPaidAction(on.db, ON, request(bob));
    expect(b.replayed).toBe(false);
    expect(b.action.id).not.toBe(a.action.id);
  });

  it('carries the request id and the action onto every ledger row of the operation', async () => {
    await ruleset(1, [{ credits: 7 }]);
    const user = await funded();
    const { action } = await beginPaidAction(on.db, ON, request(user));
    await capturePaidAction(on.db, ON, { actionId: action.id });
    await refundPaidAction(on.db, ON, { actionId: action.id }, { reason: 'the clip never arrived' });

    const rows = (
      await q<{ entry_type: string; source_type: string; source_id: string; request_id: string }>(
        `SELECT entry_type, source_type, source_id, request_id FROM wallet_transactions
          WHERE user_id = $1 AND source_type IS NOT NULL ORDER BY sequence`,
        [user],
      )
    ).rows;
    expect(rows.map((r) => r.entry_type)).toEqual(['hold', 'capture', 'refund']);
    for (const row of rows) {
      expect(row).toMatchObject({ source_type: 'paid_action', source_id: action.id, request_id: 'corr-1' });
    }
  });
});

/* ------------------------------------------------------------------ *
 * 5. Settlement: capture, release, refund
 * ------------------------------------------------------------------ */

describe('settling a held action', () => {
  const start = async (credits = 7, funds = 100) => {
    await ruleset(1, [{ credits }]);
    const user = await funded(funds);
    const { action } = await beginPaidAction(on.db, ON, request(user));
    return { user, action, selector: { actionId: action.id } };
  };

  it('capture consumes exactly what was reserved, and nothing more', async () => {
    const { user, selector } = await start();
    const { action, replayed } = await capturePaidAction(on.db, ON, selector);

    expect(replayed).toBe(false);
    expect(action).toMatchObject({ status: 'captured', amount: 7 });
    expect(action.settlementTransactionId).not.toBeNull();
    expect(action.settledAt).not.toBeNull();
    // The 7 held Credits are gone; the other 93 are untouched.
    expect(await walletOf(user)).toMatchObject({ balance: 93, held: 0 });
  });

  it('release returns the whole reservation: the customer is exactly as they started', async () => {
    const { user, selector } = await start();
    const { action } = await releasePaidAction(on.db, ON, selector, { reason: 'the provider timed out' });

    expect(action).toMatchObject({ status: 'released', failureReason: 'the provider timed out' });
    expect(await walletOf(user)).toMatchObject({ balance: 100, held: 0 });
  });

  it('refund returns Credits already consumed, and only after a capture', async () => {
    const { user, selector } = await start();
    await expect(refundPaidAction(on.db, ON, selector)).rejects.toMatchObject({ code: 'invalid_state' });

    await capturePaidAction(on.db, ON, selector);
    const { action } = await refundPaidAction(on.db, ON, selector, { reason: 'the clip never arrived' });
    expect(action).toMatchObject({ status: 'refunded' });
    expect(action.refundTransactionId).not.toBeNull();
    expect(await walletOf(user)).toMatchObject({ balance: 100, held: 0 });
  });

  it.each([
    ['capture', capturePaidAction, 'captured'],
    ['release', releasePaidAction, 'released'],
  ])('%s is idempotent: a second one returns the same action and moves nothing', async (_label, settle, status) => {
    const { user, selector } = await start();
    const first = await settle(on.db, ON, selector);
    const before = await walletOf(user);
    const again = await settle(on.db, ON, selector);

    expect(again).toEqual({ action: first.action, replayed: true });
    expect(await walletOf(user)).toEqual(before);
    expect(first.action.status).toBe(status);
  });

  it('a refund is idempotent too', async () => {
    const { user, selector } = await start();
    await capturePaidAction(on.db, ON, selector);
    const first = await refundPaidAction(on.db, ON, selector);
    const again = await refundPaidAction(on.db, ON, selector);
    expect(again).toEqual({ action: first.action, replayed: true });
    expect(await walletOf(user)).toMatchObject({ balance: 100, held: 0 });
  });

  it.each([
    ['capture a released action', 'release', capturePaidAction],
    ['release a captured action', 'capture', releasePaidAction],
  ])('refuses to %s', async (_label, firstStep, second) => {
    const { user, selector } = await start();
    await (firstStep === 'release' ? releasePaidAction : capturePaidAction)(on.db, ON, selector);
    const before = await walletOf(user);
    await expect(second(on.db, ON, selector)).rejects.toMatchObject({ name: 'PaidActionError', code: 'invalid_state' });
    expect(await walletOf(user)).toEqual(before);
  });

  it('settles by the key the caller started with, not only by id', async () => {
    const { user } = await start();
    const { action } = await capturePaidAction(on.db, ON, { userId: user, idempotencyKey: 'req-1' });
    expect(action.status).toBe('captured');
  });

  it('an action nobody started cannot be settled', async () => {
    await expect(capturePaidAction(on.db, ON, { actionId: randomUUID() })).rejects.toMatchObject({ code: 'action_not_found' });
  });

  it('leaves the wallet reconciled with its ledger through the whole lifecycle', async () => {
    const { user, selector } = await start();
    await capturePaidAction(on.db, ON, selector);
    await refundPaidAction(on.db, ON, selector);
    expect((await reconcileWallet(on.db, user, 'credits')).status).toBe('clean');
  });

  it('two actions of the same user settle independently', async () => {
    await ruleset(1, [{ credits: 7 }]);
    const user = await funded();
    const one = await beginPaidAction(on.db, ON, request(user, { idempotencyKey: 'a' }));
    const two = await beginPaidAction(on.db, ON, request(user, { idempotencyKey: 'b' }));
    expect(await walletOf(user)).toMatchObject({ balance: 86, held: 14 });

    await capturePaidAction(on.db, ON, { actionId: one.action.id });
    await releasePaidAction(on.db, ON, { actionId: two.action.id });
    expect(await walletOf(user)).toMatchObject({ balance: 93, held: 0 });
    expect((await reconcileWallet(on.db, user, 'credits')).status).toBe('clean');
  });
});

/* ------------------------------------------------------------------ *
 * 6. The whole operation: hold, work, capture -- release on failure
 * ------------------------------------------------------------------ */

describe('running an action around the caller\'s work', () => {
  const priced = async (credits = 7) => {
    await ruleset(1, [{ credits }]);
    return funded();
  };

  it('holds, runs the work once, then captures -- and hands back what the work produced', async () => {
    const user = await priced();
    const seen: Array<{ status: string; amount: number }> = [];
    const run = await runPaidAction(on.db, ON, request(user), async ({ action }) => {
      // The work sees the Credits already reserved, and the wallet agrees.
      seen.push({ status: action.status, amount: action.amount });
      expect(await walletOf(user)).toMatchObject({ balance: 93, held: 7 });
      return { clipId: 'c-1' };
    });

    expect(seen).toEqual([{ status: 'held', amount: 7 }]);
    expect(run).toMatchObject({ replayed: false, result: { clipId: 'c-1' }, action: { status: 'captured' } });
    expect(await walletOf(user)).toMatchObject({ balance: 93, held: 0 });
  });

  it('releases the reservation when the work fails, and re-throws what actually went wrong', async () => {
    const user = await priced();
    const failure = new Error('the provider refused the prompt');
    await expect(runPaidAction(on.db, ON, request(user), async () => { throw failure; })).rejects.toBe(failure);

    const action = (await readPaidAction(on.db, user, 'req-1'))!;
    expect(action).toMatchObject({ status: 'released', failureReason: 'the provider refused the prompt' });
    expect(await walletOf(user)).toMatchObject({ balance: 100, held: 0 });
    expect((await reconcileWallet(on.db, user, 'credits')).status).toBe('clean');
  });

  it('treats a cancellation exactly as a failure: the Credits go back', async () => {
    const user = await priced();
    await expect(runPaidAction(on.db, ON, request(user), async () => { throw new Error('cancelled by the customer'); })).rejects.toThrow(
      'cancelled by the customer',
    );
    expect((await readPaidAction(on.db, user, 'req-1'))!.status).toBe('released');
    expect(await walletOf(user)).toMatchObject({ balance: 100, held: 0 });
  });

  it('does NOT run the work again on a replay, and says so rather than inventing a result', async () => {
    const user = await priced();
    let runs = 0;
    const work = async () => {
      runs += 1;
      return 'done';
    };
    const first = await runPaidAction(on.db, ON, request(user), work);
    const again = await runPaidAction(on.db, ON, request(user), work);

    expect(runs).toBe(1);
    expect(first).toMatchObject({ replayed: false, result: 'done' });
    expect(again).toEqual({ action: first.action, replayed: true, result: null });
    expect(await walletOf(user)).toMatchObject({ balance: 93, held: 0 });
  });

  it('never reaches the work when the action cannot be priced or paid for', async () => {
    const user = await funded(1);
    await ruleset(1, [{ credits: 500 }]);
    let ran = false;
    await expect(
      runPaidAction(on.db, ON, request(user), async () => {
        ran = true;
        return 1;
      }),
    ).rejects.toMatchObject({ code: 'insufficient_credits' });
    expect(ran).toBe(false);
    expect(await actionCount()).toBe(0);
  });

  it('concurrent runs of the same request do the work once', async () => {
    const user = await priced();
    let runs = 0;
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        runPaidAction(on.db, ON, request(user), async () => {
          runs += 1;
          return 'done';
        }),
      ),
    );
    expect(runs).toBe(1);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(await actionCount()).toBe(1);
    expect((await reconcileWallet(on.db, user, 'credits')).status).toBe('clean');
  });
});

/* ------------------------------------------------------------------ *
 * 7. The boundaries this framework must keep
 * ------------------------------------------------------------------ */

describe('the framework stays a framework', () => {
  const src = fileURLToPath(new URL('..', import.meta.url));
  const SERVICE = 'services/paid-action-service.ts';

  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return name === 'test' ? [] : sourceFiles(path);
      return name.endsWith('.ts') && !name.endsWith('.test.ts') ? [path] : [];
    });
  }
  const application = () => sourceFiles(src).map((path) => relative(src, path).split('\\').join('/'));
  const read = (rel: string) => readFileSync(join(src, rel), 'utf8');

  it('implements no particular paid action: it knows nothing of chat, media, providers or content', () => {
    const source = read(SERVICE);
    const forbidden = /from '[^']*(media|message|conversation|character|content|provider|generation|subscription|entitlement)[^']*\.js'/g;
    expect(source.match(forbidden)).toBeNull();
  });

  it('nothing in the application calls it yet -- P7.2 is the first caller', () => {
    const callers = application()
      .filter((rel) => rel !== SERVICE)
      .filter((rel) => /paid-action-service/.test(read(rel)));
    expect(callers).toEqual([]);
  });

  it('only this table is its own: the money stays in the P2 ledger', () => {
    const source = read(SERVICE);
    // Its single schema import, and the wallet reached only through the service.
    expect(source.match(/from '\.\.\/db\/schema\.js'/g)).toHaveLength(1);
    expect(source).toMatch(/import \{[^}]*paidActions[^}]*\} from '\.\.\/db\/schema\.js'/);
    const fromWallet = source.match(/import \{([^}]*)\} from '\.\/wallet-service\.js'/)![1]!;
    expect(
      fromWallet
        .split(',')
        .map((name) => name.trim().replace(/^type /, ''))
        .filter(Boolean)
        .sort(),
    ).toEqual(['CREDITS_CURRENCY', 'WalletOperationResult', 'captureHold', 'holdCredits', 'refundTransaction', 'releaseHold']);
  });

  it('chooses no configuration for itself: every version comes from the P1.2 resolver', () => {
    const source = read(SERVICE);
    expect(source).not.toMatch(/economy_(plans|packs|rulesets|plan_versions|pack_versions|ruleset_)/);
    expect(source).toMatch(/lockEconomyRefForRecording/);
  });
});
