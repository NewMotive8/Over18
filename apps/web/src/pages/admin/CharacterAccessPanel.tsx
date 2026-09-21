import { useCallback, useEffect, useState } from 'react';
import type { AdminCharacterContentAccess, AdminClipAccess } from '@over18/shared';
import ConfirmDialog from '../../admin/ConfirmDialog';
import { serverMessages } from '../../admin/economyConfig';
import { adminContentAccessApi } from '../../lib/api';
import { Field, MessageList, Section, buttonClass, inputClass, secondaryButtonClass } from './economy/EconomyUi';

/**
 * Admin -> a character -> what her clips cost to see (P4.D2).
 *
 * IT MANAGES NO CONTENT. Uploading, approving, releasing and deleting a clip
 * are exactly where they were on this page; this panel only says what each
 * clip costs to see: Free, included with Premium, or unlocked for a price in
 * Credits. Every state shown is the server's answer, and the two actions are
 * the two the decision allows: mark one clip, or ask for a number of Free
 * clips and let the server pick them at random.
 *
 * THE PRICE RULE IS THE SERVER'S. `parseCreditPrice` below only decides whether
 * to bother sending the request -- it is a courtesy, not a second rule, and the
 * server refuses anything it would have refused anyway.
 *
 * While the economy is off nothing can be changed -- as for every commercial
 * write -- and the panel says so rather than offering controls that would fail.
 */

/**
 * A typed Credit price, or null when what was typed is not one.
 *
 * Whole Credits, 1 or more: the same shape P4.1 requires. Anything else --
 * blank, 0, 12.5, -3, "fifty" -- is not a price.
 */
export function parseCreditPrice(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const price = Number(trimmed);
  return Number.isSafeInteger(price) && price >= 1 ? price : null;
}

export const clipStateLabel = (clip: AdminClipAccess): string =>
  clip.state === 'free' ? 'Free' : clip.state === 'premium' ? 'Premium' : clip.state === 'credit' ? `${clip.creditPrice ?? '—'} Credits` : 'Unavailable';

/** What the allocation is, in one line. */
export function allocationSummary(page: AdminCharacterContentAccess): string {
  const { counts, allocation } = page;
  if (counts.clips === 0) return 'She has no clips yet.';
  const priced = counts.credit > 0 ? `, ${counts.credit} Credit-priced` : '';
  const shape = `${counts.free} of ${counts.clips} Free, ${counts.premium} Premium${priced}.`;
  return allocation.configured
    ? `${shape} New clips are Premium${allocation.freeClipCount === null ? '' : `; ${allocation.freeClipCount} Free clips configured`}.`
    : `${shape} New clips are Free: she is not in Free/Premium yet.`;
}

