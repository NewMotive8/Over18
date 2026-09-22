import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import type {
  AccountStatus,
  AdminAccountStatusChange,
  AdminAccountStatusChangeRequest,
  AdminAdjustmentAllowance,
  AdminUserDetail,
  AdminWalletAdjustmentResult,
} from '@over18/shared';
import ConfirmDialog from '../../admin/ConfirmDialog';
import { serverMessages } from '../../admin/economyConfig';
import {
  ROLE_LABEL,
  STATUS_ACTION,
  STATUS_LABEL,
  ageText,
  pageError,
  statusChangeBlocked,
  statusChangeRequest,
  statusConfirmation,
  subscriptionText,
  tierText,
  when,
} from '../../admin/userManagement';
import { adjustmentBlocked, adjustmentNotice } from '../../admin/walletSupport';
import { ApiRequestError, adminAccessApi, adminUsersApi, adminWalletApi, authApi } from '../../lib/api';
import { WalletAdjustment } from './AdminWalletPage';
import { UserSubscription } from './UserSubscriptionPanel';
import { Field, MessageList, Section, inputClass, secondaryButtonClass } from './economy/EconomyUi';

/**
 * Admin -> Users -> one user (P2.5.1): a consolidated view -- identity,
 * account, commercial state (the P3.1 resolver's), wallets (the P2.4 read
 * model) and activity.
 *
 * Three support actions are made here, each with a reason and a confirmation,
 * each enforced and audited by the server:
 *   - the account status (P2.5.2): suspend or reactivate a customer;
 *   - a wallet Credit or Debit (P2.5.3): the Wallets screen's own adjustment
 *     (`WalletAdjustment`), through the same P2.4 endpoint -- not a second one;
 *   - the plan and subscription (P3.5): assign, change, cancel or end, through
 *     the canonical subscription service, with its history.
 * After any of them, the user is read again, so the commercial state, balances
 * and the audit panel show the change at once. The full ledger stays on the
 * Wallets screen, linked.
 */

