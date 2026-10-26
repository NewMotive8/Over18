#!/usr/bin/env node
/**
 * STAGING -> PRODUCTION CONTENT SYNCHRONISATION. DRY RUN ONLY.
 *
 * -- WHAT THIS IS FOR -------------------------------------------------------
 *
 * Twenty-five characters were built on Staging and exist nowhere else. This
 * moves them to Production without anybody rebuilding them by hand, and
 * without touching anything that is already there.
 *
 * -- WHY IT IS INSERT-ONLY, AND WHY THAT IS NOT TIMIDITY --------------------
 *
 * The two environments have DIVERGED, not drifted. Production is ahead on
 * customer data (72 conversations, 1,760 messages) and holds content Staging
 * does not: thirteen characters have a persona only Production has, and seven
 * characters Staging marks `inactive` are `active` in Production WITH LIVE
 * CONVERSATIONS. A "Staging wins" copy would deactivate those seven and erase
 * the chat personality of thirteen.
 *
 * The foreign keys decide how bad a mistake gets. `conversations`, `messages`,
 * `favourites`, personas, assets and identities all CASCADE from `characters`;
 * only `call_sessions` RESTRICTs, and just four characters have call history.
 * So a careless delete silently destroys customer history and almost nothing
 * stops it.
 *
 * Insert-only is therefore the one shape that CANNOT lose data. There is no
 * UPDATE path and no DELETE path in this file -- not disabled, not gated,
 * absent. A name that already exists in Production is skipped and reported.
 *
 * -- WHY IT PRESERVES THE STAGING UUIDs -------------------------------------
 *
 * Measured: none of the 25 candidates' UUIDs -- character, identity or asset --
 * exists in Production, and no UUID is reused there for a different name. That
 * was worth checking, because three SHARED characters (amanda, nadia, rosie)
 * have DIFFERENT UUIDs in each environment, so an ID-keyed sync would not
 * recognise them and would insert duplicates.
 *
 * Preserving the IDs buys three things that remapping would have to rebuild and
 * could get wrong:
 *   - `provenance.storagePath` stays valid verbatim; it embeds the character id
 *     (`<storageDir>/<characterId>/uploads/<file>`).
 *   - `storage_key` stays valid verbatim; it embeds the asset id
 *     (`/admin/content/uploads/<assetId>/file`).
 *   - Every relationship -- identity->character, asset->identity,
 *     persona->character, persona->source_asset -- carries over unchanged.
 * It also makes idempotency free: the primary key IS the dedupe key, so a
 * rerun cannot duplicate anything.
 *
 * This only holds while the collision check passes. If it ever fails the run
 * BLOCKS rather than falling back to remapping, because a silent remap is
 * exactly how you end up with two of the same character.
 *
 * -- HOW MEDIA IS VERIFIED --------------------------------------------------
 *
 * `storage_key` IS NOT A FILE PATH for an uploaded asset -- it is the API serve
 * path. The real file is `provenance.storagePath`, with an optional verified
 * derivative at `provenance.optimisedPath`. Generated assets use the other
 * convention, where `storage_key` IS the path. Both are resolved here exactly
 * as `resolveMediaFile` does it, because a sync that guessed would write rows
 * pointing at nothing.
 *
 * Verification is a stat AND a real read of the first byte. Existence alone is
 * not readability: a file can be present and unreadable, and we would only find
 * out halfway through an apply.
 *
 * -- WHY AN UNREADABLE FILE BLOCKS THE WHOLE CHARACTER ----------------------
 *
 * Not just that asset. A character arriving with eleven of her twelve clips is
 * a silent content loss that nobody would notice until a customer did, and
 * "stop rather than guess" is the instruction. `--partial-assets` relaxes it
 * deliberately and says so in the report.
 *
 * -- WHY EVERY CHARACTER ARRIVES INACTIVE, AND WHY THAT IS LOAD-BEARING -----
 *
 * Clearing `published_at` is NOT sufficient to keep new content off the front
 * page, and assuming it was would have shipped 22 live characters.
 *
 * Publication is per-CHANNEL, and the channels are alternatives, not a chain:
 * `postsChannelCondition` reads `published_at`, but `categoryChannelCondition`
 * only asks whether the asset sits in an enabled, home-published category. An
 * asset in the `new` rail is therefore publicly reachable with `published_at`
 * still NULL. Twenty-two of the twenty-five candidates are `active` on Staging
 * and they carry twenty category placements between them.
 *
 * What gates all of it is `distributableConditions`, which requires
 * `characters.status = 'active'`. So her STATUS is the master switch, and this
 * tool sets every inserted character to `inactive` regardless of her Staging
 * status. The original is reported so it can be restored deliberately, one
 * character at a time.
 *
 * That is also the only reason copying `app_category_assets` is safe here. The
 * placements are inert while she is inactive, and the server documents this as
 * the intended operator journey -- build, upload, approve, MERCHANDISE, then
 * publish her. The two decisions hold each other up: keep the placements only
 * while the character arrives inactive. Changing either one alone puts
 * unreleased content in front of a customer.
 *
 * -- MODES ------------------------------------------------------------------
 *
 *   --mode=export   Run INSIDE Staging. Reads the Staging database, resolves
 *                   and verifies every media file on the volume, prints a
 *                   manifest. Read-only; touches no Production resource.
 *
 *   --mode=plan     Run with PRODUCTION database access. Takes the manifest,
 *                   works out what would be inserted, skipped or blocked, and
 *                   prints the report. Read-only.
 *
 *   --mode=apply    Refuses. Writing to Production is a separate approval and
 *                   the code does not exist in this file yet.
 *
 * Export is a FULL snapshot of Staging content, not a snapshot of 25 names.
 * The candidate set is computed in `plan` by differencing against Production,
 * so the list cannot go stale and there is no hardcoded roster to maintain.
 *
 * Usage:
 *   node content-sync.mjs --mode=export [--hash] > manifest.json
 *   node content-sync.mjs --mode=plan --manifest=manifest.json
 */

