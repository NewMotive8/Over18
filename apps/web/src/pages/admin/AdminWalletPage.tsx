import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type {
  AdminAdjustmentAllowance,
  AdminUserWallets,
  AdminWalletAdjustmentRequest,
  AdminWalletAdjustmentResult,
  AdminWalletSummary,
  AdminWalletTransaction,
  AdminWalletUser,
  WalletDirection,
} from '@over18/shared';
import ConfirmDialog from '../../admin/ConfirmDialog';
import { serverMessages } from '../../admin/economyConfig';
import {
  DIRECTION_LABEL,
  adjustmentBlocked,
  adjustmentNotice,
  adjustmentRequest,
  confirmationBody,
  confirmationTitle,
  emptyAdjustment,
  entryLabel,
  limitFor,
  limitText,
  newIdempotencyKey,
  parseUserId,
  referenceText,
  signedAmount,
  type AdjustmentForm,
} from '../../admin/walletSupport';
import { adminAccessApi, adminWalletApi } from '../../lib/api';
import { Field, MessageList, Section, buttonClass, inputClass, secondaryButtonClass } from './economy/EconomyUi';

/**
 * Admin -> Wallets (P2.4, PRD §16, §18, §34): one user's wallets, their ledger,
 * and support Credit and Debit.
 *
 * Looked up by the permanent User ID; Admin -> Users finds users by email too,
 * and its User Detail makes the same adjustment with this page's own
 * `WalletAdjustment` (P2.5.3). Every figure shown is the server's; every
 * adjustment is a new ledger transaction made by the server, which enforces the
 * permission, the caps, the balance, the operator's own wallet and idempotency.
 * Nothing here edits a balance or a past transaction.
 */

/* ------------------------------------------------------------------ *
 * Presentational pieces (rendered by the tests with plain props)
 * ------------------------------------------------------------------ */

export function AccountCard({ user }: { user: AdminWalletUser }) {
  return (
    <Section
      title="Account"
      actions={
        <Link to={`/admin/users/${user.id}`} className="text-sm text-rose-400 hover:text-rose-300">
          Open in Users →
        </Link>
      }
    >
      <dl className="grid gap-2 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-xs text-zinc-500">Email</dt>
          <dd className="text-zinc-100">{user.email}</dd>
        </div>
        <div>
          <dt className="text-xs text-zinc-500">User ID</dt>
          <dd className="break-all font-mono text-xs text-zinc-300">{user.id}</dd>
        </div>
        <div>
          <dt className="text-xs text-zinc-500">Created</dt>
          <dd className="text-zinc-300">{user.createdAt}</dd>
        </div>
      </dl>
    </Section>
  );
}

