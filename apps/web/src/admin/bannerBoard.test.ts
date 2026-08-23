import { describe, expect, it } from 'vitest';
import {
  audienceMatches,
  bannerEffectiveState,
  isBannerPubliclyEligible,
  type BannerStateInput,
} from '@over18/shared';
import {
  audienceLabel,
  creativeRequirementText,
  destinationLabel,
  dimensionsLabel,
  formatBytes,
  formatInZone,
  instantToWallTime,
  matchesRecommendedAspect,
  problemMessage,
  problemSummary,
  scheduleSummary,
  shortUrl,
  stateLabel,
  stateTone,
  summarise,
  wallTimeToInstant,
} from './bannerBoard';
import type { HomeBannerView } from '../lib/api';

/**
 * US-102.3 banner logic.
 *
 * Two things are covered here. The SHARED state machine — the same functions
 * the server runs, so a bug in either would be a bug in both — and the
 * workspace's presentation of it.
 *
 * The state machine is tested at every boundary with an explicit clock, which
 * is the whole reason scheduling is derived rather than run by a job: a
 * scheduler could only be tested by waiting.
 */

function stateOf(overrides: Partial<BannerStateInput> = {}): BannerStateInput {
  return { status: 'published', startsAt: null, endsAt: null, problems: [], ...overrides };
}

const START = '2026-09-01T09:00:00.000Z';
const END = '2026-09-08T09:00:00.000Z';
const at = (iso: string) => new Date(iso);

function banner(overrides: Partial<HomeBannerView> = {}): HomeBannerView {
  return {
    id: 'b1',
    title: 'Autumn',
    subtitle: null,
    ctaLabel: null,
    creative: null,
    destination: {
      kind: 'category',
      categoryId: 'c1',
      characterId: null,
      assetId: null,
      url: null,
      label: 'Trending',
    },
    status: 'published',
    audience: 'everyone',
    startsAt: null,
    endsAt: null,
    scheduleTimezone: null,
    slot: 'before_search',
    position: 0,
    publishedAt: null,
    state: 'live',
    problems: [],
    createdAt: 'x',
    updatedAt: 'x',
    ...overrides,
  };
}

/* ------------------------------------------------------------------ *
 * The state machine
 * ------------------------------------------------------------------ */

describe('bannerEffectiveState — lifecycle', () => {
  it('a draft is a draft whatever its schedule says', () => {
    expect(bannerEffectiveState(stateOf({ status: 'draft' }), at(START))).toBe('draft');
    expect(
      bannerEffectiveState(stateOf({ status: 'draft', startsAt: START, endsAt: END }), at(START)),
    ).toBe('draft');
  });

  it('a draft with problems is STILL a draft', () => {
    // Someone part-way through building one has asserted nothing yet.
    expect(
      bannerEffectiveState(stateOf({ status: 'draft', problems: ['creative_missing'] }), at(START)),
    ).toBe('draft');
  });

  it('an unpublished banner is unpublished, not ended', () => {
    expect(
      bannerEffectiveState(
        stateOf({ status: 'unpublished', startsAt: START, endsAt: END }),
        at('2026-09-04T00:00:00.000Z'),
      ),
    ).toBe('unpublished');
  });

  it('an unscheduled published banner is live immediately', () => {
    expect(bannerEffectiveState(stateOf(), at('2020-01-01T00:00:00.000Z'))).toBe('live');
  });
});

describe('bannerEffectiveState — schedule boundaries', () => {
  const scheduled = stateOf({ startsAt: START, endsAt: END });

  it('is scheduled one millisecond BEFORE the start', () => {
    expect(bannerEffectiveState(scheduled, at('2026-09-01T08:59:59.999Z'))).toBe('scheduled');
  });

  it('is live EXACTLY at the start — inclusive', () => {
    expect(bannerEffectiveState(scheduled, at(START))).toBe('live');
  });

  it('is live inside the window', () => {
    expect(bannerEffectiveState(scheduled, at('2026-09-04T12:00:00.000Z'))).toBe('live');
  });

  it('is live one millisecond BEFORE the end', () => {
    expect(bannerEffectiveState(scheduled, at('2026-09-08T08:59:59.999Z'))).toBe('live');
  });

  it('is ended EXACTLY at the end — exclusive', () => {
    expect(bannerEffectiveState(scheduled, at(END))).toBe('ended');
  });

  it('is ended long after', () => {
    expect(bannerEffectiveState(scheduled, at('2030-01-01T00:00:00.000Z'))).toBe('ended');
  });

  it('handles a start with no end, and an end with no start', () => {
    const openEnded = stateOf({ startsAt: START });
    expect(bannerEffectiveState(openEnded, at('2026-08-01T00:00:00.000Z'))).toBe('scheduled');
    expect(bannerEffectiveState(openEnded, at('2030-01-01T00:00:00.000Z'))).toBe('live');

    const untilOnly = stateOf({ endsAt: END });
    expect(bannerEffectiveState(untilOnly, at('2020-01-01T00:00:00.000Z'))).toBe('live');
    expect(bannerEffectiveState(untilOnly, at(END))).toBe('ended');
  });
});