import { createHash } from 'node:crypto';
import { closeSync, openSync, readSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';

/* ------------------------------------------------------------------ *
 * Arguments
 * ------------------------------------------------------------------ */

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, fallback = null) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const MODE = opt('mode');
const WANT_HASH = flag('hash');
const PARTIAL_ASSETS = flag('partial-assets');
/** Rehearsal escape hatch: skip the destination media check. Never for Production. */
const NO_MEDIA_CHECK = flag('no-media-check');

/**
 * Tables this tool is permitted to write, ever.
 *
 * AN ALLOWLIST, NOT A DENYLIST, so a table added to the schema next month is
 * excluded by default rather than included by default. The difference matters:
 * a denylist that forgets a new `payments_v2` is a disaster, an allowlist that
 * forgets it is a no-op.
 */
const WRITABLE_TABLES = Object.freeze([
  'characters',
  'character_visual_identities',
  'character_visual_assets',
  'character_personas',
  'character_keywords',
  'app_category_assets',
]);

/**
 * Never read for copying, never written, not even considered.
 *
 * Customer data and money first, then the two content areas that LOOK
 * syncable and are not: the economy uses incompatible code schemes in the two
 * environments (`credits_100` vs `pack_100_credits`, `premium_annual` vs
 * `annual`) and Staging carries six `qa_*` test packs; Home curation is chosen
 * in Production (hero clips karen/jasmin/jenna, not Staging's karen/zina/freya)
 * and a copy would both overwrite it and dangle, since Staging's heroes point
 * at characters Production does not have.
 */
const EXCLUDED_TABLES = Object.freeze([
  'users', 'wallets', 'wallet_ledger', 'subscriptions', 'payments', 'paid_actions',
  'analytics_events', 'conversations', 'messages', 'memories', 'favourites',
  'call_sessions', 'credit_packs', 'pack_versions', 'plans', 'content_entitlements',
  'content_offers', 'home_hero_clips', 'home_play_with_me', 'home_banners',
  'app_categories', 'discovery_categories', 'content_keywords', 'keyword_facets',
  'content_requirements',
]);

/** QA content that must never reach a customer, matched on the natural key. */
const QA_NAME_PATTERN = /^(qa|test|dummy|sample)[-_]/i;

const die = (message) => {
  process.stderr.write(`\n  REFUSED: ${message}\n\n`);
  process.exit(1);
};

/* ------------------------------------------------------------------ *
 * Media resolution -- mirrors resolveMediaFile
 * ------------------------------------------------------------------ */

const isInsideStorageRoot = (root, candidate) => {
  const r = resolve(root);
  const c = resolve(candidate);
  return c === r || c.startsWith(r.endsWith(sep) ? r : r + sep);
};

/**
 * The file an asset's bytes actually live in, or why there isn't one.
 *
 * Two conventions, and the upload one is checked first exactly as the server
 * checks it. `storage_key` is a serve path for an upload and a filesystem path
 * for a generated asset; treating them alike is the mistake this function
 * exists to prevent.
 */
const resolveAssetFiles = (asset, storageDir) => {
  const prov = asset.provenance ?? {};
  const files = [];

  if (prov.source === 'manual-upload') {
    const original = typeof prov.storagePath === 'string' ? prov.storagePath : null;
    if (!original) return { failure: 'upload_without_storage_path', files };
    if (!isAbsolute(original)) return { failure: 'storage_path_not_absolute', files };
    if (!isInsideStorageRoot(storageDir, original)) return { failure: 'outside_storage_root', files };
    files.push({ role: 'original', path: resolve(original) });

    // A derivative is an optimisation. Its absence is normal and not a failure;
    // its presence means another file has to travel with the asset.
    const optimised = typeof prov.optimisedPath === 'string' ? prov.optimisedPath : null;
    if (optimised && isInsideStorageRoot(storageDir, optimised)) {
      files.push({ role: 'optimised', path: resolve(optimised), optional: true });
    }
    return { failure: null, files };
  }

  const key = asset.storage_key;
  if (!key) return { failure: 'no_path', files };
  if (!isInsideStorageRoot(storageDir, key)) return { failure: 'outside_storage_root', files };
  files.push({ role: 'original', path: resolve(key) });
  return { failure: null, files };
};

/**
 * Exists, is a regular file, is non-empty, and can actually be read.
 *
 * THE READ IS THE POINT. `statSync` succeeding proves the directory entry is
 * there, not that the bytes can be opened -- and discovering that difference
 * part-way through an apply is the failure mode this guards.
 */
const verifyFile = (path, wantHash) => {
  let st;
  try {
    st = statSync(path);
  } catch (error) {
    return { ok: false, reason: error.code === 'ENOENT' ? 'missing' : `stat_failed:${error.code}` };
  }
  if (!st.isFile()) return { ok: false, reason: 'not_a_file' };
  if (st.size === 0) return { ok: false, reason: 'empty' };

  let fd;
  try {
    fd = openSync(path, 'r');
    const probe = Buffer.alloc(1);
    const read = readSync(fd, probe, 0, 1, 0);
    if (read !== 1) return { ok: false, reason: 'unreadable_first_byte' };
  } catch (error) {
    return { ok: false, reason: `open_failed:${error.code ?? 'unknown'}` };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }

  const out = { ok: true, size: st.size, mtime: st.mtime.toISOString() };
  if (wantHash) out.sha256 = createHash('sha256').update(readFileSync(path)).digest('hex');
  return out;
};

