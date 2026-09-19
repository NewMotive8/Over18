import { useCallback, useEffect, useState } from 'react';
import type { AdminSubscriptionAction, AdminSubscriptionChangeRequest, AdminUserSubscription } from '@over18/shared';
import ConfirmDialog from '../../admin/ConfirmDialog';
import { serverMessages } from '../../admin/economyConfig';
import { when } from '../../admin/userManagement';
import {
  ACTION_LABEL,
  currentText,
  emptySubscriptionForm,
  historyChangeText,
  needsPlan,
  planLabel,
  subscriptionChangeBlocked,
  subscriptionChangeRequest,
  subscriptionConfirmation,
  type SubscriptionForm,
} from '../../admin/userSubscription';
import { ApiRequestError, adminUsersApi } from '../../lib/api';
import { Field, MessageList, buttonClass, inputClass } from './economy/EconomyUi';

/**
 * Admin -> Users -> User Detail -> the subscription (P3.5): what the user
 * holds, every recorded change, and -- for an administrator -- assign, change,
 * cancel or end, with a reason and a confirmation. The server decides what is
 * possible and enforces it; this panel shows its answers.
 */

/** The subscription, its history and the change form. Pure: rendered by the tests with plain props. */
export function SubscriptionPanel({
  view,
  form,
  onForm,
  onReview,
  busy,
  messages,
}: {
  view: AdminUserSubscription;
  form: SubscriptionForm;
  onForm: (form: SubscriptionForm) => void;
  onReview: () => void;
  busy: boolean;
  messages: string[];
}) {
  const blocked = subscriptionChangeBlocked(view.change);
  return (
    <div className="mt-4 flex flex-col gap-3 border-t border-zinc-800 pt-4" data-testid="subscription-panel">
      <h3 className="text-sm font-semibold text-zinc-200">Plan and subscription</h3>
      <p className="text-sm text-zinc-200" data-testid="subscription-current">
        {currentText(view)}
      </p>

      <div className="overflow-x-auto">
        {view.history.length === 0 ? (
          <p className="text-sm text-zinc-500">No subscription change recorded.</p>
        ) : (
          <table className="w-full min-w-[44rem] text-left text-sm">
            <thead className="text-xs text-zinc-500">
              <tr>
                <th className="py-1">#</th>
                <th>Effective</th>
                <th>Change</th>
                <th>From → to</th>
                <th>By</th>
                <th>Reason</th>
                <th>Reference</th>
              </tr>
            </thead>
            <tbody className="text-zinc-300">
              {view.history.map((h) => (
                <tr key={h.sequence} data-testid="subscription-history-row">
                  <td className="py-1 text-xs text-zinc-500">{h.sequence}</td>
                  <td className="text-xs text-zinc-400">{when(h.effectiveAt)}</td>
                  <td className="text-xs">{ACTION_LABEL[h.change]}</td>
                  <td className="font-mono text-xs">{historyChangeText(h)}</td>
                  <td className="text-xs">{h.actorEmail ?? h.actorUserId ?? '—'}</td>
                  <td className="text-xs text-zinc-400">{h.reason ?? '—'}</td>
                  <td className="text-xs text-zinc-400">{h.reference ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {blocked ? (
        <p className="text-sm text-zinc-500" data-testid="subscription-change-blocked">
          {blocked}
        </p>
      ) : (
        <form
          className="grid gap-3 rounded-md border border-zinc-800 p-3 sm:grid-cols-2"
          data-testid="subscription-change-form"
          onSubmit={(event) => {
            event.preventDefault();
            onReview();
          }}
        >
          <Field label="Change">
            <select value={form.action} onChange={(e) => onForm({ ...form, action: e.target.value as AdminSubscriptionAction })} className={inputClass}>
              {view.actions.map((a) => (
                <option key={a} value={a}>
                  {ACTION_LABEL[a]}
                </option>
              ))}
            </select>
          </Field>
          {needsPlan(form.action) ? (
            <Field label="Plan" hint="From the published catalogue.">
              <select value={form.planCode} onChange={(e) => onForm({ ...form, planCode: e.target.value })} className={inputClass}>
                <option value="">Choose a plan…</option>
                {view.plans.map((p) => (
                  <option key={p.code} value={p.code} disabled={form.action === 'change_plan' && p.versionId === view.current?.plan.versionId}>
                    {planLabel(p)}
                  </option>
                ))}
              </select>
            </Field>
          ) : (
            <div />
          )}
          <Field label="Reason (required)" hint="Recorded in the subscription history and the audit log.">
            <textarea rows={2} maxLength={500} value={form.reason} onChange={(e) => onForm({ ...form, reason: e.target.value })} className={inputClass} />
          </Field>
          <Field label="Reference (optional)" hint="e.g. a ticket number">
            <input maxLength={100} value={form.reference} onChange={(e) => onForm({ ...form, reference: e.target.value })} className={inputClass} />
          </Field>
          <div className="sm:col-span-2">
            <MessageList messages={messages} />
          </div>
          <div className="sm:col-span-2">
            <button type="submit" disabled={busy || form.reason.trim() === ''} className={buttonClass}>
              Review {ACTION_LABEL[form.action].toLowerCase()}…
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

type Loaded = { status: 'loading' } | { status: 'failed'; messages: string[] } | { status: 'ready'; view: AdminUserSubscription };

/**
 * Loads the subscription, and makes a change: review, confirm, send. After a
 * change -- or a conflict with someone else's -- the server's answer is shown,
 * and `onChanged` lets the page read the user again.
 */
export function UserSubscription({ userId, email, onChanged }: { userId: string; email: string; onChanged: (notice: string) => void }) {
  const [state, setState] = useState<Loaded>({ status: 'loading' });
  const [form, setForm] = useState<SubscriptionForm | null>(null);
  const [pending, setPending] = useState<AdminSubscriptionChangeRequest | null>(null);
  const [busy, setBusy] = useState(false);
  const [messages, setMessages] = useState<string[]>([]);

  const show = useCallback((view: AdminUserSubscription) => {
    setState({ status: 'ready', view });
    setForm(emptySubscriptionForm(view));
  }, []);

  const load = useCallback(async () => {
    try {
      show(await adminUsersApi.subscription(userId));
    } catch (error) {
      setState({ status: 'failed', messages: serverMessages(error) });
    }
  }, [userId, show]);

  useEffect(() => {
    setState({ status: 'loading' });
    void load();
  }, [load]);

  if (state.status === 'loading') return <p className="mt-4 text-sm text-zinc-400">Loading the subscription…</p>;
  if (state.status === 'failed') return <div className="mt-4"><MessageList messages={state.messages} /></div>;
  const { view } = state;

  const review = () => {
    if (!form) return;
    const built = subscriptionChangeRequest(form, view);
    if (!built.ok) return setMessages(built.errors);
    setMessages([]);
    setPending(built.value);
  };

  const submit = async () => {
    if (!pending) return;
    setBusy(true);
    let result: AdminUserSubscription | null = null;
    try {
      result = await adminUsersApi.changeSubscription(userId, pending);
      setMessages([]);
    } catch (error) {
      setMessages(serverMessages(error));
      // Someone else changed it first: show the subscription as it is now.
      if (error instanceof ApiRequestError && error.code === 'subscription_conflict') void load();
    } finally {
      setPending(null);
      setBusy(false);
    }
    if (result) {
      show(result);
      onChanged(`${ACTION_LABEL[pending.action]}: recorded as change #${result.version}. ${currentText(result)}`);
    }
  };

  const confirmation = pending ? subscriptionConfirmation(pending, view, email) : null;
  return (
    <>
      <SubscriptionPanel
        view={view}
        form={form ?? emptySubscriptionForm(view)}
        onForm={(next) => {
          setForm(next);
          setMessages([]);
        }}
        onReview={review}
        busy={busy}
        messages={messages}
      />
      <ConfirmDialog
        open={confirmation !== null}
        title={confirmation?.title ?? ''}
        body={confirmation?.body ?? ''}
        confirmLabel={pending ? ACTION_LABEL[pending.action] : 'Confirm'}
        cancelLabel="Go back"
        onConfirm={() => void submit()}
        onCancel={() => setPending(null)}
        busy={busy}
        tone={pending?.action === 'end' || pending?.action === 'cancel' ? 'danger' : 'default'}
      />
    </>
  );
}