describe('bannerEffectiveState — problems outrank the schedule', () => {
  it('a broken published banner needs attention even inside its window', () => {
    expect(
      bannerEffectiveState(
        stateOf({ startsAt: START, endsAt: END, problems: ['destination_missing'] }),
        at('2026-09-04T00:00:00.000Z'),
      ),
    ).toBe('needs_attention');
  });

  it('a broken banner needs attention before its window too', () => {
    expect(
      bannerEffectiveState(
        stateOf({ startsAt: START, problems: ['creative_missing'] }),
        at('2020-01-01T00:00:00.000Z'),
      ),
    ).toBe('needs_attention');
  });

  it('but an unpublished broken banner is just unpublished', () => {
    expect(
      bannerEffectiveState(
        stateOf({ status: 'unpublished', problems: ['creative_missing'] }),
        at(START),
      ),
    ).toBe('unpublished');
  });
});

/**
 * A window that cannot be read must not become a window that is always open.
 *
 * Date.parse returns NaN for a string it cannot understand, and EVERY
 * comparison against NaN is false — so the obvious implementation of this
 * function falls straight through both schedule checks and reports `live`.
 * That is the worst available default for the one primitive public eligibility
 * is gated on: a single corrupt timestamp would show a banner forever.
 */
describe('bannerEffectiveState — an unreadable schedule fails CLOSED', () => {
  const UNREADABLE = ['not-a-date-at-all', '', '2026-13-45T99:99', 'next tuesday', 'null'];

  it('never reports live when the start bound is unreadable', () => {
    for (const value of UNREADABLE) {
      expect(bannerEffectiveState(stateOf({ startsAt: value }), at(START))).toBe('needs_attention');
    }
  });

  it('never reports live when the end bound is unreadable', () => {
    for (const value of UNREADABLE) {
      expect(bannerEffectiveState(stateOf({ endsAt: value }), at(START))).toBe('needs_attention');
    }
  });

  it('a readable start with an unreadable end is still refused', () => {
    // The dangerous shape: the start has passed, so the only thing that could
    // ever end this banner is the bound that cannot be read.
    expect(
      bannerEffectiveState(
        stateOf({ startsAt: START, endsAt: 'whenever' }),
        at('2026-09-04T00:00:00.000Z'),
      ),
    ).toBe('needs_attention');
  });

  it('an unreadable bound is never publicly eligible', () => {
    expect(isBannerPubliclyEligible(stateOf({ startsAt: 'nonsense' }), at(START))).toBe(false);
    expect(isBannerPubliclyEligible(stateOf({ endsAt: 'nonsense' }), at(START))).toBe(false);
  });

  it('still lets draft and unpublished win, so nothing is mislabelled', () => {
    // Lifecycle is decided before the schedule is read at all: a draft with a
    // corrupt window is a draft, not a warning chip.
    expect(bannerEffectiveState(stateOf({ status: 'draft', startsAt: 'junk' }), at(START))).toBe(
      'draft',
    );
    expect(bannerEffectiveState(stateOf({ status: 'unpublished', endsAt: 'junk' }), at(START))).toBe(
      'unpublished',
    );
  });

  it('leaves every readable schedule exactly where it was', () => {
    // The guard must not have moved a real boundary by so much as a millisecond.
    const scheduled = stateOf({ startsAt: START, endsAt: END });
    expect(bannerEffectiveState(scheduled, at('2026-09-01T08:59:59.999Z'))).toBe('scheduled');
    expect(bannerEffectiveState(scheduled, at(START))).toBe('live');
    expect(bannerEffectiveState(scheduled, at('2026-09-08T08:59:59.999Z'))).toBe('live');
    expect(bannerEffectiveState(scheduled, at(END))).toBe('ended');
    expect(bannerEffectiveState(stateOf(), at(START))).toBe('live');
  });
});

describe('isBannerPubliclyEligible', () => {
  it('is true ONLY for live', () => {
    expect(isBannerPubliclyEligible(stateOf(), at(START))).toBe(true);
    for (const input of [
      stateOf({ status: 'draft' }),
      stateOf({ status: 'unpublished' }),
      stateOf({ startsAt: END }),
      stateOf({ endsAt: START }),
      stateOf({ problems: ['destination_invalid_url'] }),
    ]) {
      expect(isBannerPubliclyEligible(input, at(START))).toBe(false);
    }
  });
});