/* ------------------------------------------------------------------ *
 * export -- runs inside Staging
 * ------------------------------------------------------------------ */

const runExport = async () => {
  const { Client } = await import('pg');
  const storageDir = process.env.MEDIA_STORAGE_DIR ?? 'var/media';
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();

  const q = async (sql, params = []) => (await db.query(sql, params)).rows;

  const characters = await q(`
    select id, name, display_name, profile_image, short_bio, personality, interests,
           conversation_style, system_prompt, status::text as status, live_call_voice,
           country_code, region, city, timezone, age,
           grok_voice, grok_speaking_style, grok_call_instructions,
           created_at, updated_at
      from characters order by name`);

  const identities = await q(`
    select id, character_id, version, status::text as status, visual_dna, label,
           created_at, updated_at
      from character_visual_identities order by character_id, version`);

  const assets = await q(`
    select id, character_id, visual_identity_id, kind::text as kind, status::text as status,
           is_canonical, position, storage_key, provenance,
           content_rating::text as content_rating, approved_by, approved_at,
           requirement_key, published_at, origin::text as origin,
           archived_at, archived_by, created_at, updated_at
      from character_visual_assets order by character_id, position nulls last, created_at`);

  const personas = await q(`
    select character_id, persona, edited_fields, source_asset_id, generated_at,
           created_at, updated_at
      from character_personas order by character_id`);

  // Join tables are exported with the NATURAL key alongside the id, because the
  // id is only meaningful in the environment it came from.
  const keywords = await q(`
    select ck.character_id, ck.keyword_id, k.key as keyword_key
      from character_keywords ck join content_keywords k on k.id = ck.keyword_id
     order by ck.character_id, k.key`);

  const categoryAssets = await q(`
    select aca.category_id, aca.asset_id, aca.position, aca.featured, c.slug as category_slug
      from app_category_assets aca join app_categories c on c.id = aca.category_id
     order by c.slug, aca.position`);

  const requirementKeys = await q(`select key from content_requirements order by key`);

  // Media verification, per asset, using the server's own resolution rules.
  const media = {};
  for (const asset of assets) {
    const { failure, files } = resolveAssetFiles(asset, storageDir);
    if (failure) {
      media[asset.id] = { resolved: false, failure, files: [] };
      continue;
    }
    media[asset.id] = {
      resolved: true,
      failure: null,
      files: files.map((f) => ({ ...f, ...verifyFile(f.path, WANT_HASH) })),
    };
  }

  await db.end();

  const manifest = {
    kind: 'over18-content-manifest',
    version: 1,
    takenAt: new Date().toISOString(),
    source: { storageDir, hashed: WANT_HASH },
    characters, identities, assets, personas, keywords, categoryAssets,
    requirementKeys: requirementKeys.map((r) => r.key),
    media,
  };
  process.stdout.write(`MANIFEST${JSON.stringify(manifest)}\n`);
};

/* ------------------------------------------------------------------ *
 * plan -- runs with Production database access
 * ------------------------------------------------------------------ */

const loadManifest = () => {
  if (globalThis.__MANIFEST) return globalThis.__MANIFEST;
  const path = opt('manifest');
  if (!path) die('--mode=plan needs --manifest=<file> (or an embedded manifest).');
  const raw = readFileSync(path, 'utf8');
  const line = raw.split(/\r?\n/).find((l) => l.startsWith('MANIFEST')) ?? raw;
  return JSON.parse(line.startsWith('MANIFEST') ? line.slice('MANIFEST'.length) : line);
};

/** Everything about the target needed to decide the plan. One read, reused. */
const readTarget = async (db) => {
  const q = async (sql, params = []) => (await db.query(sql, params)).rows;
  return {
    prodCharacters: await q('select id, name, status::text as status from characters'),
    prodIdentityIds: (await q('select id from character_visual_identities')).map((r) => r.id),
    prodAssetIds: (await q('select id from character_visual_assets')).map((r) => r.id),
    prodKeywords: await q('select id, key from content_keywords'),
    prodCategories: await q('select id, slug from app_categories'),
    prodRequirements: (await q('select key from content_requirements')).map((r) => r.key),
    prodCounts: (await q(`
      select (select count(*) from characters)::int as characters,
             (select count(*) from character_visual_assets)::int as assets,
             (select count(*) from conversations)::int as conversations,
             (select count(*) from messages)::int as messages`))[0],
  };
};

/**
 * The plan: who would be inserted, who is skipped, who is blocked and why.
 *
 * PURE, and shared by plan and apply, so apply cannot act on a different
 * understanding of the data than the one you reviewed. Apply re-derives this
 * against the live target and refuses if the token has moved.
 */
