import { useCallback, useEffect, useState } from 'react';
import type { AdminCharacterContentAccess, AdminClipAccess } from '@over18/shared';
import ClipThumb from '../../admin/ClipThumb';
import { statusLabel } from '../../admin/characterContent';
import { serverMessages } from '../../admin/economyConfig';
import type { AssetLifecycle } from '../../lib/api';
import { adminContentAccessApi } from '../../lib/api';
import { MessageList, Section } from './economy/EconomyUi';

/**
 * Admin -> a character -> which of her clips are Free (P4.D2).
 *
 * THE WHOLE OPERATOR DECISION IS TWO WORDS. Every clip is Premium; an operator
 * marks individual clips Free. There is no setup step, no activation, no
 * character-level mode to be in, and clips uploaded later are Premium without
 * anyone doing anything.
 *
 * ── THE CLIP IS THE THUMBNAIL ────────────────────────────────────────────────
 *
 * This was a table whose first column was `f71be6a9` -- the head of a uuid. An
 * operator cannot classify a clip they cannot recognise, so the decision was
 * being made against a row rather than against content. It is now the same
 * media row the Home composer's carousel uses: a still of the clip, what is
 * known about it, and the two buttons.
 *
 * IT IS THE CHARACTER'S OWN CONTENT ORDER, newest first -- deliberately NOT the
 * customer's Free-before-Premium order. A visitor should meet the free content
 * first; an operator is looking for one particular clip, and a list that
 * re-sorts itself the instant they classify something moves every other row out
 * from under them. The customer ordering rule is untouched and lives in the
 * clip list the app reads.
 *
 * WHAT THIS PANEL DELIBERATELY NO LONGER HAS. It carried a required reason
 * field, a free-clip count, a random allocation, a clear-all, and a per-clip
 * Credit price -- five controls around one two-state decision, and an operator
 * had to type a sentence before they could flip a toggle. The classification
 * is still audited (who, when, which clip, both states); it simply no longer
 * asks anyone to narrate it.
 *
 * CREDIT PRICING IS NOT GONE, IT IS ELSEWHERE. The P4.1 offer still carries a
 * Credit price and P8.2 still spends Credits against it; that is a separate
 * product decision and does not belong in the Free/Premium workflow. Nothing
 * in the database or the API was removed to take it off this screen.
 */

export const clipStateLabel = (clip: AdminClipAccess): string =>
  clip.state === 'free' ? 'Free' : clip.state === 'premium' ? 'Premium' : clip.state === 'credit' ? `${clip.creditPrice ?? '—'} Credits` : 'Unavailable';

/** `0:05`. Minutes and seconds, because a clip is seconds long. */
export function clipDurationLabel(seconds: number | null): string | null {
  if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) return null;
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

/**
 * The secondary line: what the thumbnail cannot say.
 *
 * ONLY WHAT THE DATA HOLDS. A duration appears where one was recorded and is
 * absent otherwise; there is no placeholder, no "unknown" and no invented clip
 * name anywhere -- the name shown elsewhere is the file's own, and a clip
 * without one shows none. The asset id comes LAST and small: it is the
 * technical handle for a support conversation, not the thing an operator
 * recognises the clip by.
 */
export function clipDetails(clip: AdminClipAccess): string[] {
  const parts = [clip.mediaType === 'video' ? 'Video' : clip.mediaType === 'image' ? 'Image' : clip.mediaType];
  const duration = clipDurationLabel(clip.durationSeconds);
  if (duration) parts.push(duration);
  // Where a customer can meet it, which is not the same question as whether it
  // passed review -- so the review state is named when it is not simply live.
  parts.push(clip.live ? 'Live' : statusLabel({ workflow: clip.workflow as AssetLifecycle['workflow'], isPrimary: false }));
  return parts;
}

/**
 * Where this character stands, in one line.
 *
 * Premium first, because that is the default and therefore what most of her
 * clips are.
 */
export function accessSummary(page: AdminCharacterContentAccess): string {
  const { counts } = page;
  if (counts.clips === 0) return 'She has no clips yet. Anything uploaded will be Premium.';
  const priced = counts.credit > 0 ? `, ${counts.credit} Credit-priced` : '';
  return `${counts.premium} of ${counts.clips} Premium, ${counts.free} Free${priced}.`;
}

/**
 * Free or Premium, for one clip. The selected one is filled; the other is the
 * action.
 *
 * `min-h-11` is 44px -- the touch target this has to keep on a phone, where the
 * operator is holding the device in one hand.
 */