function Facts({ rows }: { rows: Array<[string, string | number]> }) {
  return (
    <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt className="text-xs text-zinc-500">{label}</dt>
          <dd className="break-all text-zinc-200">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

const SUSPEND_BUTTON = 'rounded-md border border-red-800 px-4 py-2 text-sm font-semibold text-red-300 hover:bg-red-950/40 disabled:opacity-40';
const REACTIVATE_BUTTON =
  'rounded-md border border-emerald-700 px-4 py-2 text-sm font-semibold text-emerald-300 hover:bg-emerald-950/40 disabled:opacity-40';

/**
 * Suspend or reactivate, as the server allows: a reason, then a review in a
 * confirmation dialog. When the server says this operator may not, the panel
 * says why and offers nothing to submit.
 */
export function AccountStatusPanel({
  status,
  change,
  reason,
  onReason,
  onReview,
  busy,
  messages,
}: {
  status: AccountStatus;
  change: AdminAccountStatusChange;
  reason: string;
  onReason: (reason: string) => void;
  onReview: () => void;
  busy: boolean;
  messages: string[];
}) {
  const blocked = statusChangeBlocked(change);
  if (blocked) {
    return (
      <p className="mt-3 text-sm text-zinc-500" data-testid="status-change-blocked">
        {blocked}
      </p>
    );
  }
  const action = STATUS_ACTION[status];
  return (
    <form
      className={`mt-3 grid gap-3 rounded-md border p-3 ${action.to === 'suspended' ? 'border-red-900' : 'border-emerald-800'}`}
      data-testid="status-change-form"
      onSubmit={(event) => {
        event.preventDefault();
        onReview();
      }}
    >
      <p className="text-sm text-zinc-300">
        {action.to === 'suspended'
          ? 'Suspending signs the customer out everywhere and blocks sign-in. Subscription, wallet, entitlements and content are not changed.'
          : 'Reactivating lets the customer sign in again. Nothing else about the account changes.'}
      </p>
      <Field label="Reason (required)" hint="Recorded in the audit log.">
        <textarea rows={2} maxLength={500} value={reason} onChange={(e) => onReason(e.target.value)} className={inputClass} />
      </Field>
      <MessageList messages={messages} />
      <div>
        <button type="submit" disabled={busy || reason.trim() === ''} className={action.to === 'suspended' ? SUSPEND_BUTTON : REACTIVATE_BUTTON}>
          {action.label}…
        </button>
      </div>
    </form>
  );
}

/** What the wallet adjustment needs beyond the detail, from the same sources the Wallets page uses. */
export type WalletSupport =
  | { status: 'loading' }
  | { status: 'failed'; messages: string[] }
  | { status: 'ready'; allowances: AdminAdjustmentAllowance[]; economyEnabled: boolean; permitted: boolean; ownAccount: boolean };

/**
 * Credit and Debit in the User Detail Wallet section (P2.5.3). The adjustment
 * itself is the Wallets page's `WalletAdjustment`; this only chooses the
 * currency and says why adjusting is blocked, when it is.
 */
export function UserWalletAdjustment({
  userId,
  email,
  currencies,
  currency,
  onCurrency,
  support,
  onAdjusted,
}: {
  userId: string;
  email: string;
  currencies: readonly string[];
  currency: string;
  onCurrency: (currency: string) => void;
  support: WalletSupport;
  onAdjusted: (result: AdminWalletAdjustmentResult) => void | Promise<void>;
}) {
  return (
    <div className="mt-4 flex flex-col gap-3 border-t border-zinc-800 pt-4" data-testid="wallet-adjustment">
      <h3 className="text-sm font-semibold text-zinc-200">Support adjustment</h3>
      {support.status === 'loading' && <p className="text-sm text-zinc-400">Loading your adjustment allowance…</p>}
      {support.status === 'failed' && <MessageList messages={support.messages} />}
      {support.status === 'ready' && (
        <>
          {currencies.length > 1 && (
            <div className="flex gap-2" role="tablist" aria-label="Currency">
              {currencies.map((c) => (
                <button key={c} type="button" role="tab" aria-selected={c === currency} onClick={() => onCurrency(c)} className={secondaryButtonClass}>
                  {c}
                </button>
              ))}
            </div>
          )}
          {/* Keyed by currency: switching currency starts a fresh adjustment, as on the Wallets page. */}
          <WalletAdjustment
            key={currency}
            userId={userId}
            email={email}
            currency={currency}
            allowances={support.allowances}
            blocked={adjustmentBlocked({ economyEnabled: support.economyEnabled, permitted: support.permitted, ownAccount: support.ownAccount })}
            onAdjusted={onAdjusted}
          />
        </>
      )}
    </div>
  );
}

export function UserDetailView({
  detail,
  statusControl,
  walletControl,
  subscriptionControl,
}: {
  detail: AdminUserDetail;
  statusControl?: ReactNode;
  walletControl?: ReactNode;
  subscriptionControl?: ReactNode;
}) {
  const { identity, account, activity, commercial, wallets, audit } = detail;
  return (
    <div className="flex flex-col gap-4">
      <Section title="Identity">
        <Facts
          rows={[
            ['User ID', identity.id],
            ['Email', identity.email],
          ]}
        />
      </Section>

      <Section title="Account">
        <Facts
          rows={[
            ['Type', ROLE_LABEL[account.role]],
            ['Staff roles', account.staffRoles.length > 0 ? account.staffRoles.map((g) => `${g.role} (since ${when(g.grantedAt)})`).join(', ') : '—'],
            ['Created', when(account.createdAt)],
            ['Last updated', when(account.updatedAt)],
            ['Account status', STATUS_LABEL[account.status]],
          ]}
        />
        {statusControl}
      </Section>

      <Section title="Commercial / subscription">
        <Facts
          rows={[
            ['Economy', commercial.economyEnabled ? 'Switched on' : 'Switched off — nothing is shown to customers'],
            ['Tier', tierText(commercial.tier)],
            ['Subscription', subscriptionText(commercial.subscription)],
            ['Age verification', ageText(commercial.age)],
          ]}
        />
        {subscriptionControl}
      </Section>

      <Section
        title="Wallet"
        actions={
          <Link to={`/admin/wallets/${identity.id}`} className="text-sm text-rose-400 hover:text-rose-300">
            Full ledger history →
          </Link>
        }
      >
        <div className="overflow-x-auto">
          <table className="w-full min-w-[40rem] text-left text-sm">
            <thead className="text-xs text-zinc-500">
              <tr>
                <th className="py-1">Currency</th>
                <th>Included</th>
                <th>Earned</th>
                <th>Purchased</th>
                <th>Held</th>
                <th>Spendable</th>
                <th>Transactions</th>
              </tr>
            </thead>
            <tbody className="text-zinc-300">
              {wallets.map((w) => (
                <tr key={w.currency} data-testid="wallet-row">
                  <td className="py-1">
                    {w.currency}
                    {!w.exists && <span className="ml-2 text-xs text-zinc-500">(no wallet yet)</span>}
                  </td>
                  <td>{w.included}</td>
                  <td>{w.earned}</td>
                  <td>{w.purchased}</td>
                  <td>{w.held}</td>
                  <td className="font-semibold text-white">{w.spendable}</td>
                  <td>{w.transactions}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {walletControl}
      </Section>

      <Section title="Activity">
        <Facts
          rows={[
            ['Last sign-in', when(activity.lastSignInAt)],
            ['Active sessions', activity.activeSessions],
            ['Conversations', activity.conversations],
            ['Last conversation activity', when(activity.lastConversationAt)],
          ]}
        />
      </Section>

      <Section title="Audit">
        {!audit.available ? (
          <p className="text-sm text-zinc-500">Audit entries need the audit.read permission.</p>
        ) : audit.entries.length === 0 ? (
          <p className="text-sm text-zinc-500">No audited change concerns this user.</p>
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-zinc-500">
              <tr>
                <th className="py-1">When</th>
                <th>Action</th>
                <th>By</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody className="text-zinc-300">
              {audit.entries.map((e) => (
                <tr key={e.id} data-testid="audit-row">
                  <td className="py-1 text-xs text-zinc-400">{when(e.occurredAt)}</td>
                  <td className="font-mono text-xs">{e.action}</td>
                  <td className="text-xs">{e.actorEmail ?? e.actorUserId ?? '—'}</td>
                  <td className="text-xs text-zinc-400">{e.reason ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>
    </div>
  );
}

type Loaded =
  | { status: 'loading' }
  | { status: 'failed'; kind: 'unauthorized' | 'forbidden' | 'error'; messages: string[] }
  | { status: 'ready'; detail: AdminUserDetail };

export default function AdminUserDetailPage() {
  const { userId } = useParams();
  const [state, setState] = useState<Loaded>({ status: 'loading' });
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState<AdminAccountStatusChangeRequest | null>(null);
  const [busy, setBusy] = useState(false);
  const [messages, setMessages] = useState<string[]>([]);
  const [notice, setNotice] = useState<string[]>([]);
  const [walletSupport, setWalletSupport] = useState<WalletSupport>({ status: 'loading' });
  const [walletCurrency, setWalletCurrency] = useState<string | null>(null);

  /** Reads the user again: after a change -- or a conflict -- the server's detail is the truth. */
  const reload = useCallback(async (id: string) => {
    try {
      setState({ status: 'ready', detail: await adminUsersApi.detail(id) });
    } catch (error) {
      setState({ status: 'failed', ...pageError(error) });
    }
  }, []);

  useEffect(() => {
    if (!userId) return;
    let current = true;
    setState({ status: 'loading' });
    adminUsersApi
      .detail(userId)
      .then((detail) => current && setState({ status: 'ready', detail }))
      .catch((error: unknown) => current && setState({ status: 'failed', ...pageError(error) }));
    return () => {
      current = false;
    };
  }, [userId]);

  // The adjustment's own facts, from the sources the Wallets page uses: the
  // operator's allowance and the economy switch (the wallets read), their
  // permission (their admin access), and whether this is their own account
  // (their session). If either of the last two cannot be read, the server
  // still decides: it refuses what it must, and the refusal is shown.
  useEffect(() => {
    if (!userId) return;
    let current = true;
    setWalletSupport({ status: 'loading' });
    Promise.all([adminWalletApi.wallets(userId), adminAccessApi.me().catch(() => null), authApi.me().catch(() => null)])
      .then(([wallets, access, me]) => {
        if (!current) return;
        setWalletSupport({
          status: 'ready',
          allowances: wallets.allowances,
          economyEnabled: wallets.economyEnabled,
          permitted: access?.permissions.includes('users.credits.adjust') ?? false,
          ownAccount: me?.id === userId,
        });
      })
      .catch((error: unknown) => current && setWalletSupport({ status: 'failed', messages: serverMessages(error) }));
    return () => {
      current = false;
    };
  }, [userId]);

  /** An adjustment applied: say what it did, keep the allowance current, and read the user again. */
  const walletAdjusted = async (result: AdminWalletAdjustmentResult) => {
    if (!userId) return;
    setNotice([`${adjustmentNotice(result, result.wallet.currency)} Ledger transaction #${result.transaction.sequence}.`]);
    setWalletSupport((current) =>
      current.status !== 'ready'
        ? current
        : { ...current, allowances: current.allowances.map((a) => (a.currency === result.allowance.currency ? result.allowance : a)) },
    );
    await reload(userId);
  };

  const review = () => {
    if (state.status !== 'ready') return;
    const built = statusChangeRequest(state.detail.account.status, reason);
    if (!built.ok) return setMessages(built.errors);
    setMessages([]);
    setPending(built.value);
  };

  const submit = async () => {
    if (!pending || !userId) return;
    setBusy(true);
    try {
      const result = await adminUsersApi.changeStatus(userId, pending);
      setNotice([
        result.status === 'suspended'
          ? `Account suspended. ${result.revokedSessions === 1 ? '1 session was' : `${result.revokedSessions} sessions were`} ended.`
          : 'Account reactivated. The customer can sign in again.',
      ]);
      setReason('');
      setMessages([]);
      await reload(userId);
    } catch (error) {
      setNotice([]);
      setMessages(serverMessages(error));
      // Someone else changed the status first: show the account as it is now.
      if (error instanceof ApiRequestError && error.code === 'status_conflict') await reload(userId);
    } finally {
      setPending(null);
      setBusy(false);
    }
  };

  const confirmation = pending && state.status === 'ready' ? statusConfirmation(pending, state.detail.identity.email) : null;

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4">
      <div>
        <Link to="/admin/users" className="text-sm text-zinc-400 hover:text-zinc-200">
          ← Users
        </Link>
        <h1 className="mt-1 text-xl font-semibold text-white">{state.status === 'ready' ? state.detail.identity.email : 'User'}</h1>
        <p className="mt-1 text-sm text-zinc-400">Account status, plan and wallet Credit / Debit are changed here. The full ledger is on the Wallets screen.</p>
      </div>
      {state.status === 'loading' && <p className="text-sm text-zinc-400">Loading the user…</p>}
      {state.status === 'failed' && <MessageList messages={state.messages} />}
      <MessageList messages={notice} tone="success" />
      {state.status === 'ready' && (
        <UserDetailView
          detail={state.detail}
          subscriptionControl={
            <UserSubscription
              key={state.detail.identity.id}
              userId={state.detail.identity.id}
              email={state.detail.identity.email}
              onChanged={(message) => {
                setNotice([message]);
                void reload(state.detail.identity.id);
              }}
            />
          }
          walletControl={
            state.detail.wallets.length > 0 ? (
              <UserWalletAdjustment
                userId={state.detail.identity.id}
                email={state.detail.identity.email}
                currencies={state.detail.wallets.map((w) => w.currency)}
                currency={walletCurrency ?? state.detail.wallets[0]!.currency}
                onCurrency={setWalletCurrency}
                support={walletSupport}
                onAdjusted={walletAdjusted}
              />
            ) : null
          }
          statusControl={
            <AccountStatusPanel
              status={state.detail.account.status}
              change={state.detail.account.statusChange}
              reason={reason}
              onReason={(next) => {
                setReason(next);
                setMessages([]);
              }}
              onReview={review}
              busy={busy}
              messages={messages}
            />
          }
        />
      )}
      <ConfirmDialog
        open={confirmation !== null}
        title={confirmation?.title ?? ''}
        body={confirmation?.body ?? ''}
        confirmLabel={pending ? STATUS_ACTION[pending.expectedStatus].label : 'Confirm'}
        cancelLabel="Go back"
        onConfirm={() => void submit()}
        onCancel={() => setPending(null)}
        busy={busy}
        tone={pending?.status === 'suspended' ? 'danger' : 'default'}
      />
    </div>
  );
}
