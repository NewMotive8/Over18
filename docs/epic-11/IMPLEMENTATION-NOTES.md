# EPIC 11 — implementation notes

Engineering companion to `README.md` / `content-management-ux.html`. The design is
the UX authority; the repository is the technical authority.

## Recommended slice order

The design proposes building in this order, and the reasoning is load-bearing:

1. **Character Catalogue + Character Detail shell** (W02, W07) — the operational home.
2. **Character Media** (W09) — read-only first.
3. **Review Queue + Media Detail drawer** (W12, W11) — the receiving end of everything.
4. **Approval actions** — approve / reject, and the Approved ≠ Published distinction.
5. **Publishing / Activation** (W13) — with readiness checks.
6. **Visual Identity versioning** (W08) — highest-risk screen, deliberately late.
7. **Create Character wizard** (W03–W06) — thin orchestration of steps 2–6; earlier
   means building each step twice.
8. **Global Media Library, Today, Activity** (W01, W10, W14) — aggregations, built last
   because a dashboard can only summarise states that already exist.

**The Manual Generation Studio (W17–W21) slots after step 4**, because its entire
value depends on the review workflow existing to receive its output.

## Studio shape

Option **2b — a dedicated Studio destination — is the recommended shape**: one sidebar
entry between Media Library and Review Queue, with three tabs (Single job · Sequences ·
Runs). Entering from a character's Media tab opens the same screen pre-filled with that
character, which preserves the best property of the rejected character-scoped drawer
(option 2a) without losing a home for sequences and run history.

## Component inventory

New for the Studio: `JobComposer`, `CostEstimate`, `DestinationNotice`, `SequenceList`,
`SequenceStepRow`, `RunMonitor`, `RunSummary`.

Reused throughout: `StateBadge`, `MediaTile`, `ConfirmDialog`, `EmptyState`.

## Terminology

| Operator-facing | Internal / database |
|---|---|
| Primary | `is_canonical`, `canonical_asset_id` |
| Reference | non-primary reference asset |
| Pending review | `visual_asset_status = 'under_review'` |

Do not rename the database columns; do not surface them either.

## Sequences

A Generation Sequence is **an ordered list of Generation Jobs**. It is not a workflow
engine. Explicitly out of scope for EPIC 11: scheduling, recurrence, triggers, webhooks,
branching, IF/ELSE, loops, parallel branches, and visual workflow editing.

A step may consume supported output/reference context from the immediately prior step
where the generation engine supports it. That is the only dataflow permitted.

## Relationship to EPIC 10

EPIC 10 defines the underlying concepts (Visual DNA, Persona, character specification,
dossier, generation consuming the dossier). EPIC 11 provides the operator-facing
management experience over those concepts. EPIC 11 should expose EPIC 10's capabilities,
not reimplement them.
