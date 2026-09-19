import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { AdminUserSubscription } from '@over18/shared';
import {
  ACTION_LABEL,
  currentText,
  emptySubscriptionForm,
  historyChangeText,
  planLabel,
  subscriptionChangeBlocked,
  subscriptionChangeRequest,
  subscriptionConfirmation,
} from './userSubscription';

/**
 * P3.5 a user's subscription in Admin -> Users, as pure logic. The server owns
 * every lifecycle rule, plan and figure; these helpers shape a request from its
 * answers and put them into words. Figures below are arbitrary test data.
 */

const plan = (code: string, over: Partial<AdminUserSubscription['plans'][number]> = {}) => ({
  code,
  version: 3,
  versionId: `v-${code}`,
  displayName: `Plan ${code}`,
  billingPeriodMonths: 7,
  monthlyIncludedCredits: 13,
  priceMinor: 1234,
  currency: 'USD',
  ...over,
});

const view = (over: Partial<AdminUserSubscription> = {}): AdminUserSubscription => ({
  userId: 'u-1',
  economyEnabled: true,
  version: 4,
  current: {
    plan: { ...plan('test_plan_a'), live: true },
    status: 'active',
    storedStatus: 'active',
    currentPeriodEnd: '2026-10-01T00:00:00.000Z',
    premium: true,
  },
  history: [],
  plans: [plan('test_plan_a'), plan('test_plan_b', { billingPeriodMonths: 1 })],
  actions: ['change_plan', 'cancel', 'end'],
  change: { allowed: true },
  ...over,
});

describe('the subscription, in words', () => {
  it("names a catalogue plan by the server's figures", () => {
    expect(planLabel(plan('test_plan_a'))).toBe('Plan test_plan_a (test_plan_a v3) — 7 months, 13 Credits/month');
    expect(planLabel(plan('test_plan_b', { billingPeriodMonths: 1 }))).toContain('1 month,');
  });

  it('says what the user holds now -- including nothing, cancelled, expired and a plan that is no longer published', () => {
    expect(currentText(view({ current: null }))).toBe('No subscription — Free.');
    expect(currentText(view())).toBe('Plan test_plan_a (test_plan_a v3) — active, Premium; period ends 2026-10-01 00:00 UTC.');
    const c = view().current!;
    expect(currentText(view({ current: { ...c, status: 'past_due' } }))).toContain('past due, Premium');
    expect(currentText(view({ current: { ...c, status: 'cancelled' } }))).toBe('Plan test_plan_a (test_plan_a v3) — cancelled: Premium until 2026-10-01 00:00 UTC, then it ends.');
    expect(currentText(view({ current: { ...c, status: 'expired', premium: false } }))).toContain('expired 2026-10-01 00:00 UTC: Free.');
    expect(currentText(view({ current: { ...c, plan: { ...c.plan, live: false }, premium: false } }))).toContain('no longer published, so it gives no Premium');
  });

  it('shows each recorded change from -> to', () => {
    const to = { planCode: 'test_plan_b', planVersion: 1, status: 'past_due' as const, currentPeriodEnd: '2026-10-01T00:00:00.000Z' };
    const entry = { sequence: 2, change: 'change_plan' as const, source: 'admin' as const, effectiveAt: '2026-09-19T10:00:00.000Z', to, actorUserId: 'a', actorEmail: 'a@example.com', reason: 'r', reference: null };
    expect(historyChangeText({ ...entry, from: null })).toBe('no subscription → test_plan_b v1 · past due');
    expect(historyChangeText({ ...entry, from: { ...to, planCode: 'test_plan_a', planVersion: 3, status: 'active' } })).toBe('test_plan_a v3 · active → test_plan_b v1 · past due');
  });

  it("puts the server's refusal into words, and nothing when it allows", () => {
    expect(subscriptionChangeBlocked({ allowed: true })).toBeNull();
    expect(subscriptionChangeBlocked({ allowed: false, reason: 'permission_required' })).toMatch(/users\.subscription\.manage/);
    expect(subscriptionChangeBlocked({ allowed: false, reason: 'own_account' })).toMatch(/your own subscription/);
    expect(subscriptionChangeBlocked({ allowed: false, reason: 'economy_disabled' })).toMatch(/economy is switched off/);
  });
});

describe('a change request', () => {
  it('starts on the first change the server allows now', () => {
    expect(emptySubscriptionForm(view()).action).toBe('change_plan');
    expect(emptySubscriptionForm(view({ current: null, actions: ['assign'] })).action).toBe('assign');
  });

  it('names the version the server sent, a plan only where one is needed, and a trimmed reason', () => {
    expect(subscriptionChangeRequest({ action: 'change_plan', planCode: 'test_plan_b', reason: '  Upgrade  ', reference: ' T-1 ' }, view())).toEqual({
      ok: true,
      value: { action: 'change_plan', planCode: 'test_plan_b', expectedVersion: 4, reason: 'Upgrade', reference: 'T-1' },
    });
    expect(subscriptionChangeRequest({ action: 'cancel', planCode: 'test_plan_b', reason: 'Asked to', reference: '' }, view())).toEqual({
      ok: true,
      value: { action: 'cancel', expectedVersion: 4, reason: 'Asked to', reference: null },
    });
  });

  it('refuses what the server did not offer: an action the state does not allow, a plan not in the catalogue, no reason', () => {
    const refused = subscriptionChangeRequest({ action: 'assign', planCode: 'no_such_plan', reason: ' ', reference: '' }, view());
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.errors).toEqual([
      'Assign a plan is not possible for this subscription now.',
      'Choose a plan from the catalogue.',
      'A reason is required. It is recorded in the subscription history and the audit log.',
    ]);
  });
});

describe('the confirmation', () => {
  it('says exactly what each change does -- and that no money or Credits move', () => {
    const v = view();
    const assign = subscriptionConfirmation({ action: 'assign', planCode: 'test_plan_b', expectedVersion: 0, reason: 'Comp' }, v, 'c@example.com');
    expect(assign.title).toBe('Assign Plan test_plan_b to c@example.com?');
    expect(assign.body).toContain('one billing period of the plan (1 month)');
    const change = subscriptionConfirmation({ action: 'change_plan', planCode: 'test_plan_b', expectedVersion: 4, reason: 'Upgrade' }, v, 'c@example.com');
    expect(change.body).toContain('The status and the period end (2026-10-01 00:00 UTC) stay as they are');
    const cancel = subscriptionConfirmation({ action: 'cancel', expectedVersion: 4, reason: 'Asked to' }, v, 'c@example.com');
    expect(cancel.body).toContain('Premium continues until 2026-10-01 00:00 UTC, then ends.');
    const end = subscriptionConfirmation({ action: 'end', expectedVersion: 4, reason: 'Refund' }, v, 'c@example.com');
    expect(end.body).toContain('Premium ends immediately');
    for (const c of [assign, change, cancel, end]) {
      expect(c.body).toContain('No payment is taken or refunded, and no Credits are granted or removed.');
      expect(c.body).toMatch(/reason: "/);
    }
    expect(ACTION_LABEL.end).toBe('End now');
  });

  it('writes no plan, price, period or Credit amount into the web code: they come from the catalogue', () => {
    for (const rel of ['./userSubscription.ts', '../pages/admin/UserSubscriptionPanel.tsx']) {
      const source = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
      expect(source, rel).not.toMatch(/premium_(monthly|quarterly|annual)|\$\d|\b(12\.99|29\.99|89\.99|200 Credits)\b/i);
    }
  });
});