const computePlan = (manifest, target) => {
  const {
    prodCharacters, prodIdentityIds, prodAssetIds,
    prodKeywords, prodCategories, prodRequirements,
  } = target;

  const prodByName = new Map(prodCharacters.map((c) => [c.name, c]));
  const prodById = new Map(prodCharacters.map((c) => [c.id, c]));
  const prodIdentitySet = new Set(prodIdentityIds);
  const prodAssetSet = new Set(prodAssetIds);
  const prodKeywordByKey = new Map(prodKeywords.map((k) => [k.key, k.id]));
  const prodCategoryBySlug = new Map(prodCategories.map((c) => [c.slug, c.id]));
  const prodRequirementSet = new Set(prodRequirements);

  const identitiesByChar = new Map();
  for (const i of manifest.identities) {
    if (!identitiesByChar.has(i.character_id)) identitiesByChar.set(i.character_id, []);
    identitiesByChar.get(i.character_id).push(i);
  }
  const assetsByChar = new Map();
  for (const a of manifest.assets) {
    if (!assetsByChar.has(a.character_id)) assetsByChar.set(a.character_id, []);
    assetsByChar.get(a.character_id).push(a);
  }
  const personaByChar = new Map(manifest.personas.map((p) => [p.character_id, p]));
  const keywordsByChar = new Map();
  for (const k of manifest.keywords) {
    if (!keywordsByChar.has(k.character_id)) keywordsByChar.set(k.character_id, []);
    keywordsByChar.get(k.character_id).push(k);
  }
  const assetOwner = new Map(manifest.assets.map((a) => [a.id, a.character_id]));
  const categoryAssetsByChar = new Map();
  for (const ca of manifest.categoryAssets) {
    const owner = assetOwner.get(ca.asset_id);
    if (!owner) continue;
    if (!categoryAssetsByChar.has(owner)) categoryAssetsByChar.set(owner, []);
    categoryAssetsByChar.get(owner).push(ca);
  }

  const plan = { insert: [], skip: [], block: [] };

  for (const character of manifest.characters) {
    const reasons = [];
    const notes = [];

    /* -- identity conflicts: stop rather than guess -------------------- */
    const byName = prodByName.get(character.name);
    const byId = prodById.get(character.id);

    if (byName && byId && byName.id === byId.id) {
      plan.skip.push({ character, reason: 'already_in_production', detail: `same name and same id (${character.id})` });
      continue;
    }
    if (byName && !byId) {
      // amanda / nadia / rosie land here: same name, different id. An id-keyed
      // sync would insert a duplicate; insert-only means we skip.
      plan.skip.push({
        character,
        reason: 'name_exists_with_different_id',
        detail: `Production has "${character.name}" as ${byName.id}, Staging has ${character.id}. Insert-only: left alone.`,
      });
      continue;
    }
    if (byId && !byName) {
      reasons.push(`AMBIGUOUS IDENTITY: Staging id ${character.id} already exists in Production under the name "${byId.name}". Refusing to guess which character this is.`);
    }
    if (QA_NAME_PATTERN.test(character.name)) {
      reasons.push(`Looks like QA content ("${character.name}") and is excluded by policy.`);
    }

    /* -- the content that must travel with her ------------------------- */
    const identities = identitiesByChar.get(character.id) ?? [];
    const assets = assetsByChar.get(character.id) ?? [];
    const persona = personaByChar.get(character.id) ?? null;

    if (identities.length === 0) {
      reasons.push('No visual identity. Every asset requires one (visual_identity_id is NOT NULL), so she cannot be inserted coherently.');
    }
    for (const identity of identities) {
      if (prodIdentitySet.has(identity.id)) {
        reasons.push(`Identity UUID ${identity.id} already exists in Production. Refusing to remap silently.`);
      }
    }

    /* -- media verification -------------------------------------------- */
    const badAssets = [];
    let fileCount = 0;
    let byteCount = 0;
    for (const asset of assets) {
      if (prodAssetSet.has(asset.id)) {
        reasons.push(`Asset UUID ${asset.id} already exists in Production. Refusing to remap silently.`);
      }
      const probe = manifest.media[asset.id];
      if (!probe || !probe.resolved) {
        badAssets.push({ id: asset.id, why: probe?.failure ?? 'not_probed' });
        continue;
      }
      for (const file of probe.files) {
        if (file.ok) {
          fileCount += 1;
          byteCount += file.size ?? 0;
        } else if (!file.optional) {
          badAssets.push({ id: asset.id, why: `${file.role}:${file.reason}`, path: file.path });
        }
      }
      if (asset.requirement_key && !prodRequirementSet.has(asset.requirement_key)) {
        reasons.push(`Asset ${asset.id} needs requirement key "${asset.requirement_key}", which Production does not define.`);
      }
    }
    if (badAssets.length > 0) {
      const detail = badAssets.slice(0, 4).map((b) => `${b.id} (${b.why})`).join('; ');
      const more = badAssets.length > 4 ? ` and ${badAssets.length - 4} more` : '';
      if (PARTIAL_ASSETS) {
        notes.push(`${badAssets.length} asset(s) will be LEFT BEHIND because their media is unusable: ${detail}${more}`);
      } else {
        reasons.push(`${badAssets.length} of ${assets.length} media file(s) are missing or unreadable, so inserting her would silently lose content: ${detail}${more}`);
      }
    }

    /* -- relationship remaps by natural key ---------------------------- */
    const keywordRows = keywordsByChar.get(character.id) ?? [];
    const keywordPlan = [];
    for (const row of keywordRows) {
      const target = prodKeywordByKey.get(row.keyword_key);
      if (!target) {
        notes.push(`Keyword "${row.keyword_key}" does not exist in Production; that one tag will not be applied.`);
      } else {
        keywordPlan.push({ key: row.keyword_key, remapped: target !== row.keyword_id });
      }
    }
    const categoryRows = categoryAssetsByChar.get(character.id) ?? [];
    const categoryPlan = [];
    for (const row of categoryRows) {
      const target = prodCategoryBySlug.get(row.category_slug);
      if (!target) {
        notes.push(`Category "${row.category_slug}" does not exist in Production; that placement will not be applied.`);
      } else {
        categoryPlan.push({
          slug: row.category_slug,
          remapped: target !== row.category_id,
          assetId: row.asset_id,
          position: row.position,
          featured: row.featured,
        });
      }
    }

    /* -- persona integrity --------------------------------------------- */
    if (persona?.source_asset_id) {
      const owner = assetOwner.get(persona.source_asset_id);
      if (owner !== character.id) {
        notes.push(`Her persona cites source asset ${persona.source_asset_id}, which is not one of hers; that reference will be cleared rather than pointed at a stranger.`);
      }
    }

    /* -- what gets rewritten on the way in ----------------------------- */
    const published = assets.filter((a) => a.published_at !== null).length;
    if (published > 0) notes.push(`${published} published asset(s) arrive as UNPUBLISHED drafts.`);
    const attributed = assets.filter((a) => a.approved_by || a.archived_by).length;
    if (attributed > 0) notes.push(`${attributed} asset(s) carry a Staging operator id in approved_by/archived_by; those are cleared, because Production has different user records.`);
    if (character.status !== 'inactive') {
      const because = categoryPlan.length > 0
        ? ` This is what keeps her ${categoryPlan.length} category placement(s) invisible until you release her.`
        : '';
      notes.push(`Arrives INACTIVE (she is "${character.status}" on Staging). Her status is the gate every public surface checks.${because}`);
    }

    const entry = {
      character, identities, assets, persona,
      keywords: keywordPlan, categories: categoryPlan,
      fileCount, byteCount, notes,
    };
    if (reasons.length > 0) plan.block.push({ ...entry, reasons });
    else plan.insert.push(entry);
  }

  plan.insert.sort((a, b) => a.character.name.localeCompare(b.character.name));
  return plan;
};

