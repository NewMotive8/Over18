import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * US-16E cost accounting with hard budget enforcement.
 *
 * One JSON ledger file tracks CUMULATIVE sprint spend across all runs and
 * characters. Every paid generation is authorized BEFORE the call and recorded
 * AFTER it. Conservative accounting: a failed paid attempt still records its
 * estimated cost (we never assume a failure was free).
 *
 * Limits (all configurable via env, in USD):
 *   MEDIA_SPRINT_CEILING  hard business ceiling            default 75
 *   MEDIA_HARD_STOP       enforcement stop (< ceiling)     default 60
 *   MEDIA_SOFT_WARN       warning threshold                default 40
 * plus an optional PER-RUN character budget (e.g. $5 for the US-36 pilot)
 * passed explicitly — never hard-coded.
 *
 * SECRETS: the ledger stores provider/model/cost data only. No credentials,
 * no headers, no prompts-with-keys. Tests assert the API key never appears.
 */

export interface LedgerEntry {
  at: string; // ISO timestamp
  runId: string;
  character: string;
  provider: string;
  model: string;
  operation: 'image' | 'video';
  status: 'succeeded' | 'failed';
  unit: 'image' | 'second';
  quantity: number;
  unitCostUsd: number;
  estimatedCostUsd: number;
  cumulativeUsd: number; // sprint cumulative AFTER this entry
}

export interface LedgerFile {
  sprintCeilingUsd: number;
  hardStopUsd: number;
  softWarnUsd: number;
  entries: LedgerEntry[];
}

export interface AuthorizationResult {
  ok: boolean;
  reason?: string;
  softWarning?: string;
  cumulativeUsd: number;
  characterSpentUsd: number;
}

/**
 * Money is compared in integer MICRO-DOLLARS to avoid IEEE-754 drift. In
 * floating point `0.275 + 0.025 === 0.30000000000000004`, which would refuse a
 * legitimate request landing exactly on a $0.30 budget. Costs are still stored
 * and displayed as USD numbers; ONLY the enforcement comparisons run on exact
 * integers. Rounding to the nearest micro-dollar (6 decimals — far finer than a
 * cent) is deterministic and is NOT an arbitrary tolerance: a request that
 * genuinely exceeds a limit by >= $0.000001 still refuses. Each operand is
 * rounded independently so accumulated float drift in the running total can
 * never tip an exact-boundary request over.
 */
