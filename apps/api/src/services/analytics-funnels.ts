import { sql, type SQL } from 'drizzle-orm';
import type { AnalyticsEventName, AnalyticsFunnel, AnalyticsFunnelsView } from '@over18/shared';
import type { Db } from '../db/client.js';
// The audit export's cell rule: quoted, and safe from spreadsheet formulas.
import { csvCell } from './audit-service.js';

/**
 * THE COMMERCIAL FUNNELS (PR 3), read from `analytics_events`.
 *
 * A funnel is a fixed sequence of events. A customer reaches a step when they
 * have the step's event AT OR AFTER the moment they reached the step before,
 * inside the window -- so each step counts people, not events, and nobody is
 * counted at a step they reached out of order. Anonymous events (no user) are
 * never in a funnel; they still appear in the per-event counts.
 *
 * A CORRELATED funnel follows one thing, not just one person: every step must
 * carry the same value of its `correlate` property (Funnel C: the same
 * `assetId`). Viewing post A and then buying and unlocking post B is two
 * unfinished journeys, never one finished one. A step still counts PEOPLE --
 * those with at least one journey that reached it.
 *
 * Read-only, and fixed: the four funnels below are the whole of it. There is no
 * query language, no user list and no per-customer drill-down here -- an
 * analyst sees how many, never who.
 */

interface StepDef {
  name: AnalyticsEventName;
  /** Optional equality on one stored property. */
  where?: { property: string; value: string };
  label: string;
}

interface FunnelDef {
  key: AnalyticsFunnel['key'];
  title: string;
  steps: readonly StepDef[];
  /** A stored property every step must share, so the funnel follows one item through. */
  correlate?: 'assetId';
}

export const FUNNELS: readonly FunnelDef[] = [
  {
    key: 'free_to_premium',
    title: 'Free → Premium',
    steps: [
      { name: 'paywall_viewed', where: { property: 'tier', value: 'free' }, label: 'Saw a Premium paywall (free)' },
      { name: 'subscription_cta_clicked', label: 'Chose a plan' },
      { name: 'subscription_started', label: 'Premium started (payment confirmed)' },
    ],
  },
  {
    key: 'free_to_credit_purchase',
    title: 'Free → Credit purchase',
    steps: [
      { name: 'credit_purchase_viewed', where: { property: 'tier', value: 'free' }, label: 'Opened the Credits store (free)' },
      { name: 'credit_purchase_started', label: 'Started a Credit pack checkout' },
      { name: 'credit_purchase_completed', label: 'Credit pack paid (payment confirmed)' },
    ],
  },
  {
    key: 'locked_content_to_unlock',
    title: 'Locked content → purchase → unlock',
    // The SAME post throughout: its view, the checkout bought for it, that
    // payment, and its unlock.
    correlate: 'assetId',
    steps: [
      { name: 'locked_content_viewed', label: 'Saw locked content' },
      {
        name: 'credit_purchase_started',
        where: { property: 'originAction', value: 'content_unlock' },
        label: 'Started a checkout to unlock content',
      },
      {
        name: 'credit_purchase_completed',
        where: { property: 'originAction', value: 'content_unlock' },
        label: 'Paid for it (payment confirmed)',
      },
      { name: 'locked_content_unlocked', label: 'Unlocked content' },
    ],
  },
  {
    key: 'purchase_to_spend',
    title: 'Purchase → spend',
    steps: [
      { name: 'credit_purchase_completed', label: 'Credit pack paid (payment confirmed)' },
      { name: 'credit_spend', label: 'Spent Credits' },
    ],
  },
];

/** The properties a funnel may correlate on, spelled out so only these can be inlined. */
const CORRELATE_PROPERTY: Record<NonNullable<FunnelDef['correlate']>, string> = { assetId: 'assetId' };

/** The longest window one request may read. */
export const FUNNEL_MAX_DAYS = 366;
const DEFAULT_DAYS = 30;
const DAY_MS = 86_400_000;

export class AnalyticsQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnalyticsQueryError';
  }
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function parseDay(value: unknown, label: string): Date | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !DATE.test(value)) throw new AnalyticsQueryError(`${label} must be a date (YYYY-MM-DD).`);
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new AnalyticsQueryError(`${label} is not a real date.`);
  }
  return date;
}

/**
 * The window, in whole UTC days: `from` inclusive, `to` inclusive (stored as
 * the start of the following day, exclusive). Defaults to the last 30 days.
 */
export function parseAnalyticsWindow(
  query: { from?: unknown; to?: unknown },
  now: Date = new Date(),
): { from: Date; toExclusive: Date } {
  const to = parseDay(query.to, 'to') ?? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const from = parseDay(query.from, 'from') ?? new Date(to.getTime() - (DEFAULT_DAYS - 1) * DAY_MS);
  if (from.getTime() > to.getTime()) throw new AnalyticsQueryError('from must not be after to.');
  if ((to.getTime() - from.getTime()) / DAY_MS + 1 > FUNNEL_MAX_DAYS) {
    throw new AnalyticsQueryError(`A window may span at most ${FUNNEL_MAX_DAYS} days.`);
  }
  return { from, toExclusive: new Date(to.getTime() + DAY_MS) };
}

function stepFilter(step: StepDef, alias: string): SQL {
  const e = sql.raw(alias);
  const base = sql`${e}.name = ${step.name}`;
  return step.where ? sql`${base} and ${e}.properties ->> ${step.where.property} = ${step.where.value}` : base;
}