/**
 * The token that ties an approval to a specific plan.
 *
 * Deliberately covers the SHAPE of the work -- which characters, how many
 * assets, how many files, how many bytes -- so that anything materially
 * different on the target produces a different token and apply refuses.
 */
const planToken = (plan) => {
  const totals = plan.insert.reduce(
    (acc, e) => ({
      assets: acc.assets + e.assets.length,
      files: acc.files + e.fileCount,
      bytes: acc.bytes + e.byteCount,
    }),
    { assets: 0, files: 0, bytes: 0 },
  );
  return createHash('sha256')
    .update(JSON.stringify({
      names: plan.insert.map((e) => e.character.name).sort(),
      ...totals,
    }))
    .digest('hex')
    .slice(0, 16);
};

const runPlan = async () => {
  const manifest = loadManifest();
  if (manifest.kind !== 'over18-content-manifest') die('That file is not a content manifest.');

  const { Client } = await import('pg');
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const target = await readTarget(db);
  await db.end();

  report(manifest, computePlan(manifest, target), target.prodCounts);
};

/* ------------------------------------------------------------------ *
 * The report
 * ------------------------------------------------------------------ */

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const rule = (char = '-') => char.repeat(78);

const report = (manifest, plan, prodCounts) => {
  const out = (s = '') => process.stdout.write(`${s}\n`);
  const totalAssets = plan.insert.reduce((n, e) => n + e.assets.length, 0);
  const totalFiles = plan.insert.reduce((n, e) => n + e.fileCount, 0);
  const totalBytes = plan.insert.reduce((n, e) => n + e.byteCount, 0);
  const totalPublished = plan.insert.reduce(
    (n, e) => n + e.assets.filter((a) => a.published_at !== null).length, 0);

  out();
  out(rule('='));
  out('  STAGING -> PRODUCTION CONTENT SYNC : DRY RUN');
  out(`  manifest taken ${manifest.takenAt}`);
  out(`  planned        ${new Date().toISOString()}`);
  out(rule('='));
  out();
  out('NOTHING WAS WRITTEN. This mode cannot write; the apply path does not exist');
  out('in this file. Figures below describe what an approved apply would do.');
  out();

  out(rule());
  out('  WHAT WOULD BE INSERTED');
  out(rule());
  out();
  out(`  Characters            ${plan.insert.length}`);
  out(`  Visual identities     ${plan.insert.reduce((n, e) => n + e.identities.length, 0)}`);
  out(`  Personas              ${plan.insert.filter((e) => e.persona).length}`);
  out(`  Visual assets         ${totalAssets}   (${totalPublished} published on Staging -> all arrive as drafts)`);
  out(`  Media files           ${totalFiles}   ${mb(totalBytes)}`);
  out(`  Keyword links         ${plan.insert.reduce((n, e) => n + e.keywords.length, 0)}`);
  out(`  Category placements   ${plan.insert.reduce((n, e) => n + e.categories.length, 0)}`);
  out();

  if (plan.insert.length > 0) {
    out(`  ${'character'.padEnd(14)}${'assets'.padStart(7)}${'files'.padStart(7)}${'size'.padStart(11)}  persona`);
    for (const e of plan.insert.sort((a, b) => a.character.name.localeCompare(b.character.name))) {
      out(`  ${e.character.name.padEnd(14)}${String(e.assets.length).padStart(7)}${String(e.fileCount).padStart(7)}${mb(e.byteCount).padStart(11)}  ${e.persona ? 'yes' : 'NO'}`);
    }
    out();
  }

  const noted = plan.insert.filter((e) => e.notes.length > 0);
  if (noted.length > 0) {
    out(rule());
    out('  CHANGES MADE ON THE WAY IN');
    out(rule());
    out();
    for (const e of noted) {
      out(`  ${e.character.name}`);
      for (const n of e.notes) out(`     - ${n}`);
    }
    out();
  }

  const activeOnStaging = plan.insert.filter((e) => e.character.status === 'active').length;
  const placements = plan.insert.reduce((n, e) => n + e.categories.length, 0);
  out(rule());
  out('  WHY NONE OF THIS GOES LIVE ON ARRIVAL');
  out(rule());
  out();
  out(`  ${activeOnStaging} of the ${plan.insert.length} candidates are ACTIVE on Staging, and they carry`);
  out(`  ${placements} category placements between them.`);
  out();
  out('  Clearing published_at alone would NOT have been enough. Publication is');
  out('  per-channel: the Posts channel reads published_at, but the category');
  out('  channel only asks whether the asset sits in a home-published category.');
  out('  An asset in the "new" rail is reachable with published_at still NULL.');
  out();
  out('  So every character is inserted INACTIVE, which is the gate every public');
  out('  surface checks. Releasing her is one deliberate action per character,');
  out('  and her placements and drafts are waiting when you do.');
  out();

  out(rule());
  out(`  SKIPPED  (${plan.skip.length})  -- already in Production, never modified`);
  out(rule());
  out();
  if (plan.skip.length === 0) out('  none');
  else {
    const grouped = new Map();
    for (const s of plan.skip) {
      if (!grouped.has(s.reason)) grouped.set(s.reason, []);
      grouped.get(s.reason).push(s);
    }
    for (const [reason, rows] of grouped) {
      out(`  ${reason}  (${rows.length})`);
      if (reason === 'already_in_production') {
        out(`     ${rows.map((r) => r.character.name).join(', ')}`);
      } else {
        for (const r of rows) out(`     ${r.character.name}: ${r.detail}`);
      }
      out();
    }
  }
  out();

  out(rule());
  out(`  BLOCKED  (${plan.block.length})  -- would not be inserted, and why`);
  out(rule());
  out();
  if (plan.block.length === 0) out('  none');
  for (const b of plan.block.sort((x, y) => x.character.name.localeCompare(y.character.name))) {
    out(`  ${b.character.name}`);
    for (const r of b.reasons) out(`     ! ${r}`);
    out();
  }
  out();

  out(rule());
  out('  PRODUCTION, UNTOUCHED');
  out(rule());
  out();
  out(`  characters ${prodCounts.characters}   assets ${prodCounts.assets}   conversations ${prodCounts.conversations}   messages ${prodCounts.messages}`);
  out();
  out('  After an approved apply, conversations and messages must be UNCHANGED.');
  out(`  characters would become ${prodCounts.characters} + ${plan.insert.length} = ${prodCounts.characters + plan.insert.length}`);
  out(`  assets would become     ${prodCounts.assets} + ${totalAssets} = ${prodCounts.assets + totalAssets}`);
  out();
  out(`  Writable tables : ${WRITABLE_TABLES.join(', ')}`);
  out(`  Excluded        : ${EXCLUDED_TABLES.length} tables, including users, wallets,`);
  out('                    payments, subscriptions, conversations, messages, analytics,');
  out('                    the economy, Home curation and the taxonomy.');
  out();

  out(rule());
  out('  IDEMPOTENCY');
  out(rule());
  out();
  out('  Staging UUIDs are preserved, so the primary key is the dedupe key and a');
  out('  rerun is a no-op: every candidate would move to SKIPPED. This is only');
  out('  sound because no candidate UUID exists in Production -- checked above,');
  out('  per character, per identity, per asset. A collision BLOCKS; it never');
  out('  falls back to remapping.');
  out();

  out(rule('='));
  out('  NEXT STEP');
  out(rule('='));
  out();
  out(`  Plan token: ${planToken(plan)}`);
  out();
  out('  Applying is a SEPARATE approval and needs this exact token:');
  out('    --mode=apply --confirm=<token>');
  out('  Apply re-derives the plan against the live target and refuses if the');
  out('  token has moved, so an approval cannot be replayed against changed data.');
  out();
  if (PARTIAL_ASSETS) {
    out('  NOTE: --partial-assets was set, so characters with unusable media would');
    out('  be inserted INCOMPLETE. Re-run without it for the safe plan.');
    out();
  }
};

