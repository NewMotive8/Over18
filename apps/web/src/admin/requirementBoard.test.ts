import { describe, expect, it } from 'vitest';
import {
  buildSlots,
  categoryOptions,
  configurationSummary,
  groupByMedia,
  impactOf,
  progressPercent,
  requirementSummary,
  triageExplanation,
} from './requirementBoard';
import type { ContentRequirementView, RequirementEntryView, ReviewAssetView } from '../lib/api';

/**
 * The Review board's rules, tested without a DOM.
 *
 * The central property: slots are CAPACITY DERIVED FROM A QUANTITY, never
 * stored records. Changing the quantity changes how many places exist to put
 * content, and can never remove content that already exists.
 *
 * Note that no category name or quantity in this file is a product decision —
 * they are fixtures. The real ones live in the database.
 */

const asset = (over: Partial<ReviewAssetView> = {}): ReviewAssetView => ({
  assetId: 'a1',
  characterId: 'c1',
  characterName: 'luna',
  mediaType: 'video',
  status: 'under_review',
  contentRating: 'sfw',
  requirementKey: 'demo',
  isPrimary: false,
  storageKey: '/file',
  createdAt: '2026-08-01T00:00:00.000Z',
  approvedAt: null,
  provenance: { jobId: null, provider: null, model: null, generatedAt: null },
  ...over,
});

const entry = (over: Partial<RequirementEntryView> = {}): RequirementEntryView => ({
  key: 'demo',
  label: 'Demo',
  mediaType: 'video',
  contentRating: null,
  required: 4,
  approved: 0,
  pending: 0,
  remaining: 4,
  surplus: 0,
  satisfied: false,
  assets: [],
  ...over,
});