/* ------------------------------------------------------------------ *
 * Audience — MVP, three values, no engine
 * ------------------------------------------------------------------ */

describe('audienceMatches', () => {
  it('everyone matches both viewers', () => {
    expect(audienceMatches('everyone', { isReturning: true })).toBe(true);
    expect(audienceMatches('everyone', { isReturning: false })).toBe(true);
  });

  it('new_users matches only a first-time viewer', () => {
    expect(audienceMatches('new_users', { isReturning: false })).toBe(true);
    expect(audienceMatches('new_users', { isReturning: true })).toBe(false);
  });

  it('returning_users matches only a returning viewer', () => {
    expect(audienceMatches('returning_users', { isReturning: true })).toBe(true);
    expect(audienceMatches('returning_users', { isReturning: false })).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * Presentation
 * ------------------------------------------------------------------ */

describe('state labelling', () => {
  it('names every state', () => {
    expect(stateLabel('draft')).toBe('Draft');
    expect(stateLabel('scheduled')).toBe('Scheduled');
    expect(stateLabel('live')).toBe('Live');
    expect(stateLabel('ended')).toBe('Ended');
    expect(stateLabel('unpublished')).toBe('Unpublished');
    expect(stateLabel('needs_attention')).toBe('Needs attention');
  });

  it('gives needs_attention a warning tone and live a positive one', () => {
    expect(stateTone('needs_attention')).toBe('warning');
    expect(stateTone('live')).toBe('positive');
    expect(stateTone('ended')).toBe('muted');
    expect(stateTone('draft')).toBe('neutral');
  });
});

describe('problem copy', () => {
  it('names the repair, not just the fault', () => {
    expect(problemMessage('creative_missing')).toMatch(/Upload an image or video/);
    expect(problemMessage('destination_invalid_url')).toMatch(/https:\/\//);
  });

  it('reassures that a broken banner is intact', () => {
    // The rule this ticket must hold: nothing is silently deleted.
    expect(problemMessage('destination_missing')).toMatch(/banner and its creative are untouched/i);
  });

  it('summarises nothing as null', () => {
    expect(problemSummary([])).toBeNull();
    expect(problemSummary(['creative_missing', 'destination_missing'])).toContain('Upload an image');
  });
});

describe('destination labelling', () => {
  it('names each kind, and says when one is missing', () => {
    expect(destinationLabel(banner())).toBe('Category · Trending');
    expect(
      destinationLabel(banner({ destination: { ...banner().destination, label: null } })),
    ).toBe('Category · missing');
    expect(
      destinationLabel(
        banner({
          destination: {
            kind: 'character',
            categoryId: null,
            characterId: 'x',
            assetId: null,
            url: null,
            label: 'Luna',
          },
        }),
      ),
    ).toBe('Character · Luna');
    expect(
      destinationLabel(
        banner({
          destination: {
            kind: 'external',
            categoryId: null,
            characterId: null,
            assetId: null,
            url: 'https://example.com/a/b',
            label: 'https://example.com/a/b',
          },
        }),
      ),
    ).toBe('Link · example.com/a/b');
  });

  it('shortens a long url rather than wrecking the row', () => {
    expect(shortUrl(`https://example.com/${'x'.repeat(80)}`)).toHaveLength(40);
    expect(shortUrl('not a url at all but quite long indeed yes really')).toContain('…');
  });
});

describe('audience labelling', () => {
  it('reads in plain words', () => {
    expect(audienceLabel('everyone')).toBe('Everyone');
    expect(audienceLabel('new_users')).toBe('New users');
    expect(audienceLabel('returning_users')).toBe('Returning users');
  });
});

/* ------------------------------------------------------------------ *
 * Time
 * ------------------------------------------------------------------ */

describe('scheduleSummary', () => {
  it('says an unscheduled banner is always on', () => {
    expect(
      scheduleSummary({ startsAt: null, endsAt: null, scheduleTimezone: null }),
    ).toBe('Always on while published');
  });

  it('shows a window, a start-only and an end-only', () => {
    const zone = 'UTC';
    expect(scheduleSummary({ startsAt: START, endsAt: END, scheduleTimezone: zone })).toContain('→');
    expect(scheduleSummary({ startsAt: START, endsAt: null, scheduleTimezone: zone })).toMatch(
      /^From /,
    );
    expect(scheduleSummary({ startsAt: null, endsAt: END, scheduleTimezone: zone })).toMatch(
      /^Until /,
    );
  });

  it('names the zone the operator chose', () => {
    expect(
      scheduleSummary({ startsAt: START, endsAt: null, scheduleTimezone: 'Europe/London' }),
    ).toContain('Europe/London');
  });
});

describe('timezone conversion', () => {
  it('reads an instant back in the chosen zone, not the browser default', () => {
    // 09:00 UTC is 10:00 in London during BST — the operator must see 10:00.
    expect(formatInZone(START, 'Europe/London')).toContain('10:');
    expect(formatInZone(START, 'UTC')).toContain('09:');
  });

  it('round-trips a wall time through an instant and back', () => {
    const zone = 'Europe/London';
    const wall = '2026-09-01T10:00';
    const instant = wallTimeToInstant(wall, zone);
    expect(instant).toBe(START);
    expect(instantToWallTime(instant, zone)).toBe(wall);
  });

  it('round-trips across a zone with a negative offset', () => {
    const zone = 'America/New_York';
    const wall = '2026-12-01T08:30';
    const instant = wallTimeToInstant(wall, zone);
    expect(instant).not.toBeNull();
    expect(instantToWallTime(instant, zone)).toBe(wall);
  });

  it('returns null for an incomplete or unparseable wall time', () => {
    expect(wallTimeToInstant('', 'UTC')).toBeNull();
    expect(wallTimeToInstant('2026-09', 'UTC')).toBeNull();
    expect(wallTimeToInstant('not-a-date-at-all', 'UTC')).toBeNull();
  });

  it('never throws on an unknown zone — the screen must not break', () => {
    expect(wallTimeToInstant('2026-09-01T10:00', 'Mars/Olympus')).toBeNull();
    expect(instantToWallTime(START, 'Mars/Olympus')).toBe('');
    expect(formatInZone(START, 'Mars/Olympus')).toContain('2026-09-01');
  });

  it('renders an empty instant as an empty field', () => {
    expect(instantToWallTime(null, 'UTC')).toBe('');
  });
});

/* ------------------------------------------------------------------ *
 * Creative requirements — shown, never invented
 * ------------------------------------------------------------------ */

describe('creativeRequirementText', () => {
  const requirements = {
    acceptedMimeTypes: [
      'image/jpeg',
      'image/png',
      'image/webp',
      'video/mp4',
      'video/webm',
      'video/quicktime',
    ],
    maxLabel: '100MB',
    recommendedAspect: '16:9',
    recommendedMinWidth: 1200,
  };

  it('lists the formats in words an operator recognises', () => {
    const text = creativeRequirementText(requirements);
    expect(text).toContain('JPEG');
    expect(text).toContain('PNG');
    expect(text).toContain('WEBP');
    expect(text).toContain('MP4');
    expect(text).toContain('MOV'); // not "QUICKTIME"
  });

  it('states the size limit and that the ratio is only a recommendation', () => {
    const text = creativeRequirementText(requirements);
    expect(text).toContain('100MB');
    expect(text).toContain('16:9');
    expect(text).toContain('not enforced');
  });

  it('reflects the SERVER list, so the copy cannot drift from the rule', () => {
    expect(creativeRequirementText({ ...requirements, acceptedMimeTypes: ['image/png'] })).toContain(
      'PNG',
    );
    expect(
      creativeRequirementText({ ...requirements, acceptedMimeTypes: ['image/png'] }),
    ).not.toContain('MP4');
  });
});

describe('creative dimensions', () => {
  it('shows dimensions when the format exposed them', () => {
    expect(dimensionsLabel({ width: 1600, height: 900 })).toBe('1600 × 900');
    expect(dimensionsLabel({ width: null, height: null })).toBeNull();
    expect(dimensionsLabel(null)).toBeNull();
  });

  it('reports 16:9 as guidance, and is undecided without dimensions', () => {
    expect(matchesRecommendedAspect({ width: 1600, height: 900 })).toBe(true);
    expect(matchesRecommendedAspect({ width: 1000, height: 1000 })).toBe(false);
    expect(matchesRecommendedAspect({ width: null, height: null })).toBeNull();
  });
});

describe('formatBytes', () => {
  it('reads naturally at each scale', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });
});

describe('summarise', () => {
  it('counts each state separately', () => {
    expect(
      summarise([
        banner({ state: 'live' }),
        banner({ state: 'live' }),
        banner({ state: 'scheduled' }),
        banner({ state: 'draft' }),
        banner({ state: 'needs_attention' }),
      ]),
    ).toEqual({ total: 5, live: 2, scheduled: 1, needsAttention: 1, drafts: 1 });
  });

  it('handles an empty workspace', () => {
    expect(summarise([])).toEqual({
      total: 0,
      live: 0,
      scheduled: 0,
      needsAttention: 0,
      drafts: 0,
    });
  });
});
