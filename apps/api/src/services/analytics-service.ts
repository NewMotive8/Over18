import { isAnalyticsEventName, type AnalyticsEventName } from '@over18/shared';

/**
 * Analytics events (PRD v1.2 §23) -- the pipeline, not the destination.
 *
 * WHERE EVENTS GO IS UNDECIDED (a first-party table or a vendor), so this is a
 * seam: callers emit typed events, and a sink decides what happens to them.
 * The default sink discards. Each economy phase emits its own events as it
 * ships -- "ships with, not after, the surfaces it measures" (§27 step 10) --
 * and choosing a destination later is a change to one sink.
 *
 * ANALYTICS MUST NEVER BREAK THE ACTION IT MEASURES. `emit` does not throw and
 * does not need awaiting for correctness: a failing sink is reported and the
 * paid action, paywall or purchase it was describing carries on.
 */

export type AnalyticsPropertyValue = string | number | boolean | null;

export interface AnalyticsEvent {
  name: AnalyticsEventName;
  /** Null for an anonymous visitor. Never an email or any other identifier. */
  userId: string | null;
  occurredAt: Date;
  properties: Readonly<Record<string, AnalyticsPropertyValue>>;
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

export interface Analytics {
  /** Resolves true if the event reached the sink, false if dropped or failed. */
  emit(
    name: AnalyticsEventName,
    input: { userId: string | null; properties?: Record<string, AnalyticsPropertyValue> },
  ): Promise<boolean>;
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
    async emit(name, input) {
      if (!options.enabled) return false;
      // The type already forbids an unknown name; this refuses one that arrives
      // from outside the type system, e.g. relayed from a browser later.
      if (!isAnalyticsEventName(name)) return false;
      try {
        await sink.write({
          name,
          userId: input.userId,
          occurredAt: now(),
          properties: { ...(input.properties ?? {}) },
        });
        return true;
      } catch (error) {
        options.onError?.(error, name);
        return false;
      }
    },
  };
}
