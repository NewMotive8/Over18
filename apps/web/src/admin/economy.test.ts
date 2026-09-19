import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ApiRequestError } from '../lib/api';
import {
  COST_INPUT_KEYS,
  ECONOMY_SECTIONS,
  EMPTY_PREVIEW_FORM,
  buildPreviewRequest,
  economySection,
  gapText,
  grantSummaries,
  inputProblems,
  ladderIssueText,
  marginWarnings,
  previewErrorMessages,
} from './economy';
import { previewResponse } from './economyTestData';

/**
 * P1.4 -- the Economy admin, as pure logic. Every figure in these tests is test
 * data in the server's response shape; the module under test has none.
 */

const form = (over: Partial<typeof EMPTY_PREVIEW_FORM> = {}) => ({ ...EMPTY_PREVIEW_FORM, ...over });

describe('economy sections', () => {
  it('only the preview has server support; every other screen is pending, and says what is missing', () => {
    expect(ECONOMY_SECTIONS.map((s) => [s.key, s.backend.status])).toEqual([
      ['preview', 'available'],
      ['plans', 'pending'],
      ['packs', 'pending'],
      ['action-costs', 'pending'],
      ['allowances', 'pending'],
      ['rewards', 'pending'],
      ['versions', 'pending'],
    ]);
    for (const section of ECONOMY_SECTIONS) {
      if (section.backend.status === 'pending') expect(section.backend.missing.length, section.key).toBeGreaterThan(0);
    }
    expect(new Set(ECONOMY_SECTIONS.map((s) => s.path)).size).toBe(ECONOMY_SECTIONS.length);
  });

  it('resolves a route parameter to a section; an unknown one to null', () => {
    expect(economySection(undefined)?.key).toBe('preview');
    expect(economySection('plans')?.key).toBe('plans');
    expect(economySection('preview')?.key).toBe('preview');
    expect(economySection('wallets')).toBeNull();
  });
});

describe('building the preview request', () => {
  it('an empty form sends no rate, cost or threshold -- nothing is pre-filled', () => {
    const built = buildPreviewRequest(EMPTY_PREVIEW_FORM);
    expect(built).toEqual({
      ok: true,
      body: { mode: 'drafted', marginGuard: { minGrossMarginPercent: null, minNetMarginPercent: null, maxCostAgeDays: null } },
    });
  });

  it('passes the cost inputs and numbers through as written, leaving every rule to the server', () => {
    const costs = { rates: [{ provider: 'p', meter: 'm' }], usage: { actions: [] } };
    const built = buildPreviewRequest(
      form({ mode: 'live', costInputs: JSON.stringify(costs), minGrossMarginPercent: '150', minNetMarginPercent: '-3', maxCostAgeDays: '1.5' }),
    );
    // 150%, -3% and 1.5 days are the server's to refuse, with its own messages.
    expect(built).toEqual({
      ok: true,
      body: { ...costs, mode: 'live', marginGuard: { minGrossMarginPercent: 150, minNetMarginPercent: -3, maxCostAgeDays: 1.5 } },
    });
  });

  it('refuses what the browser can know is wrong: bad JSON, a non-object, unknown keys, non-numbers', () => {
    expect(buildPreviewRequest(form({ costInputs: '{ nope' }))).toMatchObject({ ok: false });
    expect(buildPreviewRequest(form({ costInputs: '[1, 2]' }))).toEqual({ ok: false, errors: ['Cost inputs must be a JSON object.'] });
    const unknown = buildPreviewRequest(form({ costInputs: '{"mode":"live","marginGuard":{},"rates":[]}' }));
    expect(unknown.ok).toBe(false);
    expect(!unknown.ok && unknown.errors[0]).toContain('not mode, marginGuard');
    expect(buildPreviewRequest(form({ minGrossMarginPercent: 'lots' }))).toEqual({
      ok: false,
      errors: ['Minimum gross margin must be a number, or left empty.'],
    });
  });

  it('accepts exactly the cost inputs the server reads', () => {
    expect(COST_INPUT_KEYS).toEqual(['providers', 'rates', 'usage', 'salesChannels', 'otherCosts']);
  });
});