async function countFunnel(db: Db, funnel: FunnelDef, from: Date, toExclusive: Date): Promise<number[]> {
  const window = (alias: string) =>
    sql`${sql.raw(alias)}.occurred_at >= ${from.toISOString()}::timestamptz and ${sql.raw(alias)}.occurred_at < ${toExclusive.toISOString()}::timestamptz and ${sql.raw(alias)}.user_id is not null`;

  // A journey is (customer, k): k is the correlated property's value, or one
  // constant when the funnel follows only the customer. An event without the
  // correlated property belongs to no journey.
  // Inlined, not bound: the SELECT and the GROUP BY must be the identical
  // expression, and `correlate` is a fixed literal of this file, never input.
  const key = funnel.correlate ? sql.raw(`(e.properties ->> '${CORRELATE_PROPERTY[funnel.correlate]}')`) : sql`''`;
  const keyed = funnel.correlate ? sql` and ${key} is not null` : sql``;
  const groupKey = funnel.correlate ? sql`, ${key}` : sql``;

  // s1: each journey's first qualifying event. sN: the journey's first event of
  // step N at or after the moment it reached step N-1 -- same customer, same k.
  const ctes: SQL[] = funnel.steps.map((step, i) => {
    const name = sql.raw(`s${i + 1}`);
    if (i === 0) {
      return sql`${name} as (select e.user_id, ${key} as k, min(e.occurred_at) as t from analytics_events e where ${stepFilter(step, 'e')} and ${window('e')}${keyed} group by e.user_id${groupKey})`;
    }
    const prev = sql.raw(`s${i}`);
    return sql`${name} as (select e.user_id, ${key} as k, min(e.occurred_at) as t from analytics_events e join ${prev} p on p.user_id = e.user_id and p.k = ${key} and e.occurred_at >= p.t where ${stepFilter(step, 'e')} and ${window('e')} group by e.user_id${groupKey})`;
  });
  // People, not journeys: a customer with two journeys at a step is one person there.
  const counts = funnel.steps.map((_, i) => sql`(select count(distinct user_id)::int from ${sql.raw(`s${i + 1}`)}) as ${sql.raw(`c${i + 1}`)}`);

  const result = await db.execute<Record<string, number>>(
    sql`with ${sql.join(ctes, sql`, `)} select ${sql.join(counts, sql`, `)}`,
  );
  const row = result.rows[0] ?? {};
  return funnel.steps.map((_, i) => Number(row[`c${i + 1}`] ?? 0));
}

export async function readAnalyticsFunnels(
  db: Db,
  window: { from: Date; toExclusive: Date },
  recording: boolean,
): Promise<AnalyticsFunnelsView> {
  const { from, toExclusive } = window;
  const funnels: AnalyticsFunnel[] = [];
  for (const def of FUNNELS) {
    const counts = await countFunnel(db, def, from, toExclusive);
    funnels.push({ key: def.key, title: def.title, steps: def.steps.map((s, i) => ({ label: s.label, users: counts[i]! })) });
  }

  const totals = await db.execute<{ name: string; n: number }>(
    sql`select name, count(*)::int as n from analytics_events
        where occurred_at >= ${from.toISOString()}::timestamptz and occurred_at < ${toExclusive.toISOString()}::timestamptz
        group by name order by name`,
  );
  const eventCounts: Record<string, number> = {};
  for (const r of totals.rows) eventCounts[r.name] = Number(r.n);

  return {
    from: from.toISOString().slice(0, 10),
    to: new Date(toExclusive.getTime() - DAY_MS).toISOString().slice(0, 10),
    funnels,
    eventCounts,
    failedCreditPurchases: eventCounts.credit_purchase_failed ?? 0,
    recording,
  };
}

/* ------------------------------------------------------------------ *
 * Export -- bounded, and nothing but the stored event
 * ------------------------------------------------------------------ */

export const ANALYTICS_EXPORT_MAX = 10_000;
const CSV_COLUMNS = ['occurred_at', 'name', 'source', 'user_id', 'properties'] as const;

/**
 * The window's events, oldest first, at most ANALYTICS_EXPORT_MAX rows. Each
 * row is exactly what was stored: the user id and allow-listed properties --
 * never an email or anything joined from the account.
 */
export async function exportAnalyticsEventsCsv(
  db: Db,
  window: { from: Date; toExclusive: Date },
  limit = ANALYTICS_EXPORT_MAX,
): Promise<{ csv: string; rows: number; truncated: boolean }> {
  const bounded = Math.max(1, Math.min(limit, ANALYTICS_EXPORT_MAX));
  const result = await db.execute<{ occurred_at: Date | string; name: string; source: string; user_id: string | null; properties: unknown }>(
    sql`select occurred_at, name, source, user_id, properties from analytics_events
        where occurred_at >= ${window.from.toISOString()}::timestamptz and occurred_at < ${window.toExclusive.toISOString()}::timestamptz
        order by occurred_at, id limit ${bounded + 1}`,
  );
  const rows = result.rows.slice(0, bounded);
  const lines = [CSV_COLUMNS.join(',')];
  for (const r of rows) {
    const at = r.occurred_at instanceof Date ? r.occurred_at.toISOString() : new Date(r.occurred_at).toISOString();
    lines.push([at, r.name, r.source, r.user_id, r.properties ?? {}].map(csvCell).join(','));
  }
  return { csv: `${lines.join('\r\n')}\r\n`, rows: rows.length, truncated: result.rows.length > bounded };
}
