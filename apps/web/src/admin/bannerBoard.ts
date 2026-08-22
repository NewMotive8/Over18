import type { BannerProblem, BannerState } from '@over18/shared';
import type { HomeBannerView } from '../lib/api';

/**
 * Banner workspace presentation logic (US-102.3) — React-free, like its
 * siblings, because this repo's web tests run in node with no DOM.
 *
 * The STATE MACHINE is not here: bannerEffectiveState and audienceMatches live
 * in @over18/shared so the server and the editor's live preview give the same
 * answer. What lives here is only how that answer is worded and arranged for
 * an operator — the part that is presentation, not truth.
 */

/** Chip text. Short enough for a list row, unambiguous on its own. */
export function stateLabel(state: BannerState): string {
  switch (state) {
    case 'draft':
      return 'Draft';
    case 'scheduled':
      return 'Scheduled';
    case 'live':
      return 'Live';
    case 'ended':
      return 'Ended';
    case 'unpublished':
      return 'Unpublished';
    case 'needs_attention':
      return 'Needs attention';
    default:
      return state;
  }
}

export type StateTone = 'neutral' | 'positive' | 'warning' | 'muted';

export function stateTone(state: BannerState): StateTone {
  if (state === 'live') return 'positive';
  if (state === 'needs_attention') return 'warning';
  if (state === 'ended' || state === 'unpublished') return 'muted';
  return 'neutral';
}

/**
 * What is wrong, and what to do about it.
 *
 * Each message names the specific broken thing and the repair, because
 * "Needs attention" on its own sends the operator hunting. It also says the
 * banner is intact — the rule this ticket has to hold is that nothing is
 * silently deleted, and the copy is where an operator learns that.
 */
export function problemMessage(problem: BannerProblem): string {
  switch (problem) {
    case 'creative_missing':
      return 'No creative. Upload an image or video for this banner.';
    case 'creative_invalid':
      return 'The creative file is missing or unreadable. Upload it again.';
    case 'destination_missing':
      return 'Its destination no longer exists. Pick a new one — the banner and its creative are untouched.';
    case 'destination_unavailable':
      return 'Its destination has been hidden or withdrawn. Restore it, or point the banner somewhere else.';
    case 'destination_invalid_url':
      return 'Its link is not a valid https:// address. Fix the link to publish again.';
    default:
      return 'Something about this banner needs attention before it can be shown.';
  }
}

/** Every problem, in one sentence, for a list row. */
export function problemSummary(problems: readonly BannerProblem[]): string | null {
  if (problems.length === 0) return null;
  return problems.map(problemMessage).join(' ');
}

export function destinationLabel(banner: HomeBannerView): string {
  const { kind, label, url } = banner.destination;
  switch (kind) {
    case 'category':
      return label ? `Category · ${label}` : 'Category · missing';
    case 'character':
      return label ? `Character · ${label}` : 'Character · missing';
    case 'content':
      return label ? 'Content item' : 'Content · missing';
    case 'external':
      return url ? `Link · ${shortUrl(url)}` : 'Link · missing';
    default:
      return 'No destination';
  }
}

/** Host plus a trimmed path — a full URL wrecks a list row. */
export function shortUrl(raw: string): string {
  try {
    const url = new URL(raw);
    const path = url.pathname === '/' ? '' : url.pathname;
    const shown = `${url.host}${path}`;
    return shown.length > 40 ? `${shown.slice(0, 39)}…` : shown;
  } catch {
    return raw.length > 40 ? `${raw.slice(0, 39)}…` : raw;
  }
}

export function audienceLabel(audience: HomeBannerView['audience']): string {
  switch (audience) {
    case 'everyone':
      return 'Everyone';
    case 'new_users':
      return 'New users';
    case 'returning_users':
      return 'Returning users';
    default:
      return audience;
  }
}

/**
 * The schedule in words, in the operator's own timezone choice.
 *
 * Rendering in the stored zone rather than the browser's is deliberate: an
 * operator who scheduled a banner for 09:00 in Europe/London should read back
 * "09:00 London", not its local translation, or they cannot check their own
 * work. The instant is what the server compares; this is only how it is shown.
 */
export function scheduleSummary(banner: {
  startsAt: string | null;
  endsAt: string | null;
  scheduleTimezone: string | null;
}): string {
  const { startsAt, endsAt, scheduleTimezone } = banner;
  if (!startsAt && !endsAt) return 'Always on while published';
  const zone = scheduleTimezone ?? 'UTC';
  const from = startsAt ? formatInZone(startsAt, zone) : null;
  const to = endsAt ? formatInZone(endsAt, zone) : null;
  if (from && to) return `${from} → ${to} (${zone})`;
  if (from) return `From ${from} (${zone})`;
  return `Until ${to} (${zone})`;
}

