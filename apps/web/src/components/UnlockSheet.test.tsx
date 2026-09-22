import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { UnlockFailure } from '../lib/contentUnlock';
import UnlockSheet from './UnlockSheet';

/**
 * P8.2 -- the confirmation a customer agrees to spend Credits in.
 *
 * Every number rendered below is passed in, exactly as the server stated it.
 * The sheet performs no arithmetic and makes no judgement about affordability,
 * so there is nothing here that could disagree with the server.
 */

const sheet = (
  over: {
    target?: { assetId: string; title: string; creditPrice: number | null };
    balance?: number | null;
    busy?: boolean;
    failure?: UnlockFailure | null;
  } = {},
) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <UnlockSheet
        target={over.target ?? { assetId: 'a-1', title: 'Post 3', creditPrice: 50 }}
        balance={over.balance === undefined ? 120 : over.balance}
        busy={over.busy ?? false}
        failure={over.failure ?? null}
        onConfirm={() => {}}
        onCancel={() => {}}
      />
    </MemoryRouter>,
  );

describe('what the confirmation states', () => {
  it("names the content, the exact price and the customer's Credits, with both ways out", () => {
    const html = sheet();
    expect(html).toContain('Post 3');
    // The price, in the heading and on the action.
    expect(html).toContain('Unlock this for 50 Credits?');
    expect(html).toContain('Unlock · 50 Credits');
    // What they have, said separately from what it costs.
    expect(html).toContain('Your Credits');
    expect(html).toContain('120 Credits');
    expect(html).toContain('Not now');
  });

  it('behaves as a dialog, and is labelled by its own heading', () => {
    const html = sheet();
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-labelledby="unlock-sheet-title"');
    expect(html).toContain('id="unlock-sheet-title"');
  });

  it('does no arithmetic: it never says what would be left, and never judges affordability', () => {
    const html = sheet({ balance: 10, target: { assetId: 'a-1', title: 'Post 3', creditPrice: 50 } });
    expect(html).toContain('10 Credits');
    expect(html).toContain('50 Credits');
    expect(html).not.toMatch(/left|remaining|after this|can't afford|cannot afford|not enough/i);
    // The action is still the server's to refuse -- this screen does not pre-empt it.
    expect(html).not.toContain('disabled=""');
  });

  it('says a balance it does not know is unavailable, rather than showing zero', () => {
    // A price with no zero in it, so "0 Credits" could only come from the balance.
    const html = sheet({ balance: null, target: { assetId: 'a-1', title: 'Post 3', creditPrice: 7 } });
    expect(html).toContain('Not available');
    expect(html).not.toContain('0 Credits');
  });

  it('uses the singular for one Credit, and never invents a price the server did not send', () => {
    expect(sheet({ target: { assetId: 'a-1', title: 'Post 3', creditPrice: 1 }, balance: 1 })).toContain('1 Credit?');
    const unpriced = sheet({ target: { assetId: 'a-1', title: 'Post 3', creditPrice: null } });
    expect(unpriced).toContain('Unlock this for Credits?');
    expect(unpriced).not.toMatch(/NaN|undefined|null/);
  });

  it('speaks no backend terms', () => {
    expect(sheet()).not.toMatch(/wallet|ledger|entitlement|offer|held|spendable|idempotenc/i);
  });
});

describe('while it is sending', () => {
  it('says so, and neither action can be pressed again', () => {
    const html = sheet({ busy: true });
    expect(html).toContain('Unlocking…');
    expect(html).not.toContain('Unlock · 50 Credits');
    expect(html).toContain('aria-busy="true"');
    // Both the confirm and the cancel: it cannot be dismissed mid-request.
    expect(html.match(/disabled=""/g)).toHaveLength(2);
  });
});

describe('when the server refuses', () => {
  const failure = (over: Partial<UnlockFailure> = {}): UnlockFailure => ({
    code: 'insufficient_credits',
    message: "You don't have enough Credits to unlock this. Nothing was charged.",
    action: { label: 'Get Credits', to: '/credits' },
    retryable: false,
    ...over,
  });

  it('stays open, says why as an alert, and offers the way out', () => {
    const html = sheet({ failure: failure() });
    expect(html).toContain('role="alert"');
    expect(html).toContain('Nothing was charged');
    expect(html).toContain('href="/credits"');
    expect(html).toContain('Get Credits');
    // And the customer can still try, or leave.
    expect(html).toContain('Not now');
  });

  it('shows a refusal with nowhere to go without inventing a link', () => {
    const html = sheet({ failure: failure({ code: 'unavailable', message: "This content isn't available any more.", action: null }) });
    expect(html).toContain('available any more');
    expect(html).not.toContain('href="/credits"');
    expect(html).not.toContain('href="/subscription"');
  });

  it('never claims the content was unlocked', () => {
    const html = sheet({ failure: failure() });
    expect(html).not.toMatch(/unlocked\b|you own|owned/i);
  });
});
