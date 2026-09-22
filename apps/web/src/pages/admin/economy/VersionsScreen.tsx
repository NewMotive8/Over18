import { useCallback, useEffect, useState } from 'react';
import type { EconomyConfigurationView, EconomyPublishReview } from '@over18/shared';
import ConfirmDialog from '../../../admin/ConfirmDialog';
import {
  EMPTY_PUBLISH_FORM,
  changeValue,
  diffTitle,
  draftsChanged,
  isCancellable,
  publishRequest,
  serverMessages,
  versionRows,
  type PublishForm,
  type VersionRow,
} from '../../../admin/economyConfig';
import { adminEconomyApi } from '../../../lib/api';
import { Field, MessageList, Section, StateBadge, buttonClass, inputClass, secondaryButtonClass } from './EconomyUi';

/**
 * Versions & publishing. Every version by state; the server's old -> new
 * review of ALL open drafts; publishing them together, now or at a scheduled
 * time, with a required reason and an explicit confirmation; and cancelling a
 * scheduled version. The server decides what may be published and when.
 */

export function VersionsTable({ rows, onCancel }: { rows: readonly VersionRow[]; onCancel: (row: VersionRow) => void }) {
  if (rows.length === 0) return <p className="text-sm text-zinc-500">No configuration version yet.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[56rem] text-left text-sm">
        <thead className="text-xs text-zinc-500">
          <tr>
            <th className="py-1">What</th>
            <th>Version</th>
            <th>State</th>
            <th>Takes effect</th>
            <th>Published</th>
            <th>By</th>
            <th>Reason</th>
            <th />
          </tr>
        </thead>
        <tbody className="align-top text-zinc-300">
          {rows.map((row) => (
            <tr key={row.id} data-testid="version-row">
              <td className="py-1">{row.kind === 'ruleset' ? 'Ruleset' : `${row.kind === 'plan' ? 'Plan' : 'Pack'} ${row.code}`}</td>
              <td>v{row.version}</td>
              <td>
                <StateBadge state={row.state} />
              </td>
              <td className="text-xs text-zinc-400">{row.effectiveFrom ?? '—'}</td>
              <td className="text-xs text-zinc-400">{row.publishedAt ?? '—'}</td>
              <td className="break-all font-mono text-[11px] text-zinc-500">{row.publishedBy ?? '—'}</td>
              <td className="text-xs text-zinc-400">{row.state === 'cancelled' ? `Cancelled: ${row.cancelReason ?? '—'}` : (row.publishReason ?? '—')}</td>
              <td>
                {isCancellable(row) && (
                  <button type="button" onClick={() => onCancel(row)} className="text-xs text-amber-300 hover:text-amber-200">
                    Cancel…
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The review and the publish form. Pure: the parent fetches and publishes. */
export function ReviewPanel({
  review,
  form,
  onForm,
  onPublish,
  busy,
  messages,
}: {
  review: EconomyPublishReview;
  form: PublishForm;
  onForm: (form: PublishForm) => void;
  onPublish: () => void;
  busy: boolean;
  messages: string[];
}) {
  const blocked = review.errors.length > 0;
  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-zinc-500">Reviewed at {review.asOf}. Publishing applies exactly these drafts, all together.</p>
      {review.diff.map((diff) => (
        <div key={`${diff.kind}-${diff.code ?? ''}`} className="rounded-md border border-zinc-800 p-3">
          <p className="text-sm font-medium text-zinc-200">{diffTitle(diff)}</p>
          {diff.changes.length === 0 ? (
            <p className="mt-1 text-xs text-zinc-500">No value changes.</p>
          ) : (
            <table className="mt-2 w-full text-left text-xs">
              <thead className="text-zinc-500">
                <tr>
                  <th className="py-1">Field</th>
                  <th>Live now</th>
                  <th>Draft</th>
                </tr>
              </thead>
              <tbody className="font-mono text-zinc-300">
                {diff.changes.map((change) => (
                  <tr key={change.field} data-testid="diff-change">
                    <td className="py-0.5 pr-3">{change.field}</td>
                    <td className="pr-3 text-zinc-500">{changeValue(change.before)}</td>
                    <td className="text-zinc-100">{changeValue(change.after)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ))}
      {blocked && <p className="text-sm font-medium text-red-200">Publishing is blocked until the server's errors are resolved:</p>}
      <MessageList messages={review.errors} />
      <MessageList messages={review.warnings} tone="warning" />
      <form
        className="grid gap-3 rounded-md border border-zinc-800 p-3 sm:grid-cols-2"
        onSubmit={(event) => {
          event.preventDefault();
          onPublish();
        }}
      >
        <Field label="Reason (required)" hint="Recorded with every published version.">
          <textarea rows={2} value={form.reason} onChange={(e) => onForm({ ...form, reason: e.target.value })} className={inputClass} />
        </Field>
        <fieldset className="text-sm text-zinc-300">
          <legend>Takes effect</legend>
          <label className="mt-1 flex items-center gap-2">
            <input type="radio" name="when" checked={form.when === 'now'} onChange={() => onForm({ ...form, when: 'now' })} />
            Now
          </label>
          <label className="mt-1 flex items-center gap-2">
            <input type="radio" name="when" checked={form.when === 'scheduled'} onChange={() => onForm({ ...form, when: 'scheduled' })} />
            At a scheduled time
          </label>
          {form.when === 'scheduled' && (
            <input type="datetime-local" aria-label="Scheduled time" value={form.scheduledAt} onChange={(e) => onForm({ ...form, scheduledAt: e.target.value })} className={inputClass} />
          )}
        </fieldset>
        <MessageList messages={messages} />
        <div className="sm:col-span-2">
          <button type="submit" disabled={busy || blocked || form.reason.trim() === ''} className={buttonClass}>
            {form.when === 'now' ? 'Publish all drafts…' : 'Schedule all drafts…'}
          </button>
        </div>
      </form>
    </div>
  );
}

function CancelForm({ row, onDone, onClose }: { row: VersionRow; onDone: (messages: string[]) => void; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const [messages, setMessages] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const cancel = async () => {
    if (!reason.trim()) return setMessages(['A reason is required to cancel a scheduled version.']);
    setBusy(true);
    try {
      await adminEconomyApi.cancelVersion(row.kind, row.id, reason.trim());
      onDone([`${row.kind === 'ruleset' ? 'Ruleset' : `${row.kind} ${row.code}`} v${row.version} cancelled.`]);
    } catch (error) {
      setMessages(serverMessages(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="flex flex-col gap-3 rounded-md border border-amber-500/30 p-3"
      onSubmit={(event) => {
        event.preventDefault();
        void cancel();
      }}
    >
      <p className="text-sm text-zinc-200">
        Cancel {row.kind === 'ruleset' ? 'the ruleset' : `${row.kind} ${row.code}`} v{row.version}, scheduled for {row.effectiveFrom}? It will not take effect.
      </p>
      <Field label="Reason (required)">
        <input value={reason} onChange={(e) => setReason(e.target.value)} className={inputClass} />
      </Field>
      <MessageList messages={messages} />
      <div className="flex gap-2">
        <button type="submit" disabled={busy} className={buttonClass}>
          {busy ? 'Cancelling…' : 'Cancel this version'}
        </button>
        <button type="button" onClick={onClose} className={secondaryButtonClass}>
          Keep it
        </button>
      </div>
    </form>
  );
}

export default function VersionsScreen({ config, reload }: { config: EconomyConfigurationView; reload: () => Promise<void> }) {
  const [review, setReview] = useState<EconomyPublishReview | null>(null);
  const [reviewError, setReviewError] = useState<string[]>([]);
  const [form, setForm] = useState<PublishForm>(EMPTY_PUBLISH_FORM);
  const [messages, setMessages] = useState<string[]>([]);
  const [notice, setNotice] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [cancelling, setCancelling] = useState<VersionRow | null>(null);

  const loadReview = useCallback(async () => {
    setReviewError([]);
    try {
      setReview(await adminEconomyApi.review());
    } catch (error) {
      setReview(null);
      setReviewError(serverMessages(error));
    }
  }, []);

  useEffect(() => {
    void loadReview();
  }, [loadReview]);

  const requestPublish = () => {
    if (!review) return;
    const built = publishRequest(form, review.draftSetToken);
    if (!built.ok) return setMessages(built.errors);
    setMessages([]);
    setConfirming(true);
  };

  const publish = async () => {
    if (!review) return;
    const built = publishRequest(form, review.draftSetToken);
    if (!built.ok) return setMessages(built.errors);
    setBusy(true);
    try {
      const result = await adminEconomyApi.publish(built.body);
      setConfirming(false);
      setForm(EMPTY_PUBLISH_FORM);
      setNotice(
        result.published.map(
          (p) => `${p.kind === 'ruleset' ? 'Ruleset' : `${p.kind === 'plan' ? 'Plan' : 'Pack'} ${p.code}`} v${p.version} published, taking effect ${p.effectiveFrom}.`,
        ),
      );
      await reload();
      await loadReview();
    } catch (error) {
      setConfirming(false);
      setMessages(serverMessages(error));
      if (draftsChanged(error)) await loadReview();
    } finally {
      setBusy(false);
    }
  };

  const draftCount = review?.diff.length ?? 0;
  return (
    <div className="flex flex-col gap-4">
      <MessageList messages={notice} tone="success" />
      <Section
        title="Review and publish all drafts"
        actions={
          <button type="button" onClick={() => void loadReview()} className={secondaryButtonClass}>
            Refresh review
          </button>
        }
      >
        <MessageList messages={reviewError} />
        {review ? (
          <ReviewPanel review={review} form={form} onForm={setForm} onPublish={requestPublish} busy={busy} messages={messages} />
        ) : (
          reviewError.length === 0 && <p className="text-sm text-zinc-500">Loading the review…</p>
        )}
      </Section>

      <Section title="All versions">
        {cancelling && (
          <div className="mb-3">
            <CancelForm
              row={cancelling}
              onClose={() => setCancelling(null)}
              onDone={(done) => {
                setCancelling(null);
                setNotice(done);
                void reload().then(loadReview);
              }}
            />
          </div>
        )}
        <VersionsTable rows={versionRows(config)} onCancel={setCancelling} />
      </Section>

      <ConfirmDialog
        open={confirming}
        title={form.when === 'now' ? `Publish all ${draftCount} drafts now?` : `Schedule all ${draftCount} drafts?`}
        body={
          form.when === 'now'
            ? 'Every open draft goes live together, immediately. A published version cannot be edited -- only superseded by a newer one.'
            : `Every open draft takes effect together at ${form.scheduledAt}. Until then a scheduled version can be cancelled; the server says when it no longer can.`
        }
        confirmLabel={form.when === 'now' ? 'Publish' : 'Schedule'}
        cancelLabel="Go back"
        onConfirm={() => void publish()}
        onCancel={() => setConfirming(false)}
        busy={busy}
      />
    </div>
  );
}
