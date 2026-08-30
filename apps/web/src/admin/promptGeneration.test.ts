import { describe, expect, it } from 'vitest';
import type {
  PromptBatchView,
  PromptCostEstimate,
  PromptJobView,
  PromptOutputStatus,
  PromptOutputView,
} from '../lib/api';
import {
  batchSummary,
  canRetryOutput,
  costSentence,
  formatUsd,
  isLargeBatch,
  jobStatusLabel,
  outputProgress,
  outputStatusLabel,
  retryCostsMoney,
  startRefusal,
  startRefusalMessage,
  summariseSelection,
} from './promptGeneration';

/**
 * Generation workspace presentation rules.
 *
 * These decide what an operator is told before spending money and what they
 * are told after something failed. The page itself cannot be tested here — the
 * web suite renders with react-dom/server and never runs an effect — which is
 * exactly why these rules live outside it.
 */

function output(overrides: Partial<PromptOutputView> & { ordinal: number }): PromptOutputView {
  return {
    id: `out-${overrides.ordinal}`,
    status: 'pending',
    outputFilename: `luna_001_${overrides.ordinal}.jpg`,
    driveFileId: null,
    driveWebViewLink: null,
    attempts: 0,
    error: null,
    generatedAt: null,
    uploadedAt: null,
    ...overrides,
  };
}

function job(overrides: Partial<PromptJobView> = {}): PromptJobView {
  return {
    id: 'job-1',
    ordinal: 1,
    originalFilename: 'luna_001.txt',
    status: 'queued',
    requestedOutputs: 2,
    succeededCount: 0,
    failedCount: 0,
    attempts: 0,
    error: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    startedAt: null,
    completedAt: null,
    outputs: [output({ ordinal: 1 }), output({ ordinal: 2 })],
    ...overrides,
  };
}

function estimate(overrides: Partial<PromptCostEstimate> = {}): PromptCostEstimate {
  return {
    prompts: 10,
    outputsPerPrompt: 2,
    images: 20,
    pricePerImageUsd: 0.08,
    totalUsd: 1.6,
    ...overrides,
  };
}

function batch(overrides: Partial<PromptBatchView> = {}): PromptBatchView {
  return {
    id: 'batch-1',
    name: 'Batch 1',
    status: 'draft',
    model: 'grok-imagine-image-2.0',
    params: { aspectRatio: '2:3', resolution: '2k', quality: 'medium' },
    outputsPerPrompt: 2,
    driveFolderId: 'folder-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    startedAt: null,
    completedAt: null,
    totals: { prompts: 10, outputs: 20, completed: 0, failed: 0 },
    estimate: estimate(),
    ...overrides,
  };
}

describe('progress', () => {
  it('counts only images that actually reached Drive', () => {
    expect(outputProgress(job())).toBe('0/2');
    expect(
      outputProgress(
        job({ outputs: [output({ ordinal: 1, status: 'completed' }), output({ ordinal: 2 })] }),
      ),
    ).toBe('1/2');
    // 'generated' is NOT done: the image exists but is not saved anywhere the
    // operator can reach, and counting it would overstate the result.
    expect(
      outputProgress(
        job({
          outputs: [
            output({ ordinal: 1, status: 'generated' }),
            output({ ordinal: 2, status: 'drive_upload_failed' }),
          ],
        }),
      ),
    ).toBe('0/2');
  });
});

describe('status wording', () => {
  it('calls a half-successful job "Partly done", never "Failed"', () => {
    // One image IS in Drive. Calling this failed would invite an operator to
    // redo work that succeeded — and pay for it twice.
    expect(jobStatusLabel(job({ status: 'partial' }))).toBe('Partly done');
    expect(jobStatusLabel(job({ status: 'failed' }))).toBe('Failed');
  });

  it('distinguishes a Drive failure from a generation failure', () => {
    expect(outputStatusLabel('drive_upload_failed')).toMatch(/Generated/);
    expect(outputStatusLabel('drive_upload_failed')).toMatch(/Drive/);
    expect(outputStatusLabel('failed')).toBe('Failed');
    expect(outputStatusLabel('completed')).toBe('In Drive');
  });

  it('has wording for every status the API can send', () => {
    const all: PromptOutputStatus[] = [
      'pending',
      'generated',
      'uploading',
      'completed',
      'failed',
      'drive_upload_failed',
    ];
    for (const status of all) expect(outputStatusLabel(status).length).toBeGreaterThan(0);
  });
});