/* ------------------------------------------------------------------ *
 * apply -- the only mode that writes
 * ------------------------------------------------------------------ */

/**
 * Insert one character and everything that belongs to her, in ONE transaction.
 *
 * ON CONFLICT DO NOTHING on every statement, so a rerun after a partial
 * failure cannot duplicate a row and cannot fail on one that already landed.
 * Combined with preserved UUIDs that makes the whole operation idempotent
 * without a bookkeeping table to fall out of step with reality.
 *
 * WHAT IS DELIBERATELY REWRITTEN ON THE WAY IN:
 *   status        -> 'inactive', always, whatever Staging says. This is the
 *                    gate every public surface checks, so it is what keeps the
 *                    import invisible until an operator releases her.
 *   published_at  -> NULL on every asset. Not sufficient on its own (see the
 *                    header), but correct.
 *   approved_by   -> NULL, and archived_by too. They reference Staging's
 *   archived_by      operator accounts, which do not exist here. approved_at
 *                    is KEPT: the approval happened, and a timestamp with no
 *                    actor is honest where a fabricated actor would not be.
 *   source_asset_id  kept only when it points at one of her own migrating
 *                    assets; otherwise NULL rather than at a stranger.
 */
const insertCharacter = async (db, entry, maps) => {
  const { character, identities, assets, persona, keywords, categories } = entry;
  const counts = { identities: 0, assets: 0, personas: 0, keywords: 0, categories: 0 };

  await db.query('begin');
  try {
    await db.query(
      `insert into characters (
         id, name, display_name, profile_image, short_bio, personality, interests,
         conversation_style, system_prompt, status, live_call_voice,
         country_code, region, city, timezone, age,
         grok_voice, grok_speaking_style, grok_call_instructions,
         created_at, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'inactive',$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
       on conflict (id) do nothing`,
      [
        character.id, character.name, character.display_name, character.profile_image,
        character.short_bio, character.personality, character.interests,
        character.conversation_style, character.system_prompt, character.live_call_voice,
        character.country_code, character.region, character.city, character.timezone,
        character.age, character.grok_voice, character.grok_speaking_style,
        character.grok_call_instructions, character.created_at, character.updated_at,
      ],
    );

    for (const identity of identities) {
      const r = await db.query(
        `insert into character_visual_identities
           (id, character_id, version, status, visual_dna, label, created_at, updated_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict (id) do nothing`,
        [identity.id, identity.character_id, identity.version, identity.status,
          identity.visual_dna, identity.label, identity.created_at, identity.updated_at],
      );
      counts.identities += r.rowCount;
    }

    for (const asset of assets) {
      const r = await db.query(
        `insert into character_visual_assets (
           id, character_id, visual_identity_id, kind, status, is_canonical, position,
           storage_key, provenance, content_rating, approved_by, approved_at,
           requirement_key, published_at, origin, archived_at, archived_by,
           created_at, updated_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NULL,$11,$12,NULL,$13,$14,NULL,$15,$16)
         on conflict (id) do nothing`,
        [asset.id, asset.character_id, asset.visual_identity_id, asset.kind, asset.status,
          asset.is_canonical, asset.position, asset.storage_key, asset.provenance,
          asset.content_rating, asset.approved_at, asset.requirement_key,
          asset.origin, asset.archived_at, asset.created_at, asset.updated_at],
      );
      counts.assets += r.rowCount;
    }

    if (persona) {
      const ownAsset = assets.some((a) => a.id === persona.source_asset_id);
      const r = await db.query(
        `insert into character_personas
           (character_id, persona, edited_fields, source_asset_id, generated_at, created_at, updated_at)
         values ($1,$2,$3,$4,$5,$6,$7) on conflict (character_id) do nothing`,
        [persona.character_id, persona.persona, persona.edited_fields,
          ownAsset ? persona.source_asset_id : null,
          persona.generated_at, persona.created_at, persona.updated_at],
      );
      counts.personas += r.rowCount;
    }

    for (const link of keywords) {
      const keywordId = maps.keywordByKey.get(link.key);
      if (!keywordId) continue;
      const r = await db.query(
        `insert into character_keywords (character_id, keyword_id)
         values ($1,$2) on conflict (character_id, keyword_id) do nothing`,
        [character.id, keywordId],
      );
      counts.keywords += r.rowCount;
    }

    for (const placement of categories) {
      const categoryId = maps.categoryBySlug.get(placement.slug);
      if (!categoryId) continue;
      const r = await db.query(
        `insert into app_category_assets (category_id, asset_id, position, featured)
         values ($1,$2,$3,$4) on conflict (category_id, asset_id) do nothing`,
        [categoryId, placement.assetId, placement.position, placement.featured],
      );
      counts.categories += r.rowCount;
    }

    await db.query('commit');
    return { ok: true, counts };
  } catch (error) {
    await db.query('rollback');
    return { ok: false, error: error.message, counts };
  }
};

