import { useState, type ReactNode } from 'react';
import type { EconomyVersionState } from '@over18/shared';
import ConfirmDialog from '../../../admin/ConfirmDialog';
import { activeOf, draftOf, serverMessages } from '../../../admin/economyConfig';
import { Field, MessageList, Section, VersionHistory, buttonClass, inputClass, secondaryButtonClass } from './EconomyUi';

/**
 * One screen shape for plans and Credit packs: the items by code, the chosen
 * item's version history, and its one open draft -- start it, edit it, save
 * it, discard it. Nothing here is published: drafts go live only through
 * Versions & publishing. Every rule is the server's; its messages are shown.
 */

type Version = {
  id: string;
  version: number;
  state: EconomyVersionState;
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
  toDraft: (form: F) => Parsed<B>;
  save: (code: string, body: B & { reason: string | null }) => Promise<unknown>;
  discard: (code: string) => Promise<unknown>;
  reload: () => Promise<void>;
  columns: Array<{ label: string; value: (v: V) => ReactNode }>;
  renderForm: (form: F, onChange: (form: F) => void) => ReactNode;
}

export default function VersionedItemScreen<V extends Version, F, B>(spec: ItemScreenSpec<V, F, B>) {
  const [selected, setSelected] = useState<string | null>(spec.items[0]?.code ?? null);
  const [newCode, setNewCode] = useState('');
  const [notice, setNotice] = useState<string[]>([]);
  const item = spec.items.find((i) => i.code === selected) ?? null;
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
                {i.code}
                {draftOf(i.versions) && <span className="ml-2 text-[10px] uppercase tracking-wide text-sky-400">draft</span>}
              </button>
            </li>
          ))}
        </ul>
        {spec.items.length === 0 && <p className="text-sm text-zinc-500">No {spec.noun} yet.</p>}
        <form
          className="mt-2 border-t border-zinc-800 pt-3"
          onSubmit={(event) => {
            event.preventDefault();
            const code = newCode.trim();
            if (!code) return;
            setSelected(code);
            setNewCode('');
            setNotice([]);
          }}
        >
          <Field label={`New ${spec.noun} code`} hint="The server checks the format; a code cannot be changed later.">
            <input value={newCode} onChange={(e) => setNewCode(e.target.value)} className={inputClass} />
          </Field>
          <button type="submit" className={`${secondaryButtonClass} mt-2`}>
            Add {spec.noun}
          </button>
        </form>
      </aside>

      <div className="flex flex-col gap-4">
        <MessageList messages={notice} tone="success" />
        {selected === null ? (
          <p className="text-sm text-zinc-400">Choose a {spec.noun}, or add one.</p>
        ) : (
          <>
            <Section title={`${Noun} ${selected}`}>
              <VersionHistory versions={item?.versions ?? []} columns={spec.columns} />
            </Section>
            <ItemDraftEditor
              key={`${selected}:${draft?.id ?? 'none'}:${draft?.updatedAt ?? ''}`}
              spec={spec}
              code={selected}
              versions={item?.versions ?? []}
              onNotice={setNotice}
            />
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
  versions,
  onNotice,
}: {
  spec: ItemScreenSpec<V, F, B>;
  code: string;
  versions: readonly V[];
  onNotice: (messages: string[]) => void;
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
    setBusy(true);
    setMessages([]);
    try {
      await spec.save(code, { ...parsed.body, reason: note.trim() || null });
      onNotice([`Draft of ${spec.noun} ${code} saved. It goes live only when published from Versions & publishing.`]);
      await spec.reload();
    } catch (error) {
      setMessages(serverMessages(error));
    } finally {
      setBusy(false);
    }
  };

  const discard = async () => {
    setBusy(true);
    try {
      await spec.discard(code);
      setConfirming(false);
      onNotice([`Draft of ${spec.noun} ${code} discarded.`]);
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
        <p className="text-sm text-zinc-400">No open draft. Changes are made in a draft, then published.</p>
        {base && (
          <button type="button" onClick={() => setForm(spec.formFrom(base))} className={`${secondaryButtonClass} mt-3`}>
            Start a draft from v{base.version}
          </button>
        )}
      </Section>
    );
  }

  return (
    <Section title={draft ? `Draft v${draft.version}` : 'New draft'}>
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
        title={`Discard the draft of ${spec.noun} ${code}?`}
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
