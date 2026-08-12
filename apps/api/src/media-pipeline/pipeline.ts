import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CostLedger } from './cost-ledger.js';
import { qaImage, qaVideo, type QaReport } from './media-qa.js';
import { ProviderError, type MediaProviders } from './types.js';

/**
 * US-16E pipeline workflow over a per-character directory tree:
 *
 *   <root>/<character>/
 *     candidates/images/…      generated image candidates (never auto-promoted)
 *     candidates/videos/…      generated video candidates
 *     canonical/reference.jpg  the ONE selected canonical reference
 *     approved/…               QA-passed, human-approved finals (+ posters)
 *     run-record.json          auditable event log (see appendEvent)
 *
 * Candidates and approved assets are physically separated; approving never
 * overwrites an existing approved file (explicit --replace only), and a file
 * that fails technical QA can NOT be approved. Human review remains the final
 * authority for subjective quality — the pipeline records that decision, it
 * does not make it.
 */

export interface RunRecordEvent {
  at: string;
  runId: string;
  action:
    | 'generate_image'
    | 'generate_video'
    | 'generation_failed'
    | 'generation_refused'
    | 'select_canonical'
    | 'qa'
    | 'reject'
    | 'approve'
    | 'approve_refused';
  provider?: string;
  model?: string;
  prompt?: string;
  referenceImage?: string;
  file?: string;
  estimatedCostUsd?: number;
  cumulativeUsd?: number;
  reason?: string;
  qa?: QaReport;
}

export class PipelineRefusal extends Error {}

export class MediaPipeline {
  readonly characterDir: string;
  private readonly runId: string;

  constructor(
    root: string,
    private readonly character: string,
    private readonly providers: MediaProviders,
    private readonly ledger: CostLedger,
    private readonly characterBudgetUsd?: number,
    runId?: string,
  ) {
    if (!/^[a-z][a-z0-9-]{1,40}$/.test(character)) {
      throw new PipelineRefusal(`invalid character slug "${character}"`);
    }
    this.characterDir = join(root, character);
    this.runId = runId ?? `run-${Date.now().toString(36)}`;
    mkdirSync(join(this.characterDir, 'candidates', 'images'), { recursive: true });
    mkdirSync(join(this.characterDir, 'candidates', 'videos'), { recursive: true });
    mkdirSync(join(this.characterDir, 'approved'), { recursive: true });
  }

  // ── audit record ─────────────────────────────────────────────────────────
  private recordPath(): string {
    return join(this.characterDir, 'run-record.json');
  }

