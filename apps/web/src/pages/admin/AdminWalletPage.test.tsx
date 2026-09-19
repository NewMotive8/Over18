import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { AdminAdjustmentAllowance, AdminWalletSummary, AdminWalletTransaction } from '@over18/shared';
import { emptyAdjustment } from '../../admin/walletSupport';
import AdminWalletPage, { AccountCard, AdjustmentLimits, AdjustmentPanel, HistoryTable, WalletBalances } from './AdminWalletPage';

/**
 * P2.4 -- the admin Wallets page, rendered statically (the suite runs no
 * effects). Every figure is server-shaped test data passed in as props; the
 * page has none of its own.
 */

const render = (node: ReactNode) => renderToStaticMarkup(<MemoryRouter>{node}</MemoryRouter>);
const noop = () => {};

const wallet = (over: Partial<AdminWalletSummary> = {}): AdminWalletSummary => ({
  currency: 'credits',
  exists: true,
  balance: 37,
  held: 4,
  version: 6,
  classes: { included: { spendable: 11, held: 4 }, earned: { spendable: 21, held: 0 }, purchased: { spendable: 5, held: 0 } },
  ...over,
});

const allowances: AdminAdjustmentAllowance[] = [
  { currency: 'credits', credit: { cap: 77, used: 7, remaining: 70 }, debit: { cap: 33, used: 0, remaining: 33 } },
];

const transaction = (over: Partial<AdminWalletTransaction> = {}): AdminWalletTransaction => ({
  id: 't-1',
  sequence: 6,
  entryType: 'admin_adjustment',
  direction: 'credit',
  amount: 13,
  creditClass: 'earned',
  balanceAfter: 37,
  heldAfter: 4,
  relatedTransactionId: null,
  source: { type: 'support_reference', id: 'T-5' },
  reason: 'Goodwill for a failed image',
  actorUserId: 'operator-1',
  createdAt: '2026-09-19T10:00:00.000Z',
  ...over,
});

const panel = (over: Partial<Parameters<typeof AdjustmentPanel>[0]> = {}) =>
  render(
    <AdjustmentPanel
      currency="credits"
      allowances={allowances}
      blocked={null}
      form={null}
      onChoose={noop}
      onForm={noop}
      onReview={noop}
      busy={false}
      messages={[]}
      {...over}
    />,
  );

describe('the account and its balances', () => {
  it('confirms the account by email and permanent User ID', () => {
    const html = render(<AccountCard user={{ id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301', email: 'customer@example.com', createdAt: '2026-09-01T00:00:00.000Z' }} />);
    expect(html).toContain('customer@example.com');
    expect(html).toContain('3f2504e0-4f89-41d3-9a0c-0305e82c3301');
  });

  it('shows spendable and held apart, and every class', () => {
    const html = render(<WalletBalances wallet={wallet()} />);
    expect(html).toMatch(/data-testid="balance">37</);
    expect(html).toMatch(/data-testid="held">4</);
    expect(html.match(/data-testid="class-row"/g)).toHaveLength(3);
    expect(html).toContain('<td>21</td>');
  });

  it('says when the user has no wallet in that currency yet', () => {
    expect(render(<WalletBalances wallet={wallet({ exists: false, balance: 0, held: 0, version: 0 })} />)).toContain('No credits wallet yet');
  });

  it("shows the operator's remaining allowance exactly as the server sent it", () => {
    const html = render(<AdjustmentLimits allowance={allowances[0]!} />);
    expect(html).toContain('70 of 77 left today (UTC)');
    expect(html).toContain('33 of 33 left today (UTC)');
  });
});

describe('adjusting', () => {
  it('offers Credit and Debit as two separate actions', () => {
    const html = panel();
    expect(html).toMatch(/aria-pressed="false"[^>]*>Credit…/);
    expect(html).toMatch(/aria-pressed="false"[^>]*>Debit…/);
    expect(html).not.toContain('credit-form');
  });

  it('shows the chosen one\'s own form, with a required reason, an optional reference and its allowance', () => {
    const credit = panel({ form: emptyAdjustment('credit') });
    expect(credit).toContain('data-testid="credit-form"');
    expect(credit).toContain('Credit credits to this user');
    expect(credit).toContain('70 of 77 left today (UTC)');
    expect(credit).toContain('Reason (required)');
    expect(credit).toContain('Support reference (optional)');
    expect(credit).toMatch(/<button type="submit" disabled=""[^>]*>Review Credit…/);

    const debit = panel({ form: { ...emptyAdjustment('debit'), amount: '5', reason: 'Duplicate grant' } });
    expect(debit).toContain('data-testid="debit-form"');
    expect(debit).toContain('Debit credits from this user');
    expect(debit).toMatch(/<button type="submit"[^>]*>Review Debit…/);
    expect(debit).not.toMatch(/<button type="submit" disabled=""/);
  });

  it('disables both actions, and says why, while the economy is off or the role does not permit it', () => {
    const html = panel({ blocked: 'The economy is switched off: adjustments are disabled. Reading is unaffected.', form: emptyAdjustment('credit') });
    expect(html).toContain('The economy is switched off');
    expect(html.match(/disabled=""[^>]*>(Credit|Debit)…/g)).toHaveLength(2);
    expect(html).not.toContain('credit-form');
  });

  it("shows the server's refusal as it came", () => {
    const html = panel({ form: emptyAdjustment('debit'), messages: ['This debit of 40 would take your credits debits today to 41, over the daily cap of 33; 0 remain.'] });
    expect(html).toContain('role="alert"');
    expect(html).toContain('over the daily cap of 33');
  });
});

describe('the transaction history', () => {
  it('lists each transaction with its type, signed amount, class, results, reason, reference and operator', () => {
    const html = render(
      <HistoryTable transactions={[transaction(), transaction({ id: 't-0', sequence: 5, direction: 'debit', amount: 2, entryType: 'hold', source: null, reason: null })]} />,
    );
    expect(html.match(/data-testid="history-row"/g)).toHaveLength(2);
    expect(html).toContain('Support adjustment');
    expect(html).toContain('+13');
    expect(html).toContain('-2');
    expect(html).toContain('support_reference: T-5');
    expect(html).toContain('Goodwill for a failed image');
    expect(html).toContain('operator-1');
  });

  it('says when there is none', () => {
    expect(render(<HistoryTable transactions={[]} />)).toContain('No transactions yet.');
  });
});

describe('the page', () => {
  it('asks for a User ID, and loads the wallet from the server for one', () => {
    expect(render(<AdminWalletPage />)).toContain('Enter a user&#x27;s permanent User ID');
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={['/admin/wallets/3f2504e0-4f89-41d3-9a0c-0305e82c3301']}>
        <Routes>
          <Route path="/admin/wallets/:userId" element={<AdminWalletPage />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(html).toContain('Loading the wallet');
    expect(html).toContain('value="3f2504e0-4f89-41d3-9a0c-0305e82c3301"');
  });
});