export function WalletBalances({ wallet }: { wallet: AdminWalletSummary }) {
  return (
    <div className="flex flex-col gap-3" data-testid="wallet-balances">
      {!wallet.exists && <p className="text-sm text-zinc-500">No {wallet.currency} wallet yet: a Credit opens one.</p>}
      <dl className="grid gap-3 sm:grid-cols-3">
        <div>
          <dt className="text-xs text-zinc-500">Spendable</dt>
          <dd className="text-2xl font-semibold text-white" data-testid="balance">
            {wallet.balance}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-zinc-500">Held (in-flight actions, not spendable)</dt>
          <dd className="text-2xl font-semibold text-zinc-300" data-testid="held">
            {wallet.held}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-zinc-500">Transactions</dt>
          <dd className="text-2xl font-semibold text-zinc-400">{wallet.version}</dd>
        </div>
      </dl>
      <table className="w-full max-w-md text-left text-sm">
        <thead className="text-xs text-zinc-500">
          <tr>
            <th className="py-1">Class</th>
            <th>Spendable</th>
            <th>Held</th>
          </tr>
        </thead>
        <tbody className="text-zinc-300">
          {Object.entries(wallet.classes).map(([name, value]) => (
            <tr key={name} data-testid="class-row">
              <td className="py-0.5">{name}</td>
              <td>{value.spendable}</td>
              <td>{value.held}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function AdjustmentLimits({ allowance }: { allowance: AdminAdjustmentAllowance | null }) {
  const limits = allowance ? [allowance.credit, allowance.debit] : [null, null];
  return (
    <dl className="grid gap-2 text-sm sm:grid-cols-2" data-testid="adjustment-limits">
      {(['credit', 'debit'] as const).map((direction, i) => (
        <div key={direction}>
          <dt className="text-xs text-zinc-500">Your {DIRECTION_LABEL[direction]} allowance</dt>
          <dd className="text-zinc-200">{limitText(limits[i] ?? null)}</dd>
        </div>
      ))}
    </dl>
  );
}

const DIRECTION_STYLE: Record<WalletDirection, string> = {
  credit: 'border-emerald-700 text-emerald-300 hover:bg-emerald-950/40',
  debit: 'border-red-800 text-red-300 hover:bg-red-950/40',
};

/** Credit and Debit as two separate actions, then the chosen one's form. */
export function AdjustmentPanel({
  currency,
  allowances,
  blocked,
  form,
  onChoose,
  onForm,
  onReview,
  busy,
  messages,
}: {
  currency: string;
  allowances: readonly AdminAdjustmentAllowance[];
  /** Why adjusting is impossible now; null when it is possible. */
  blocked: string | null;
  form: AdjustmentForm | null;
  onChoose: (direction: WalletDirection) => void;
  onForm: (form: AdjustmentForm) => void;
  onReview: () => void;
  busy: boolean;
  messages: string[];
}) {
  return (
    <div className="flex flex-col gap-3" data-testid="adjustment-panel">
      <AdjustmentLimits allowance={allowances.find((a) => a.currency === currency) ?? null} />
      {blocked ? (
        <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-200" role="status">
          {blocked}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {(['credit', 'debit'] as const).map((direction) => (
          <button
            key={direction}
            type="button"
            disabled={Boolean(blocked) || busy}
            onClick={() => onChoose(direction)}
            aria-pressed={form?.direction === direction}
            className={`rounded-md border px-4 py-2 text-sm font-semibold disabled:opacity-40 ${DIRECTION_STYLE[direction]}`}
          >
            {DIRECTION_LABEL[direction]}…
          </button>
        ))}
      </div>
      {form && !blocked && (
        <form
          className={`grid gap-3 rounded-md border p-3 sm:grid-cols-2 ${form.direction === 'credit' ? 'border-emerald-800' : 'border-red-900'}`}
          data-testid={`${form.direction}-form`}
          onSubmit={(event) => {
            event.preventDefault();
            onReview();
          }}
        >
          <p className="text-sm font-semibold text-zinc-100 sm:col-span-2">
            {form.direction === 'credit' ? `Credit ${currency} to this user` : `Debit ${currency} from this user`} — {limitText(limitFor(allowances, currency, form.direction))}
          </p>
          <Field label="Amount (whole Credits)">
            <input inputMode="numeric" value={form.amount} onChange={(e) => onForm({ ...form, amount: e.target.value })} className={inputClass} />
          </Field>
          <Field label="Support reference (optional)" hint="e.g. a ticket number">
            <input value={form.reference} onChange={(e) => onForm({ ...form, reference: e.target.value })} className={inputClass} />
          </Field>
          <div className="sm:col-span-2">
            <Field label="Reason (required)" hint="Recorded on the transaction and in the audit log.">
              <textarea rows={2} value={form.reason} onChange={(e) => onForm({ ...form, reason: e.target.value })} className={inputClass} />
            </Field>
          </div>
          <MessageList messages={messages} />
          <div className="sm:col-span-2">
            <button type="submit" disabled={busy || form.reason.trim() === '' || form.amount.trim() === ''} className={buttonClass}>
              Review {DIRECTION_LABEL[form.direction]}…
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

export function HistoryTable({ transactions }: { transactions: readonly AdminWalletTransaction[] }) {
  if (transactions.length === 0) return <p className="text-sm text-zinc-500">No transactions yet.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[60rem] text-left text-sm">
        <thead className="text-xs text-zinc-500">
          <tr>
            <th className="py-1">#</th>
            <th>When</th>
            <th>Type</th>
            <th>Amount</th>
            <th>Class</th>
            <th>Spendable after</th>
            <th>Held after</th>
            <th>Reason</th>
            <th>Reference</th>
            <th>By</th>
          </tr>
        </thead>
        <tbody className="align-top text-zinc-300">
          {transactions.map((t) => (
            <tr key={t.id} data-testid="history-row">
              <td className="py-1">{t.sequence}</td>
              <td className="text-xs text-zinc-400">{t.createdAt}</td>
              <td>{entryLabel(t.entryType)}</td>
              <td className={t.direction === 'credit' ? 'text-emerald-300' : 'text-red-300'}>{signedAmount(t)}</td>
              <td>{t.creditClass}</td>
              <td>{t.balanceAfter}</td>
              <td>{t.heldAfter}</td>
              <td className="text-xs text-zinc-400">{t.reason ?? '—'}</td>
              <td className="text-xs text-zinc-400">{referenceText(t)}</td>
              <td className="break-all font-mono text-[11px] text-zinc-500">{t.actorUserId ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * The adjustment -- one implementation, also used by Admin -> Users -> User
 * Detail (P2.5.3)
 * ------------------------------------------------------------------ */

/**
 * Credit or Debit one user's wallet in one currency: two separate actions, the
 * chosen one's form, a review in a confirmation dialog, then the P2.4
 * adjustment endpoint -- where the server enforces the permission, the caps,
 * the balance, the operator's own wallet and idempotency.
 *
 * The idempotency key is made when a review opens and kept for any retry of
 * that same adjustment, so confirming twice cannot apply it twice; changing the
 * adjustment makes it a new one. `onAdjusted` receives the server's result, and
 * the host shows it.
 */
export function WalletAdjustment({
  userId,
  email,
  currency,
  allowances,
  blocked,
  onAdjusted,
}: {
  userId: string;
  email: string;
  currency: string;
  allowances: readonly AdminAdjustmentAllowance[];
  /** Why adjusting is impossible now (see adjustmentBlocked); null when it is possible. */
  blocked: string | null;
  onAdjusted: (result: AdminWalletAdjustmentResult) => void | Promise<void>;
}) {
  const [form, setForm] = useState<AdjustmentForm | null>(null);
  const [pending, setPending] = useState<AdminWalletAdjustmentRequest | null>(null);
  const [key, setKey] = useState<string | null>(null);
  const [messages, setMessages] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const editForm = (next: AdjustmentForm) => {
    setForm(next);
    setKey(null); // a changed adjustment is a new one
    setMessages([]);
  };

  const review = () => {
    if (!form) return;
    const intended = key ?? newIdempotencyKey();
    const built = adjustmentRequest(form, intended);
    if (!built.ok) return setMessages(built.errors);
    setKey(intended);
    setPending(built.value);
  };

  const submit = async () => {
    if (!pending) return;
    setBusy(true);
    let result: AdminWalletAdjustmentResult | null = null;
    try {
      result = await adminWalletApi.adjust(userId, currency, pending);
      setForm(null);
      setKey(null);
      setMessages([]);
    } catch (error) {
      // The key is kept: confirming the same adjustment again cannot apply it twice.
      setMessages(serverMessages(error));
    } finally {
      setPending(null);
      setBusy(false);
    }
    // Outside the try: whatever the host does next, this adjustment was applied.
    if (result) await onAdjusted(result);
  };

  return (
    <>
      <AdjustmentPanel
        currency={currency}
        allowances={allowances}
        blocked={blocked}
        form={form}
        onChoose={(direction) => editForm(emptyAdjustment(direction))}
        onForm={editForm}
        onReview={review}
        busy={busy}
        messages={messages}
      />
      <ConfirmDialog
        open={pending !== null}
        title={pending ? confirmationTitle(pending, currency, email) : ''}
        body={pending ? confirmationBody(pending) : ''}
        confirmLabel={pending ? DIRECTION_LABEL[pending.direction] : 'Confirm'}
        cancelLabel="Go back"
        onConfirm={() => void submit()}
        onCancel={() => setPending(null)}
        busy={busy}
        tone={pending?.direction === 'debit' ? 'danger' : 'default'}
      />
    </>
  );
}

/* ------------------------------------------------------------------ *
 * The workspace for one user
 * ------------------------------------------------------------------ */

type Loaded = { status: 'loading' } | { status: 'error'; messages: string[] } | { status: 'ready'; data: AdminUserWallets };

function UserWallets({ userId }: { userId: string }) {
  const [state, setState] = useState<Loaded>({ status: 'loading' });
  const [permitted, setPermitted] = useState(false);
  const [currency, setCurrency] = useState<string | null>(null);
  const [history, setHistory] = useState<{ transactions: AdminWalletTransaction[]; nextBefore: number | null } | null>(null);
  const [historyMessages, setHistoryMessages] = useState<string[]>([]);
  const [notice, setNotice] = useState<string[]>([]);

  const load = useCallback(async () => {
    try {
      const data = await adminWalletApi.wallets(userId);
      setState({ status: 'ready', data });
      setCurrency((current) => current ?? data.wallets[0]?.currency ?? null);
    } catch (error) {
      setState({ status: 'error', messages: serverMessages(error) });
    }
  }, [userId]);

  const loadHistory = useCallback(
    async (before: number | null) => {
      if (!currency) return;
      try {
        const page = await adminWalletApi.history(userId, currency, before);
        setHistoryMessages([]);
        setHistory((current) => ({
          transactions: before && current ? [...current.transactions, ...page.transactions] : page.transactions,
          nextBefore: page.nextBefore,
        }));
      } catch (error) {
        setHistoryMessages(serverMessages(error));
      }
    },
    [userId, currency],
  );

  useEffect(() => {
    void load();
    adminAccessApi
      .me()
      .then((access) => setPermitted(access.permissions.includes('users.credits.adjust')))
      .catch(() => setPermitted(false));
  }, [load]);

  useEffect(() => {
    setHistory(null);
    void loadHistory(null);
  }, [loadHistory]);

  const adjusted = (result: AdminWalletAdjustmentResult) => {
    const adjustedCurrency = result.wallet.currency;
    setNotice([adjustmentNotice(result, adjustedCurrency)]);
    setState((current) =>
      current.status !== 'ready'
        ? current
        : {
            status: 'ready',
            data: {
              ...current.data,
              wallets: current.data.wallets.map((w) => (w.currency === adjustedCurrency ? result.wallet : w)),
              allowances: current.data.allowances.map((a) => (a.currency === adjustedCurrency ? result.allowance : a)),
            },
          },
    );
    void loadHistory(null);
  };

  if (state.status === 'loading') return <p className="text-sm text-zinc-400">Loading the wallet…</p>;
  if (state.status === 'error') return <MessageList messages={state.messages} />;

  const { data } = state;
  const wallet = data.wallets.find((w) => w.currency === currency) ?? data.wallets[0];
  const blocked = adjustmentBlocked({ economyEnabled: data.economyEnabled, permitted });

  return (
    <div className="flex flex-col gap-4">
      <AccountCard user={data.user} />
      <MessageList messages={notice} tone="success" />
      {data.wallets.length > 1 && (
        <div className="flex gap-2" role="tablist" aria-label="Currency">
          {data.wallets.map((w) => (
            <button
              key={w.currency}
              type="button"
              role="tab"
              aria-selected={w.currency === wallet?.currency}
              onClick={() => setCurrency(w.currency)}
              className={secondaryButtonClass}
            >
              {w.currency}
            </button>
          ))}
        </div>
      )}
      {wallet && (
        <>
          <Section title={`${wallet.currency} balance`}>
            <WalletBalances wallet={wallet} />
          </Section>
          <Section title="Support adjustment">
            {/* Keyed by currency: switching currency starts a fresh adjustment. */}
            <WalletAdjustment
              key={wallet.currency}
              userId={userId}
              email={data.user.email}
              currency={wallet.currency}
              allowances={data.allowances}
              blocked={blocked}
              onAdjusted={adjusted}
            />
          </Section>
          <Section title="Transactions">
            {history ? (
              <HistoryTable transactions={history.transactions} />
            ) : historyMessages.length > 0 ? (
              <MessageList messages={historyMessages} />
            ) : (
              <p className="text-sm text-zinc-400">Loading transactions…</p>
            )}
            {history?.nextBefore ? (
              <button type="button" onClick={() => void loadHistory(history.nextBefore)} className={`${secondaryButtonClass} mt-3`}>
                Show older
              </button>
            ) : null}
          </Section>
        </>
      )}
    </div>
  );
}

export default function AdminWalletPage() {
  const { userId } = useParams();
  const navigate = useNavigate();
  const [text, setText] = useState(userId ?? '');
  const [errors, setErrors] = useState<string[]>([]);

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold text-white">Wallets</h1>
        <p className="mt-1 text-sm text-zinc-400">One user's wallets and ledger, and support Credit and Debit. Look a user up by their permanent User ID.</p>
      </div>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const parsed = parseUserId(text);
          if (!parsed.ok) return setErrors(parsed.errors);
          setErrors([]);
          navigate(`/admin/wallets/${parsed.value}`);
        }}
      >
        <Field label="User ID">
          <input value={text} onChange={(e) => setText(e.target.value)} className={`${inputClass} w-96 font-mono`} placeholder="00000000-0000-0000-0000-000000000000" />
        </Field>
        <button type="submit" className={buttonClass}>
          Look up
        </button>
      </form>
      <MessageList messages={errors} />
      {userId ? <UserWallets key={userId} userId={userId} /> : <p className="text-sm text-zinc-500">Enter a user's permanent User ID to see their wallets.</p>}
    </div>
  );
}