const runApply = async () => {
  const manifest = loadManifest();
  if (manifest.kind !== 'over18-content-manifest') die('That file is not a content manifest.');

  const confirm = opt('confirm');
  if (!confirm) {
    die(
      'Apply needs the token printed by the dry run:\n' +
      '    --mode=apply --confirm=<token>\n' +
      '  Run --mode=plan first and read what it says it would do.',
    );
  }

  const { Client } = await import('pg');
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();

  const target = await readTarget(db);
  const plan = computePlan(manifest, target);
  const token = planToken(plan);

  if (token !== confirm) {
    await db.end();
    die(
      `The plan has changed since it was approved.\n` +
      `    approved: ${confirm}\n` +
      `    now     : ${token}\n` +
      '  Re-run --mode=plan, read the new report, and approve that instead.',
    );
  }

  const out = (s = '') => process.stdout.write(`${s}\n`);
  out();
  out(rule('='));
  out('  STAGING -> PRODUCTION CONTENT SYNC : APPLY');
  out(`  token ${token} (matches the approved plan)`);
  out(rule('='));
  out();

  /**
   * MEDIA FIRST, ALWAYS.
   *
   * The files must already be on this volume before any row references them,
   * so a half-finished run leaves orphaned FILES -- which are invisible and
   * harmless -- rather than rows pointing at nothing, which is a broken card
   * in front of a customer. Verified by stat and a real read, exactly as the
   * export verified the source.
   */
  const storageDir = process.env.MEDIA_STORAGE_DIR ?? 'var/media';
  if (!NO_MEDIA_CHECK) {
    out('  Verifying media is already on this volume...');
    const missing = [];
    for (const entry of plan.insert) {
      for (const asset of entry.assets) {
        const probe = manifest.media[asset.id];
        if (!probe?.resolved) continue;
        for (const file of probe.files) {
          if (!file.ok || file.optional) continue;
          const here = verifyFile(file.path, false);
          if (!here.ok) missing.push({ name: entry.character.name, path: file.path, why: here.reason });
          else if (here.size !== file.size) {
            missing.push({ name: entry.character.name, path: file.path, why: `size ${here.size} != source ${file.size}` });
          }
        }
      }
    }
    if (missing.length > 0) {
      await db.end();
      const sample = missing.slice(0, 6).map((m) => `    ${m.name}: ${m.path} (${m.why})`).join('\n');
      die(
        `${missing.length} media file(s) are not on this volume yet, so no rows were inserted.\n` +
        `  Copy the media across first, then re-run apply.\n${sample}`,
      );
    }
    out(`  OK -- every required file is present and the right size (root ${storageDir}).`);
  } else {
    out('  !! MEDIA CHECK SKIPPED (--no-media-check). Rehearsal only; never for Production.');
  }
  out();

  const maps = {
    keywordByKey: new Map(target.prodKeywords.map((k) => [k.key, k.id])),
    categoryBySlug: new Map(target.prodCategories.map((c) => [c.slug, c.id])),
  };

  const results = [];
  for (const entry of plan.insert) {
    const result = await insertCharacter(db, entry, maps);
    results.push({ name: entry.character.name, ...result });
    const c = result.counts;
    out(result.ok
      ? `  ${entry.character.name.padEnd(14)} ok    identities ${c.identities}  assets ${c.assets}  persona ${c.personas}  categories ${c.categories}`
      : `  ${entry.character.name.padEnd(14)} FAILED  ${result.error}`);
  }
  out();

  /* -- verification, against the database rather than against hope -- */
  const after = await readTarget(db);
  const names = plan.insert.map((e) => e.character.name);
  const landed = await db.query(
    `select c.name, c.status::text as status,
            (select count(*) from character_visual_assets a where a.character_id = c.id)::int as assets,
            (select count(*) from character_visual_assets a where a.character_id = c.id and a.published_at is not null)::int as published,
            (select count(*) from character_visual_identities i where i.character_id = c.id)::int as identities,
            (select count(*) from character_personas p where p.character_id = c.id)::int as personas
       from characters c where c.name = any($1) order by c.name`,
    [names],
  );
  await db.end();

  const expected = new Map(plan.insert.map((e) => [e.character.name, e]));
  const problems = [];
  for (const row of landed.rows) {
    const want = expected.get(row.name);
    if (row.status !== 'inactive') problems.push(`${row.name} is ${row.status}, expected inactive`);
    if (row.assets !== want.assets.length) problems.push(`${row.name} has ${row.assets} assets, expected ${want.assets.length}`);
    if (row.published !== 0) problems.push(`${row.name} has ${row.published} PUBLISHED assets, expected 0`);
    if (row.identities !== want.identities.length) problems.push(`${row.name} has ${row.identities} identities, expected ${want.identities.length}`);
    if (row.personas !== (want.persona ? 1 : 0)) problems.push(`${row.name} persona count ${row.personas}`);
  }
  if (landed.rows.length !== names.length) {
    problems.push(`${names.length - landed.rows.length} character(s) did not land at all`);
  }
  if (after.prodCounts.conversations !== target.prodCounts.conversations) {
    problems.push(`CONVERSATIONS CHANGED: ${target.prodCounts.conversations} -> ${after.prodCounts.conversations}`);
  }
  if (after.prodCounts.messages !== target.prodCounts.messages) {
    problems.push(`MESSAGES CHANGED: ${target.prodCounts.messages} -> ${after.prodCounts.messages}`);
  }

  out(rule());
  out('  VERIFICATION');
  out(rule());
  out();
  out(`  characters     ${target.prodCounts.characters} -> ${after.prodCounts.characters}`);
  out(`  assets         ${target.prodCounts.assets} -> ${after.prodCounts.assets}`);
  out(`  conversations  ${target.prodCounts.conversations} -> ${after.prodCounts.conversations}   ${after.prodCounts.conversations === target.prodCounts.conversations ? 'UNCHANGED' : 'CHANGED !!'}`);
  out(`  messages       ${target.prodCounts.messages} -> ${after.prodCounts.messages}   ${after.prodCounts.messages === target.prodCounts.messages ? 'UNCHANGED' : 'CHANGED !!'}`);
  out();
  out(`  inserted ${landed.rows.length} of ${names.length} characters`);
  out();
  if (problems.length > 0) {
    out('  PROBLEMS:');
    for (const p of problems) out(`     ! ${p}`);
    out();
    process.exitCode = 2;
  } else {
    out('  No discrepancies. Every character is inactive, carries the expected');
    out('  identities, assets and persona, and nothing published.');
    out();
    out('  The 25 are now in Production and invisible. Release them one at a');
    out('  time from Admin when you are ready.');
    out();
  }
  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) process.exitCode = 2;
};

/* ------------------------------------------------------------------ *
 * Entry
 * ------------------------------------------------------------------ */

if (MODE === 'export') await runExport();
else if (MODE === 'plan') await runPlan();
else if (MODE === 'apply') await runApply();
else die('Use --mode=export (inside Staging), --mode=plan, or --mode=apply --confirm=<token>.');
