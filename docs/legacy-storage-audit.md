# Legacy storage audit (P0.9)

Every place this product keeps media bytes, who writes it, who reads it, and —
where something is legacy — what it would take to remove it.

Audited on the `epic-11-ops` branch after P0.8. Nothing in production was
touched: no stored file was moved, no URL changed, no database column dropped.

---

## 1. The canonical model

Everything an operator produces today lives under `MEDIA_STORAGE_DIR`, and
every read resolves through one function (`resolveMediaFile`) that refuses any
path escaping that root.

| Path | Written by | Read by | Status |
|---|---|---|---|
| `<root>/<characterId>/uploads/<assetId>.<ext>` | `library-upload-service` | admin media route, public media route, chat media | **Canonical** |
| `<root>/<characterId>/generated/<jobId>.<ext>` | `media-generation-service` | same | **Canonical** |
| `<root>/<characterId>/uploads/<assetId>.opt.mp4` (recorded in `provenance.optimisedPath`) | `media-optimise-service` | `resolveMediaFile` when `MEDIA_OPTIMISED_ENABLED` | **Canonical**, additive: the original is never replaced |
| `<root>/inbox/…` | `content-inbox-service` | admin inbox routes only | **Canonical** |
| banner creative files | `banner-creative-service` | Home banner routes | **Canonical** |

### Two storage-key conventions, both live

`character_visual_assets.storage_key` means two different things depending on
how the asset was created, and `resolveMediaFile` settles it:

1. **Upload convention** — the key is an API route (`/admin/content/uploads/<id>/file`)
   and the real path is in `provenance.storagePath`.
2. **Generated convention** — the key *is* the absolute server path (or a
   `MEDIA_PUBLIC_BASE_URL` prefix plus the relative path).

The second is the older shape. It is **retained**: production rows depend on it,
and clients never see it — every surface hands out an id-keyed route instead.
Removing it would mean rewriting `storage_key` for every generated asset to the
route convention, with `provenance.storagePath` filled in first. Not attempted
here; nothing is broken by leaving it.

---

## 2. Bundled demo media — `apps/web/public/media/`

PoC-era files that ship inside the web bundle. The manifest that served them
(`apps/web/src/lib/characterMedia.ts`) was deleted in earlier work, so most of
them lost their only consumer.

### Removed in P0.9 (14 files, ~30MB)

`ember/profile-02.*`, `ember/profile-03.*`, `maria/hero.*`,
`maria/profile-02.*`, `maria/profile-03.*`, `sage/hero.*`, `sage/profile-02.*`

Evidence they were unused:

- no reference in `apps/api/src`, `apps/web/src`, `docs/`, `packages/` or
  `.claude/launch.json` (source, tests and configuration all searched);
- the manifest that once served them is deleted, and
  `DEMO_MEDIA_OVERRIDES` is empty;
- **no database row can point at them**: the only `/media/…` value the seed has
  ever written, across the whole git history, is Maria's portrait (below), and
  `characters.profile_image` has no writer other than the seed — no route or
  admin screen sets it.

### Retained, with their consumers