describe('preview errors', () => {
  it("shows the server's own validation messages for a 400", () => {
    const error = new ApiRequestError(400, 'invalid_preview_input', 'Request failed (400).', {
      error: 'invalid_preview_input',
      messages: ['rates[0].amountMicros must be a positive whole number (millionths of the currency unit).'],
    });
    expect(previewErrorMessages(error)).toEqual(['rates[0].amountMicros must be a positive whole number (millionths of the currency unit).']);
  });

  it('explains a missing permission, an ended session and anything else', () => {
    expect(previewErrorMessages(new ApiRequestError(403, 'forbidden', 'This action requires the economy.manage permission.'))).toEqual([
      'This action requires the economy.manage permission.',
    ]);
    expect(previewErrorMessages(new ApiRequestError(401, 'unauthorized', 'Authentication required.'))[0]).toContain('Sign in');
    expect(previewErrorMessages(new Error('network'))).toEqual(['The preview could not be run. Try again.']);
  });
});

describe('reading the preview -- wording only, the figures are the server’s', () => {
  it('says in plain words what a month of the grant buys', () => {
    expect(grantSummaries(previewResponse())).toEqual([
      {
        heading: 'A month of test_monthly v2 (Draft) -- 100 Credits -- buys:',
        items: ['10 × image/standard/any', '20 min of voice_call/standard/any'],
      },
    ]);
  });

  it('quotes the margin guard warnings with the floor they breach', () => {
    const preview = previewResponse({
      marginGuard: {
        status: 'evaluated',
        minGrossMarginPercent: 60,
        maxCostAgeDays: null,
        warnings: [{ action: 'image/standard/any', pack: 'test_large', grossMarginPercent: '59.99' }],
        notEvaluated: [],
        net: {
          status: 'evaluated',
          minNetMarginPercent: 40,
          warnings: [{ action: 'image/standard/any', channel: 'web', pack: 'test_small', netMarginPercent: '39.50' }],
          notEvaluated: [],
        },
      },
    });
    expect(marginWarnings(preview)).toEqual([
      'image/standard/any at test_large: gross margin 59.99% is below the 60% floor',
      'image/standard/any at test_small via web: net margin 39.50% is below the 40% floor',
    ]);
  });

  it('names ladder issues, gaps and only the input lists that have something in them', () => {
    expect(ladderIssueText({ kind: 'inverted', rung: 'b', previous: 'a' })).toBe('b is dearer per Credit than a');
    expect(ladderIssueText({ kind: 'flat', rung: 'c', previous: 'b' })).toBe('c is no cheaper per Credit than b');
    expect(gapText({ reason: 'rate_not_supplied', ref: 'xai/grok_4_6_output_tokens' })).toBe('no rate supplied for xai/grok_4_6_output_tokens');
    expect(gapText({ reason: 'sales_channel_not_supplied', ref: 'sales_channels' })).toBe('no sales channel supplied');
    expect(inputProblems(previewResponse())).toEqual([{ label: 'AI provider cost missing', items: ['image/standard/any'] }]);
  });
});

describe('the economy admin carries no economy values and no customer fixture', () => {
  const src = fileURLToPath(new URL('..', import.meta.url));
  const read = (rel: string) => readFileSync(join(src, rel), 'utf8');
  const applicationSources = (dir = src): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return applicationSources(path);
      return /\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) ? [relative(src, path).split('\\').join('/')] : [];
    });

  it('never imports the customer economy module or its fixture', () => {
    for (const rel of ['admin/economy.ts', 'pages/admin/EconomyPage.tsx']) {
      expect(read(rel), rel).not.toMatch(/customerEconomy/);
    }
  });

  it('no application module imports the admin test data', () => {
    const importers = applicationSources()
      .filter((rel) => rel !== 'admin/economyTestData.ts')
      .filter((rel) => /from\s+['"][^'"]*economyTestData['"]/.test(read(rel)));
    expect(importers).toEqual([]);
  });

  it('writes no money amount or Credit figure into the admin code', () => {
    for (const rel of ['admin/economy.ts', 'pages/admin/EconomyPage.tsx']) {
      // Money amounts (e.g. 9.99, 0.04) and micros-scale integers (e.g. 2_000_000);
      // CSS values such as tracking-[0.18em] are not amounts.
      expect(read(rel), rel).not.toMatch(/(?<![[\w.])\d+\.\d{2,}(?!\w)|\b\d{1,3}(?:_\d{3})+\b/);
    }
  });
});
