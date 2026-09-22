import {
  ApiRequestError,
  type EconomyPreviewRequest,
  type EconomyPreviewResponse,
  type PreviewGap,
  type PreviewMoney,
  type PreviewSource,
} from '../lib/api';

/**
 * Admin -> Economy (P1.4), as pure logic. The web suite runs no effects, so
 * everything the screens decide lives here and is tested here; the page only
 * renders.
 *
 * THE SERVER IS THE AUTHORITY. Every figure shown comes from the P1.3 preview
 * response exactly as the server computed and rounded it -- nothing here does
 * commercial arithmetic, and no economy value is written into this module.
 * Where the server has no endpoint for a screen, the screen says so.
 */

/* ------------------------------------------------------------------ *
 * Sections
 * ------------------------------------------------------------------ */

export type EconomySectionKey = 'preview' | 'plans' | 'packs' | 'action-costs' | 'allowances' | 'rewards' | 'versions';

export interface EconomySection {
  key: EconomySectionKey;
  label: string;
  path: string;
  /** What the screen manages, per PRD §31 and the P1.4 scope. */
  manages: string;
}

export const ECONOMY_SECTIONS: readonly EconomySection[] = [
  {
    key: 'preview',
    label: 'Preview & margin guard',
    path: '/admin/economy',
    manages: 'What the drafted or live economy buys, costs and earns, and the margin guard.',
  },
  {
    key: 'plans',
    label: 'Plans',
    path: '/admin/economy/plans',
    manages: 'Plan name, term, price, currency, monthly Credit grant, feature flags and purchasability -- one draft per plan.',
  },
  {
    key: 'packs',
    label: 'Credit packs',
    path: '/admin/economy/packs',
    manages: 'The Credit pack ladder: Credits, price, currency, position, best-value flag and purchasability -- one draft per pack.',
  },
  {
    key: 'action-costs',
    label: 'Action costs',
    path: '/admin/economy/action-costs',
    manages: 'Credit cost per action, quality tier and duration tier -- part of the one ruleset draft.',
  },
  {
    key: 'allowances',
    label: 'Allowances',
    path: '/admin/economy/allowances',
    manages: 'The catalogue allowances -- part of the one ruleset draft.',
  },
  {
    key: 'rewards',
    label: 'Rewards',
    path: '/admin/economy/rewards',
    manages: 'Reward amounts and per-user caps -- part of the one ruleset draft.',
  },
  {
    key: 'versions',
    label: 'Versions & publishing',
    path: '/admin/economy/versions',
    manages: 'Every version by state, the old -> new review of all open drafts, publishing them together, and cancelling a scheduled version.',
  },
];

/** The section for a route parameter: none is the preview; an unknown one is null. */
export function economySection(param: string | undefined): EconomySection | null {
  if (param === undefined || param === '') return ECONOMY_SECTIONS[0]!;
  return ECONOMY_SECTIONS.find((section) => section.key === param) ?? null;
}

/* ------------------------------------------------------------------ *
 * The preview request -- built from the form, validated by the server
 * ------------------------------------------------------------------ */

export interface PreviewForm {
  mode: 'drafted' | 'live';
  /** JSON: providers, rates, usage, salesChannels, otherCosts. */
  costInputs: string;
  minGrossMarginPercent: string;
  minNetMarginPercent: string;
  maxCostAgeDays: string;
}

/** The form starts empty: no rate, cost or threshold is pre-filled. */
export const EMPTY_PREVIEW_FORM: PreviewForm = {
  mode: 'drafted',
  costInputs: '',
  minGrossMarginPercent: '',
  minNetMarginPercent: '',
  maxCostAgeDays: '',
};

export const COST_INPUT_KEYS = ['providers', 'rates', 'usage', 'salesChannels', 'otherCosts'] as const;

export type BuiltPreviewRequest = { ok: true; body: EconomyPreviewRequest } | { ok: false; errors: string[] };

/**
 * The request body for a form. Checks only what the browser must: that the
 * cost inputs are a JSON object of the known keys, and that the numeric fields
 * are numbers. Ranges and every rule about the inputs are the server's, which
 * answers with all of its messages -- they are not restated here.
 */
