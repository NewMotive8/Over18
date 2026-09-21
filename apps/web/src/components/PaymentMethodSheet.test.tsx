import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { PlanCatalog } from './CustomerEconomy';
import PaymentMethodSheet from './PaymentMethodSheet';
import type { CustomerEconomyOverview } from '../lib/customerEconomy';

/**
 * P9.1 -- choosing a plan and a payment method.
 *
 * Every figure rendered here is passed in exactly as the server stated it.
 * Nothing on these surfaces prices anything, and nothing claims a payment
 * happened: pressing a method only starts a checkout.
 */

const sheet = (over: { busy?: boolean; error?: string | null } = {}) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <PaymentMethodSheet
        planName="Premium Monthly"
        price="$12.99 / month"
        busy={over.busy ?? false}
        error={over.error ?? null}
        onChoose={() => {}}
        onCancel={() => {}}
      />
    </MemoryRouter>,
  );

describe('the payment method sheet', () => {
  it('offers exactly the three intended methods, each marked as a test', () => {
    const html = sheet();
    for (const label of ['Apple Pay', 'Google Pay', 'PayPal']) expect(html).toContain(label);
    expect(html.match(/\(test\)/g)).toHaveLength(3);
    expect(html).toContain('Test payment');
    // No card fields anywhere: there is nothing to type a card into.
    expect(html).not.toMatch(/card number|cvv|expiry|<input/i);
  });

  it('names the plan and the server price, and computes neither', () => {
    const html = sheet();
    expect(html).toContain('Premium Monthly');
    expect(html).toContain('$12.99 / month');
  });

  it('behaves as a dialog with a way out', () => {
    const html = sheet();
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('Not now');
  });

  it('cannot be pressed twice while a checkout is starting', () => {
    const html = sheet({ busy: true });
    expect(html).toContain('Starting…');
    // Three methods and the cancel.
    expect(html.match(/disabled=""/g)).toHaveLength(4);
  });

  it('shows a refusal without claiming anything was paid', () => {
    const html = sheet({ error: 'This account already has an active subscription.' });
    expect(html).toContain('role="alert"');
    expect(html).toContain('already has an active subscription');
    expect(html).not.toMatch(/success|paid|premium is active/i);
  });
});

/* ------------------------------------------------------------------ *
 * The plan list
 * ------------------------------------------------------------------ */

const overview = (): CustomerEconomyOverview =>
  ({
    catalog: {
      asOf: '2026-09-21T00:00:00.000Z',
      plans: [
        {
          code: 'premium_monthly',
          version: 1,
          versionId: 'v1',
          displayName: 'Plan premium_monthly',
          billingPeriodMonths: 1,
          priceMinor: 1299,
          currency: 'USD',
          monthlyIncludedCredits: 200,
          isPurchasable: true,
          effectiveFrom: '2026-09-01T00:00:00.000Z',
        },
      ],
      packs: [],
    },
    commercial: null,
    actions: [],
  }) as unknown as CustomerEconomyOverview;

describe('the plan list', () => {
  it('offers a purchase when the surface can carry one', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <PlanCatalog overview={overview()} onBuy={() => {}} />
      </MemoryRouter>,
    );
    // One CTA, naming the period it will buy and carrying the server's price.
    expect(html).toContain('Choose Monthly');
    expect(html).toContain('$12.99 / month');
    expect(html).toContain('200 Credits');
    expect(html).not.toContain("Subscribing isn't available yet");
    expect(html).not.toContain('disabled=""');
  });

  it('says so plainly when it cannot -- the approved behaviour is unchanged', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <PlanCatalog overview={overview()} />
      </MemoryRouter>,
    );
    // A typographic apostrophe, so not the escaped ASCII one.
    expect(html).toContain('Subscribing isn\u2019t available yet');
    expect(html).toContain('disabled=""');
    expect(html).not.toContain('Choose Monthly');
  });
});
