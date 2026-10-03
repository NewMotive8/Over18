import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AnalyticsFunnelsView } from '@over18/shared';
import { AnalyticsReport, stepConversion } from './AdminAnalyticsPage';
import { adminAnalyticsApi } from '../../lib/api';

const VIEW: AnalyticsFunnelsView = {
  from: '2026-09-01',
  to: '2026-09-30',
  funnels: [
    {
      key: 'free_to_credit_purchase',
      title: 'Free → Credit purchase',
      steps: [
        { label: 'Opened the Credits store (free)', users: 200 },
        { label: 'Started a Credit pack checkout', users: 50 },
        { label: 'Credit pack paid (payment confirmed)', users: 4 },
      ],
    },
    { key: 'purchase_to_spend', title: 'Purchase → spend', steps: [{ label: 'Paid', users: 0 }, { label: 'Spent', users: 0 }] },
  ],
  eventCounts: { credit_purchase_viewed: 260, credit_purchase_failed: 3 },
  failedCreditPurchases: 3,
  recording: true,
};

describe('Admin -> Analytics', () => {
  it('shows each funnel as a table of people per step, with step-to-step conversion', () => {
    const html = renderToStaticMarkup(<AnalyticsReport view={VIEW} />);
    expect(html).toContain('Free → Credit purchase');
    expect(html).toContain('Opened the Credits store (free)');
    expect(html).toContain('>200<');
    expect(html).toContain('>25%<');
    expect(html).toContain('>8.0%<');
    expect(html).toContain('failed or cancelled Credit purchases: 3');
    expect(html).toContain('credit_purchase_viewed');
    expect(html).not.toContain('switched off');
  });

  it('says so when recording is off', () => {
    const html = renderToStaticMarkup(<AnalyticsReport view={{ ...VIEW, recording: false, eventCounts: {}, failedCreditPurchases: 0 }} />);
    expect(html).toContain('Analytics recording is switched off');
    expect(html).toContain('No events in this range.');
  });

  it('has no conversion for a first step or after an empty one', () => {
    expect(stepConversion(VIEW.funnels[1]!.steps, 0)).toBe('—');
    expect(stepConversion(VIEW.funnels[1]!.steps, 1)).toBe('—');
  });

  it('exports the range shown', () => {
    expect(adminAnalyticsApi.exportUrl({ from: '2026-09-01', to: '2026-09-30' })).toMatch(
      /\/admin\/analytics\/events\/export\.csv\?from=2026-09-01&to=2026-09-30$/,
    );
  });
});
