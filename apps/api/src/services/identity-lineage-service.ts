import type { CharacterVisualIdentityRow } from '../db/schema.js';
import type { AssetRole, AssetWorkflow } from './asset-lifecycle.js';

/**
 * IDENTITY LINEAGE (P0.6) -- which identity version each asset was made
 * against, and how much of a character's content still sits on an older one.
 *
 * ── THE RELATIONSHIP ALREADY EXISTS ──────────────────────────────────────────
 *
 * `character_visual_assets.visual_identity_id` is NOT NULL with a foreign key
 * to `character_visual_identities`, written once when the asset is created --
 * from the character's ACTIVE version, or from the version a reference upload
 * names explicitly. `character_visual_identities` carries the version number
 * and its `draft` / `active` / `retired` status, with a partial unique index
 * guaranteeing exactly one active version per character.
 *
 * So this module ADDS NO SOURCE OF TRUTH. It reads the canonical one and says
 * what it means, because nothing surfaced it: the Character page showed no
 * version at all, and the review view showed an opaque uuid.
 *
 * ── THE TWO LIFECYCLES STAY SEPARATE ─────────────────────────────────────────
 *
 * Activating a new version retires the previous one and nothing else --
 * `activateVisualIdentityVersion` touches identity rows only. Approved and
 * released content keeps its binding, its workflow state and its distribution;
 * a redesign is not a moderation decision and never invalidates what exists.
 *
 * What an operator gains here is the ability to SEE that: "eight approved
 * clips, three of them live, were made against v1, which is retired." Acting
 * on that -- regenerating, retiring, or leaving it alone -- stays a human
 * decision, and this module offers no mechanism for any of them.
 */

/** One identity version, as every admin surface names it. */
export interface IdentityVersionRef {
  id: string;
  version: number;
  status: CharacterVisualIdentityRow['status'];
  label: string | null;
  /** True for the character's one active version. */
  active: boolean;
}

export function identityRefOf(row: CharacterVisualIdentityRow): IdentityVersionRef {
  return {
    id: row.id,
    version: row.version,
    status: row.status,
    label: row.label,
    active: row.status === 'active',
  };
}

/** How much content a version carries, by the P0.4 workflow it is in. */
export interface IdentityUsageCounts {
  total: number;
  pendingReview: number;
  approved: number;
  rejected: number;
  archived: number;
  /** Approved content actually reaching customers (the P0.5 model). */
  live: number;
  /** Identity references -- her portraits, which belong to the version itself. */
  references: number;
}

export interface IdentityVersionUsage extends IdentityVersionRef {
  counts: IdentityUsageCounts;
}

export interface IdentityLineage {
  /** The active version number, or null while she has none. */
  activeVersion: number | null;
  /** Every version, newest first, with what it carries. */
  versions: IdentityVersionUsage[];
  /**
   * Content made against a version that is NOT the active one. Counted only
   * where it matters operationally: approved content, and the subset of it
   * customers can see right now. Pending and rejected items on an old version
   * are not a lineage problem -- they are a review queue.
   */
  staleApproved: number;
  staleLive: number;
  /** Versions, other than the active one, that still carry approved content. */
  staleVersions: number[];
}

/** What the summary needs to know about one asset. Nothing more is read. */
export interface LineageAsset {
  visualIdentityId: string;
  workflow: AssetWorkflow;
  role: AssetRole;
  /** From the P0.5 distribution model: is it reaching customers right now? */
  live: boolean;
}

const emptyCounts = (): IdentityUsageCounts => ({
  total: 0,
  pendingReview: 0,
  approved: 0,
  rejected: 0,
  archived: 0,
  live: 0,
  references: 0,
});

/**
 * The lineage of one character, from the canonical version rows and her assets.
 *
 * PURE. Both inputs are already loaded by the caller that has them -- the
 * Character shelf reads assets and versions in the same pass -- so this adds no
 * query, and it can be tested without a database.
 *
 * An asset whose version is missing from `versions` cannot happen (the column
 * is NOT NULL with a foreign key), and is ignored rather than invented if it
 * somehow does: this read model never reports a version that does not exist.
 */
export function summariseIdentityLineage(
  versions: readonly CharacterVisualIdentityRow[],
  assets: readonly LineageAsset[],
): IdentityLineage {
  const byId = new Map<string, IdentityVersionUsage>();
  for (const row of versions) {
    byId.set(row.id, { ...identityRefOf(row), counts: emptyCounts() });
  }

  for (const asset of assets) {
    const usage = byId.get(asset.visualIdentityId);
    if (!usage) continue;
    const counts = usage.counts;
    counts.total += 1;
    if (asset.role === 'reference') counts.references += 1;
    switch (asset.workflow) {
      case 'pending_review':
        counts.pendingReview += 1;
        break;
      case 'approved':
        counts.approved += 1;
        if (asset.live) counts.live += 1;
        break;
      case 'rejected':
        counts.rejected += 1;
        break;
      case 'archived':
        counts.archived += 1;
        break;
    }
  }

  const ordered = [...byId.values()].sort((a, b) => b.version - a.version);
  const active = ordered.find((version) => version.active) ?? null;

  const stale = ordered.filter((version) => !version.active && version.counts.approved > 0);
  return {
    activeVersion: active?.version ?? null,
    versions: ordered,
    staleApproved: stale.reduce((n, version) => n + version.counts.approved, 0),
    staleLive: stale.reduce((n, version) => n + version.counts.live, 0),
    staleVersions: stale.map((version) => version.version),
  };
}
