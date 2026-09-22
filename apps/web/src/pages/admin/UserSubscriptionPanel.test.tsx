import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { AdminUserSubscription } from '@over18/shared';
import { emptySubscriptionForm } from '../../admin/userSubscription';
import { SubscriptionPanel, UserSubscription } from './UserSubscriptionPanel';

/**
 * P3.5 -- a user's plan and subscription on the User Detail, rendered
 * statically (the suite runs no effects). Everything shown is server-shaped
 * test data passed in.
 */

const render = (node: ReactNode) => renderToStaticMarkup(<MemoryRouter>{node}</MemoryRouter>);

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
  version: 2,
  current: {
    plan: { ...plan('test_plan_a'), live: true },
    status: 'active',
    storedStatus: 'active',
    currentPeriodEnd: '2026-10-01T00:00:00.000Z',
    premium: true,
  },
  history: [
    {
      sequence: 2,
      change: 'change_plan',
      source: 'admin',
      effectiveAt: '2026-09-19T12:00:00.000Z',
      from: { planCode: 'test_plan_b', planVersion: 1, status: 'active', currentPeriodEnd: '2026-10-01T00:00:00.000Z' },
      to: { planCode: 'test_plan_a', planVersion: 3, status: 'active', currentPeriodEnd: '2026-10-01T00:00:00.000Z' },
      actorUserId: 'op-1',
      actorEmail: 'operator@example.com',
      reason: 'Upgrade agreed',
      reference: 'T-9',
    },
    {
      sequence: 1,
      change: 'assign',
      source: 'admin',
      effectiveAt: '2026-09-01T12:00:00.000Z',
      from: null,
      to: { planCode: 'test_plan_b', planVersion: 1, status: 'active', currentPeriodEnd: '2026-10-01T00:00:00.000Z' },
      actorUserId: 'op-1',
      actorEmail: 'operator@example.com',
      reason: 'Outage goodwill',
      reference: null,
    },
  ],
  plans: [plan('test_plan_a'), plan('test_plan_b', { versionId: 'v-b', billingPeriodMonths: 1 })],
  actions: ['change_plan', 'cancel', 'end'],
  change: { allowed: true },
  ...over,
});

const panel = (v: AdminUserSubscription, form = emptySubscriptionForm(v), messages: string[] = []) =>
  render(<SubscriptionPanel view={v} form={form} onForm={() => {}} onReview={() => {}} busy={false} messages={messages} />);

describe('the plan and subscription panel', () => {
  it('shows what the user holds and every recorded change, newest first, with who and why', () => {
    const html = panel(view());
    expect(html).toContain('Plan test_plan_a (test_plan_a v3) — active, Premium; period ends 2026-10-01 00:00 UTC.');
    expect(html.match(/data-testid="subscription-history-row"/g)).toHaveLength(2);
    expect(html.indexOf('Upgrade agreed')).toBeLessThan(html.indexOf('Outage goodwill'));
    expect(html).toContain('test_plan_b v1 · active → test_plan_a v3 · active');
    expect(html).toContain('no subscription → test_plan_b v1 · active');
    expect(html).toContain('operator@example.com');
    expect(html).toContain('T-9');
  });

  it("offers exactly the changes the server allows, and the catalogue's plans -- the one held disabled for a change", () => {
    const html = panel(view());
    expect(html).toContain('data-testid="subscription-change-form"');
    expect(html).toContain('<option value="change_plan" selected="">Change plan</option>');
    expect(html).toContain('<option value="cancel">Cancel at period end</option>');
    expect(html).toContain('<option value="end">End now</option>');
    expect(html).not.toContain('value="assign"');
    expect(html).toContain('<option value="test_plan_a" disabled="">Plan test_plan_a (test_plan_a v3) — 7 months, 13 Credits/month</option>');
    expect(html).toContain('<option value="test_plan_b">Plan test_plan_b (test_plan_b v3) — 1 month, 13 Credits/month</option>');
    expect(html).toContain('Reason (required)');
    expect(html).toContain('Reference (optional)');
    // No reason yet: nothing to review.
    expect(html).toMatch(/<button type="submit" disabled=""[^>]*>Review change plan…/);
  });

  it('asks for no plan where none is needed', () => {
    const v = view();
    const html = panel(v, { action: 'cancel', planCode: '', reason: 'Asked to', reference: '' });
    expect(html).not.toContain('Choose a plan');
    expect(html).toMatch(/<button type="submit"[^>]*>Review cancel at period end…/);
    expect(html).not.toMatch(/<button type="submit" disabled=""/);
  });

  it('with no subscription: says Free, records nothing yet, and offers only assigning a plan', () => {
    const html = panel(view({ current: null, history: [], version: 0, actions: ['assign'] }));
    expect(html).toContain('No subscription — Free.');
    expect(html).toContain('No subscription change recorded.');
    expect(html).toContain('<option value="assign" selected="">Assign a plan</option>');
    expect(html).toContain('<option value="test_plan_a">');
  });

  it('offers nothing to submit when the server says no -- and says why', () => {
    for (const [reason, words] of [
      ['permission_required', 'users.subscription.manage'],
      ['own_account', 'your own subscription'],
      ['economy_disabled', 'economy is switched off'],
    ] as const) {
      const html = panel(view({ change: { allowed: false, reason } }));
      expect(html).toContain('data-testid="subscription-change-blocked"');
      expect(html).toContain(words);
      expect(html).not.toMatch(/<form|<textarea|<select/);
      // The subscription and its history are still shown.
      expect(html.match(/data-testid="subscription-history-row"/g)).toHaveLength(2);
    }
  });

  it("shows the server's refusal as it came, e.g. a conflict", () => {
    const html = panel(view(), undefined, ['This subscription has changed since you loaded it. Nothing was changed.']);
    expect(html).toContain('role="alert"');
    expect(html).toContain('changed since you loaded it');
  });

  it('asks the server for the subscription rather than assuming one', () => {
    expect(render(<UserSubscription userId="u-1" email="c@example.com" onChanged={() => {}} />)).toContain('Loading the subscription');
  });
});
