import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { AdminUserDetail } from '@over18/shared';
import { ROLE_LABEL, ageText, pageError, subscriptionText, tierText, when } from '../../admin/userManagement';
import { adminUsersApi } from '../../lib/api';
import { MessageList, Section } from './economy/EconomyUi';

/**
 * Admin -> Users -> one user (P2.5.1): a consolidated, READ-ONLY view --
 * identity, account, commercial state (the P3.1 resolver's), wallets (the P2.4
 * read model) and activity. Support actions live elsewhere: the wallet one is
 * the existing Wallets screen, linked from here; account status controls
 * arrive with P2.5.2.
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

export function UserDetailView({ detail }: { detail: AdminUserDetail }) {
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
            ['Account status', 'Not tracked yet — account status arrives with P2.5.2'],
          ]}
        />
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
      </Section>

      <Section
        title="Wallet"
        actions={
          <Link to={`/admin/wallets/${identity.id}`} className="text-sm text-rose-400 hover:text-rose-300">
            Open wallet support →
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

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4">
      <div>
        <Link to="/admin/users" className="text-sm text-zinc-400 hover:text-zinc-200">
          ← Users
        </Link>
        <h1 className="mt-1 text-xl font-semibold text-white">{state.status === 'ready' ? state.detail.identity.email : 'User'}</h1>
        <p className="mt-1 text-sm text-zinc-400">Read-only. Support actions happen on their own screens.</p>
      </div>
      {state.status === 'loading' && <p className="text-sm text-zinc-400">Loading the user…</p>}
      {state.status === 'failed' && <MessageList messages={state.messages} />}
      {state.status === 'ready' && <UserDetailView detail={state.detail} />}
    </div>
  );
}