/** The panel, rendered from server data alone. */
export function ContentAccessPanel({
  page,
  freeCount,
  reason,
  busy,
  messages,
  prices,
  onFreeCount,
  onReason,
  onPrice,
  onAllocate,
  onClear,
  onMark,
}: {
  page: AdminCharacterContentAccess;
  freeCount: string;
  reason: string;
  busy: boolean;
  messages: string[];
  /** What the operator has typed into each clip's Credit price box, by asset id. */
  prices: Record<string, string>;
  onFreeCount: (value: string) => void;
  onReason: (value: string) => void;
  onPrice: (assetId: string, value: string) => void;
  onAllocate: () => void;
  onClear: () => void;
  onMark: (clip: AdminClipAccess, state: 'free' | 'premium' | 'credit', creditPrice?: number) => void;
}) {
  const locked = !page.economyEnabled;
  return (
    <div className="flex flex-col gap-3" data-testid="content-access-panel">
      <p className="text-sm text-zinc-300" data-testid="access-summary">
        {allocationSummary(page)}
      </p>
      {locked && (
        <p role="status" className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
          The economy is switched off: clip access cannot be changed yet. Everything below is read-only.
        </p>
      )}
      <MessageList messages={messages} />

      <form
        className="grid gap-3 rounded-md border border-zinc-800 p-3 sm:grid-cols-[10rem_1fr_auto]"
        data-testid="allocation-form"
        onSubmit={(event) => {
          event.preventDefault();
          onAllocate();
        }}
      >
        <Field label="Free clips" hint="Chosen at random.">
          <input inputMode="numeric" value={freeCount} onChange={(e) => onFreeCount(e.target.value)} disabled={locked} className={inputClass} />
        </Field>
        <Field label="Reason (required)" hint="Recorded in the audit log.">
          <input value={reason} onChange={(e) => onReason(e.target.value)} disabled={locked} className={inputClass} />
        </Field>
        <div className="flex items-end gap-2">
          <button type="submit" disabled={locked || busy || reason.trim() === '' || freeCount.trim() === ''} className={buttonClass}>
            Choose at random
          </button>
          {page.allocation.configured && (
            <button type="button" onClick={onClear} disabled={locked || busy || reason.trim() === ''} className={secondaryButtonClass}>
              Turn off
            </button>
          )}
        </div>
      </form>

      {page.clips.length === 0 ? (
        <p className="text-sm text-zinc-500">No clips yet. Anything uploaded later follows this character's setting.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[32rem] text-left text-sm">
            <thead className="text-xs text-zinc-500">
              <tr>
                <th className="py-1">Clip</th>
                <th>Where</th>
                <th>Access</th>
                <th className="text-right">Set</th>
              </tr>
            </thead>
            <tbody className="text-zinc-300">
              {page.clips.map((clip) => (
                <tr key={clip.assetId} data-testid="clip-access-row" data-state={clip.state}>
                  <td className="py-1 font-mono text-[11px] text-zinc-500">{clip.assetId.slice(0, 8)}</td>
                  <td className="text-xs text-zinc-400">{clip.live ? 'Live' : clip.workflow}</td>
                  <td>
                    <span className={clip.state === 'free' ? 'text-emerald-300' : clip.state === 'credit' ? 'text-amber-300' : 'text-rose-300'}>
                      {clipStateLabel(clip)}
                    </span>
                    {clip.byDefault && <span className="ml-2 text-[11px] text-zinc-500">by default</span>}
                  </td>
                  <td className="text-right">
                    {(() => {
                      const typed = prices[clip.assetId] ?? '';
                      const price = parseCreditPrice(typed);
                      const blocked = locked || busy || reason.trim() === '';
                      return (
                        <div className="flex items-center justify-end gap-1">
                          <button
                            type="button"
                            data-testid="set-free"
                            onClick={() => onMark(clip, 'free')}
                            disabled={blocked || clip.state === 'free'}
                            className={`${secondaryButtonClass} px-2 py-1 text-xs`}
                          >
                            Free
                          </button>
                          <button
                            type="button"
                            data-testid="set-premium"
                            onClick={() => onMark(clip, 'premium')}
                            disabled={blocked || clip.state === 'premium'}
                            className={`${secondaryButtonClass} px-2 py-1 text-xs`}
                          >
                            Premium
                          </button>
                          <input
                            inputMode="numeric"
                            data-testid="credit-price"
                            aria-label={`Credit price for clip ${clip.assetId.slice(0, 8)}`}
                            placeholder="Credits"
                            value={typed}
                            onChange={(event) => onPrice(clip.assetId, event.target.value)}
                            disabled={locked || busy}
                            className={`${inputClass} w-20 px-2 py-1 text-xs`}
                          />
                          <button
                            type="button"
                            data-testid="set-credit"
                            onClick={() => price !== null && onMark(clip, 'credit', price)}
                            disabled={blocked || price === null}
                            className={`${secondaryButtonClass} px-2 py-1 text-xs`}
                          >
                            Set price
                          </button>
                        </div>
                      );
                    })()}
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

/** Loads a character's clip access, and applies the operator's two actions. */
export default function CharacterAccessSection({ characterId }: { characterId: string }) {
  const [state, setState] = useState<Loaded>({ status: 'loading' });
  const [freeCount, setFreeCount] = useState('');
  const [reason, setReason] = useState('');
  const [prices, setPrices] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [messages, setMessages] = useState<string[]>([]);
  const [pending, setPending] = useState<{ kind: 'allocate' | 'clear'; count?: number } | null>(null);

  const load = useCallback(async () => {
    try {
      const page = await adminContentAccessApi.get(characterId);
      setState({ status: 'ready', page });
      setFreeCount(page.allocation.freeClipCount === null ? '' : String(page.allocation.freeClipCount));
    } catch (error) {
      setState({ status: 'failed', messages: serverMessages(error) });
    }
  }, [characterId]);

  useEffect(() => {
    setState({ status: 'loading' });
    void load();
  }, [load]);

  if (state.status === 'loading') return <Section title="Clip access and pricing"><p className="text-sm text-zinc-400">Loading clip access…</p></Section>;
  if (state.status === 'failed') {
    return (
      <Section title="Clip access and pricing">
        <MessageList messages={state.messages} />
      </Section>
    );
  }

  const run = async (action: () => Promise<AdminCharacterContentAccess>) => {
    setBusy(true);
    try {
      setState({ status: 'ready', page: await action() });
      setMessages([]);
    } catch (error) {
      setMessages(serverMessages(error));
    } finally {
      setPending(null);
      setBusy(false);
    }
  };

  const review = () => {
    const count = Number(freeCount.trim());
    if (!/^\d+$/.test(freeCount.trim()) || !Number.isSafeInteger(count)) {
      return setMessages(['Enter a whole number of Free clips, 0 or more.']);
    }
    setMessages([]);
    setPending({ kind: 'allocate', count });
  };

  const confirmation =
    pending?.kind === 'allocate'
      ? {
          title: `Make ${pending.count} of ${state.page.counts.clips} clips Free?`,
          body: 'The server picks them at random. Every other clip of hers becomes Premium, and clips uploaded later are Premium too. Nothing is charged and no content is changed.',
        }
      : pending?.kind === 'clear'
        ? {
            title: 'Turn off Free/Premium for this character?',
            body: 'Her clips go back to being Free, as they were before. The access records are retired, not deleted.',
          }
        : null;

  return (
    <Section title="Clip access and pricing">
      <ContentAccessPanel
        page={state.page}
        freeCount={freeCount}
        reason={reason}
        busy={busy}
        messages={messages}
        onFreeCount={(value) => {
          setFreeCount(value);
          setMessages([]);
        }}
        onReason={setReason}
        prices={prices}
        onPrice={(assetId, value) => {
          setPrices((current) => ({ ...current, [assetId]: value }));
          setMessages([]);
        }}
        onAllocate={review}
        onClear={() => setPending({ kind: 'clear' })}
        onMark={(clip, next, creditPrice) =>
          void run(() =>
            adminContentAccessApi.markClip(characterId, clip.assetId, {
              state: next,
              // Sent for `credit` alone: the server refuses a price on anything
              // else, which is what should happen if this ever sends one.
              ...(next === 'credit' ? { creditPrice } : {}),
              reason: reason.trim(),
            }),
          )
        }
      />
      <ConfirmDialog
        open={confirmation !== null}
        title={confirmation?.title ?? ''}
        body={confirmation?.body ?? ''}
        confirmLabel={pending?.kind === 'clear' ? 'Turn off' : 'Choose at random'}
        cancelLabel="Go back"
        onConfirm={() =>
          void run(() =>
            pending?.kind === 'clear'
              ? adminContentAccessApi.clear(characterId, { reason: reason.trim() })
              : adminContentAccessApi.allocate(characterId, { freeClipCount: pending?.count ?? 0, reason: reason.trim() }),
          )
        }
        onCancel={() => setPending(null)}
        busy={busy}
        tone={pending?.kind === 'clear' ? 'danger' : 'default'}
      />
    </Section>
  );
}