  appendEvent(event: Omit<RunRecordEvent, 'at' | 'runId'>): void {
    const path = this.recordPath();
    const events: RunRecordEvent[] = existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as RunRecordEvent[]) : [];
    events.push({ ...event, at: new Date().toISOString(), runId: this.runId });
    writeFileSync(path, `${JSON.stringify(events, null, 2)}\n`);
  }

  events(): RunRecordEvent[] {
    return existsSync(this.recordPath()) ? (JSON.parse(readFileSync(this.recordPath(), 'utf8')) as RunRecordEvent[]) : [];
  }

  // ── generation (budget-guarded) ──────────────────────────────────────────
  async generateImageCandidates(prompt: string, count: number, size = { width: 1080, height: 1920 }): Promise<string[]> {
    const written: string[] = [];
    for (let i = 0; i < count; i++) {
      const outputPath = join(this.characterDir, 'candidates', 'images', `${this.runId}-img-${String(i + 1).padStart(2, '0')}.jpg`);
      const request = { prompt, ...size, outputPath };
      const estimate = this.providers.image.estimateImageCost(request);
      const auth = this.ledger.authorize(estimate, this.character, this.characterBudgetUsd);
      if (!auth.ok) {
        this.appendEvent({ action: 'generation_refused', provider: this.providers.image.name, model: this.providers.image.imageModel, reason: auth.reason });
        throw new PipelineRefusal(`refused before paid call: ${auth.reason}`);
      }
      if (auth.softWarning) console.warn(`! ${auth.softWarning}`);
      try {
        const result = await this.providers.image.generateImage(request);
        const entry = this.ledger.record({
          runId: this.runId,
          character: this.character,
          provider: result.provider,
          model: result.model,
          operation: 'image',
          status: 'succeeded',
          unit: result.unit,
          quantity: result.quantity,
          unitCostUsd: result.unitCostUsd,
          estimatedCostUsd: result.estimatedCostUsd,
        });
        this.appendEvent({
          action: 'generate_image',
          provider: result.provider,
          model: result.model,
          prompt,
          file: outputPath,
          estimatedCostUsd: result.estimatedCostUsd,
          cumulativeUsd: entry.cumulativeUsd,
        });
        written.push(outputPath);
      } catch (err) {
        // Conservative accounting: a failed paid attempt still costs its estimate.
        const entry = this.ledger.record({
          runId: this.runId,
          character: this.character,
          provider: this.providers.image.name,
          model: this.providers.image.imageModel,
          operation: 'image',
          status: 'failed',
          unit: 'image',
          quantity: 1,
          unitCostUsd: estimate,
          estimatedCostUsd: estimate,
        });
        this.appendEvent({
          action: 'generation_failed',
          provider: this.providers.image.name,
          model: this.providers.image.imageModel,
          prompt,
          estimatedCostUsd: estimate,
          cumulativeUsd: entry.cumulativeUsd,
          reason: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    }
    return written;
  }

  selectCanonical(candidatePath: string, options?: { replace?: boolean }): string {
    if (!existsSync(candidatePath)) throw new PipelineRefusal(`candidate not found: ${candidatePath}`);
    const qa = qaImage(candidatePath);
    this.appendEvent({ action: 'qa', file: candidatePath, qa });
    if (!qa.pass) {
      throw new PipelineRefusal(`candidate failed technical image QA — cannot become canonical (${qa.checks.filter((c) => !c.ok).map((c) => c.name).join(', ')})`);
    }
    const target = join(this.characterDir, 'canonical', 'reference.jpg');
    if (existsSync(target) && !options?.replace) {
      throw new PipelineRefusal('canonical reference already exists — pass --replace to change it deliberately');
    }
    mkdirSync(join(this.characterDir, 'canonical'), { recursive: true });
    copyFileSync(candidatePath, target);
    this.appendEvent({ action: 'select_canonical', file: target, referenceImage: candidatePath });
    return target;
  }

  canonicalPath(): string {
    return join(this.characterDir, 'canonical', 'reference.jpg');
  }

  async generateVideoCandidates(
    prompt: string,
    count: number,
    options: { durationSeconds?: number; resolution?: '480p' | '720p' | '1080p' } = {},
  ): Promise<string[]> {
    const reference = this.canonicalPath();
    if (!existsSync(reference)) {
      throw new PipelineRefusal('no canonical reference selected — run select-canonical first (video identity is anchored to the canonical still)');
    }
    const durationSeconds = options.durationSeconds ?? 5;
    const resolution = options.resolution ?? '1080p';
    const written: string[] = [];
    for (let i = 0; i < count; i++) {
      const outputPath = join(this.characterDir, 'candidates', 'videos', `${this.runId}-vid-${String(i + 1).padStart(2, '0')}.mp4`);
      const request = { referenceImagePath: reference, prompt, durationSeconds, resolution, outputPath };
      const estimate = this.providers.video.estimateVideoCost(request);
      const auth = this.ledger.authorize(estimate, this.character, this.characterBudgetUsd);
      if (!auth.ok) {
        this.appendEvent({ action: 'generation_refused', provider: this.providers.video.name, model: this.providers.video.videoModel, reason: auth.reason });
        throw new PipelineRefusal(`refused before paid call: ${auth.reason}`);
      }
      if (auth.softWarning) console.warn(`! ${auth.softWarning}`);
      try {
        const result = await this.providers.video.imageToVideo(request);
        const entry = this.ledger.record({
          runId: this.runId,
          character: this.character,
          provider: result.provider,
          model: result.model,
          operation: 'video',
          status: 'succeeded',
          unit: result.unit,
          quantity: result.quantity,
          unitCostUsd: result.unitCostUsd,
          estimatedCostUsd: result.estimatedCostUsd,
        });
        this.appendEvent({
          action: 'generate_video',
          provider: result.provider,
          model: result.model,
          prompt,
          referenceImage: reference,
          file: outputPath,
          estimatedCostUsd: result.estimatedCostUsd,
          cumulativeUsd: entry.cumulativeUsd,
        });
        written.push(outputPath);
      } catch (err) {
        const entry = this.ledger.record({
          runId: this.runId,
          character: this.character,
          provider: this.providers.video.name,
          model: this.providers.video.videoModel,
          operation: 'video',
          status: 'failed',
          unit: 'second',
          quantity: durationSeconds,
          unitCostUsd: estimate / durationSeconds,
          estimatedCostUsd: estimate,
        });
        this.appendEvent({
          action: 'generation_failed',
          provider: this.providers.video.name,
          model: this.providers.video.videoModel,
          prompt,
          referenceImage: reference,
          estimatedCostUsd: estimate,
          cumulativeUsd: entry.cumulativeUsd,
          reason: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    }
    return written;
  }

  reject(file: string, reason: string): void {
    if (!reason.trim()) throw new PipelineRefusal('a rejection requires a reason');
    this.appendEvent({ action: 'reject', file, reason });
  }

  /**
   * Technical QA + promotion. NEVER overwrites an existing approved asset
   * (explicit replace only), and refuses when technical QA fails. Extracts the
   * first frame as the matching poster (same dimensions by construction).
   * `humanApproval` documents WHO judged the subjective quality — the pipeline
   * refuses to approve without it.
   */
  approveVideo(candidatePath: string, options: { as?: string; replace?: boolean; humanApproval: string }): { video: string; poster: string; qa: QaReport } {
    if (!options.humanApproval?.trim()) {
      throw new PipelineRefusal('human approval attribution is required (--approved-by) — subjective quality is a human decision');
    }
    if (!existsSync(candidatePath)) throw new PipelineRefusal(`candidate not found: ${candidatePath}`);
    const name = options.as ?? 'hero';
    const video = join(this.characterDir, 'approved', `${name}.mp4`);
    const poster = join(this.characterDir, 'approved', `${name}.jpg`);
    if ((existsSync(video) || existsSync(poster)) && !options.replace) {
      this.appendEvent({ action: 'approve_refused', file: candidatePath, reason: `approved asset "${name}" already exists (no implicit overwrite)` });
      throw new PipelineRefusal(`approved asset "${name}" already exists — pass --replace to supersede it deliberately`);
    }
    const qa = qaVideo(candidatePath);
    this.appendEvent({ action: 'qa', file: candidatePath, qa });
    if (!qa.pass) {
      this.appendEvent({ action: 'approve_refused', file: candidatePath, reason: `technical QA failed: ${qa.checks.filter((c) => !c.ok).map((c) => c.name).join(', ')}` });
      throw new PipelineRefusal('candidate failed technical QA — it cannot become an approved asset');
    }
    copyFileSync(candidatePath, video);
    try {
      execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', video, '-frames:v', '1', '-q:v', '2', poster]);
    } catch {
      throw new ProviderError('output_missing', 'poster extraction failed');
    }
    const finalQa = qaVideo(video, poster);
    if (!finalQa.pass) {
      throw new PipelineRefusal('approved copy failed re-QA with poster — refusing');
    }
    this.appendEvent({
      action: 'approve',
      file: video,
      referenceImage: this.canonicalPath(),
      reason: `human approval by ${options.humanApproval}`,
      qa: finalQa,
    });
    return { video, poster, qa: finalQa };
  }
}
