# EPIC 11 — AI Creator Content Operations · UX handoff

Approved UX baseline for EPIC 11 (US-99 … US-110).
Epic card: https://trello.com/c/oaJn6cX9/227-epic-11-ai-creator-content-operations

## How to read this

`content-management-ux.html` in this directory is the canonical, visual handoff.
It is a **JavaScript-rendered** page: opening it with a plain file read or `curl`
returns only "This page requires JavaScript to display" and roughly 75 characters
of text. Open it in a browser, or render it headless, to see the wireframes.

Because several tickets instruct implementers to fall back to this README when the
HTML cannot be rendered visually, the **full text of the rendered design is
reproduced verbatim below**. It is a mechanical extraction of the rendered page —
nothing has been added, removed or reinterpreted. Where the two disagree, the HTML
wins.

## Wireframe index

W01 Today / Dashboard · W02 Character Catalogue · W03–W06 Create Character wizard ·
W07 Character Detail Overview · W08 Visual Identity · W09 Character Media ·
W10 Global Media Library · W11 Media Detail / Review drawer · W12 Review Queue ·
W13 Publishing / Activation · W14 Activity · W15–W16 supporting states ·
**W17 Studio — Single job · W18 Studio — Sequences · W19 Sequence builder ·
W20 Run monitor · W21 Failure / budget states**

## Non-negotiables carried into implementation

1. A generated asset **always** lands as `under_review`, attributed to the
   character's active identity version — never approved, never Primary. The Studio
   has no approve action anywhere; it hands off to the Review Queue (W12) and stops.
2. Parameters unsupported by the selected model are refused **locally, before any
   paid call**, with the reason shown.
3. Cost unknown is a **hard error, never $0.00**.
4. Operator-facing terminology is **Primary**, never "canonical", regardless of
   internal database column names.

---

# Rendered design — full text

2
Manual Generation Studio — where the operator makes new media. Two shapes for the studio, then the screens.

This answers OD-3 from turn 1 in the affirmative: operators can trigger generation. So the design has to carry the two things that make it dangerous — cost and content state — on every screen, and it must not become a workflow engine.

Non-negotiable rule that shapes everything below: a generated asset always lands as under_review, attributed to the character's active identity version, never approved, never Primary. The Studio has no approve action anywhere. It hands off to the Review Queue W12 and stops. Generation and approval stay two different jobs done by the same person at different times.

Explicitly out of scope this sprint, and stated as such in the UI so nobody looks for it: scheduling · recurring runs · triggers · branching · conditional logic · loops · parallel execution · workflow editing beyond reorder/remove · budget administration · multi-role approval. A sequence is an ordered list of generation steps. Nothing else.
2a
Contextual composer — a drawer launched from the character, no new destination
Over18 Admin
Characters / Maria / Media
Maria
Media · 18 assets
Character context is implicit — never picked, never picked wrong.
Generate for Maria
✕
Image
Video
Run a sequence
Prompt
Reference
◆ Primary 1 ▾
Size
1080 × 1920 ▾
ESTIMATED COST
$0.04
1 image · runpod · sdxl-turbo
Lands as pending review on identity v2, rated as set below. It will appear in the Review Queue.
Generate · $0.04
Cancel
Rating: Safe ▾
Trade-off. Fastest path for "one more image of Maria", zero new navigation, character and identity version can't be chosen wrongly. But saved sequences have no home — you can run one, not find, build or manage them — and cross-character work means opening four characters. Right for single jobs, wrong for the sequence half of the brief.
2b
Dedicated Studio destination, three modes —
recommended
Over18 Admin
Studio
Today
Characters
Media Library
Studio
Review Queue
9
Activity
Studio
manual generation · everything lands in review
Single job
Sequences 4
Runs 2 active
Character
Maria ● LIVE ▾
identity v2 active — used for this job
Job type
Image
Video
Prompt
Presentation only — clothing, pose, lighting, scene. Identity comes from v2 and the reference; don't re-describe her face.
Reference image
◆ Primary 1 ▾
Dimensions
1080 × 1920 ▾
Content rating
Safe ▾
PROVIDER
runpod · sdxl-turbo
Same models and parameters the automated system uses. change
Run job · $0.04
Save as sequence step
Runs once. No scheduling.
BEFORE YOU RUN
ESTIMATED COST
$0.04
1 image @ $0.04. Priced before the call — an unknown price is an error, never zero.
WHERE IT GOES
→ Maria's Media, identity v2
→ Pending review
→ Review Queue (9 → 10)

