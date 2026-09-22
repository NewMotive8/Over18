import type {
  AdminSubscriptionAction,
  AdminSubscriptionChangeRequest,
  AdminSubscriptionHistoryEntry,
  AdminSubscriptionPlan,
  AdminSubscriptionSnapshot,
  AdminUserSubscription,
} from '@over18/shared';
import { when } from './userManagement';

/**
 * Admin -> Users -> a user's subscription (P3.5), as pure logic. The web suite
 * runs no effects, so what the panel decides lives here and is tested here.
 *
 * THE SERVER DECIDES. Which changes the current state allows, which plans can
 * be assigned, whether this operator may change anything, and every lifecycle
 * rule are the server's: this module only shapes a request from those answers
 * and puts them into words. No plan, price, period or Credit amount is written
 * here -- every one shown is the catalogue's, as the server sent it.
 */

export const ACTION_LABEL: Record<AdminSubscriptionAction, string> = {
  assign: 'Assign a plan',
  change_plan: 'Change plan',
  cancel: 'Cancel at period end',
  end: 'End now',
};

export const needsPlan = (action: AdminSubscriptionAction): boolean => action === 'assign' || action === 'change_plan';

const months = (n: number) => (n === 1 ? '1 month' : `${n} months`);

/** A catalogue plan, in words, from the server's figures. */
export function planLabel(plan: AdminSubscriptionPlan): string {
  return `${plan.displayName} (${plan.code} v${plan.version}) — ${months(plan.billingPeriodMonths)}, ${plan.monthlyIncludedCredits} Credits/month`;
}

/** Why this operator cannot change the subscription, in words; null when they can. */
export function subscriptionChangeBlocked(change: AdminUserSubscription['change']): string | null {
  if (change.allowed) return null;
  switch (change.reason) {
    case 'permission_required':
      return 'Changing a subscription needs the users.subscription.manage permission (administrators only).';
    case 'own_account':
      return 'You cannot change your own subscription. Another administrator must.';
    case 'economy_disabled':
      return 'The economy is switched off: subscription changes are disabled. Reading is unaffected.';
  }
}

/** The subscription now, in words. */
export function currentText(view: AdminUserSubscription): string {
  const c = view.current;
  if (!c) return 'No subscription — Free.';
  const plan = `${c.plan.displayName} (${c.plan.code} v${c.plan.version})`;
  if (!c.plan.live) return `${plan} — this plan version is no longer published, so it gives no Premium.`;
  switch (c.status) {
    case 'active':
    case 'past_due':
    case 'grace':
      return `${plan} — ${c.status.replace('_', ' ')}, Premium; period ends ${when(c.currentPeriodEnd)}.`;
    case 'cancelled':
      return `${plan} — cancelled: Premium until ${when(c.currentPeriodEnd)}, then it ends.`;
    case 'expired':
      return `${plan} — expired ${when(c.currentPeriodEnd)}: Free.`;
  }
}

const side = (s: AdminSubscriptionSnapshot) => `${s.planCode} v${s.planVersion} · ${s.status.replace('_', ' ')}`;

/** One recorded change, from -> to. */
export function historyChangeText(entry: AdminSubscriptionHistoryEntry): string {
  return `${entry.from ? side(entry.from) : 'no subscription'} → ${side(entry.to)}`;
}

export interface SubscriptionForm {
  action: AdminSubscriptionAction;
  planCode: string;
  reason: string;
  reference: string;
}

/** A fresh form for the first change the server allows now. */
export function emptySubscriptionForm(view: AdminUserSubscription): SubscriptionForm {
  return { action: view.actions[0] ?? 'assign', planCode: '', reason: '', reference: '' };
}

/**
 * The request for a reviewed change. Checks its SHAPE against what the server
 * said -- an allowed action, an offered plan, a reason -- and names the version
 * the server sent, so a change made since is refused rather than overwritten.
 */
export function subscriptionChangeRequest(
  form: SubscriptionForm,
  view: AdminUserSubscription,
): { ok: true; value: AdminSubscriptionChangeRequest } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!view.actions.includes(form.action)) errors.push(`${ACTION_LABEL[form.action]} is not possible for this subscription now.`);
  if (needsPlan(form.action) && !view.plans.some((p) => p.code === form.planCode)) errors.push('Choose a plan from the catalogue.');
  const reason = form.reason.trim();
  if (!reason) errors.push('A reason is required. It is recorded in the subscription history and the audit log.');
  else if (reason.length > 500) errors.push('The reason must be at most 500 characters.');
  const reference = form.reference.trim();
  if (reference.length > 100) errors.push('The reference must be at most 100 characters.');
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      action: form.action,
      ...(needsPlan(form.action) ? { planCode: form.planCode } : {}),
      expectedVersion: view.version,
      reason,
      reference: reference || null,
    },
  };
}

/** What the confirmation says the change will and will not do. */
export function subscriptionConfirmation(
  request: AdminSubscriptionChangeRequest,
  view: AdminUserSubscription,
  email: string,
): { title: string; body: string } {
  const plan = view.plans.find((p) => p.code === request.planCode);
  const noMoney = 'No payment is taken or refunded, and no Credits are granted or removed.';
  const recorded = `Recorded in the subscription history and the audit log with the reason: "${request.reason}".`;
  const periodEnd = view.current ? when(view.current.currentPeriodEnd) : '—';
  switch (request.action) {
    case 'assign':
      return {
        title: `Assign ${plan?.displayName ?? request.planCode} to ${email}?`,
        body: `Premium starts now, for one billing period of the plan (${plan ? months(plan.billingPeriodMonths) : '—'}). ${noMoney} ${recorded}`,
      };
    case 'change_plan':
      return {
        title: `Move ${email} to ${plan?.displayName ?? request.planCode}?`,
        body: `The new plan applies now. The status and the period end (${periodEnd}) stay as they are. ${noMoney} ${recorded}`,
      };
    case 'cancel':
      return {
        title: `Cancel ${email}'s subscription at the period end?`,
        body: `Premium continues until ${periodEnd}, then ends. ${noMoney} ${recorded}`,
      };
    case 'end':
      return {
        title: `End ${email}'s subscription now?`,
        body: `Premium ends immediately and the account becomes Free. ${noMoney} ${recorded}`,
      };
  }
}