export function buildPreviewRequest(form: PreviewForm): BuiltPreviewRequest {
  const errors: string[] = [];
  let costInputs: Record<string, unknown> = {};
  const raw = form.costInputs.trim();
  if (raw !== '') {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        errors.push('Cost inputs must be a JSON object.');
      } else {
        const unknownKeys = Object.keys(parsed).filter((key) => !(COST_INPUT_KEYS as readonly string[]).includes(key));
        if (unknownKeys.length > 0) {
          errors.push(
            `Cost inputs may contain only ${COST_INPUT_KEYS.join(', ')} -- not ${unknownKeys.join(', ')}. Set the mode and margin floors with the fields above.`,
          );
        }
        costInputs = parsed as Record<string, unknown>;
      }
    } catch (error) {
      errors.push(`Cost inputs are not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const number = (value: string, label: string): number | null => {
    const trimmed = value.trim();
    if (trimmed === '') return null;
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) {
      errors.push(`${label} must be a number, or left empty.`);
      return null;
    }
    return parsed;
  };
  const marginGuard = {
    minGrossMarginPercent: number(form.minGrossMarginPercent, 'Minimum gross margin'),
    minNetMarginPercent: number(form.minNetMarginPercent, 'Minimum net margin'),
    maxCostAgeDays: number(form.maxCostAgeDays, 'Maximum cost age'),
  };
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, body: { ...costInputs, mode: form.mode, marginGuard } };
}

/** What to tell the admin when the preview request fails. */
export function previewErrorMessages(error: unknown): string[] {
  if (error instanceof ApiRequestError) {
    if (error.status === 400) {
      const messages = (error.details as { messages?: unknown } | null)?.messages;
      if (Array.isArray(messages) && messages.every((m) => typeof m === 'string') && messages.length > 0) return messages;
      return [error.message];
    }
    if (error.status === 401) return ['Your session has ended. Sign in again to run the preview.'];
    if (error.status === 403) return [error.message || 'Your role does not include economy.manage.'];
  }
  return ['The preview could not be run. Try again.'];
}

/* ------------------------------------------------------------------ *
 * Reading the server's answer -- wording only, no arithmetic
 * ------------------------------------------------------------------ */

export const formatMoney = (money: PreviewMoney): string => `${money.amount} ${money.currency}`;

export const sourceLabel = (source: PreviewSource): string => (source === 'draft' ? 'Draft' : 'Live');

/** "A month of premium_monthly v1 (Draft) -- 300 Credits -- buys:" and each quantity, as the server counted it. */
export function grantSummaries(preview: EconomyPreviewResponse): Array<{ heading: string; items: string[] }> {
  return preview.grants.map((grant) => ({
    heading: `A month of ${grant.plan} v${grant.version} (${sourceLabel(grant.source)}) -- ${grant.monthlyCredits} Credits -- buys:`,
    items:
      grant.buys.length === 0
        ? ['nothing: no action is priced']
        : grant.buys.map((buy) =>
            buy.unit === 'per_minute' ? `${buy.quantity} min of ${buy.action}` : `${buy.quantity} × ${buy.action}`,
          ),
  }));
}

export function ladderIssueText(issue: EconomyPreviewResponse['ladders'][number]['issues'][number]): string {
  return issue.kind === 'inverted'
    ? `${issue.rung} is dearer per Credit than ${issue.previous}`
    : `${issue.rung} is no cheaper per Credit than ${issue.previous}`;
}

const GAP_WORDING: Record<PreviewGap['reason'], string> = {
  usage_not_supplied: 'no usage supplied for',
  unit_mismatch: 'usage unit does not match',
  rate_not_supplied: 'no rate supplied for',
  endpoint_not_declared: 'no endpoint declared for provider',
  mixed_currencies: 'mixed currencies',
  ai_provider_cost_incomplete: 'AI provider cost incomplete for',
  sales_channel_not_supplied: 'no sales channel supplied',
  infrastructure_not_supplied: 'no infrastructure allocation for',
  grant_cost_incomplete: 'grant cost incomplete for',
  no_purchasable_pack: 'no purchasable pack in',
  currency_mismatch: 'currency mismatch:',
};

export function gapText(gap: PreviewGap): string {
  return gap.reason === 'sales_channel_not_supplied' ? GAP_WORDING[gap.reason] : `${GAP_WORDING[gap.reason]} ${gap.ref}`;
}

/** The margin guard's warnings, gross then net, as sentences quoting the server's figures. */
export function marginWarnings(preview: EconomyPreviewResponse): string[] {
  const guard = preview.marginGuard;
  const gross = guard.warnings.map(
    (w) => `${w.action} at ${w.pack}: gross margin ${w.grossMarginPercent}% is below the ${guard.minGrossMarginPercent}% floor`,
  );
  const net = guard.net.warnings.map(
    (w) => `${w.action} at ${w.pack} via ${w.channel}: net margin ${w.netMarginPercent}% is below the ${guard.net.minNetMarginPercent}% floor`,
  );
  return [...gross, ...net];
}

/** The inputs report, as labelled lists -- only those with something in them. */
export function inputProblems(preview: EconomyPreviewResponse): Array<{ label: string; items: string[] }> {
  const inputs = preview.inputs;
  const lists: Array<{ label: string; items: string[] }> = [
    { label: 'AI provider cost missing', items: inputs.missingAiProviderCosts },
    { label: 'Matches no action or plan', items: inputs.unmatched },
    { label: 'Rates no usage refers to', items: inputs.unusedRates },
    { label: 'Unit mismatches', items: inputs.unitMismatches },
    { label: 'Currency mismatches', items: inputs.currencyMismatches },
    { label: 'Undated inputs', items: inputs.undated },
    { label: 'Stale inputs', items: inputs.stale.map((s) => `${s.input} (${s.ageDays} days old)`) },
    { label: 'Dated in the future', items: inputs.futureDated },
  ];
  return lists.filter((list) => list.items.length > 0);
}
