import { useState, type ReactNode } from 'react';
import type { EconomyVersionState } from '@over18/shared';
import ConfirmDialog from '../../../admin/ConfirmDialog';
import { activeOf, codeFromName, draftOf, itemName, serverMessages } from '../../../admin/economyConfig';
import { Field, MessageList, Section, StateGuide, VersionHistory, buttonClass, inputClass, secondaryButtonClass } from './EconomyUi';

/**
 * One screen shape for plans and Credit packs: the items by name, the chosen
 * item's version history, and its one open draft -- start it, edit it, save
 * it, discard it. Nothing here is published: drafts go live only through
 * Versions & publishing. Every rule is the server's; its messages are shown.
 *
 * THE INTERNAL ID IS MADE, NOT TYPED. The server keys each plan and pack by a
 * permanent code. A new item gets its code from its name on the first save
 * (`codeFromName`); after that the code is shown as a small reference and is
 * never asked for.
 */

type Version = {
  id: string;
  version: number;
  state: EconomyVersionState;
  displayName: string;
  effectiveFrom: string | null;
  publishReason: string | null;
  updatedAt: string;
};
type Parsed<B> = { ok: true; body: B } | { ok: false; errors: string[] };

export interface ItemScreenSpec<V extends Version, F, B> {
  noun: 'plan' | 'pack';
  items: ReadonlyArray<{ code: string; versions: readonly V[] }>;
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

export default function VersionedItemScreen<V extends Version, F, B>(spec: ItemScreenSpec<V, F, B>) {
  const [selected, setSelected] = useState<Selection>(spec.items[0]?.code ?? null);
  const [notice, setNotice] = useState<string[]>([]);
  const item = typeof selected === 'string' ? (spec.items.find((i) => i.code === selected) ?? null) : null;
  const draft = item ? draftOf(item.versions) : null;
  const Noun = spec.noun === 'plan' ? 'Plan' : 'Pack';

  return (
    <div className="grid gap-4 md:grid-cols-[14rem_1fr]">
      <aside className="flex flex-col gap-2">
        <ul className="flex flex-col gap-1">
          {spec.items.map((i) => (
            <li key={i.code}>
              <button
                type="button"
                onClick={() => {
                  setSelected(i.code);
                  setNotice([]);
                }}
                aria-current={i.code === selected ? 'true' : undefined}
                className={`w-full rounded-md px-3 py-2 text-left text-sm ${i.code === selected ? 'bg-zinc-900 text-white' : 'text-zinc-400 hover:bg-zinc-900/60'}`}
              >
                {itemName(i)}
                {draftOf(i.versions) && <span className="ml-2 text-[10px] uppercase tracking-wide text-sky-400">draft</span>}
              </button>
            </li>
          ))}
        </ul>
        {spec.items.length === 0 && <p className="text-sm text-zinc-500">No {spec.noun} yet.</p>}
        <div className="mt-2 border-t border-zinc-800 pt-3">
          <button
            type="button"
            onClick={() => {
              setSelected(NEW_ITEM);
              setNotice([]);
            }}
            aria-current={selected === NEW_ITEM ? 'true' : undefined}
            className={secondaryButtonClass}
          >
            Add {spec.noun}
          </button>
        </div>
      </aside>

      <div className="flex flex-col gap-4">
        <MessageList messages={notice} tone="success" />
        {selected === null ? (
          <p className="text-sm text-zinc-400">Choose a {spec.noun}, or add one.</p>
        ) : selected === NEW_ITEM ? (
          <ItemDraftEditor key="new" spec={spec} code={null} name={`New ${spec.noun}`} versions={[]} onNotice={setNotice} onCreated={setSelected} />
        ) : (
          <>
            <Section title={`${Noun}: ${item ? itemName(item) : selected}`}>
              <VersionHistory versions={item?.versions ?? []} columns={spec.columns} />
              <p className="mt-3 text-xs text-zinc-500">
                Internal ID: <code>{selected}</code> — set automatically, for support and reports. It never changes.
              </p>
            </Section>
            <ItemDraftEditor
              key={`${selected}:${draft?.id ?? 'none'}:${draft?.updatedAt ?? ''}`}
              spec={spec}
              code={selected}
              name={item ? itemName(item) : selected}
              versions={item?.versions ?? []}
              onNotice={setNotice}
              onCreated={setSelected}
            />
            <StateGuide />
          </>
        )}
      </div>
    </div>
  );
}

/** The draft of one item. Remounted (by key) whenever the server's draft changes. */
function ItemDraftEditor<V extends Version, F, B>({
  spec,
  code,
  name,
  versions,
  onNotice,
  onCreated,
}: {
  spec: ItemScreenSpec<V, F, B>;
  /** Null for an item that has never been saved: its code is made from its name on the first save. */
  code: string | null;
  name: string;
  versions: readonly V[];
  onNotice: (messages: string[]) => void;
  onCreated: (code: string) => void;
}) {
  const draft = draftOf(versions);
  const base = activeOf(versions) ?? [...versions].filter((v) => v.state !== 'cancelled').sort((a, b) => b.version - a.version)[0] ?? null;
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
      onNotice([`Draft of “${spec.nameOf(form).trim()}” saved. Customers see no change until it is published from Versions & publishing.`]);
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
      onNotice([`Draft of “${name}” discarded. Nothing customers see has changed.`]);
      await spec.reload();
    } catch (error) {
      setConfirming(false);
      setMessages(serverMessages(error));
    } finally {
      setBusy(false);
    }
  };

  if (!form) {
    return (
      <Section title="Draft">
        <p className="text-sm text-zinc-400">No open draft. To change this {spec.noun}, start a draft, edit it, then publish it.</p>
        {base && (
          <button type="button" onClick={() => setForm(spec.formFrom(base))} className={`${secondaryButtonClass} mt-3`}>
            Start a draft from v{base.version}
          </button>
        )}
      </Section>
    );
  }

  return (
    <Section title={draft ? `Draft v${draft.version}` : code === null ? name : 'New draft'}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        {spec.renderForm(form, setForm)}
        <Field label="Note for the audit log (optional)">
          <input value={note} onChange={(e) => setNote(e.target.value)} className={inputClass} />
        </Field>
        <MessageList messages={messages} />
        <div className="flex flex-wrap gap-2">
          <button type="submit" disabled={busy} className={buttonClass}>
            {busy ? 'Saving…' : 'Save draft'}
          </button>
          {draft && (
            <button type="button" disabled={busy} onClick={() => setConfirming(true)} className={secondaryButtonClass}>
              Discard draft
            </button>
          )}
        </div>
      </form>
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
    </Section>
  );
}