It is not approved, not Primary and not visible to users.
RECENT RUNS
✓ Maria · 3 images · $0.12 · 2h
✓ Sage · "portrait set" · $0.31 · Thu
✕ Ember · video · refused (budget)
Why this one. Three modes, one destination: Single job, Sequences (find / run / build) and Runs (what's happening now). Sequences and run history get a real home, cross-character work is one screen, and the cost + destination rail is always in view. Entering from a character's Media tab opens this same screen with the character pre-filled — so it keeps 2a's best property instead of trading it away.
W17
Studio — Single job (video variant)
— the image variant is 2b above
Single job
Sequences
Runs
Character
Maria ▾
Job type
Image
Video
Video is always made from a still. Identity consistency is anchored by image-to-video, never text-to-video — so a source image is required, not optional.
Source image *
◆ 1
◆ 2
APPR
Any approved image on Maria — Primary references first, then other approved stills. Pending and rejected images can't be used as a source: an unreviewed frame would put unreviewed content into a new asset.
Motion prompt
Describe movement, not appearance. Max 2000 characters.
Duration
6 s ▾
2–15 s
Resolution
480p
720p
1080p
Content rating
Explicit 18+ ▾
PROVIDER
runpod · wan-i2v-720p
1080p at 15 s is not supported by this model — the option disables itself with that reason.
Run job · $0.42
Save as sequence step
ESTIMATED COST
$0.42
6 s @ $0.07/s · recalculates as you change duration or resolution.
WHERE IT GOES
→ Maria's Media, identity v2
→ Pending review, tagged 18+
→ Review Queue
Source & History for the new asset is recorded automatically: character, identity version, source image, prompt, provider, model, duration, resolution, cost, who ran it, when.
Purpose
Run one generation job by hand, with the same models and parameters the automated system uses.
Entry
Sidebar → Studio; "Generate media" on a character's Media tab (character pre-filled); "run again" from a past run.
Primary action
Run job — the button always states the price. Secondary: save as a sequence step; change provider; switch job type.
Must see
Cost before running · which identity version will be used · that the result lands pending review · the content rating being applied.
States
No character selected (form disabled with "pick a character") · character has no active identity (blocked: "Maria has no active Visual Identity — generation has nothing to condition on", link to W08) · no approved source image for video (blocked, link to Review Queue) · parameter unsupported by model (option disabled with the reason, refused locally before any paid call) · running (see W20) · budget refused (see W21) · provider error (see W21) · cost unknown → hard error, never $0.00.
W18
Studio — Sequences, and running a saved one
Single job
Sequences 4
Runs
Saved sequences
Search…
+ New sequence
Portrait set
4 STEPS
3 images + 1 video · any character · last run Thu · $0.54 est.
▶
step 4 uses step 1's output
Run…
Edit
Duplicate
Launch pack — new character
6 STEPS
6 images · any character · never run · $0.24 est.
The set every new character needs before she can go live. Run it once on a draft character, review, mark one Primary.
Run…
Edit
Run "Portrait set"
4 steps, run in order, one at a time.
For which character?
Sage ● LIVE ▾
identity v1 active · Primary 1 will be the reference
1
Image · portrait, soft light
$0.04
2
Image · full length, street
$0.04
3
Image · close crop, evening
$0.04
4
Video · 6 s, 720p — from step 1
$0.42
TOTAL ESTIMATE
$0.54
All 4 assets land as pending review on Sage's identity v1. Nothing is published.
Runs once, now.
Cancel
Run 4 steps · $0.54
Purpose
Find a saved sequence and run it against a chosen character.
Entry
Studio tab; "run a sequence" from a character; after saving a new sequence.
Primary action
Run… → pick character → confirm with the total. Secondary: new, edit, duplicate, delete, search.
Must see
Step count and composition, total estimate, and which character the run will target — the one thing that changes per run.
States
Empty ("no sequences yet — build one from an ordered list of jobs") · sequence invalid for the chosen character (e.g. a video step needs an approved source and she has none → that step shows ✕ and the run button says "1 step can't run: fix or skip") · deleting a sequence never touches assets it produced · a run already in progress for that character → warn, allow queueing after.
W19
Sequence builder
— an ordered list, deliberately not a canvas
Portrait set
4 steps · $0.54 estimated · not character-specific
Cancel
Save sequence
1
⠿
IMAGE
portrait, soft light
$0.04
reference: ◆ Primary 1 · 1080×1920 · rating: safe · runpod / sdxl-turbo
Edit
Duplicate
Remove
2
⠿
IMAGE
full length, street
$0.04
reference: ◆ Primary 1 · 1080×1920 · rating: safe · runpod / sdxl-turbo
3
⠿
IMAGE
close crop, evening
$0.04
4
⠿
VIDEO
slow turn, soft smile
$0.42
Source image
↑ Output of step 1 ▾
Duration / resolution
6 s · 720p ▾
The one dependency the builder allows. A video step's source can be an earlier step's output or an existing approved image. That is the whole of "step ordering matters" — no other step can read another step's result, and there is no branching, no condition, no loop.
Add step:
+ Image
+ Video
Max 12 steps.
SEQUENCE ESTIMATE
$0.54
3 images @ $0.04 · 1 video @ $0.42. Per run, per character.
HOW A SEQUENCE BEHAVES
· Steps run in order, one at a time
· A step is not character-specific — you pick the character at run time
· "◆ Primary 1" resolves to whichever image is Primary for that character
· A failed step stops the run; earlier assets are kept and still go to review
· Every produced asset lands pending review
Deliberately absent: triggers, schedules, conditions, retries-with-variation, parallel steps, sub-sequences, variables. If a step needs judgement, that judgement belongs to the operator at run time.
Purpose
Save a repeatable ordered list of generation jobs — the sets an operator runs over and over.
Entry
Sequences → New; "save as sequence step" from a single job; Edit / Duplicate on an existing sequence.
Primary action
Save sequence. Secondary: add / edit / duplicate / remove step, drag to reorder, rename.
Information hierarchy
Ordinal → job type → prompt summary → resolved parameters in one monospace line → cost. Steps read as a list, top to bottom, because that is exactly how they execute.
States
Empty (one dashed "add step" affordance, nothing else) · unsaved changes (leave → confirm) · invalid step (missing prompt or source → step marked ✕, save allowed, run blocked) · a step whose source references a removed step (auto-falls back to "Primary 1" with a visible notice) · editing a sequence that is mid-run (read-only until the run ends) · 12-step cap reached.
W20
Run monitor
Single job
Sequences
Runs
RUNNING — "PORTRAIT SET" ON SAGE
step 2 of 4 · $0.08 spent of $0.54 est.
Stop after this step
1
Image · portrait, soft light
⏱ PENDING REVIEW
$0.04
2
···
Image · full length, street
GENERATING
$0.04
3
Image · close crop, evening
QUEUED
$0.04
4
Video · 6 s, 720p — from step 1
QUEUED
$0.42
Assets appear in review as each step finishes, not at the end — a stopped or failed run still hands over everything it produced. Leaving the page doesn't cancel the run; the Runs tab and a sidebar indicator carry it.
EARLIER RUNS
Maria
Single job · image
2h ago
$0.04
✓ 1 in review
Run again
Sage
"Portrait set"
Thu
$0.54
✓ 4 in review
Run again
Ember
Single job · video
Wed
$0.00
✕ refused
Details
Purpose
Show what is generating right now, what it has cost so far, and where the results went.
Entry
Automatically after starting a run; Studio → Runs; sidebar running indicator.
Primary action
Watch, or stop after this step — the honest control, since a call in flight is already paid for. Secondary: open a produced asset; run again; view details of a failure.
Must see
Which step is running, spend so far vs estimate, and that finished assets are already pending review.
States
Queued · generating · succeeded (with the resulting thumbnail and PENDING REVIEW badge) · failed (step marked, remaining steps cancelled, reason in plain words) · stopped by operator · budget refused (nothing spent, $0.00) · run history empty · two concurrent runs (allowed; a third queues).
W21
Handoff to review, and the failure states
Run complete — the handoff
4 assets created for Sage
All 4 are pending review on identity v1 and are already in the Review Queue. None is approved, none is Primary, none is visible to users.
▶
Review these 4 now
Open Sage's media
Total $0.54
"Review these 4 now" opens the Review Queue W12 filtered to this run, entering the drawer W11 in sequence with the usual A / R / S keys. Generation and approval remain separate acts — the Studio never approves, and the reviewer sees the same Source & History as any other asset.
Effect on the rest of the admin: Review Queue count rises · the character's Media tab gains 4 pending tiles · Needs Attention will flag them after 48 h W14 · Activity records the run, the operator, the cost and the assets W01.
Failures, in the operator's language
Run refused — budget
"This run would cost $0.42 and Ember has $0.18 left of her generation budget. Nothing was spent." → Reduce duration · Choose 480p · Ask for more budget. Refused locally, before any paid call.
Parameter not supported
"This model can't do 15 s at 1080p. Longest at 1080p is 8 s." Shown as a disabled option with the reason, so it can't be submitted at all.
Provider failed
"The image service didn't respond. Nothing was created and you weren't charged for step 3." → Retry step · Stop run. One plain sentence per failure kind — auth, network, service error, unusable response, unverified output — never a status code or an error enum.
Blocked before you start
"Luna has no active Visual Identity — there's nothing to keep her looking consistent." · "Sage has no approved image to animate." Both link straight to the fix, and the Run button stays disabled with that reason on hover.
Rule. Every failure message says three things: what happened, whether money was spent, and what to do next. The operator should never need to ask a developer to interpret a generation failure — that is the same standard as the rest of the epic.
Where this lands in the plan, and what it needs decided
IA change: one new sidebar destination, Studio, between Media Library and Review Queue, with three tabs (Single job · Sequences · Runs). Character Detail's "Generate media" button now opens Studio pre-filled instead of being deferred.
Implementation slot: after slice 5 (approval actions), because the Studio's entire value depends on the review workflow existing to receive its output. Build order within it: single image job → single video job → run monitor → sequence run → sequence builder.
New components: JobComposer · CostEstimate · DestinationNotice · SequenceList · SequenceStepRow · RunMonitor · RunSummary. Everything else is reused: StateBadge, MediaTile, ConfirmDialog, EmptyState.
NEW OPEN DECISIONS
GD-1 · Whose budget, and is it visible? The design shows a per-character remaining budget and refuses locally when a run would exceed it. Confirm the budget is per character (not per operator or per month) and that operators may see the number. Advanced budget administration is out of scope — this is display plus refusal only.
GD-2 · Can an operator choose the provider/model, or is it fixed? Shown as changeable but pre-set to the same bundle the automated system uses. Locking it removes a whole class of "why does this look different" support questions; exposing it helps comparison work.
GD-3 · Are sequences shared or personal? Assumed shared across all operators, since there is one role. If sequences should be private drafts, the list needs an owner column and a share action.
GD-4 · Explicit-rated generation — any pre-flight gate? The design lets an operator set Explicit on a job and relies on downstream review. If policy needs an acknowledgement before generating adult content, it belongs on the Run button, not in the review step.

Try next: "go with 2b and start building W17" · "drop the sequence builder to 6 steps max" · "show the Studio with the character-scoped entry from 2a".

1
Character Detail — three structures. This is the screen everything else hangs off, so it goes first.

Grounded in the real codebase (apps/api/src/db/schema.ts): a character has one active visual identity version (DB-enforced), identities are draft / active / retired, assets are generated → under_review → approved / rejected with is_canonical and content_rating flags. The public API only ever projects the active identity + approved primary references — which is exactly why Approved ≠ Published. The wireframes below make that derivation visible instead of leaving it in the query layer.

Operator language vs data-model language. The UI says Primary for the main approved visual reference — the data model stores it as is_canonical, and that name stays in the code. Likewise the operator sees Source & History where the schema calls it provenance. The words "canonical" and "provenance" never appear in operator-facing UI.

STATE BADGE VOCABULARY — used identically on every screen
● LIVE
exposed to users
READY
complete, not activated
DRAFT
incomplete
PAUSED
was live, withdrawn
◆ PRIMARY
the main approved reference
⏱ REVIEW
EXPLICIT
never subtle — red bar, always
⚠ ATTENTION
1a
Tabbed detail — the brief's suggested shape
Over18 Admin
Characters / Maria
operator@over18
MANAGE
Today
Characters
Media Library
Review Queue
7
Activity
canon.
Maria
● LIVE
maria · updated 2d ago
Edit
Deactivate
Overview
Persona
Visual Identity
Media 18
Publishing
IDENTITY
v2 · active
3 primary references
MEDIA
18 assets
11 approved · 2 pending
PUBLISHED
3 assets live
from identity v2
primary ref 01
primary ref 02
primary ref 03
+ add reference
RECENT ACTIVITY
Trade-off. Cheapest to build and familiar. But readiness and the publish action live inside the Publishing tab — the operator's most important question ("is she safe/complete right now?") is one click away on every other tab, and warnings can be missed entirely.
1b
Tabs + persistent readiness rail —
recommended
Over18 Admin
Characters / Maria
operator@over18
MANAGE
Today
Characters
Media Library
Review Queue
7
Activity
CHARACTERS
Maria
Luna
⚠
Ember
Sage
canon.
Maria
● LIVE
maria · identity v2 · updated 2d ago by operator@over18
Overview
Persona
Visual Identity v2
Media 18
Publishing
History
WHAT USERS SEE RIGHT NOW
hero / canon 01
◆ PRIMARY
the main approved reference
canon 02
◆ PRIMARY
the main approved reference
canon 03
◆ PRIMARY
the main approved reference
These 3 assets are the character's published surface: approved primary references on the active identity v2. Nothing else reaches users.
Preview as user →
PERSONA
Warm, playful, direct
art
travel
music
MEDIA BREAKDOWN
11
approved
2
pending
4
generated
1
rejected
PUBLICATION
● LIVE
since 12 Aug
In the live catalogue. Visible in Discover, Swipe and chat.
READINESS
✓
Profile & persona complete
✓
Visual Identity v2 active
✓
3 primary references approved
⚠
2 assets awaiting review
Review
Deactivate character
QUICK ACTIONS
Upload reference asset
New identity version
Edit persona
Why this one. The rail keeps publication state, readiness and the safe/destructive action pinned no matter which tab is open, and "What users see right now" answers the epic's core question — what content is currently exposed? — before any tab is touched. Cost: ~250px of width, so admin is desktop-only (fine; operators are at desks).
1c
Single-scroll object canvas — no tabs
Over18 Admin
Characters / Luna
ON THIS PAGE
Summary
Persona
Visual Identity
Reference assets
Generated media
Publishing
History
STATUS
DRAFT
Activate (blocked)
Luna
DRAFT
⚠ ATTENTION
Luna cannot go live yet
✕ No primary reference asset — upload one
✕ Visual Identity v1 is still a draft — activate version
✓ Profile & persona complete
SUMMARY
no primary
reference
VISUAL IDENTITY
v1 DRAFT
created 14 Aug
Visual DNA — 9 identity attributes recorded. Generation will use this version once activated.
REFERENCE ASSETS — empty
Drop images here, or browse. The first approved reference becomes primary.
Trade-off. Nothing is hidden and incomplete characters read beautifully — but for a healthy character with hundreds of assets the page becomes very long and media has to be truncated into "see all" links, which reintroduces tabs by another name. Best as the Draft-state presentation of 1b rather than the whole pattern.

Full deliverable — IA, lifecycle, flow, W01–W16 and the spec — is in the sections below, drawn using 1b. Try next: "go with 1b, but use 1c's blocked banner for drafts" · "show me the catalogue as a dense table instead of cards" · "start implementing W01–W02".

PART G+H · FIRST, BECAUSE EVERY SCREEN DEPENDS ON IT
Lifecycle & state model

The brief proposes six character states and five media states. The database today stores only active | inactive for characters. My recommendation is to keep it that way and derive the rest — a stored "Ready" flag goes stale the moment an asset is rejected, and a stored "Published" flag can silently disagree with what the API actually serves.

Character lifecycle — 2 stored states, 3 derived
Draft
→
Ready
→
Live
⇄
Paused
→
Retired
DRAFT
Derived. status=inactive, never activated, readiness fails. Only reachable place for a half-built character.
READY
Derived. status=inactive and all readiness rules pass. The Activate button becomes enabled — this is the only difference the operator sees.
LIVE
Stored: status='active'. Exactly what GET /api/characters returns today. No schema change.
PAUSED
Derived. status='inactive' after having been live. Distinguished from Draft by history, not by a new column — matters because pausing is reversible in one click and drafting is not.
RETIRED
Needs one new value. Permanently withdrawn, hidden from the default catalogue, records intact. The only schema addition I'd ask for. Deferrable past the PoC.
"Review" is deliberately not a character state. The brief's Inactive → Ready for Review → Ready to Publish → Active assumes a two-person approval chain. Review in this product happens on media assets, not on characters. Adding a character review state would force operators to advance a workflow that has no second actor. If a second role (approver) is ever introduced, insert it here — see Open Decision OD-2.
Media lifecycle — stored states already exist in the schema
Generated
or Uploaded
→
Under review
→
Approved
→
Published
derived
off-ramps →
Rejected
Retired
THE APPROVED / PUBLISHED DISTINCTION — READ FROM THE CODE

An asset is Published if and only if all four hold:

kind = 'reference'
status = 'approved'
is_canonical = true
visual_identity_id = the character's ACTIVE identity
…and the character is Live

That is precisely what the public visual-identity endpoint projects. So an approved generated video is approved but never published — correct, and today invisible. The UI states this in words on every asset instead of making the operator infer it.

Retired is the one media addition needed: withdraw an approved asset without rejecting it (rejection implies "bad", retirement implies "superseded"). Can be modelled as is_canonical=false + a retired flag.
Generated media never auto-promotes. Reaching Primary requires an explicit approve action that stamps approved_by / approved_at — already true in the schema; the UI must not offer a shortcut around it.
Content rating (sfw | explicit) is orthogonal to status and always rendered as a separate red bar, never merged into the status badge.
PART A · US-103
Recommended information architecture

The brief proposes Characters → All / Active / Inactive / Needs Attention as four nav items. At 5–20 characters that is four destinations that all render the same table. I recommend five top-level areas, with state as filters, and Needs Attention promoted to a signal that appears in three places rather than a page you must remember to visit.

Recommended
/admin
├── Today            operational overview · landing
├── Characters       catalogue
│     └── Character Detail  ← the operational home
│           Overview · Persona · Visual Identity
│           Media · Publishing · History
├── Media Library    every asset, every character
│     └── Media Detail      side drawer, not a page
├── Review Queue 7  one job: decide
└── Activity         who changed what, when
Characters vs Media is the top-level split — the two nav items are adjacent and never nest inside each other. Character Detail's Media tab is a filtered view of the same library, not a second system.
Review Queue is separate from Media Library even though it shows media. Different job: the library is for finding, the queue is for deciding, and it empties. A count badge in the sidebar is the epic's "what needs attention" answer at zero cost.
Activity replaces the developer's git log. It is how an operator answers "who deactivated Maria?" without a database.
Changes from the brief, and why
DROPPED
Active / Inactive / Needs Attention as nav items. They become persistent filter chips on the catalogue with counts. Same information, one destination, and the counts are visible without navigating.
RENAMED
Dashboard → Today. Signals "operational state right now", discourages it drifting into a charts page.
ADDED
Activity. Not in the brief but required by the epic's premise: replacing a deploy pipeline means replacing its audit trail too.
DEMOTED
Media Detail is a drawer, not a route. Review is a rapid sequence of decisions; a full page navigation per asset destroys the rhythm and loses grid scroll position. It keeps a deep-linkable URL.
SCOPED
Needs Attention lives in all three places the brief asks about — a Today block (triage), a catalogue filter chip + per-row flag (browse), and a banner on Character Detail (in context). One rules engine, three renderings.
Where the admin lives, relative to the existing app

The consumer app is a mobile-first shell (max-w-lg, zinc-950 / rose-500, three bottom-nav destinations). The admin is a separate desktop route tree at /admin with its own sidebar shell — it must not inherit the mobile bottom nav or the 512px column. It does inherit the existing type scale, radii, zinc surfaces and rose accent, so it reads as the same product's back office. Wireframes here are greyscale on purpose; the applied theme is the dark zinc surface used by AppShell.tsx, with rose reserved for destructive and explicit-content signalling only.

PART B
End-to-end user flow
TODAY  (landing — triage, never analytics)
  │
  ├─ "2 characters need attention" ──────────────┐
  ├─ "7 assets awaiting review" ─────────┐       │
  │                                      │       │
  ├─ CHARACTERS [W02]                     │       │
  │    │  filters: All · Live · Paused · Draft · ⚠ Needs attention ←──────┘
  │    │
  │    ├─ + CREATE CHARACTER  wizard, creates a DRAFT on step 1
  │    │     1 Basics [W03] → 2 Persona → 3 Visual Identity [W04]
  │    │       → 4 Reference assets [W05] → 5 Review [W06]
  │    │            │                                    │
  │    │            └─ "Save & finish later" ────────────┤
  │    │                                                 ▼
  │    └─ CHARACTER DETAIL [W07] ← the operational home
  │           ├─ Overview      what users see right now
  │           ├─ Persona       edit profile / conversation style
  │           ├─ Visual Identity [W08]  versions · Visual DNA · primary set
  │           │      └─ New version → draft → Activate version ⚠ confirm
  │           ├─ Media [W09]   filtered Media Library, scoped to character
  │           │      └─ MEDIA DETAIL drawer [W11] ─┐
  │           ├─ Publishing [W13]  readiness → Activate / Deactivate ⚠ [W15]
  │           └─ History      audit trail for this character
  │                                                      │
  ├─ MEDIA LIBRARY [W10] ────────────────────────────┤
  │     grid · filters: character · type · origin · state · rating
  │     └─ MEDIA DETAIL drawer [W11] ←───────────────┘
  │           actions: Approve · Reject · Make primary · Retire · Replace
  │
  ├─ REVIEW QUEUE [W12] ←──────────────────────────┘
  │     one asset at a time · keyboard A/R/S · ends empty
  │
  └─ ACTIVITY   who changed what, when — replaces the git log
Every loop closes on Character Detail. Approving an asset from the queue offers "back to queue" (default) and "open Maria". Finishing the wizard lands on Detail, not on the catalogue. Reactivating from the catalogue opens Detail's Publishing tab. There is no dead end where the operator must re-navigate from the sidebar.
Two irreversible-feeling actions get confirmation: character deactivation [W15] and activating a different identity version (it changes what every future generation looks like). Approving, rejecting and retiring media are all reversible and use an inline undo toast instead of a modal — modals on a review queue destroy throughput.
PART C + D
Wireframes W01–W16, with condensed spec

Each screen carries a spec strip: purpose · entry · primary action · must-see · states. Drawn at desktop 1180px. Greyscale is deliberate — structure and hierarchy first, product theme applied at build time.

W01
Today — admin landing
Over18 Admin
operator@over18
Today
Characters
Media Library
Review Queue
7
Activity
Today
Friday 15 August · catalogue healthy
+ New character
⚠ NEEDS ATTENTION — 3 ITEMS
Luna DRAFT
No primary reference — cannot go live
Add reference
Maria ● LIVE
2 videos awaiting review for 6 days
Review
Ember PAUSED
Visual Identity v2 draft incomplete — 4 attributes missing
Open v2
CATALOGUE
4 characters
2 LIVE
1 PAUSED
1 DRAFT
MEDIA
42 assets
31 approved · 7 pending · 4 retired
PUBLISHED TO USERS
7 assets live
Across 2 live characters. See exactly what users see →
RECENT ACTIVITY
09:14
Maria — video
gen_1841
approved by operator@over18
Thu
Luna — Visual Identity v2 created
Wed
Ember — deactivated (reason: identity rework)
Purpose
Answer "what needs me?" in under 5 seconds. Triage, not analytics.
Entry
Login; logo click; sidebar.
Primary action
Resolve an attention item. Secondary: new character.
Must see
Attention list above the counts — counts are context, not the job.
States
Empty ("Nothing needs attention — 4 characters healthy"); loading skeleton per block; per-block error that never blanks the page; zero-characters first-run → wizard CTA.
W02
Character catalogue
— media-led cards, because the operator recognises characters by face before name
Over18 Admin
Characters
Today
Characters
Media Library
Review Queue
7
Activity
Characters
Search…
+ New character
All 4
Live 2
Paused 1
Draft 1
⚠ Needs attention 3
grid ▮ / list ☰ · sort: updated
primary ref
● LIVE
Maria
identity v2 · 18 assets
3 ◆
2 ⏱
updated 2d ago
primary ref
● LIVE
Sage
identity v1 · 9 assets
2 ◆
updated 3w ago
primary ref
PAUSED
Ember
identity v1 active · v2 draft
⚠
v2 incomplete
paused 2d ago
no primary ref
DRAFT
Luna
identity v1 draft · 1 asset
⚠
No primary reference
created 1d ago
Fields deliberately NOT on the card: approved/pending counts as raw numbers for every state, publication date, provider, model, video counts. They are one click away on Detail. The card answers only: who, live or not, is anything wrong, and when did it last change.
Purpose
State of every character at a glance; route into Detail.
Entry
Sidebar; Today counts; post-wizard.
Primary action
Open a character. Secondary: new character, filter, search, switch to list view.
Must see
Face, name, live-or-not, warning flag. Attention cards get a dark border — visible even when scanning peripherally.
States
Empty first-run (illustrated CTA); filter-empty ("No paused characters" + clear filter); loading = 8 skeleton cards; missing image → initial-letter tile, never a broken image (matches CharacterCard.tsx behaviour); error = retry banner, filters stay usable.
W03
Create character — Step 1, Basics
Pattern decision: a guided wizard that creates a Draft on step 1 — not a single page, not a modal form. Three reasons, all structural rather than stylistic. (1) The data has a hard dependency order: an identity version needs a character row, and a visual asset needs an identity version (visual_identity_id NOT NULL). A single page would have to fake that ordering or defer all writes to one giant submit. (2) Onboarding is interruptible — sourcing reference imagery takes days; "Save & finish later" must be a first-class exit at every step, which means real persistence, which means a Draft. (3) It makes accidental publishing structurally impossible: the wizard has no activate action until step 5, and step 5's button is gated by the same readiness rules as Detail — one rules engine, not two. Steps 2–4 are skippable; only step 1 is mandatory.
1
Basics
2
Persona
3
Visual Identity
4
Reference assets
5
Review
Who is this character?
Saved as a draft the moment you continue. Nothing is visible to users until you activate her.
Display name *
Luna
Handle — unique, lowercase, permanent
luna
✓ available
Short bio * — shown on the discover card
96 / 160
LIVE PREVIEW — DISCOVER CARD
no image yet
Luna
The preview mirrors the real consumer card, so the operator sees the consequence of their copy without deploying anything.
Draft saved automatically · Save & finish later
Cancel
Continue →
Purpose
Create the character row; nothing more.
Entry
Today CTA; catalogue CTA; empty state.
Primary action
Continue (creates the Draft).
Must see
That this is a draft and users can't see it.
States
Handle taken (inline, blocking); required-field errors on continue not on blur; save-in-flight disables Continue; cancel with unsaved input → "discard draft?" confirm.
W04
Create character — Step 3, Visual Identity
✓ Basics
→
✓ Persona
→
Visual Identity
→ Reference assets → Review
What does Luna look like?
This is her Visual DNA — identity only. Clothing, pose, lighting and scene are decided per-generation and never stored here, so her face stays consistent across every image and video. Saved as identity v1 (draft).
Apparent age band *
adult (mid-20s) ▾
Must denote an adult. Non-adult values are rejected.
Version label
e.g. "launch look"
Face
Eyes
Hair
Skin
Body
Distinctive features
+ Add another identity attribute
IDENTITY vs PRESENTATION
Belongs here: face, eyes, hair colour & type, skin, body, marks, age band.

Does not belong here: hairstyle of the day, makeup, clothing, accessories, pose, expression, environment, lighting, camera, style. Those are typed into a generation prompt and stored on the resulting asset.
COMPLETENESS
5 of 9 attributes recorded. Only the age band is required — but a sparse Visual DNA produces inconsistent generations.
← Back · Save & finish later
Skip for now
Continue →
Purpose
Record Visual DNA as identity v1 (draft).
Entry
Wizard step 2; or Detail → Visual Identity → new version.
Primary action
Continue. The version is not activated here.
Must see
The identity/presentation rule, before typing "red dress" into Distinctive features.
States
Age band rejected as non-adult (blocking, explains why); skip → readiness later reports "no visual identity"; attribute list is open-ended and can grow.
W05
Create character — Step 4, Reference assets
✓ Basics
→
✓ Persona
→
✓ Visual Identity v1
→
Reference assets
→ Review
Primary references for identity v1
The trusted images that anchor Luna's appearance. Every future generation is conditioned on these, and these are the only images users ever see on her profile. At least one approved primary reference is required to go live.
luna-01.jpg
◆ PRIMARY 1
1024×1536 · sfw
luna-02.jpg
SUPPORTING
1024×1536 · sfw
luna-03.jpg
⏱ UPLOADING 64%
+
Drop or browse
Ordering matters. Drag to reorder — position 1 is the character's hero image on the discover card and profile. Primary vs supporting: primary references are used for generation conditioning and shown to users; supporting references inform generation but stay internal.
CONTENT RATING
Safe / reference
Explicit
18+
Applies to the selected asset. Explicit assets are tagged with a red bar everywhere they appear and are excluded from the discover surface.
Uploaded ≠ approved. A reference you upload here starts as under review. Marking it primary on step 5 records you as the approver.
← Back · Save & finish later
Skip for now
Continue →
Purpose
Attach and order the reference set for identity v1.
Entry
Wizard step 3; Detail → Visual Identity; attention item.
Primary action
Upload. Secondary: mark primary, reorder, set rating, remove.
Must see
Which image is position 1, and that uploads are not yet approved.
States
Empty (dashed dropzone, explains why one is required); uploading with progress + cancel; upload failed (retry, keeps the tile); unsupported type/size rejected before upload; storage unavailable → banner, wizard still continues.
W06
Create character — Step 5, Review & activate
— shown in the blocked state, which is the state that matters
Review Luna before she goes live
canon 1
NAME / HANDLE
Luna ·
luna
edit
BIO
PERSONA
Playful, curious · 3 interests ·
edit
VISUAL IDENTITY
v1
DRAFT
· 5 of 9 attributes
REFERENCES
2 uploaded ·
0 approved
NOT READY TO ACTIVATE
✓
Profile & persona complete
✓
Visual DNA recorded
✕
Visual Identity v1 is still a draft
Activate version v1
✕
No approved primary reference
Review 2 uploads
Activate Luna
Disabled until every ✕ is resolved. Hovering explains why rather than just greying out.
Save as draft & exit
Purpose
Last look; the only place in the wizard that can publish.
Entry
Step 4; or jumping ahead from the stepper.
Primary action
Activate — gated. Secondary: save as draft, edit any section inline.
Must see
The failing checks and a one-click route to fix each one.
States
Ready (all ✓, dark Activate enabled) · Not ready (shown) · Activating (spinner, disabled) · Activation failed (inline error, character stays draft, nothing partially published) · Success → Character Detail with a "Luna is live" toast + Undo for 10s.
W07
Character Detail — Overview
Drawn in full as option 1b above — tabs plus the persistent readiness rail. Spec strip below.
Purpose
The operational home for one character. Every question about her is answered here or one tab away.
Entry
Catalogue card; Today attention item; sidebar recent list; post-wizard; review-queue "open character".
Primary action
Depends on state: Draft → resolve blockers; Live → review pending media; Paused → reactivate.
Must see
Name, publication state, active identity version, what users currently see, and any warning — all above the fold, all rail-pinned.
States
Draft (rail shows blocked activation, borrow 1c's banner) · Live (shown) · Paused (muted header + "reactivate" primary) · Loading (header + rail skeleton, tabs disabled) · Not found / no permission (full-page state, back to catalogue) · Save conflict ("edited in another tab — reload").
W08
Character Detail — Visual Identity
— US-101. Versioning is the whole point of this screen.
Over18 Admin
Characters / Maria / Visual Identity
Today
Characters
Media Library
Review Queue
Activity
Maria
● LIVE
Overview
Persona
Visual Identity
Media
Publishing
History
VERSIONS
+ New
v2
ACTIVE
"softer look" · 12 Aug
Used by all generation
v3
DRAFT
unlabelled · today
Not used yet
v1
RETIRED
"launch" · 02 Jun
4 assets still reference it
Exactly one version can be active. Editing never overwrites history — a change creates v4.
Identity v2 — "softer look"
ACTIVE
Duplicate as v4
Edit
VISUAL DNA — identity attributes only
APPARENT AGE
adult (mid-20s)
FACE
EYES
HAIR
SKIN
BODY
PRIMARY REFERENCE SET — what users see
Manage set
◆ 1
hero
◆ 2
◆ 3
SUPPORT
internal
Primary = reference + approved + is_canonical on this version. Removing one changes the live profile immediately — the action confirms.
Purpose
See and control which identity generation uses, without losing history.
Entry
Detail tab; catalogue "v2 incomplete" warning; wizard step 3.
Primary action
Activate a version (confirm modal: "New images and videos will be generated from v3. Existing media keeps its original version"). Secondary: new/duplicate version, edit DNA, manage primary set.
Must see
Which version is active and that it is the one generation uses — stated in words, not implied by a highlight.
States
No identity yet (empty, "create v1") · draft-only (nothing active; character can't be live) · activating (optimistic, rollback on failure) · retired version opened read-only with "duplicate to edit" · attribute-diff view when comparing two versions.
W09
Character Detail — Media
— the global library, pre-filtered. Same component, same behaviours.
Over18 Admin
Characters / Maria / Media
Maria
● LIVE
Upload
Generate media
Overview
Persona
Visual Identity
Media 18
Publishing
History
All 18
Published 3
Pending 2
Approved 11
Rejected 1
Type: all ▾
Origin: all ▾
Identity: v2 ▾
Rating: all ▾
PUBLISHED
◆
ref · img · v2
PUBLISHED
ref · img · v2
⏱ REVIEW
▶ 0:06
gen · video · v2
⏱ REVIEW
18+
gen · img · v2
APPROVED
gen · img · v2
REJECTED
gen · img · v1
2 selected
Approve
Reject
Retire
Bulk actions never include "make primary" — that is a deliberate, per-asset decision.
Purpose
Everything visual belonging to this character, in one grid.
Entry
Detail tab; "18 assets" on the card; from a media drawer's character link.
Primary action
Open an asset (drawer). Secondary: upload, generate, filter, multi-select bulk approve/reject/retire.
Must see
State badge on every tile with no hover required; 18+ bar top-right; video duration.
States
Empty ("no media yet — upload a reference or generate"); filter-empty; loading skeleton tiles; broken/missing file → grey tile with "file unavailable" (this happens in the PoC when /tmp is wiped — the UI must say so rather than show a broken image); generation in progress tile with spinner + cost estimate.
W10
Global Media Library
Over18 Admin
Media Library
Today
Characters
Media Library
Review Queue
Activity
FILTERS
CHARACTER
☑ Maria 18
☐ Sage 9
☐ Ember 14
☐ Luna 1
TYPE
☐ Image
☐ Video
ORIGIN
☐ Reference
☐ Generated
☐ Primary only
STATE
☐ Published
☐ Approved
☐ Pending review
☐ Rejected
☐ Retired
RATING
☐ Safe
☐ Explicit 18+
ADVANCED ▾
provider · model · identity version · date created
Media Library
18 of 42 assets · Maria
Search…
Newest ▾
▮ ☰
Maria ✕
clear all
PUBLISHED
Maria · ref · v2
⏱ REVIEW
▶ 0:06
Maria · gen · v2
APPROVED
18+
Maria · gen · v2
APPROVED
Maria · gen · v2
file unavailable
(row exists)
Maria · gen · v1
Purpose
Find any asset across every character; cross-character bulk work.
Entry
Sidebar; Today "42 assets"; "see all media" from a character.
Primary action
Find, then open the drawer. Secondary: bulk state changes, sort, view toggle.
Must see
Which character each tile belongs to (the one thing the character-scoped grid doesn't need) and its state.
States
Empty library; no-results with active-filter summary and clear-all; loading; partial failure (thumbnails fail, metadata renders); list view for thousands of assets with provider/model/cost columns; infinite scroll with a stable count header.
W11
Media Detail / Review — side drawer
— a pending generated video
Grid stays mounted behind the drawer — scroll position is never lost.
Generated video
3 of 7 in review · ↑ ↓ ✕
video preview
⏱ PENDING REVIEW
18+ EXPLICIT
▶
0:02 / 0:06
720p · 6s · mp4 · 4.2 MB
SOURCE & HISTORY
CHARACTER
Maria ● LIVE open
ORIGIN
Generated (image-to-video) from primary ref 01
IDENTITY
v2 "softer look" — the version active at generation time
STATE
Pending review · not approved · not published
RATING
Explicit change
PROVIDER
runpod · wan-i2v-720p
COST
$0.42 · 6 s @ $0.07/s
CREATED
09 Aug 2026, 14:22 · job j_8814
MOTION PROMPT
slow turn toward camera, soft smile, hair moves slightly
Approving will not publish this. Only approved primary reference images on the active identity reach users. Approving marks it usable and stores you as the approver.
Approve A
Reject R
Skip S
Retire
Replace file
Make primary — images only
Purpose
Everything about one asset, and a decision — without opening a database.
Entry
Any grid tile; review queue; activity entry. Deep-linkable URL.
Primary action
Approve / Reject. Secondary: retire, replace, make primary, change rating, open character.
Must see
State, rating, character, and the approved-vs-published explainer.
States
Image (no player) · video (player + duration/resolution) · already approved (Approve replaced by Retire) · rejected (reason shown, Reopen available) · file missing (metadata still renders, preview says why) · action in flight (buttons disabled, optimistic badge) · action failed (badge reverts + toast) · no-permission (read-only, actions hidden not greyed).
W12
Review Queue
— one job, keyboard-driven, ends empty
Over18 Admin
Review Queue
Today
Characters
Media Library
Review Queue
7
Activity
Review Queue
7 assets awaiting a decision · oldest 6 days
All characters ▾
Start reviewing →
ASSET
CHARACTER
TYPE / ORIGIN
RATING
IDENTITY
WAITING
DECIDE
☐
Maria
video · generated
18+
v2
6 days
Approve
Reject
☐
Maria
video · generated
sfw
v2
4 days
Approve
Reject
☐
Ember
image · reference
sfw
v2 draft
2 days
Approve
Reject
☐
Luna
image · reference
sfw
v1 draft
1 day — blocks activation
Approve
Reject
List for scanning and triage; Start reviewing enters the drawer W11 in sequence with A / R / S keys. Rejection asks for a one-line reason — it appears on the asset and in Activity, so nobody re-reviews it blind.
Purpose
Clear the backlog of undecided media, fast.
Entry
Sidebar badge; Today; character readiness "2 awaiting review".
Primary action
Approve / Reject, one asset at a time.
Must see
Waiting time (drives urgency) and whether an item blocks an activation.
States
Empty is the goal state — "Nothing waiting. Last reviewed 2h ago." · loading · action failed (row restored + toast) · concurrent decision by another operator (row marked "already decided by X", not silently removed) · filtered to one character.
W13
Character Publishing / Activation
Ember
PAUSED
Overview
Persona
Visual Identity
Media
Publishing
History
WHAT GOES LIVE IF YOU ACTIVATE
◆ 1
◆ 2
2 primary references from identity v1, her bio, persona and interests. 12 approved generated assets stay internal — they are not primary references, so users never see them. Preview her profile as a user →
PUBLICATION HISTORY
13 Aug
Deactivated by operator@over18 — "identity rework"
02 Jun
Activated by operator@over18
READY TO ACTIVATE
✓
Profile & persona complete
✓
Visual Identity v1 active
✓
2 primary references approved
✓
No media awaiting review
⚠
Identity v2 draft is incomplete — does not block activation, v1 stays active
Activate Ember
She appears in Discover within seconds. No deployment.
Warnings vs blockers. ✕ blocks activation. ⚠ is informational and never disables the button — otherwise operators learn to distrust the checklist.
Purpose
Make going live an explicit, informed, reversible act.
Entry
Detail tab; rail button; catalogue row action; wizard step 5.
Primary action
Activate (or Deactivate when live → W15).
Must see
Exactly what content activation exposes, before clicking.
States
Ready (shown) · not ready (✕ list, disabled button with reason on hover) · live (Activate replaced by Deactivate + "live since") · activating/deactivating in flight · failure (state unchanged, error names the cause) · readiness recomputed live if an asset is approved in another tab.
W14
Needs Attention — the rules engine, and its three renderings
The rules — one shared definition, evaluated server-side
BLOCKER
Live character with zero approved primary references — she is live and users see a placeholder
BLOCKER
Live character with no active identity version — generation has nothing to condition on
READINESS
Draft character failing one or more activation checks
AGEING
Any asset pending review for more than 48 hours
DRIFT
Identity draft untouched for 14+ days — someone started a rework and stopped
INTEGRITY
Asset row whose file is missing from storage — the PoC's /tmp wipe, surfaced instead of hidden
Severity, not a flat list. Blockers (something is wrong in production right now) sort above readiness items (something isn't finished yet). Only blockers colour red; everything else stays greyscale, or the operator stops reading warnings.
Rendered in three places — the brief asks "which one?", the answer is all three
1 · Today block W01
Cross-character triage list with a fix action per row. This is the daily surface.
2 · Catalogue filter chip + card flag W02
For the operator already browsing. The dark card border does the work; the chip narrows to only affected characters.
3 · Character Detail banner + readiness rail 1b 1c
In context, with the fix one click away. Never a link to a separate page.
Not a dedicated nav item. A page you must remember to visit is a page that goes unvisited. The sidebar Review Queue badge already carries the persistent count.
States — healthy (Today shows a calm "all clear" block, not a hidden section); 20+ items (grouped by character, "show all"); stale data (evaluated server-side per request, no client caching of warnings).
W15
Deactivation — destructive confirmation
(added; the brief asks for it but doesn't number it)
Deactivate Maria?
She will be removed from the live catalogue immediately. Users browsing Discover will no longer see her, and no new conversations can start.
WHAT IS KEPT
✓ Her profile, persona and all 3 identity versions
✓ All 18 media assets and their approvals
✓ Existing conversations and memories
WHAT CHANGES
• Hidden from Discover, Swipe and search
• Reversible in one click from her Publishing tab
Reason — appears in Activity
e.g. reworking her visual identity
Cancel
Deactivate
Rules for destructive confirmation
State the consequence, not the action. "She will be removed from the live catalogue" beats "Are you sure?".
Say what survives. Most operator hesitation is fear of losing work. The kept/changed split removes it and prevents the "let me ask a developer first" reflex the epic exists to kill.
Reason field, optional but prompted. Costs three seconds, saves an archaeology session later. It is the replacement for a commit message.
Red only here. Rose/red is reserved for two things in the whole admin: the explicit-content bar and the confirmed destructive button.
No confirmation for reversible acts. Approve, reject, retire, reorder → inline undo toast (10s). Modal fatigue is what makes people click through the one modal that mattered.
Same pattern, other destructive moments: activating a different identity version ("all future generations will use v3"); removing a primary reference from a live character ("her profile will show 2 images instead of 3"); retiring the last primary reference (blocked outright, with an explanation).
W16
System states — the set every screen draws from
EMPTY — FIRST RUN
No characters yet
Create your first AI creator — no developer required.
+ New character
LOADING — SKELETON
Shape-matched skeletons, never spinners on grids — layout must not jump.
ERROR — RECOVERABLE
Couldn't load media
The library didn't respond. Your filters are still applied.
Retry
Report
Plain language, no status codes, never a blank page.
PERMISSION / DISABLED
Activate character
Needs 1 approved primary reference. Review 2 uploads
A disabled control always explains itself and offers the fix. Read-only operators see actions hidden, not greyed.
PART E + F
Component inventory & state matrix
Components to build — 21, of which 6 do most of the work
SHELL
AdminShell (sidebar + topbar, desktop) · SidebarNav with count badges · Breadcrumb
CORE SIX — everything else composes these
StateBadge (one component, every state + rating; the vocabulary at the top of this doc) · MediaTile (image/video, badges, selection) · MediaGrid (+ filter bar, bulk bar, empty/loading/error) · MediaDrawer (detail + decisions, keyboard nav) · ReadinessChecklist (blockers vs warnings, fix links — used on Detail rail, wizard step 5, Publishing) · AttentionList (the rules engine's rendering)
CHARACTER
CharacterCard (admin variant) · CharacterTable (list view) · CharacterHeader · TabBar · PublicationRail · IdentityVersionList · VisualDnaEditor · PrimarySetEditor (drag-reorder)
FLOW & FEEDBACK
WizardStepper · ConfirmDialog (consequence/kept/changed/reason) · UndoToast · FilterChipRow · Uploader (drag-drop, progress, retry) · ActivityFeed · EmptyState (extend the existing EmptyState.tsx)
Reused from the existing app: EmptyState, PageHeader, the Tailwind zinc/rose token usage, and the image-failure fallback logic already in CharacterCard.tsx. Deliberately not reused: AppShell (mobile bottom nav, 512px cap) and MediaGallery / MediaViewer (consumer premium-gating semantics don't apply to an operator).
Which asset states are visible where
ASSET STATE
MEDIA LIB
QUEUE
GENERATION
USERS
Generated / uploaded
✓
—
—
—
Under review
✓
✓
—
—
Approved, not primary
✓
—
✓ ref only
—
Approved + primary, active identity
✓
—
✓
✓ PUBLISHED
Approved + primary, retired identity
✓
—
—
—
Rejected
✓ filtered out by default
—
—
—
Retired
✓ filtered out by default
—
—
—
Read row 5: retiring an identity version silently unpublishes its primary set. That is correct behaviour and today invisible — which is exactly why activating a new identity version gets a confirmation that names how many published images will change.
PART I
Open product decisions — six, all genuinely yours

Everything else I resolved with UX judgement and recorded above. These six change scope or policy, so I've stated a recommendation and what it costs to disagree.

OD-1
Who can approve adult content, and does approval need a second pair of eyes?
The whole design assumes one operator role that can create, approve and publish. If explicit media legally or commercially requires a separate approver, the review queue becomes a two-stage pipeline and every "approve" button needs a role check. My recommendation: single role for the PoC, design the queue so a second stage can be inserted without redrawing it.
OD-2
Is generated media ever shown to users, or only primary references?
Today the API publishes only approved primary references, so an approved generated video can never reach a user. If generated video is meant to appear in Discover (the code has a video-first seam waiting for it), publishing needs its own explicit flag rather than riding on is_canonical — a real data-model decision, and the single biggest fork in this epic. My recommendation: add an explicit "publish to profile" flag on approved assets; it makes Approved-vs-Published operator-controlled instead of implied.
OD-3
Can operators trigger generation from the admin — and who pays?
The pipeline exists behind an internal token with a cost ledger and per-character budget. Exposing "Generate media" in the UI W09 means an operator can spend real money in one click. Needs: budget display, confirm-with-cost, or omit the button entirely for v1. My recommendation: ship v1 read-only with upload; add generation in a later story with a visible remaining-budget meter.
OD-4
What happens to live conversations when a character is deactivated?
W15 currently promises conversations survive and only discovery is hidden. If deactivation should also stop existing chats replying, the copy — and the operator's mental model — changes materially. My recommendation: hide from discovery, keep existing chats working; anything else is a user-facing breakage disguised as an admin action.
OD-5
Is Retired needed for the PoC, for characters and for media?
The only schema additions this design asks for. Paused already covers "not live". My recommendation: add retired for media (operators need "superseded, not bad"); defer retired for characters until there are enough of them for Paused to feel crowded.
OD-6
Where do asset files actually live?
Generated assets currently write to local disk and the code itself warns that a redeploy can wipe them. An operator-facing library that shows "file unavailable" tiles is honest but not acceptable long-term. Object storage is a prerequisite for upload — not strictly a design decision, but it gates W05 and W10. My recommendation: treat durable storage as a hard dependency of the first implementation story.
PART J
Recommended implementation sequence

Ordered so that every slice ends with the operator able to do something they previously needed a developer for. Nothing here is a "foundations sprint" with no user-visible result.

1
Admin shell, auth gate, catalogue read-only W02 · US-99
Route tree at /admin, sidebar, StateBadge, CharacterCard. Needs an admin-scoped characters endpoint that returns inactive rows too (the public one filters them out). Ends with: the operator can see the catalogue and its true state for the first time.
2
Character Detail — Overview, Persona, editing W07 · US-99
Header, tabs, rail shell, persona edit + save. Ends with: bios and personalities change without a commit.
3
Readiness engine + activation / deactivation W13 · W15 · US-102
One server-side rules evaluation reused by rail, wizard and Publishing. Ends with: the deploy-to-go-live workflow is dead. This is the epic's core promise and should land early, not last.
4
Media grid + drawer, character-scoped W09 · W11 · US-100
MediaTile / MediaGrid / MediaDrawer built once, reused by W10 and W12. Depends on OD-6 (durable storage) for upload. Ends with: assets are inspectable without a database client.
5
Approval actions + Review Queue W12 · US-100
Approve / reject / retire with approver stamping and undo; the queue is a filtered MediaGrid plus keyboard sequencing. Ends with: a real content-safety workflow exists.
6
Visual Identity versioning W08 · US-101
Version list, DNA editor, primary set, activate-version confirmation. Highest-risk screen — deliberately after the operator is fluent in the rest of the admin.
7
Create Character wizard W03–W06 · US-99
Deliberately late: it is a thin orchestration of steps 2–6, and building it earlier means building each step twice. Ends with: the Maria onboarding story is fully self-service.
8
Global Media Library, Today, Activity W01 · W10 · W14 · US-103
All three are aggregations of work already done. The dashboard is built last on purpose — it can only summarise states that exist.
Nothing has been implemented. No repository files were modified, no schema changes made. Pick a Character Detail structure — 1a, 1b or 1c — and answer OD-2 and OD-6, and slice 1 is ready to hand to engineering.
