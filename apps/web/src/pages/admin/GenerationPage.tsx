import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ApiRequestError,
  promptGenerationApi,
  type PromptBatchView,
  type PromptGenerationSettings,
  type PromptIngestOutcome,
  type PromptJobView,
  type PromptOutputView,
} from '../../lib/api';
import {
  batchSummary,
  canRetryOutput,
  costSentence,
  driveConnectMessage,
  driveConnectionView,
  driveDestination,
  formatUsd,
  isLargeBatch,
  jobStatusLabel,
  outputProgress,
  outputStatusLabel,
  retryCostsMoney,
  startRefusal,
  startRefusalMessage,
  summariseSelection,
} from '../../admin/promptGeneration';

/**
 * Admin -> Generation: prompt files in, images into one Google Drive folder.
 *
 * A PRODUCTION TOOL, AND NOTHING ELSE. Nothing on this screen can approve,
 * publish, categorise or attach anything to a character — the API it talks to
 * has no route that could. Generated images exist in the operator's Drive and
 * in a private server spool, and nowhere in the Over18 content system.
 *
 * THE PAGE POLLS; IT NEVER RESUMES. Every refresh issues GETs only, so
 * reloading mid-batch cannot restart a job, double-generate a prompt, or spend
 * a penny. Work continues on the server whether this tab is open or not.
 */

const POLL_MS = 2000;

