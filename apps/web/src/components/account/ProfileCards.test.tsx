import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { CustomerCommercialState, SubscriptionStatus } from '@over18/shared';
import type { CustomerEconomyState } from '../../lib/customerEconomy';
import { PREMIUM_SUMMARY, formatPlanDate, membershipView } from '../../lib/membership';
import { CreditsCard, IdentityHeader, MembershipCard, SignOutLink } from './ProfileCards';

/**
 * Profile redesign -- what the page says to a Free and to a Premium customer,
 * decided from the server's facts only, and rendered statically.
 */

const render = (node: JSX.Element) => renderToStaticMarkup(<MemoryRouter>{node}</MemoryRouter>);
// Midday UTC: the same calendar date in every time zone a test machine might use.
const PERIOD_END = '2026-11-02T12:00:00.000Z';
const DATE = formatPlanDate(PERIOD_END)!;

const PLANS = [
  { code: 'premium_monthly', version: 1, versionId: 'v1', displayName: 'Premium monthly', billingPeriodMonths: 1, priceMinor: 1299, currency: 'USD', monthlyIncludedCredits: 200, isPurchasable: true, effectiveFrom: '' },
  { code: 'premium_legacy', version: 1, versionId: 'v2', displayName: 'Premium (legacy)', billingPeriodMonths: 1, priceMinor: 999, currency: 'USD', monthlyIncludedCredits: 100, isPurchasable: false, effectiveFrom: '' },
];

function ready(tier: 'free' | 'premium' | null, subscription: { status: SubscriptionStatus; planCode?: string; cancelAtPeriodEnd?: boolean; currentPeriodEnd?: string } | null | 'unavailable' = null, spendable: number | null = 850): CustomerEconomyState {
  const commercial = {
    viewer: { userId: 'u' },
    economyEnabled: true,
    tier: tier === null ? { available: false, reason: 'subscription_unresolvable' } : { available: true, value: tier },
    subscription:
      subscription === 'unavailable'
        ? { available: false, reason: 'subscription_unresolvable' }
        : {
            available: true,
            value: subscription && {
              status: subscription.status,
              planCode: subscription.planCode ?? 'premium_monthly',
              currentPeriodEnd: subscription.currentPeriodEnd ?? PERIOD_END,
              cancelAtPeriodEnd: subscription.cancelAtPeriodEnd ?? subscription.status === 'cancelled',
            },
          },
    wallet: spendable === null ? { available: false, reason: 'wallet_not_supported' } : { available: true, value: { included: 0, earned: 0, purchased: spendable, bonus: 0, held: 0, spendable } },
    age: { available: false, reason: 'age_verification_not_supported' },
  } as unknown as CustomerCommercialState;
  return { status: 'ready', overview: { commercial, catalog: { asOf: '', plans: PLANS, packs: [], actionCosts: [] }, actions: [] } };
}

describe('membership, from the server facts', () => {
  it('a Free customer: Free, the Premium summary, and ONE "Go Premium" to the Premium page', () => {
    const view = membershipView(ready('free', null));
    expect(view).toEqual({ kind: 'free' });
    const html = render(<MembershipCard view={view} />);
    expect(html).toContain('Free plan');
    expect(html).toContain(PREMIUM_SUMMARY);
    expect(html.match(/Go Premium/g)).toHaveLength(1);
    expect(html).toMatch(/<a(?=[^>]*href="\/subscription")(?=[^>]*data-testid="profile-go-premium")[^>]*>Go Premium<\/a>/);
  });

  it('an expired subscription is Free (the server says so): offered Premium again', () => {
    expect(membershipView(ready('free', { status: 'expired' }))).toEqual({ kind: 'free' });
  });

  it('an active Premium customer: the plan name and renewal date -- and NEVER "Go Premium"', () => {
    const view = membershipView(ready('premium', { status: 'active' }));
    expect(view).toEqual({ kind: 'premium', planName: 'Premium monthly', status: 'active', cancelling: false, dateLine: `Renews ${DATE}`, notice: null });
    const html = render(<MembershipCard view={view} />);
    expect(html).toContain('Premium monthly');
    expect(html).toContain(`Renews ${DATE}`);
    expect(html).not.toMatch(/Go Premium|Free plan|Cancelled/);
  });

  it('cancelling: "Premium until <date>" and that it will not renew -- shown only when the server says cancelled', () => {
    const view = membershipView(ready('premium', { status: 'cancelled' }));
    expect(view).toMatchObject({ cancelling: true, dateLine: `Premium until ${DATE}` });
    const html = render(<MembershipCard view={view} />);
    expect(html).toContain(`Premium until ${DATE}`);
    expect(html).toContain('Cancelled, will not renew');
    expect(html).not.toMatch(/Renews|Go Premium/);
    // An active subscription is never described as cancelled.
    expect(render(<MembershipCard view={membershipView(ready('premium', { status: 'active' }))} />)).not.toContain('Cancelled');
  });

  it.each([
    ['past_due', 'Your last payment did not go through.'],
    ['grace', 'Your payment is overdue; Premium continues for now.'],
  ] as const)('%s: still Premium, the period end stated as such, and the payment problem said plainly', (status, notice) => {
    const view = membershipView(ready('premium', { status }));
    expect(view).toMatchObject({ kind: 'premium', status, cancelling: false, dateLine: `Current period ends ${DATE}`, notice });
    const html = render(<MembershipCard view={view} />);
    expect(html).toContain(notice);
    expect(html).not.toMatch(/Renews|Go Premium/);
  });

  it('nothing is invented: no date without one, a retired plan still named, "Premium" when the plan cannot be named', () => {
    expect(membershipView(ready('premium', { status: 'active', currentPeriodEnd: 'not-a-date' }))).toMatchObject({ dateLine: null });
    expect(membershipView(ready('premium', { status: 'active', planCode: 'premium_legacy' }))).toMatchObject({ planName: 'Premium (legacy)' });
    expect(membershipView(ready('premium', { status: 'active', planCode: 'unknown_plan' }))).toMatchObject({ planName: 'Premium' });
    // Premium per the server, but no subscription record to read: the name only.
    expect(membershipView(ready('premium', 'unavailable'))).toEqual({ kind: 'premium', planName: 'Premium', status: null, cancelling: false, dateLine: null, notice: null });
  });

  it('while loading, or when the tier is not stated: no plan is claimed at all', () => {
    expect(membershipView({ status: 'loading' })).toEqual({ kind: 'loading' });
    expect(membershipView(ready(null))).toEqual({ kind: 'unavailable' });
    expect(membershipView({ status: 'disabled', message: 'off' })).toEqual({ kind: 'unavailable' });
    expect(render(<MembershipCard view={{ kind: 'unavailable' }} />)).toBe('');
    expect(render(<MembershipCard view={{ kind: 'loading' }} />)).not.toMatch(/Free plan|Premium|Go Premium/);
  });
});

