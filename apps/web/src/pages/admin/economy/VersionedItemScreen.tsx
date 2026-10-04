import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { EconomyVersionState } from '@over18/shared';
import ConfirmDialog from '../../../admin/ConfirmDialog';
import { ECONOMY_SECTIONS } from '../../../admin/economy';
import { activeOf, codeFromName, draftOf, itemName, itemStatus, serverMessages, type ItemStatus } from '../../../admin/economyConfig';
import { Field, MessageList, StateGuide, VersionHistory, buttonClass, inputClass, secondaryButtonClass } from './EconomyUi';

/**
 * One screen shape for plans and Credit packs, written for someone who has
 * never used it:
 *
 *   1. A LIST of what exists, each with one plain status -- is it on the site
 *      or not -- and a button to add another.
 *   2. ONE ITEM: what customers see now, a form to change it, and what to do
 *      next. The version history is there, folded away.
 *
 * Saving here never changes the site: a change is a draft until it is
 * published, and every place that matters says so and links to the publish
 * screen. Nothing here is published; every rule is the server's.
 *
 * THE INTERNAL ID IS MADE, NOT TYPED. The server keys each plan and pack by a
 * permanent code. A new item gets its code from its name on the first save
 * (`codeFromName`); after that it is shown as a small reference only.
 */

type Version = {
  id: string;
  version: number;
  state: EconomyVersionState;
  displayName: string;
  isPurchasable: boolean;
  effectiveFrom: string | null;
  publishReason: string | null;
  updatedAt: string;
};
type Parsed<B> = { ok: true; body: B } | { ok: false; errors: string[] };
type Item<V> = { code: string; versions: readonly V[] };

export interface ItemScreenSpec<V extends Version, F, B> {
  noun: 'plan' | 'pack';
  /** Where customers meet these, for the explanations: "the Premium page". */
  where: string;
  /** One sentence on what this kind of product is. */
  about: string;
  items: ReadonlyArray<Item<V>>;
  /** A version in a line or two, the way a customer would describe it. */
  summary: (version: V) => string[];
  /** The order items are listed in; lower first. */
  order?: (version: V) => number;
  emptyForm: () => F;
  formFrom: (version: V) => F;
  /** The name typed in the form: what a new item's internal ID is made from. */
  nameOf: (form: F) => string;
  toDraft: (form: F) => Parsed<B>;
  save: (code: string, body: B & { reason: string | null }) => Promise<unknown>;
  discard: (code: string) => Promise<unknown>;
  reload: () => Promise<void>;
  columns: Array<{ label: string; value: (v: V) => ReactNode }>;
  renderForm: (form: F, onChange: (form: F) => void) => ReactNode;
}

/** An item not saved yet: it has no code until its first draft is saved. */
const NEW_ITEM = Symbol('new item');
type Selection = string | typeof NEW_ITEM | null;

const PUBLISH_PATH = ECONOMY_SECTIONS.find((section) => section.key === 'versions')!.path;

/** The version an item is described by: what is live, else the newest there is. */
const shownVersion = <V extends Version>(item: Item<V>): V | null =>
  activeOf(item.versions) ?? [...item.versions].sort((a, b) => b.version - a.version)[0] ?? null;

const TONE: Record<ItemStatus['tone'], string> = {
  live: 'border-emerald-700 bg-emerald-950/40 text-emerald-300',
  off: 'border-zinc-700 bg-zinc-900 text-zinc-400',
  scheduled: 'border-amber-700 bg-amber-950/30 text-amber-300',
  new: 'border-sky-800 bg-sky-950/30 text-sky-300',
};

export function StatusPill({ status }: { status: ItemStatus }) {
  return <span className={`inline-block rounded-full border px-2.5 py-0.5 text-xs font-medium ${TONE[status.tone]}`}>{status.label}</span>;
}