export default function GenerationPage() {
  const [settings, setSettings] = useState<PromptGenerationSettings | null>(null);
  const [batch, setBatch] = useState<PromptBatchView | null>(null);
  const [selected, setSelected] = useState<File[]>([]);
  const [outcomes, setOutcomes] = useState<PromptIngestOutcome[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const fileInput = useRef<HTMLInputElement | null>(null);

  const loadBatch = useCallback(async (batchId: string) => {
    const { batch: fresh } = await promptGenerationApi.batch(batchId);
    setBatch(fresh);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [config, list] = await Promise.all([
          promptGenerationApi.settings(),
          promptGenerationApi.listBatches(),
        ]);
        if (cancelled) return;
        setSettings(config);
        // Resume the newest batch rather than creating one: opening this page
        // must never be a write.
        const newest = list.batches[0];
        if (newest) await loadBatch(newest.id);
      } catch (err) {
        if (!cancelled) setError(messageOf(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadBatch]);

  /** Polls while there is work in flight. Read-only, and it stops when idle. */
  useEffect(() => {
    if (!batch) return;
    const active = batch.status === 'running' || batch.jobs?.some((j) => isActive(j.status));
    if (!active) return;
    const timer = setInterval(() => {
      void loadBatch(batch.id).catch(() => {});
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [batch, loadBatch]);

  const selection = useMemo(
    () => summariseSelection(selected.map((f) => ({ name: f.name, size: f.size }))),
    [selected],
  );

  const refusal = startRefusal(batch, settings?.driveLive ?? false, settings?.xaiLive ?? false);

  /**
   * The callback redirects back here with `?drive=…`, so the outcome is read
   * from the URL once and then cleared — leaving it would make the banner
   * reappear on every later reload of the page.
   */
  const [driveNotice, setDriveNotice] = useState<string | null>(null);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const notice = driveConnectMessage(params.get('drive'), params.get('reason'));
    if (!notice) return;
    setDriveNotice(notice);
    window.history.replaceState({}, '', window.location.pathname);
    void promptGenerationApi.settings().then(setSettings).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function connectDrive() {
    setBusy(true);
    try {
      const { authorizationUrl } = await promptGenerationApi.connectDrive();
      // A full navigation, not a fetch: this is Google's consent screen and it
      // must be shown to the operator in their own browser.
      window.location.href = authorizationUrl;
    } catch (error) {
      setDriveNotice(messageOf(error));
      setBusy(false);
    }
  }

  async function disconnectDrive() {
    setBusy(true);
    try {
      await promptGenerationApi.disconnectDrive();
      setDriveNotice('Google Drive disconnected.');
      setSettings(await promptGenerationApi.settings());
    } catch (error) {
      setDriveNotice(messageOf(error));
    } finally {
      setBusy(false);
    }
  }
  const refusalMessage = startRefusalMessage(refusal);

  async function guarded(work: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  const upload = () =>
    guarded(async () => {
      if (selection.accepted.length === 0) return;
      /**
       * Only a batch that has not been run accepts more prompts.
       *
       * A running batch would race the queue, and a completed one is a record
       * of what was generated — adding to it would make its cost estimate and
       * its history disagree with itself. Either way the answer is a NEW batch,
       * which mirrors what the API accepts rather than discovering a 409.
       */
      let target = batch;
      if (!target || (target.status !== 'draft' && target.status !== 'paused')) {
        const created = await promptGenerationApi.createBatch('');
        target = created.batch;
      }
      const result = await promptGenerationApi.uploadFiles(target.id, selected);
      setOutcomes(result.outcomes);
      setBatch(result.batch);
      setSelected([]);
      if (fileInput.current) fileInput.current.value = '';
    });

  const start = () =>
    guarded(async () => {
      if (!batch) return;
      const result = await promptGenerationApi.start(batch.id);
      setBatch(result.batch);
      setConfirming(false);
    });

  const pause = () =>
    guarded(async () => {
      if (!batch) return;
      const result = await promptGenerationApi.pause(batch.id);
      setBatch(result.batch);
    });

  const retryFailed = () =>
    guarded(async () => {
      if (!batch) return;
      const result = await promptGenerationApi.retryFailed(batch.id);
      setBatch(result.batch);
    });

  const retryOneOutput = (outputId: string) =>
    guarded(async () => {
      await promptGenerationApi.retryOutput(outputId);
      if (batch) await loadBatch(batch.id);
    });

  const retryOneJob = (jobId: string) =>
    guarded(async () => {
      await promptGenerationApi.retryJob(jobId);
      if (batch) await loadBatch(batch.id);
    });

  return (
    <div className="mx-auto max-w-6xl px-6 py-8 text-neutral-200">
      <header className="mb-6">
        <h1 className="text-xl font-semibold text-white">Generation</h1>
        <p className="mt-1 text-sm text-neutral-400">
          Upload prompt files, generate images with Grok Imagine, and save them straight to Google
          Drive. Nothing here touches character content or anything the app publishes.
        </p>
      </header>

      {error && (
        <p
          role="alert"
          className="mb-4 rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-200"
        >
          {error}
        </p>
      )}

      {settings && (settings.xaiLive === false || settings.driveLive === false) && (
        <p className="mb-4 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
          {!settings.xaiLive && !settings.driveLive
            ? 'Test mode: image generation and Google Drive are both unconfigured, so nothing is generated for real and nothing is uploaded.'
            : !settings.xaiLive
              ? 'Test mode: image generation is unconfigured, so placeholder images are produced instead of real ones. Nothing is charged.'
              : 'Google Drive is not connected. Generated images would have nowhere to go, so batches cannot be started.'}
        </p>
      )}

      {/* ---------------- UPLOAD ---------------- */}
      <section aria-labelledby="upload-heading" className="mb-8">
        <h2 id="upload-heading" className="text-sm font-semibold text-neutral-200">
          Upload prompt files
        </h2>
        <p className="mt-1 text-xs text-neutral-500">
          One <code>.txt</code> file per prompt. The filename becomes the image name.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <input
            ref={fileInput}
            type="file"
            multiple
            accept=".txt,text/plain"
            aria-label="Prompt files"
            onChange={(event) => setSelected(Array.from(event.target.files ?? []))}
            className="text-sm text-neutral-300 file:mr-3 file:rounded-md file:border-0 file:bg-neutral-800 file:px-3 file:py-1.5 file:text-sm file:text-neutral-200"
          />
          <button
            type="button"
            onClick={upload}
            disabled={busy || selection.accepted.length === 0}
            className="rounded-md bg-rose-600 px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-40"
          >
            Add to queue
          </button>
        </div>
        {selected.length > 0 && (
          <>
            <p className="mt-2 text-xs text-neutral-400">{selection.message}</p>
            <ul className="mt-2 flex flex-wrap gap-1.5">
              {selection.accepted.map((file) => (
                <li
                  key={file.name}
                  className="rounded bg-neutral-800 px-2 py-0.5 text-[11px] text-neutral-300"
                >
                  {file.name}
                </li>
              ))}
            </ul>
          </>
        )}
        {outcomes.filter((o) => !o.accepted).length > 0 && (
          <ul className="mt-3 space-y-1">
            {outcomes
              .filter((o) => !o.accepted)
              .map((o) => (
                <li key={o.filename} className="text-xs text-amber-300">
                  {o.filename} — {o.message}
                </li>
              ))}
          </ul>
        )}
      </section>

      {/* ---------------- SETTINGS ---------------- */}
      {settings && (
        <section aria-labelledby="settings-heading" className="mb-8">
          <h2 id="settings-heading" className="text-sm font-semibold text-neutral-200">
            Settings
          </h2>
          <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
            <Setting label="Model" value={settings.model} />
            <Setting label="Images per prompt" value={`${settings.outputsPerPrompt} (fixed)`} />
            <Setting label="Aspect ratio" value={`${settings.params.aspectRatio} portrait`} />
            <Setting label="Resolution" value={settings.params.resolution.toUpperCase()} />
            <Setting label="Quality" value={settings.params.quality} />
            <Setting label="Google Drive folder" value={driveDestination(settings).label} />
            <Setting
              label="Google Drive"
              value={driveConnectionView(settings.driveConnection).label}
            />
          </dl>

          {/* ---------------- CONNECT GOOGLE DRIVE ---------------- */}
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={connectDrive}
              disabled={busy}
              className="rounded-md bg-neutral-100 px-3 py-1.5 text-sm font-semibold text-neutral-900 disabled:opacity-40"
            >
              {driveConnectionView(settings.driveConnection).action === 'connect'
                ? 'Connect Google Drive'
                : 'Reconnect Google Drive'}
            </button>
            {settings.driveConnection.source === 'oauth' && (
              <button
                type="button"
                onClick={disconnectDrive}
                disabled={busy}
                className="rounded-md border border-neutral-700 px-3 py-1.5 text-sm text-neutral-300 disabled:opacity-40"
              >
                Disconnect
              </button>
            )}
            {driveNotice && <span className="text-xs text-neutral-300">{driveNotice}</span>}
          </div>
          {/*
            SAID ON THE SCREEN, BECAUSE IT IS INVISIBLE EVERYWHERE ELSE. Google
            expires a refresh token after seven days for any app whose consent
            screen is still in "Testing" with an external user type, unless the
            only scopes are name/email/profile. `drive.file` is not among those,
            so a connection that dies every week is a publishing-status problem
            rather than a bug — and an operator would otherwise have no way of
            knowing that.
          */}
          <p className="mt-2 max-w-3xl text-xs text-neutral-500">
            Only the drive.file permission is requested, which lets this app reach the files it
            creates and nothing else in your Drive. While the Google consent screen is in
            &ldquo;Testing&rdquo;, Google expires the connection after 7 days — publish the consent
            screen to stop that.
          </p>
          {/*
            THE TRAP THAT COST TWO PRODUCTION ROUNDS, NAMED ON SCREEN. The scope
            is drive.file, so this app can write only to a folder it created
            itself. An operator who pastes in the id of a folder they made by
            hand gets a valid-looking setting and a 404 on every upload, with
            nothing anywhere to explain why. Saying it here is cheaper than
            diagnosing it a third time.
          */}
          {driveDestination(settings).warning && (
            <p className="mt-3 max-w-3xl text-xs text-amber-500">
              {driveDestination(settings).warning}
            </p>
          )}
          {/*
            The API's `quality` and the Grok web app's Quality control are not
            documented as the same thing. Saying so here means an operator
            comparing this output with the web app is not misled by the shared
            word.
          */}
          <p className="mt-3 max-w-3xl text-xs text-neutral-500">{settings.qualityNote}</p>
        </section>
      )}

      {/* ---------------- BATCH CONTROLS + COST ---------------- */}
      {batch && (
        <section aria-labelledby="batch-heading" className="mb-6">
          <h2 id="batch-heading" className="text-sm font-semibold text-neutral-200">
            {batch.name}
          </h2>
          <p className="mt-1 text-xs text-neutral-400">{batchSummary(batch)}</p>

          <p
            className={`mt-3 rounded-lg border px-3 py-2 text-sm ${
              isLargeBatch(batch.estimate)
                ? 'border-amber-500/50 bg-amber-500/10 font-semibold text-amber-200'
                : 'border-neutral-800 bg-neutral-900 text-neutral-300'
            }`}
          >
            Estimated cost: {costSentence(batch.estimate)}
            {settings && !settings.xaiLive && ' — nothing is charged in test mode'}
          </p>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            {batch.status === 'running' ? (
              <button
                type="button"
                onClick={pause}
                disabled={busy}
                className="rounded-md border border-neutral-700 px-3 py-1.5 text-sm text-neutral-200 disabled:opacity-40"
              >
                Pause
              </button>
            ) : confirming ? (
              <>
                {/*
                  A second click, not a first. A large paid batch must never be
                  one accidental button press away, and the total is repeated
                  here so the confirmation itself carries the number.
                */}
                <span className="text-sm text-amber-200">
                  Start and spend about {formatUsd(batch.estimate.totalUsd)}?
                </span>
                <button
                  type="button"
                  onClick={start}
                  disabled={busy}
                  className="rounded-md bg-rose-600 px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-40"
                >
                  Yes, start
                </button>
                <button
                  type="button"
                  onClick={() => setConfirming(false)}
                  className="rounded-md border border-neutral-700 px-3 py-1.5 text-sm text-neutral-300"
                >
                  Cancel
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => setConfirming(true)}
                disabled={busy || refusal !== null}
                title={refusalMessage ?? undefined}
                className="rounded-md bg-rose-600 px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-40"
              >
                Start generation
              </button>
            )}
            <button
              type="button"
              onClick={retryFailed}
              disabled={busy || batch.totals.failed === 0}
              className="rounded-md border border-neutral-700 px-3 py-1.5 text-sm text-neutral-200 disabled:opacity-40"
            >
              Retry failed
            </button>
            {refusalMessage && batch.status !== 'running' && (
              <span className="text-xs text-neutral-500">{refusalMessage}</span>
            )}
          </div>
        </section>
      )}

      {/* ---------------- QUEUE ---------------- */}
      <section aria-labelledby="queue-heading">
        <h2 id="queue-heading" className="text-sm font-semibold text-neutral-200">
          Queue
        </h2>
        {!batch || (batch.jobs ?? []).length === 0 ? (
          <p className="mt-3 text-sm text-neutral-500">
            No prompts queued yet. Upload some .txt files to begin.
          </p>
        ) : (
          <ul className="mt-3 divide-y divide-neutral-800 rounded-lg border border-neutral-800">
            {(batch.jobs ?? []).map((job) => (
              <QueueRow
                key={job.id}
                job={job}
                busy={busy}
                onRetryJob={() => retryOneJob(job.id)}
                onRetryOutput={retryOneOutput}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function Setting({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[11px] uppercase tracking-wide text-neutral-500">{label}</dt>
      <dd className="truncate text-neutral-200">{value}</dd>
    </div>
  );
}

function QueueRow({
  job,
  busy,
  onRetryJob,
  onRetryOutput,
}: {
  job: PromptJobView;
  busy: boolean;
  onRetryJob: () => void;
  onRetryOutput: (outputId: string) => void;
}) {
  return (
    <li className="px-3 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-neutral-100">{job.originalFilename}</p>
          <p className="mt-0.5 text-xs text-neutral-400">
            <span className={statusTone(job.status)}>{jobStatusLabel(job)}</span>
            <span className="text-neutral-600"> · </span>
            <span>{outputProgress(job)} in Drive</span>
          </p>
        </div>
        {job.status !== 'completed' && job.status !== 'queued' && (
          <button
            type="button"
            onClick={onRetryJob}
            disabled={busy}
            className="rounded border border-neutral-700 px-2 py-1 text-[11px] text-neutral-300 disabled:opacity-40"
          >
            Retry remaining
          </button>
        )}
      </div>
      {job.error && <p className="mt-1 text-xs text-rose-300">{job.error.message}</p>}
      <ul className="mt-2 space-y-1">
        {job.outputs.map((output) => (
          <OutputRow
            key={output.id}
            output={output}
            busy={busy}
            onRetry={() => onRetryOutput(output.id)}
          />
        ))}
      </ul>
    </li>
  );
}

function OutputRow({
  output,
  busy,
  onRetry,
}: {
  output: PromptOutputView;
  busy: boolean;
  onRetry: () => void;
}) {
  return (
    <li className="flex flex-wrap items-center gap-2 rounded bg-neutral-900/60 px-2 py-1.5 text-xs">
      <span className="font-mono text-neutral-300">{output.outputFilename}</span>
      <span className={outputTone(output.status)}>{outputStatusLabel(output.status)}</span>
      {output.driveWebViewLink && (
        <a
          href={output.driveWebViewLink}
          target="_blank"
          rel="noreferrer"
          className="text-rose-300 underline"
        >
          Open in Drive
        </a>
      )}
      {output.error && <span className="text-rose-300">{output.error.message}</span>}
      {canRetryOutput(output) && (
        <button
          type="button"
          onClick={onRetry}
          disabled={busy}
          className="ml-auto rounded border border-neutral-700 px-2 py-0.5 text-[11px] text-neutral-300 disabled:opacity-40"
        >
          {/*
            The label states the consequence. A Drive retry re-uploads bytes we
            already own; anything else pays for a new image, and an operator
            deciding whether to click deserves to know which.
          */}
          {retryCostsMoney(output) ? 'Generate again' : 'Retry upload'}
        </button>
      )}
    </li>
  );
}

function isActive(status: string): boolean {
  return status === 'queued' || status === 'generating' || status === 'uploading';
}

function statusTone(status: string): string {
  if (status === 'completed') return 'text-emerald-300';
  if (status === 'partial') return 'text-amber-300';
  if (status === 'failed') return 'text-rose-300';
  return 'text-neutral-300';
}

function outputTone(status: string): string {
  if (status === 'completed') return 'text-emerald-300';
  if (status === 'drive_upload_failed') return 'text-amber-300';
  if (status === 'failed') return 'text-rose-300';
  return 'text-neutral-400';
}

function messageOf(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  return 'Something went wrong.';
}