describe('what a retry costs', () => {
  it('says a Drive retry is free and a regeneration is not', () => {
    // The image already exists in the spool, so re-uploading spends nothing.
    expect(retryCostsMoney(output({ ordinal: 1, status: 'drive_upload_failed' }))).toBe(false);
    expect(retryCostsMoney(output({ ordinal: 1, status: 'failed' }))).toBe(true);
    expect(retryCostsMoney(output({ ordinal: 1, status: 'pending' }))).toBe(true);
  });

  it('offers no retry on a completed or in-flight output', () => {
    expect(canRetryOutput(output({ ordinal: 1, status: 'completed' }))).toBe(false);
    expect(canRetryOutput(output({ ordinal: 1, status: 'uploading' }))).toBe(false);
    expect(canRetryOutput(output({ ordinal: 1, status: 'failed' }))).toBe(true);
  });
});

describe('cost before starting', () => {
  it('shows the arithmetic, not just the total', () => {
    const sentence = costSentence(estimate({ prompts: 10, totalUsd: 1.6 }));
    expect(sentence).toContain('10 prompts');
    expect(sentence).toContain('2 images');
    expect(sentence).toContain('$0.08');
    expect(sentence).toContain('$1.60');
  });

  it('is singular for one prompt', () => {
    expect(costSentence(estimate({ prompts: 1, images: 2, totalUsd: 0.16 }))).toContain('1 prompt ×');
  });

  it('says plainly when there is nothing to cost', () => {
    expect(costSentence(estimate({ prompts: 0, images: 0, totalUsd: 0 }))).toMatch(/No prompt/);
  });

  it('always shows money to two decimals', () => {
    expect(formatUsd(1.6)).toBe('$1.60');
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(12)).toBe('$12.00');
  });

  it('emphasises a large batch', () => {
    expect(isLargeBatch(estimate({ totalUsd: 1.6 }))).toBe(false);
    expect(isLargeBatch(estimate({ totalUsd: 32 }))).toBe(true);
  });
});

describe('when Start is unavailable', () => {
  it('refuses an empty batch', () => {
    expect(startRefusal(batch({ totals: { prompts: 0, outputs: 0, completed: 0, failed: 0 } }), true, true)).toBe(
      'no_prompts',
    );
  });

  it('refuses a batch that is already running', () => {
    expect(startRefusal(batch({ status: 'running' }), true, true)).toBe('already_running');
  });

  it('refuses a LIVE batch with no Drive destination', () => {
    // Spending real money on images with nowhere to put them is the one
    // failure whose cost cannot be recovered.
    expect(startRefusal(batch(), false, true)).toBe('drive_not_configured');
  });

  it('allows a batch in test mode even without Drive, so the workspace is usable', () => {
    expect(startRefusal(batch(), false, false)).toBeNull();
  });

  it('allows a ready batch', () => {
    expect(startRefusal(batch(), true, true)).toBeNull();
    expect(startRefusalMessage(null)).toBeNull();
  });

  it('explains every refusal in words', () => {
    for (const refusal of ['no_prompts', 'already_running', 'drive_not_configured'] as const) {
      expect(startRefusalMessage(refusal)!.length).toBeGreaterThan(0);
    }
  });
});

describe('file selection', () => {
  it('counts .txt files and names what will be ignored', () => {
    const summary = summariseSelection([
      { name: 'a.txt', size: 10 },
      { name: 'b.TXT', size: 10 },
      { name: 'c.png', size: 10 },
    ]);
    expect(summary.accepted).toHaveLength(2);
    expect(summary.ignored).toHaveLength(1);
    expect(summary.message).toContain('2 prompt files selected');
    expect(summary.message).toContain('1 non-.txt file will be ignored');
  });

  it('is singular for one file and silent when nothing is ignored', () => {
    const summary = summariseSelection([{ name: 'a.txt', size: 1 }]);
    expect(summary.message).toBe('1 prompt file selected.');
  });
});

describe('batch summary', () => {
  it('reports images in Drive against the number expected', () => {
    expect(
      batchSummary(batch({ totals: { prompts: 10, outputs: 20, completed: 18, failed: 2 } })),
    ).toBe('10 prompts · 18/20 images in Drive · 2 needing attention');
  });

  it('stays quiet about failures when there are none', () => {
    expect(batchSummary(batch({ totals: { prompts: 1, outputs: 2, completed: 2, failed: 0 } }))).toBe(
      '1 prompt · 2/2 images in Drive',
    );
  });
});