describe('slots come from the quantity', () => {
  it('draws exactly as many places as the requirement asks for', () => {
    expect(buildSlots(entry({ required: 4 }))).toHaveLength(4);
    expect(buildSlots(entry({ required: 1 }))).toHaveLength(1);
    expect(buildSlots(entry({ required: 0 }))).toHaveLength(0);
  });

  it('fills approved first, then pending, then leaves the rest empty', () => {
    const slots = buildSlots(
      entry({
        required: 4,
        approved: 1,
        pending: 1,
        assets: [
          asset({ assetId: 'pending-1', status: 'under_review' }),
          asset({ assetId: 'approved-1', status: 'approved' }),
        ],
      }),
    );
    expect(slots.map((s) => s.state)).toEqual(['approved', 'pending', 'empty', 'empty']);
    expect(slots[0]!.asset!.assetId).toBe('approved-1');
    expect(slots[1]!.asset!.assetId).toBe('pending-1');
    expect(slots[2]!.asset).toBeNull();
  });

  it('KEEPS content when the quantity drops below what exists', () => {
    // The product rule: lowering a requirement never deletes anything. The
    // extra items are shown and marked, not dropped.
    const assets = [
      asset({ assetId: 'a', status: 'approved' }),
      asset({ assetId: 'b', status: 'approved' }),
      asset({ assetId: 'c', status: 'approved' }),
    ];
    const slots = buildSlots(entry({ required: 1, approved: 3, surplus: 2, assets }));
    expect(slots).toHaveLength(3);
    expect(slots.filter((s) => s.surplus)).toHaveLength(2);
    expect(slots.map((s) => s.asset?.assetId)).toEqual(['a', 'b', 'c']);
  });

  it('does not badge PENDING content as surplus', () => {
    // "Extra" claims the requirement is over-filled. With three pending items
    // and nothing approved it is not over-filled — those may all be rejected.
    const slots = buildSlots(
      entry({
        required: 2,
        approved: 0,
        pending: 3,
        surplus: 0,
        assets: [
          asset({ assetId: 'p1', status: 'under_review' }),
          asset({ assetId: 'p2', status: 'under_review' }),
          asset({ assetId: 'p3', status: 'under_review' }),
        ],
      }),
    );
    expect(slots).toHaveLength(3);
    expect(slots.filter((s) => s.surplus)).toHaveLength(0);
    // ...but an APPROVED item past capacity still is surplus.
    const mixed = buildSlots(
      entry({
        required: 1,
        approved: 2,
        surplus: 1,
        assets: [
          asset({ assetId: 'a1', status: 'approved' }),
          asset({ assetId: 'a2', status: 'approved' }),
        ],
      }),
    );
    expect(mixed.filter((s) => s.surplus).map((s) => s.asset!.assetId)).toEqual(['a2']);
  });

  it('gives every slot a stable, non-colliding key', () => {
    const a = buildSlots(entry({ key: 'x', required: 3 }));
    const b = buildSlots(entry({ key: 'y', required: 3 }));
    const ids = [...a, ...b].map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('what the board says', () => {
  it('counts approved against required, and flags surplus separately', () => {
    expect(requirementSummary(entry({ approved: 2, required: 4 }))).toBe('2 / 4');
    expect(requirementSummary(entry({ approved: 3, required: 2, surplus: 1 }))).toBe('3 / 2 (+1)');
  });

  it('never reports more than complete, and treats "nothing required" as done', () => {
    expect(progressPercent(0, 10)).toBe(0);
    expect(progressPercent(5, 10)).toBe(50);
    expect(progressPercent(12, 10)).toBe(100);
    expect(progressPercent(0, 0)).toBe(100);
  });

  it('groups by medium, keeping the configured order and dropping empty groups', () => {
    const groups = groupByMedia([
      entry({ key: 'nude', mediaType: 'image' }),
      entry({ key: 'selfie', mediaType: 'video' }),
      entry({ key: 'natural', mediaType: 'image' }),
    ]);
    expect(groups.map((g) => g.mediaType)).toEqual(['image', 'video']);
    expect(groups[0]!.entries.map((e) => e.key)).toEqual(['nude', 'natural']);
    expect(groupByMedia([])).toEqual([]);
    expect(groupByMedia([entry({ mediaType: 'video' })]).map((g) => g.label)).toEqual(['Videos']);
  });

  it('explains, in words, why an item counts toward nothing', () => {
    expect(triageExplanation('uncategorised')).toContain('No category');
    expect(triageExplanation('unknown_requirement')).toContain('no longer configured');
    expect(triageExplanation('media_mismatch')).toContain('Wrong medium');
  });

  it('offers exactly the configured categories, filtered by medium when asked', () => {
    const requirements: ContentRequirementView[] = [
      {
        id: '1',
        key: 'a',
        label: 'A',
        mediaType: 'image',
        requiredQuantity: 1,
        contentRating: null,
        enabled: true,
        assignPrimaryReference: false,
        position: 1,
      },
      {
        id: '2',
        key: 'b',
        label: 'B',
        mediaType: 'video',
        requiredQuantity: 2,
        contentRating: null,
        enabled: true,
        assignPrimaryReference: false,
        position: 2,
      },
    ];
    expect(categoryOptions(requirements)).toEqual([
      { value: 'a', label: 'A' },
      { value: 'b', label: 'B' },
    ]);
    expect(categoryOptions(requirements, 'video')).toEqual([{ value: 'b', label: 'B' }]);
    // With nothing configured there are no options — and no invented defaults.
    expect(categoryOptions([])).toEqual([]);
  });
});

describe('settings wording', () => {
  it('states the whole configuration in one line', () => {
    expect(configurationSummary({ items: 10, images: 2, videos: 8 })).toBe(
      'Every character needs 10 items — 2 images and 8 videos.',
    );
    expect(configurationSummary({ items: 1, images: 1, videos: 0 })).toBe(
      'Every character needs 1 item — 1 image.',
    );
    expect(configurationSummary({ items: 0, images: 0, videos: 0 })).toContain('No content');
  });

  it('states the consequence of a change, and that nothing is destroyed', () => {
    expect(impactOf('Explicit clips', 4, 4, 12)).toBeNull();

    const more = impactOf('Explicit clips', 4, 6, 12)!;
    expect(more).toContain('12 characters');
    expect(more).toContain('2 items more');
    expect(more).toContain('Nothing existing is affected');

    const fewer = impactOf('Explicit clips', 4, 2, 12)!;
    expect(fewer).toContain('Existing content is kept');
    expect(fewer).toContain('surplus');

    // Singular reads properly — this text is shown to a non-developer.
    expect(impactOf('Selfies', 1, 2, 1)!).toContain('1 character would each need 1 item more');
  });
});