| File | Consumer | To remove it later |
|---|---|---|
| `maria/portrait.png` | `SEED_CHARACTERS` (Maria's `profile_image`) and `SEED_VISUAL_ASSETS` (her canonical reference `storage_key`) | Migrate Maria's portrait into `MEDIA_STORAGE_DIR` as an ordinary reference asset, then re-seed. See §3. |
| `luna/profile-04.jpg`, `luna/profile-04.mp4` | Mock provider fixture defaults in `services/media-providers.ts` and `media-pipeline/cli.ts` | Point `MEDIA_MOCK_IMAGE_FIXTURE` / `MEDIA_MOCK_VIDEO_FIXTURE` at a fixture inside the test tree and drop the defaults. |
| `ember/hero.jpg`, `ember/hero.mp4` | `media-pipeline.test.ts` — the QA suite needs a genuine portrait H.264 clip and a real first-frame poster | Generate an equivalent fixture at test time (needs ffmpeg in CI) or vendor a smaller real clip. |

Note: the defaults in `media-providers.ts` are **relative to the process
working directory** (`apps/web/public/media/...`), so they only resolve when the
API runs from the repository root — a development convenience, never a
production path. Production selects a real provider.

---

## 3. `characters.profile_image` — legacy, still consumed

**Not removable yet.** The column is a plain text locator predating first-class
visual assets.

- **Writers:** the seed only. `character-service`'s update input still accepts
  the field, but no route passes it, and no admin screen offers it.
- **Values that can exist:** three `placehold.co` URLs (Luna, Ember, Sage),
  Maria's `/media/maria/portrait.png`, or null. Confirmed against every version
  of `seed-data.ts` in git history.
- **Readers:**
  - `toPublicCharacter` → every public character payload carries it;
  - `home-composition-service` character cards;
  - web: `CharacterCard`, `resolveHeroMedia` and `characterHeaderItems` use it
    as the fallback still **after** the canonical reference image.

**What removal requires** (this is P0.2's deliverable, not P0.9's):

1. give every seeded character a canonical reference asset holding her portrait,
   so `firstCanonicalImage` answers before the fallback is reached;
2. drop `profileImage` from `toPublicCharacter` and the Home card projection,
   and remove the web fallbacks;
3. only then drop the column, in its own additive-then-destructive migration.

Until step 1 lands, deleting the column would leave Maria with no portrait on
the cards that fall back to it.

---

## 4. Seeded placeholder assets point at external URLs

`SEED_VISUAL_ASSETS` writes `storage_key` values like
`https://placehold.co/640x800/...`. These are not files this product owns, and
`resolveMediaFile` refuses them (`outside_storage_root`), so the media route
answers 404 for them and no byte is ever fetched from a third party.

**Retained**: they are seed fixtures for local development and demo data, and
they are harmless — but they are the reason a seeded character can have an asset
row whose media does not resolve. Replace with real fixtures under
`MEDIA_STORAGE_DIR` when the seed is next revised.

---

## 5. The offline media pipeline — `apps/api/src/media-pipeline/`

A CLI (`cli.ts` + `pipeline.ts`) with its own directory tree per character:
`candidates/`, `approved/`, plus an events log and a cost ledger file. It is a
**development and operations tool**: the API never reads that tree, and nothing
in it is served to a customer.

**Retained.** It is the QA harness for generated media (`media-qa.ts` is used by
the automated tests), and removing it would remove real coverage.

---

## 6. Repository working directories, not shipped

- `Content/` at the repository root — the source material an operator imported
  from the site (`provenance.source = 'approved-site-content'`). Untracked, not
  built, not deployed. Left alone.
- `apps/api/scripts/*.mjs` — untracked local harnesses. Left alone.

---

## 7. Unresolved risk

- **Production data was not inspected.** The removals above rest on proving
  that no *writer* can produce a reference to the deleted files. If someone has
  hand-edited `characters.profile_image` or a `storage_key` directly in the
  production database to a `/media/...` path other than Maria's portrait, that
  one image would now 404 and fall back to the initial-letter tile. A read-only
  check before deploying:

  ```sql
  select id, name, profile_image from characters
   where profile_image like '/media/%' and profile_image <> '/media/maria/portrait.png';
  select id, character_id, storage_key from character_visual_assets
   where storage_key like '/media/%' and storage_key <> '/media/maria/portrait.png';
  ```

  Both should return zero rows.

- **Orphaned bytes under `MEDIA_STORAGE_DIR`** (files whose asset row was
  deleted before P0.7 added cleanup, or left by an interrupted upload) were not
  swept. There is no inventory job; writing one means walking the tree and
  comparing against `storage_key` + `provenance.storagePath`. Deliberately not
  attempted here — it touches real operator media and belongs with P9.4's
  deletion and retention work.