describe('identity', () => {
  it('the email wraps instead of overflowing; the Premium badge only for Premium', () => {
    const long = 'a.very.long.email.address.for.testing.overflow@subdomain.example-company.test';
    const html = render(<IdentityHeader email={long} premium />);
    expect(html).toMatch(/data-testid="profile-email" class="[^"]*overflow-wrap:anywhere/);
    // A break opportunity at the @, so the address splits there before anywhere else.
    expect(html).toContain('a.very.long.email.address.for.testing.overflow<wbr/>@subdomain.example-company.test');
    expect(html).toContain('data-testid="profile-premium-badge"');
    expect(render(<IdentityHeader email="x@y.test" premium={false} />)).not.toContain('profile-premium-badge');
  });
});

describe('Credits', () => {
  it('one card with the server balance and "Top up" straight to /credits', () => {
    const html = render(<CreditsCard credits={1250} />);
    expect(html).toContain('1,250');
    expect(html).toMatch(/<a(?=[^>]*href="\/credits")(?=[^>]*data-testid="profile-top-up")[^>]*>Top up<\/a>/);
    // One combined number: no class breakdown.
    expect(html).not.toMatch(/purchased|included|earned|bonus/i);
  });

  it('nothing -- never a zero -- while the balance is not known', () => {
    expect(render(<CreditsCard credits={null} />)).toBe('');
  });

  it('the Membership card no longer carries a balance', () => {
    for (const view of [membershipView(ready('free')), membershipView(ready('premium', { status: 'active' }))]) {
      const html = render(<MembershipCard view={view} />);
      expect(html).not.toMatch(/850|Credits available|href="\/credits"/);
    }
  });
});

describe('the page', () => {
  const page = readFileSync(join(fileURLToPath(new URL('../..', import.meta.url)), 'pages/ProfilePage.tsx'), 'utf8');

  it('has no placeholder settings and no oversized title block', () => {
    expect(page).not.toMatch(/Coming soon|PlaceholderRow|Notifications|Preferences|Privacy &amp; data|Privacy & data/);
    expect(page).not.toMatch(/PageHeader|Manage your account and preferences/);
  });

  it('keeps the working account actions: sign out, and sign in for a guest', () => {
    expect(page).toMatch(/<SignOutLink onSignOut=\{\(\) => void handleLogout\(\)\} \/>/);
    expect(page).toMatch(/to="\/login"/);
    let signedOut = false;
    const html = render(<SignOutLink onSignOut={() => (signedOut = true)} />);
    expect(html).toMatch(/<button type="button"[^>]*data-testid="profile-sign-out"[^>]*>Sign out<\/button>/);
    expect(signedOut).toBe(false); // rendering alone signs nobody out
  });

  it('never offers a subscription-management action: no customer route can manage one yet', () => {
    expect(page).not.toMatch(/Manage subscription/i);
    expect(render(<MembershipCard view={membershipView(ready('premium', { status: 'active' }))} />)).not.toMatch(/Manage|Resume/i);
  });
});