const MICROS_PER_USD = 1_000_000;
function toMicros(usd: number): number {
  return Math.round(usd * MICROS_PER_USD);
}
/** True when `spent + cost` strictly exceeds `limit`, computed on exact integers. */
function exceedsLimit(spentUsd: number, costUsd: number, limitUsd: number): boolean {
  return toMicros(spentUsd) + toMicros(costUsd) > toMicros(limitUsd);
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number, got "${raw}"`);
  }
  return value;
}

export class CostLedger {
  private data: LedgerFile;

  constructor(
    private readonly filePath: string,
    limits?: { sprintCeilingUsd?: number; hardStopUsd?: number; softWarnUsd?: number },
  ) {
    const sprintCeilingUsd = limits?.sprintCeilingUsd ?? envNumber('MEDIA_SPRINT_CEILING', 75);
    const hardStopUsd = limits?.hardStopUsd ?? envNumber('MEDIA_HARD_STOP', 60);
    const softWarnUsd = limits?.softWarnUsd ?? envNumber('MEDIA_SOFT_WARN', 40);
    if (!(softWarnUsd <= hardStopUsd && hardStopUsd <= sprintCeilingUsd)) {
      throw new Error(
        `Budget limits must satisfy softWarn <= hardStop <= ceiling (got ${softWarnUsd}/${hardStopUsd}/${sprintCeilingUsd}).`,
      );
    }
    if (existsSync(filePath)) {
      this.data = JSON.parse(readFileSync(filePath, 'utf8')) as LedgerFile;
      // Limits in the file are informational; current env/args win but never loosen history.
      this.data.sprintCeilingUsd = sprintCeilingUsd;
      this.data.hardStopUsd = hardStopUsd;
      this.data.softWarnUsd = softWarnUsd;
    } else {
      this.data = { sprintCeilingUsd, hardStopUsd, softWarnUsd, entries: [] };
    }
  }

  get cumulativeUsd(): number {
    return this.data.entries.reduce((sum, e) => sum + e.estimatedCostUsd, 0);
  }

  characterSpentUsd(character: string): number {
    return this.data.entries
      .filter((e) => e.character === character)
      .reduce((sum, e) => sum + e.estimatedCostUsd, 0);
  }

  /**
   * MUST be called before every paid generation. Refuses when:
   * - the estimate is not a positive finite number (unknown cost is never $0);
   * - the sprint hard stop would be crossed;
   * - the supplied per-character budget would be crossed.
   * Emits a soft warning once spend (including this call) exceeds MEDIA_SOFT_WARN.
   */
  authorize(estimatedCostUsd: number, character: string, characterBudgetUsd?: number): AuthorizationResult {
    const cumulativeUsd = this.cumulativeUsd;
    const characterSpentUsd = this.characterSpentUsd(character);
    if (!Number.isFinite(estimatedCostUsd) || estimatedCostUsd <= 0) {
      return {
        ok: false,
        reason: `estimated cost is unknown or invalid (${estimatedCostUsd}) — refusing; unknown cost is never treated as free`,
        cumulativeUsd,
        characterSpentUsd,
      };
    }
    if (characterBudgetUsd !== undefined) {
      if (!Number.isFinite(characterBudgetUsd) || characterBudgetUsd <= 0) {
        return { ok: false, reason: `invalid character budget (${characterBudgetUsd})`, cumulativeUsd, characterSpentUsd };
      }
      if (exceedsLimit(characterSpentUsd, estimatedCostUsd, characterBudgetUsd)) {
        return {
          ok: false,
          reason: `character budget would be exceeded: spent $${characterSpentUsd.toFixed(3)} + $${estimatedCostUsd.toFixed(3)} > $${characterBudgetUsd.toFixed(2)}`,
          cumulativeUsd,
          characterSpentUsd,
        };
      }
    }
    if (exceedsLimit(cumulativeUsd, estimatedCostUsd, this.data.hardStopUsd)) {
      return {
        ok: false,
        reason: `sprint HARD STOP: $${cumulativeUsd.toFixed(2)} + $${estimatedCostUsd.toFixed(3)} > $${this.data.hardStopUsd.toFixed(2)} (ceiling $${this.data.sprintCeilingUsd.toFixed(2)})`,
        cumulativeUsd,
        characterSpentUsd,
      };
    }
    const softWarning = exceedsLimit(cumulativeUsd, estimatedCostUsd, this.data.softWarnUsd)
      ? `soft warning: sprint spend $${(cumulativeUsd + estimatedCostUsd).toFixed(2)} exceeds $${this.data.softWarnUsd.toFixed(2)}`
      : undefined;
    return { ok: true, softWarning, cumulativeUsd, characterSpentUsd };
  }

  /** Records a generation attempt (success OR failure — failures still cost). */
  record(entry: Omit<LedgerEntry, 'at' | 'cumulativeUsd'>): LedgerEntry {
    if (!Number.isFinite(entry.estimatedCostUsd) || entry.estimatedCostUsd <= 0) {
      throw new Error('refusing to record an entry with unknown/invalid cost');
    }
    const full: LedgerEntry = {
      ...entry,
      at: new Date().toISOString(),
      cumulativeUsd: this.cumulativeUsd + entry.estimatedCostUsd,
    };
    this.data.entries.push(full);
    this.save();
    return full;
  }

  summary(): { cumulativeUsd: number; hardStopUsd: number; softWarnUsd: number; sprintCeilingUsd: number; entries: number } {
    return {
      cumulativeUsd: this.cumulativeUsd,
      hardStopUsd: this.data.hardStopUsd,
      softWarnUsd: this.data.softWarnUsd,
      sprintCeilingUsd: this.data.sprintCeilingUsd,
      entries: this.data.entries.length,
    };
  }

  private save(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, `${JSON.stringify(this.data, null, 2)}\n`);
  }
}
