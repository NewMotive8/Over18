import { allowedAnalyticsProperties, isAnalyticsEventName, type AnalyticsEventName } from '@over18/shared';
import type { Db } from '../db/client.js';
import { analyticsEvents } from '../db/schema.js';

/**
 * Analytics events (PRD v1.2 §23).
 *
 * Callers emit typed events; a sink decides where they go. Since PR 3 the
 * destination is first-party: `createDbAnalyticsSink` writes `analytics_events`.
 * Nothing is recorded unless ANALYTICS_ENABLED is on.
 *
 * ANALYTICS MUST NEVER BREAK THE ACTION IT MEASURES. `emit` does not throw and
 * does not need awaiting for correctness: a failing sink is reported and the
 * paid action, paywall or purchase it was describing carries on. Business code
 * uses `track`, which does not wait at all -- and calls it only AFTER its own
 * transaction has committed, so an event never describes something that rolled
 * back.
 *
 * NO PII BEYOND THE USER ID. Every event's properties are cut down to the
 * shared per-event allow-list (`ANALYTICS_EVENT_PROPERTIES`) before any sink
 * sees them: ids, short codes, whole numbers, booleans and fixed values only.
 */

export type AnalyticsPropertyValue = string | number | boolean | null;
export type AnalyticsSource = 'server' | 'client';

export interface AnalyticsEvent {
  name: AnalyticsEventName;
  /** Null for an anonymous visitor. Never an email or any other identifier. */
  userId: string | null;
  occurredAt: Date;
  /** Already cut down to the event's allow-list. */
  properties: Readonly<Record<string, string | number | boolean>>;
  source: AnalyticsSource;
  requestId: string | null;
}

export interface AnalyticsSink {
  write(event: AnalyticsEvent): Promise<void>;
}

export const noopAnalyticsSink: AnalyticsSink = {
  async write() {},
};

/** Collects events in memory. For tests and local verification only. */
export function createMemoryAnalyticsSink(): AnalyticsSink & { events: AnalyticsEvent[] } {
  const events: AnalyticsEvent[] = [];
  return {
    events,
    async write(event) {
      events.push(event);
    },
  };
}

/** One row of `analytics_events` per event. */
export function createDbAnalyticsSink(db: Db): AnalyticsSink {
  return {
    async write(event) {
      await db.insert(analyticsEvents).values({
        name: event.name,
        userId: event.userId,
        occurredAt: event.occurredAt,
        source: event.source,
        properties: { ...event.properties },
        requestId: event.requestId,
      });
    },
  };
}

export interface EmitInput {
  userId: string | null;
  properties?: Record<string, unknown>;
  /** `server` unless a browser reported it. */
  source?: AnalyticsSource;
  requestId?: string | null;
  /**
   * When the thing happened. `track` sets it at the moment it is called --
   * right after the commit -- so work done later to describe the event (reading
   * its properties, waiting for the store) can never move it later than an
   * event that genuinely happened after it.
   */
  occurredAt?: Date;
}

export interface Analytics {
  readonly enabled: boolean;
  /** The analytics clock: what `track` stamps an event with when it is emitted. */
  now(): Date;
  /** Resolves true if the event reached the sink, false if dropped or failed. Never rejects. */
  emit(name: AnalyticsEventName, input: EmitInput): Promise<boolean>;
}

export function createAnalytics(options: {
  enabled: boolean;
  sink?: AnalyticsSink;
  onError?: (error: unknown, name: string) => void;
  now?: () => Date;
}): Analytics {
  const sink = options.sink ?? noopAnalyticsSink;
  const now = options.now ?? (() => new Date());

  return {
    enabled: options.enabled,
    now,
    async emit(name, input) {
      if (!options.enabled) return false;
      // The type already forbids an unknown name; this refuses one that arrives
      // from outside the type system -- e.g. relayed from a browser.
      if (!isAnalyticsEventName(name)) return false;
      try {
        await sink.write({
          name,
          userId: input.userId,
          // The emitter's time when it gave one; the sink writes it as given.
          occurredAt: input.occurredAt ?? now(),
          properties: allowedAnalyticsProperties(name, input.properties ?? {}),
          source: input.source ?? 'server',
          requestId: input.requestId ?? null,
        });
        return true;
      } catch (error) {
        try {
          options.onError?.(error, name);
        } catch {
          /* a failing error reporter is not the action's problem either */
        }
        return false;
      }
    },
  };
}

/** Records nothing. What every service uses when it is given no analytics. */
export const disabledAnalytics: Analytics = createAnalytics({ enabled: false });

/**
 * Emit from business code, AFTER its transaction has committed. Returns the
 * pending emit (for tests that want to wait for it) but callers never await it:
 * it cannot throw, delay or fail the action it describes. The input is built
 * lazily -- not at all while analytics is off -- and a failure building it
 * costs a data point, never a purchase.
 *
 * THE TIME IS TAKEN HERE, SYNCHRONOUSLY, before anything is awaited: an event
 * is dated when it happened, not when its properties finished loading.
 */
export function track(
  analytics: Analytics | undefined,
  name: AnalyticsEventName,
  input: () => EmitInput | Promise<EmitInput>,
): Promise<boolean> {
  if (!analytics?.enabled) return Promise.resolve(false);
  let occurredAt: Date;
  try {
    occurredAt = analytics.now();
  } catch {
    return Promise.resolve(false);
  }
  return (async () => {
    try {
      return await analytics.emit(name, { ...(await input()), occurredAt });
    } catch {
      return false;
    }
  })();
}