export function formatInZone(iso: string, timeZone: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone,
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(date);
  } catch {
    // An unknown zone must never break the screen — the server validates the
    // zone on save, so this is belt and braces for legacy or hand-edited rows.
    return date.toISOString().slice(0, 16).replace('T', ' ');
  }
}

/**
 * Converts a local wall time plus an IANA zone into the absolute instant the
 * server stores.
 *
 * There is no date library in this app and this ticket is not the place to add
 * one, so the conversion is done with Intl: format the candidate instant in the
 * target zone, read back what wall time it produced, and correct by the
 * difference. One correction pass is enough for every fixed-offset zone and for
 * DST except in the one ambiguous hour, where it lands on a valid neighbouring
 * instant rather than throwing.
 *
 * Returns null for an incomplete or unparseable input, so a half-typed field
 * never becomes a bad timestamp.
 */
const WALL_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

export function wallTimeToInstant(localValue: string, timeZone: string): string | null {
  // Shape-checked before parsing: Date.parse is lenient enough to turn a string
  // like "not-a-date-at-all:00Z" into a real instant, which would silently
  // schedule a banner for the year 2000.
  if (!WALL_TIME_RE.test(localValue.slice(0, 16))) return null;
  const asUtc = Date.parse(`${localValue.slice(0, 16)}:00Z`);
  if (Number.isNaN(asUtc)) return null;
  try {
    const offset = zoneOffsetMs(asUtc, timeZone);
    const corrected = asUtc - offset;
    // Second pass catches a DST transition between the two instants.
    const settled = asUtc - zoneOffsetMs(corrected, timeZone);
    return new Date(settled).toISOString();
  } catch {
    return null;
  }
}

/** The reverse: an instant back into a datetime-local value for the editor. */
export function instantToWallTime(iso: string | null, timeZone: string): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(date);
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
    const hour = get('hour') === '24' ? '00' : get('hour');
    return `${get('year')}-${get('month')}-${get('day')}T${hour}:${get('minute')}`;
  } catch {
    return '';
  }
}

/** How far `timeZone` is from UTC at this instant, in milliseconds. */
function zoneOffsetMs(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(new Date(instant));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');
  const hour = get('hour') === 24 ? 0 : get('hour');
  const asIfUtc = Date.UTC(get('year'), get('month') - 1, get('day'), hour, get('minute'), get('second'));
  return asIfUtc - instant;
}

export interface BannerTotals {
  total: number;
  live: number;
  scheduled: number;
  needsAttention: number;
  drafts: number;
}

export function summarise(banners: readonly HomeBannerView[]): BannerTotals {
  return {
    total: banners.length,
    live: banners.filter((b) => b.state === 'live').length,
    scheduled: banners.filter((b) => b.state === 'scheduled').length,
    needsAttention: banners.filter((b) => b.state === 'needs_attention').length,
    drafts: banners.filter((b) => b.state === 'draft').length,
  };
}

/**
 * The requirements sentence shown above the upload control.
 *
 * Built from the server's own values so what the operator is told cannot drift
 * from what is enforced — and it says plainly that the aspect ratio is a
 * recommendation, because this product has no dimension rule to enforce.
 */
export function creativeRequirementText(requirements: {
  acceptedMimeTypes: string[];
  maxLabel: string;
  recommendedAspect: string;
  recommendedMinWidth: number;
}): string {
  const formats = requirements.acceptedMimeTypes
    .map((mime) => mime.split('/')[1]?.toUpperCase() ?? mime)
    .map((name) => (name === 'QUICKTIME' ? 'MOV' : name))
    .join(', ');
  return `${formats} · up to ${requirements.maxLabel} · ${requirements.recommendedAspect} and at least ${requirements.recommendedMinWidth}px wide recommended (not enforced)`;
}

/** "1600 × 900" or null when the file did not expose its dimensions. */
export function dimensionsLabel(creative: { width: number | null; height: number | null } | null): string | null {
  if (!creative || creative.width === null || creative.height === null) return null;
  return `${creative.width} × ${creative.height}`;
}

/** Whether the creative is close enough to 16:9 to skip the guidance note. */
export function matchesRecommendedAspect(creative: {
  width: number | null;
  height: number | null;
}): boolean | null {
  if (creative.width === null || creative.height === null || creative.height === 0) return null;
  const ratio = creative.width / creative.height;
  return Math.abs(ratio - 16 / 9) < 0.15;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
