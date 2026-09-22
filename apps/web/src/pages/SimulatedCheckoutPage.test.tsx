import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import SimulatedCheckoutPage from './SimulatedCheckoutPage';

/**
 * P9 -- the screen standing in for the payment provider's hosted checkout.
 *
 * What matters here is that it can never be mistaken for a real payment, and
 * that it collects nothing. It decides nothing either: the outcome buttons ask
 * the SERVER to emit a provider event, and the server applies it.
 */

const page = () =>
  renderToStaticMarkup(
    <MemoryRouter initialEntries={['/fake-checkout/chk_abc123']}>
      <Routes>
        <Route path="/fake-checkout/:checkoutRef" element={<SimulatedCheckoutPage />} />
      </Routes>
    </MemoryRouter>,
  );

describe('the simulated checkout screen', () => {
  it('says it is a test before anything else, and says no money moves', () => {
    const html = page();
    expect(html).toContain('data-testid="simulated-banner"');
    expect(html).toContain('Test payment — not real');
    expect(html).toMatch(/no card is collected/i);
    expect(html).toMatch(/no money moves/i);
    expect(html).toContain('role="status"');
  });

  it('collects no payment details of any kind', () => {
    const html = page();
    expect(html).not.toMatch(/<input|card number|cvv|expiry|sort code|iban/i);
  });

  it('never dresses itself as a real provider', () => {
    const html = page();
    // It may not imply a real processor is taking the money.
    expect(html).not.toMatch(/stripe|paypal\.com|secure payment|verified by|3-?d secure/i);
  });
});
