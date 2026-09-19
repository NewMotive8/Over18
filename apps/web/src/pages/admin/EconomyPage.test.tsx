import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { ECONOMY_SECTIONS } from '../../admin/economy';
import { previewResponse } from '../../admin/economyTestData';
import EconomyPage, { BackendPendingPanel, PreviewReport } from './EconomyPage';

/**
 * P1.4 -- the Economy admin screens, rendered statically (the suite runs no
 * effects). The page never fetches on render: the preview runs only when an
 * admin asks for it.
 */

/** A money-like figure; CSS values such as tracking-[0.18em] are not amounts. */
const AMOUNT = /(?<![[\w.])\d+\.\d{2,}(?!\w)/;

const renderAt = (path: string) =>
  renderToStaticMarkup(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/admin/economy" element={<EconomyPage />} />
        <Route path="/admin/economy/:section" element={<EconomyPage />} />
      </Routes>
    </MemoryRouter>,
  );

describe('the economy console', () => {
  it('opens on the preview: an empty form, no result and no figures until it is run', () => {
    const html = renderAt('/admin/economy');
    expect(html).toContain('Preview &amp; margin guard');
    expect(html).toContain('Run preview');
    expect(html).toContain('Read-only: nothing is saved, published or activated.');
    expect(html).not.toContain('Configuration');
    expect(html).not.toMatch(AMOUNT);
  });

  it('shows "Backend support pending" -- and nothing else -- for every screen without a server', () => {
    for (const section of ECONOMY_SECTIONS.filter((s) => s.backend.status === 'pending')) {
      const html = renderAt(section.path);
      expect(html, section.key).toContain('Backend support pending');
      expect(html, section.key).not.toMatch(/<input|<textarea|<select|type="submit"/);
      expect(html, section.key).not.toMatch(AMOUNT);
    }
  });

  it('lists what is missing on a pending screen and points to the preview', () => {
    const plans = ECONOMY_SECTIONS.find((s) => s.key === 'plans')!;
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <BackendPendingPanel section={plans} />
      </MemoryRouter>,
    );
    expect(html).toContain('No admin endpoint lists, creates or edits plan versions.');
    expect(html).toContain('href="/admin/economy"');
  });

  it('says so for an unknown section', () => {
    expect(renderAt('/admin/economy/wallets')).toContain('There is no such economy section.');
  });
});

describe('the preview report', () => {
  const render = (preview = previewResponse()) =>
    renderToStaticMarkup(
      <MemoryRouter>
        <PreviewReport preview={preview} />
      </MemoryRouter>,
    );

  it('shows each configuration version with its state', () => {
    const html = render();
    expect(html).toContain('test_monthly');
    expect(html).toContain('v2');
    expect(html).toContain('Draft');
    expect(html).toContain('Live');
  });

  it("shows the server's figures exactly as sent", () => {
    const html = render();
    expect(html).toContain('A month of test_monthly v2 (Draft) -- 100 Credits -- buys:');
    expect(html).toContain('20 min of voice_call/standard/any');
    expect(html).toContain('0.080 USD');
    expect(html).toContain('Spread: 20%');
    expect(html).toContain('12.00 USD a month');
    expect(html).toContain('Test caveat from the server.');
  });

  it('shows incomplete figures as gaps, never as zero', () => {
    const html = render();
    expect(html).toContain('incomplete: no usage supplied for image/standard/any');
    expect(html).toContain('incomplete: no sales channel supplied');
    expect(html).toContain('AI provider cost missing');
  });

  it('flags ladder issues and runtime refusals as alerts', () => {
    const base = previewResponse();
    const html = render({
      ...base,
      ladders: [{ ...base.ladders[0]!, issues: [{ kind: 'inverted', rung: 'test_large', previous: 'test_small' }] }],
      configurationIssues: [{ action: 'video/standard/5s', reason: 'ambiguous_configuration' }],
    });
    expect(html).toContain('test_large is dearer per Credit than test_small');
    expect(html).toContain('Runtime would refuse video/standard/5s: ambiguous_configuration');
  });

  it('says when the margin guard is not configured, rather than implying it passed', () => {
    expect(render()).toContain('Gross floor: not configured · Net floor: not configured');
  });
});