function AccessChoice({
  clip,
  busy,
  locked,
  onMark,
}: {
  clip: AdminClipAccess;
  busy: boolean;
  locked: boolean;
  onMark: (clip: AdminClipAccess, state: 'free' | 'premium') => void;
}) {
  const options = [
    { value: 'free' as const, label: 'Free' },
    { value: 'premium' as const, label: 'Premium' },
  ];
  return (
    <div
      role="group"
      aria-label={`Access for clip ${clip.fileName ?? clip.assetId.slice(0, 8)}`}
      className="flex w-full shrink-0 overflow-hidden rounded-lg border border-zinc-700 sm:w-auto"
    >
      {options.map((option) => {
        const selected = clip.state === option.value;
        return (
          <button
            key={option.value}
            type="button"
            data-testid={`set-${option.value}`}
            aria-pressed={selected}
            // Re-selecting what it already is would write an offer and an audit
            // row saying nothing changed.
            disabled={locked || busy || selected}
            onClick={() => onMark(clip, option.value)}
            className={`min-h-11 flex-1 px-3 text-xs font-semibold transition-colors sm:flex-none sm:px-4 ${
              selected
                ? 'bg-rose-600 text-white'
                : 'bg-transparent text-zinc-300 hover:bg-zinc-800 disabled:text-zinc-600 disabled:hover:bg-transparent'
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * One clip: what it is, then the decision.
 *
 * `min-w-0` on the middle column is what keeps the row inside the screen: it
 * lets the text column shrink below its content so `truncate` can do its job,
 * instead of the row growing wider than the phone and taking the page with it.
 *
 * ON A PHONE THE DECISION GETS ITS OWN LINE. Inside the admin shell a row is
 * about 250px wide at 375px, and three columns left roughly 40px for the name:
 * the file was shown as "m." while two buttons sat beside it, which is the
 * failure this whole change exists to fix. `basis-full` wraps the buttons
 * underneath so the name gets the full width; from `sm` up, where there is
 * room, everything sits on one line as the carousel rows do.
 */
function ClipRow({
  clip,
  busy,
  locked,
  onMark,
}: {
  clip: AdminClipAccess;
  busy: boolean;
  locked: boolean;
  onMark: (clip: AdminClipAccess, state: 'free' | 'premium') => void;
}) {
  return (
    <li
      data-testid="clip-access-row"
      data-state={clip.state}
      className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-zinc-800 bg-zinc-900/60 p-2.5"
    >
      <ClipThumb previewUrl={clip.previewUrl} mediaType={clip.mediaType} />
      <div className="min-w-0 flex-1">
        {clip.fileName && (
          <p className="truncate text-sm text-zinc-200" data-testid="clip-name">
            {clip.fileName}
          </p>
        )}
        <p className="flex flex-wrap items-center gap-x-2 text-[11px] text-zinc-400">
          {clipDetails(clip).map((part) => (
            <span key={part}>{part}</span>
          ))}
          {/* A state neither button represents -- a Credit price set
              elsewhere -- is named rather than silently unselected. */}
          {clip.state !== 'free' && clip.state !== 'premium' && (
            <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-300">
              {clipStateLabel(clip)}
            </span>
          )}
          {clip.byDefault && <span className="text-zinc-500">Premium by default</span>}
        </p>
        <p className="truncate font-mono text-[10px] text-zinc-600">{clip.assetId.slice(0, 8)}</p>
      </div>
      <div className="basis-full sm:basis-auto">
        <AccessChoice clip={clip} busy={busy} locked={locked} onMark={onMark} />
      </div>
    </li>
  );
}

/** The panel, rendered from server data alone. */
export function ContentAccessPanel({
  page,
  busy,
  messages,
  onMark,
}: {
  page: AdminCharacterContentAccess;
  busy: boolean;
  messages: string[];
  onMark: (clip: AdminClipAccess, state: 'free' | 'premium') => void;
}) {
  const locked = !page.economyEnabled;
  return (
    <div className="flex flex-col gap-3" data-testid="content-access-panel">
      <p className="text-sm text-zinc-300" data-testid="access-summary">
        {accessSummary(page)}
      </p>
      <p className="text-xs text-zinc-500" data-testid="access-model">
        All clips are Premium by default. Mark individual clips Free when needed.
      </p>
      {locked && (
        <p role="status" className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
          The economy is switched off: clip access cannot be changed yet. Everything below is read-only.
        </p>
      )}
      <MessageList messages={messages} />

      {page.clips.length === 0 ? (
        <p className="text-sm text-zinc-500">No clips yet. Anything uploaded is Premium.</p>
      ) : (
        <ul className="flex flex-col gap-2" data-testid="clip-access-list">
          {page.clips.map((clip) => (
            <ClipRow key={clip.assetId} clip={clip} busy={busy} locked={locked} onMark={onMark} />
          ))}
        </ul>
      )}
    </div>
  );
}

type Loaded =
  | { status: 'loading' }
  | { status: 'failed'; messages: string[] }
  | { status: 'ready'; page: AdminCharacterContentAccess };

/** Loads a character's clip access, and applies the one operator action. */
export default function CharacterAccessSection({ characterId }: { characterId: string }) {
  const [state, setState] = useState<Loaded>({ status: 'loading' });
  const [busy, setBusy] = useState(false);
  const [messages, setMessages] = useState<string[]>([]);

  const load = useCallback(async () => {
    try {
      setState({ status: 'ready', page: await adminContentAccessApi.get(characterId) });
    } catch (error) {
      setState({ status: 'failed', messages: serverMessages(error) });
    }
  }, [characterId]);

  useEffect(() => {
    setState({ status: 'loading' });
    void load();
  }, [load]);

  if (state.status === 'loading') {
    return (
      <Section title="Clip access">
        <p className="text-sm text-zinc-400">Loading clip access…</p>
      </Section>
    );
  }
  if (state.status === 'failed') {
    return (
      <Section title="Clip access">
        <MessageList messages={state.messages} />
      </Section>
    );
  }

  /**
   * Applied straight away. Marking one clip Free is a two-state change an
   * operator can see and immediately undo, so a confirmation would only be a
   * step between them and the thing they already decided.
   */
  const mark = async (clip: AdminClipAccess, next: 'free' | 'premium') => {
    setBusy(true);
    try {
      setState({ status: 'ready', page: await adminContentAccessApi.markClip(characterId, clip.assetId, { state: next }) });
      setMessages([]);
    } catch (error) {
      setMessages(serverMessages(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title="Clip access">
      <ContentAccessPanel page={state.page} busy={busy} messages={messages} onMark={(clip, next) => void mark(clip, next)} />
    </Section>
  );
}
