import { useEffect, useRef } from 'react';
import { isAnalyticsClientEvent, type AnalyticsClientEventName } from '@over18/shared';
import { API_URL } from './api';

/**
 * Funnel analytics from the browser (Credits Store PR 3).
 *
 * The browser reports only what the server cannot see: that a customer SAW or
 * DISMISSED a paywall, the Credits store or locked content. Purchases, spends
 * and unlocks are recorded by the server after they commit -- never from here.
 *
 * FIRE AND FORGET. `track` returns nothing, never throws and never delays the
 * page; a failed report is simply lost. The server drops anything that is not
 * on the event's allow-list, so passing a property it does not keep is
 * harmless -- but never pass free text, an email or a URL.
 */

export type AnalyticsClientProperties = Record<string, string | number | boolean | null | undefined>;

/** Injectable for tests; the real one posts with the session cookie. */
type Transport = (body: string) => void;

const defaultTransport: Transport = (body) => {
  void fetch(`${API_URL}/api/analytics/events`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body,
    // Survives the navigation a CTA click usually triggers.
    keepalive: true,
  }).catch(() => {});
};

let transport: Transport = defaultTransport;

export function setAnalyticsTransport(next: Transport | null): void {
  transport = next ?? defaultTransport;
}

export function track(name: AnalyticsClientEventName, properties: AnalyticsClientProperties = {}): void {
  try {
    if (!isAnalyticsClientEvent(name)) return;
    const kept: Record<string, string | number | boolean> = {};
    for (const [key, value] of Object.entries(properties)) {
      if (value !== null && value !== undefined) kept[key] = value;
    }
    transport(JSON.stringify({ name, properties: kept }));
  } catch {
    /* analytics never breaks the page */
  }
}

/**
 * Reports a "viewed" event once per mount, when `ready` -- e.g. once the data
 * the properties describe has loaded. Later changes to the properties do not
 * report again.
 */
export function useTrackView(name: AnalyticsClientEventName, properties: AnalyticsClientProperties, ready = true): void {
  const sent = useRef(false);
  const latest = useRef(properties);
  latest.current = properties;
  useEffect(() => {
    if (!ready || sent.current) return;
    sent.current = true;
    track(name, latest.current);
  }, [name, ready]);
}
