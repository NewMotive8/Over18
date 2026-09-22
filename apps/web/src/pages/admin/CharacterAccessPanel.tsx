import { useCallback, useEffect, useState } from 'react';
import type { AdminCharacterContentAccess, AdminClipAccess } from '@over18/shared';
import { serverMessages } from '../../admin/economyConfig';
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

/** Free or Premium, for one clip. The selected one is filled; the other is the action. */
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
      aria-label={`Access for clip ${clip.assetId.slice(0, 8)}`}
      className="inline-flex overflow-hidden rounded-lg border border-zinc-700"
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
            className={`min-h-9 px-4 py-1.5 text-xs font-semibold transition-colors ${
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
        <div className="overflow-x-auto">
          <table className="w-full min-w-[26rem] text-left text-sm">
            <thead className="text-xs text-zinc-500">
              <tr>
                <th className="py-1">Clip</th>
                <th>Where</th>
                <th className="text-right">Access</th>
              </tr>
            </thead>
            <tbody className="text-zinc-300">
              {page.clips.map((clip) => (
                <tr key={clip.assetId} data-testid="clip-access-row" data-state={clip.state}>
                  <td className="py-1.5 font-mono text-[11px] text-zinc-500">{clip.assetId.slice(0, 8)}</td>
                  <td className="text-xs text-zinc-400">{clip.live ? 'Live' : clip.workflow}</td>
                  <td className="py-1.5 text-right">
                    <div className="flex items-center justify-end gap-2">
                      {/* A state neither button represents -- a Credit price set
                          elsewhere -- is named rather than silently unselected. */}
                      {clip.state !== 'free' && clip.state !== 'premium' && (
                        <span className="rounded bg-zinc-800 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-400">
                          {clipStateLabel(clip)}
                        </span>
                      )}
                      {clip.byDefault && <span className="text-[11px] text-zinc-500">by default</span>}
                      <AccessChoice clip={clip} busy={busy} locked={locked} onMark={onMark} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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
