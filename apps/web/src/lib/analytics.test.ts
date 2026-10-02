import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ANALYTICS_CLIENT_EVENTS, ANALYTICS_EVENT_NAMES, type AnalyticsClientEventName } from '@over18/shared';
import { setAnalyticsTransport, track } from './analytics';

/**
 * Funnel analytics from the browser (Credits Store PR 3): fire-and-forget,
 * client events only, and wired into exactly the surfaces it measures.
 */

afterEach(() => setAnalyticsTransport(null));

const capture = () => {
  const sent: unknown[] = [];
  setAnalyticsTransport((body) => sent.push(JSON.parse(body)));
  return sent;
};

describe('track', () => {
  it('sends the event name and its properties, dropping empty values', () => {
    const sent = capture();
    track('paywall_viewed', { surface: 'premium_gate', characterId: undefined, tier: null });
    expect(sent).toEqual([{ name: 'paywall_viewed', properties: { surface: 'premium_gate' } }]);
  });

  it('refuses a server event even if one is forced past the type', () => {
    const sent = capture();
    track('credit_purchase_completed' as AnalyticsClientEventName);
    track('credit_spend' as AnalyticsClientEventName);
    expect(sent).toEqual([]);
  });

  it('never throws, whatever the transport does', () => {
    setAnalyticsTransport(() => {
      throw new Error('offline');
    });
    expect(() => track('paywall_dismissed', { surface: 'credits_store' })).not.toThrow();
  });

  it('the client list is a subset of the catalogue, with no purchase, spend or unlock in it', () => {
    for (const name of ANALYTICS_CLIENT_EVENTS) expect(ANALYTICS_EVENT_NAMES).toContain(name);
    expect(ANALYTICS_CLIENT_EVENTS).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/started|completed|failed|spend|unlocked|refunded/)]),
    );
  });
});

describe('where the browser reports', () => {
  const src = fileURLToPath(new URL('..', import.meta.url));
  const read = (rel: string) => readFileSync(join(src, rel), 'utf8');
  function files(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return files(path);
      return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
    });
  }
  const sources = () => files(src).map((path) => relative(src, path).split('\\').join('/'));
  /** Every (file, event) pair the app reports. */
  const reported = () =>
    sources().flatMap((rel) =>
      [...read(rel).matchAll(/(?:track|useTrackView)\(\s*'([a-z_]+)'/g)].map((m) => `${rel}: ${m[1]}`),
    );

  it('reports exactly the planned events from exactly the planned surfaces', () => {
    expect(reported().sort()).toEqual(
      [
        'components/PremiumGate.tsx: paywall_viewed',
        'components/PremiumGate.tsx: paywall_dismissed',
        'components/PremiumGate.tsx: paywall_dismissed',
        'components/PremiumGate.tsx: subscription_cta_clicked',
        'pages/SubscriptionPage.tsx: paywall_viewed',
        'pages/SubscriptionPage.tsx: subscription_cta_clicked',
        'pages/SubscriptionPage.tsx: paywall_dismissed',
        'pages/CreditsStorePage.tsx: credit_purchase_viewed',
        'pages/CreditsStorePage.tsx: paywall_dismissed',
        'components/profile/PostsTab.tsx: locked_content_viewed',
      ].sort(),
    );
  });

  it('never sends a server-owned fact: tier, balance state, access decision or price', () => {
    for (const rel of ['components/PremiumGate.tsx', 'pages/SubscriptionPage.tsx', 'pages/CreditsStorePage.tsx', 'components/profile/PostsTab.tsx']) {
      // Only the reports themselves: the unlock flow uses a price for its own purposes.
      const calls = [...read(rel).matchAll(/(?:track|useTrackView)\(\s*'[a-z_]+',\s*\{[^}]*\}/g)].map((m) => m[0]);
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) expect(call).not.toMatch(/\b(tier|balanceState|decision|creditPrice)\b/);
    }
  });
});
