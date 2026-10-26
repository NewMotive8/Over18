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

const runPlan = async () => {
  const manifest = loadManifest();
  if (manifest.kind !== 'over18-content-manifest') die('That file is not a content manifest.');

  const { Client } = await import('pg');
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const q = async (sql, params = []) => (await db.query(sql, params)).rows;

  const prodCharacters = await q('select id, name, status::text as status from characters');
  const prodIdentityIds = (await q('select id from character_visual_identities')).map((r) => r.id);
  const prodAssetIds = (await q('select id from character_visual_assets')).map((r) => r.id);
  const prodKeywords = await q('select id, key from content_keywords');
  const prodCategories = await q('select id, slug from app_categories');
  const prodRequirements = (await q('select key from content_requirements')).map((r) => r.key);
  const prodCounts = (await q(`
    select (select count(*) from characters)::int as characters,
           (select count(*) from character_visual_assets)::int as assets,
           (select count(*) from conversations)::int as conversations,
           (select count(*) from messages)::int as messages`))[0];
  await db.end();

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
        categoryPlan.push({ slug: row.category_slug, remapped: target !== row.category_id });
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

  report(manifest, plan, prodCounts);
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

  const token = createHash('sha256')
    .update(JSON.stringify({
      names: plan.insert.map((e) => e.character.name).sort(),
      assets: totalAssets, files: totalFiles, bytes: totalBytes,
    }))
    .digest('hex')
    .slice(0, 16);

  out(rule('='));
  out('  NEXT STEP');
  out(rule('='));
  out();
  out(`  Plan token: ${token}`);
  out();
  out('  Applying is a SEPARATE approval. The write path is not implemented in');
  out('  this file, so there is nothing to run accidentally. When approved, apply');
  out('  must re-derive this plan live and refuse if the token has changed.');
  out();
  if (PARTIAL_ASSETS) {
    out('  NOTE: --partial-assets was set, so characters with unusable media would');
    out('  be inserted INCOMPLETE. Re-run without it for the safe plan.');
    out();
  }
};

/* ------------------------------------------------------------------ *
 * Entry
 * ------------------------------------------------------------------ */

if (MODE === 'export') await runExport();
else if (MODE === 'plan') await runPlan();
else if (MODE === 'apply') {
  die(
    'Apply is not implemented. Inserting into Production is a separate, explicit\n' +
    '  approval, and this file deliberately contains no write path -- so there is\n' +
    '  no flag, no environment variable and no token that can make it write.',
  );
} else {
  die('Use --mode=export (inside Staging) or --mode=plan --manifest=<file>.');
}