/** The three steps, always in view: the one thing a newcomer cannot guess is that saving is not publishing. */
export function HowItWorks({ noun }: { noun: 'plan' | 'pack' }) {
  const steps = [
    ['Create or edit', `Add a ${noun}, or open one and change it.`],
    ['Save as a draft', 'A draft is private. Customers see no change yet.'],
    ['Publish', 'Publishing puts your drafts on the site.'],
  ];
  return (
    <ol className="grid gap-2 rounded-lg border border-zinc-800 bg-zinc-900/40 p-3 sm:grid-cols-3">
      {steps.map(([title, text], i) => (
        <li key={title} className="flex gap-3">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-zinc-800 text-xs font-semibold text-zinc-200">{i + 1}</span>
          <span className="text-sm">
            <span className="font-medium text-zinc-100">{title}</span>
            <span className="block text-xs text-zinc-400">{text}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

/** Says that drafts are waiting, and where to publish them. */
function PublishPrompt({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
      <p>{children}</p>
      <Link to={PUBLISH_PATH} className="shrink-0 rounded-md bg-amber-400 px-3 py-1.5 text-sm font-semibold text-zinc-950 hover:bg-amber-300">
        Review &amp; publish →
      </Link>
    </div>
  );
}

/** Every plan or pack, as a card: its name, what it is, and whether it is on the site. */
export function ItemList<V extends Version, F, B>({
  spec,
  onOpen,
  onNew,
}: {
  spec: ItemScreenSpec<V, F, B>;
  onOpen: (code: string) => void;
  onNew: () => void;
}) {
  const order = spec.order;
  const items = order
    ? [...spec.items].sort((a, b) => {
        const [va, vb] = [shownVersion(a), shownVersion(b)];
        return (va ? order(va) : 0) - (vb ? order(vb) : 0);
      })
    : spec.items;
  const waiting = spec.items.filter((i) => draftOf(i.versions)).length;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-2xl text-sm text-zinc-400">{spec.about}</p>
        <button type="button" onClick={onNew} className={buttonClass}>
          + New {spec.noun}
        </button>
      </div>
      <HowItWorks noun={spec.noun} />
      {waiting > 0 && (
        <PublishPrompt>
          {waiting === 1 ? `1 ${spec.noun} has` : `${waiting} ${spec.noun}s have`} changes saved as a draft. Customers will not see them until you publish.
        </PublishPrompt>
      )}
      {items.length === 0 ? (
        <p className="rounded-lg border border-dashed border-zinc-800 p-6 text-center text-sm text-zinc-400">
          There is no {spec.noun} yet. Press “+ New {spec.noun}” to create the first one.
        </p>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((item) => {
            const version = shownVersion(item);
            const status = itemStatus(item.versions, spec.noun, spec.where);
            return (
              <li key={item.code} data-testid="item-card" className="flex flex-col gap-3 rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
                <div className="flex flex-col gap-1.5">
                  <h3 className="text-base font-semibold text-zinc-100">{itemName(item)}</h3>
                  <div>
                    <StatusPill status={status} />
                  </div>
                </div>
                {version && (
                  <ul className="text-sm text-zinc-300">
                    {spec.summary(version).map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                )}
                {status.pending && <p className="text-xs text-amber-300">{status.pending}</p>}
                <button type="button" onClick={() => onOpen(item.code)} className={`${secondaryButtonClass} mt-auto self-start`}>
                  View / edit
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** One plan or pack: what customers see now, the form that changes it, and its history. */
export function ItemDetail<V extends Version, F, B>({
  spec,
  item,
  onBack,
  onNotice,
  onCreated,
}: {
  spec: ItemScreenSpec<V, F, B>;
  /** Null for an item that has never been saved: its code is made from its name on the first save. */
  item: Item<V> | null;
  onBack: () => void;
  onNotice: (messages: string[]) => void;
  onCreated: (code: string) => void;
}) {
  const versions: readonly V[] = item?.versions ?? [];
  const code = item?.code ?? null;
  const name = item ? itemName(item) : `New ${spec.noun}`;
  const draft = draftOf(versions);
  const live = activeOf(versions);
  const base = live ?? [...versions].filter((v) => v.state !== 'cancelled').sort((a, b) => b.version - a.version)[0] ?? null;
  const status = item ? itemStatus(versions, spec.noun, spec.where) : null;
  const [form, setForm] = useState<F | null>(() => (draft ? spec.formFrom(draft) : versions.length === 0 ? spec.emptyForm() : null));
  const [note, setNote] = useState('');
  const [messages, setMessages] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const save = async () => {
    if (!form) return;
    const parsed = spec.toDraft(form);
    if (!parsed.ok) return setMessages(parsed.errors);
    const saveAs =
      code ??
      codeFromName(
        spec.nameOf(form),
        spec.noun,
        spec.items.map((i) => i.code),
      );
    if (saveAs === null) return setMessages(['Name: use a name that contains letters or numbers.']);
    setBusy(true);
    setMessages([]);
    try {
      await spec.save(saveAs, { ...parsed.body, reason: note.trim() || null });
      onNotice([`“${spec.nameOf(form).trim()}” is saved as a draft. It is not on the site yet — publish it to make it live.`]);
      await spec.reload();
      if (code === null) onCreated(saveAs);
    } catch (error) {
      setMessages(serverMessages(error));
    } finally {
      setBusy(false);
    }
  };

  const discard = async () => {
    if (code === null) return;
    setBusy(true);
    try {
      await spec.discard(code);
      setConfirming(false);
      onNotice([`The draft of “${name}” was discarded. Nothing customers see has changed.`]);
      await spec.reload();
    } catch (error) {
      setConfirming(false);
      setMessages(serverMessages(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <button type="button" onClick={onBack} className="self-start text-sm text-zinc-400 hover:text-zinc-200">
        ← All {spec.noun}s
      </button>

      <div className="flex flex-col gap-2">
        <h2 className="text-xl font-semibold text-zinc-100">{name}</h2>
        {status ? (
          <p className="flex flex-wrap items-center gap-2 text-sm text-zinc-400">
            <StatusPill status={status} />
            {status.explain}
          </p>
        ) : (
          <p className="text-sm text-zinc-400">
            Fill this in and save it as a draft. Customers will not see the new {spec.noun} until you publish it.
          </p>
        )}
      </div>

      {draft && (
        <PublishPrompt>
          This {spec.noun} has changes saved as a draft. {live ? 'Customers still see the current version' : `Customers cannot see this ${spec.noun}`} until you publish.
        </PublishPrompt>
      )}

      {live && (
        <section className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
          <h3 className="mb-2 text-sm font-semibold text-zinc-200">What customers see now</h3>
          <ul className="text-sm text-zinc-300">
            {spec.summary(live).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </section>
      )}

      <section className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
        {!form ? (
          <>
            <h3 className="mb-2 text-sm font-semibold text-zinc-200">Change this {spec.noun}</h3>
            <p className="text-sm text-zinc-400">
              Change the price, the name or anything else, or take this {spec.noun} off sale. Your changes are saved as a draft first; nothing changes on the
              site until you publish.
            </p>
            {base && (
              <button type="button" onClick={() => setForm(spec.formFrom(base))} className={`${buttonClass} mt-3`}>
                Edit this {spec.noun}
              </button>
            )}
          </>
        ) : (
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <h3 className="text-sm font-semibold text-zinc-200">{draft ? 'Your unpublished changes' : code === null ? `New ${spec.noun}` : `Edit this ${spec.noun}`}</h3>
            {spec.renderForm(form, setForm)}
            <Field label="Note for your records (optional)" hint="Why you made this change. Only admins see it.">
              <input value={note} onChange={(e) => setNote(e.target.value)} className={inputClass} />
            </Field>
            <MessageList messages={messages} />
            <div className="flex flex-wrap items-center gap-2">
              <button type="submit" disabled={busy} className={buttonClass}>
                {busy ? 'Saving…' : 'Save draft'}
              </button>
              {draft ? (
                <button type="button" disabled={busy} onClick={() => setConfirming(true)} className={secondaryButtonClass}>
                  Discard draft
                </button>
              ) : (
                code !== null && (
                  <button type="button" disabled={busy} onClick={() => setForm(null)} className={secondaryButtonClass}>
                    Cancel
                  </button>
                )
              )}
              <span className="text-xs text-zinc-500">Saving does not change the site. Publish afterwards to make it live.</span>
            </div>
          </form>
        )}
      </section>

      {item && (
        <details className="rounded-lg border border-zinc-800 bg-zinc-900/40 px-4 py-3">
          <summary className="cursor-pointer text-sm text-zinc-400">History and internal ID</summary>
          <div className="mt-3 flex flex-col gap-3">
            <VersionHistory versions={versions} columns={spec.columns} />
            <p className="text-xs text-zinc-500">
              Internal ID: <code>{item.code}</code> — set automatically, for support and reports. It never changes.
            </p>
            <StateGuide />
          </div>
        </details>
      )}

      <ConfirmDialog
        open={confirming}
        title={`Discard the draft of “${name}”?`}
        body="The draft is deleted. Nothing that is live or scheduled changes."
        confirmLabel="Discard draft"
        cancelLabel="Keep draft"
        onConfirm={() => void discard()}
        onCancel={() => setConfirming(false)}
        busy={busy}
        tone="danger"
      />
    </div>
  );
}

export default function VersionedItemScreen<V extends Version, F, B>(spec: ItemScreenSpec<V, F, B>) {
  const [selected, setSelected] = useState<Selection>(null);
  const [notice, setNotice] = useState<string[]>([]);
  const item = typeof selected === 'string' ? (spec.items.find((i) => i.code === selected) ?? null) : null;
  const draft = item ? draftOf(item.versions) : null;
  const open = (selection: Selection) => {
    setSelected(selection);
    setNotice([]);
  };

  return (
    <div className="flex flex-col gap-4">
      <MessageList messages={notice} tone="success" />
      {selected === null || (typeof selected === 'string' && !item) ? (
        <ItemList spec={spec} onOpen={open} onNew={() => open(NEW_ITEM)} />
      ) : (
        <ItemDetail
          // Remounted whenever the server's draft changes, so the form always holds what is stored.
          key={selected === NEW_ITEM ? 'new' : `${item!.code}:${draft?.id ?? 'none'}:${draft?.updatedAt ?? ''}`}
          spec={spec}
          item={selected === NEW_ITEM ? null : item}
          onBack={() => open(null)}
          onNotice={setNotice}
          onCreated={setSelected}
        />
      )}
    </div>
  );
}
