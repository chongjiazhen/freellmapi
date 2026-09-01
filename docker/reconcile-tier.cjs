#!/usr/bin/env node
/*
 * reconcile-tier.cjs - boot-time data-residency guard for a tier-segregated
 * freellmapi instance (see docker/README.md and the allowlist source
 * docker/tiers/clean.config.example.json). The per-provider privacy research
 * behind which providers are allowlisted is kept privately, not in this repo.
 *
 * PROBLEM IT CLOSES. Tiers are assigned by flipping flags in a DB that was
 * CLONED from the default instance (docker-compose.tiers.yml header). A re-clone,
 * or a careless api_keys toggle, silently re-arms a Tier-B provider (e.g. Google)
 * on the clean instance. The clone also copies the `migrations` ledger, so a
 * migration-based guard would show "already applied" and skip exactly when needed.
 * This runs UNCONDITIONALLY every boot, outside the migration ledger, and heals
 * the DB back to its declared allowlist before the server accepts traffic.
 *
 * ALLOWLIST = single source of truth. Reads platforms from TIER_ALLOWLIST_FILE
 * (a tiers/*.config.example.json, `keys[].platform`), else the TIER_ALLOWLIST
 * env (csv). Any platform NOT on the allowlist is removed from api_keys, models
 * AND media_models. Edit the json, the guard follows: no drift between the doc
 * and enforcement.
 *
 * FAIL POSTURE (matches freellmapi's "fail loud, never silently change residency"):
 *   - No allowlist configured        -> NO-OP, exit 0  (gray/default instance;
 *                                       the guard is only wired onto clean).
 *   - Allowlist set but unparseable / empty / DB won't open / driver missing
 *                                     -> FATAL, exit 1  (cannot verify, so do not
 *                                       boot un-verified; the `&&` in the compose
 *                                       command stops the server from starting).
 *   - Allowlist set, offenders found  -> HEAL (delete + disable), log, exit 0
 *                                       (a re-clone that arms Google boots with
 *                                       Google disabled, not clean-instance-down).
 *
 * An empty allowlist is treated as FATAL, never as "allow nothing, delete all":
 * a misparse must not wipe every provider.
 *
 * WIRING lives in docker-compose.override.yml, which is GITIGNORED and machine-local.
 * Deliberately NOT in the upstream-tracked docker-compose.yml: the guard hard-no-ops
 * without TIER_ALLOWLIST(_FILE), so upstream users should not be forced into a custom
 * command. Consequence: this comment is the only version-controlled record of the
 * wiring. Reproduce it verbatim on the clean service when rebuilding a box, or the
 * guard ships present-but-unwired and fails OPEN into the re-clone hole above.
 *   volumes:     - ./docker:/app/docker:ro
 *   environment: TIER_ALLOWLIST_FILE: /app/docker/tiers/clean.config.example.json
 *   command: ["sh","-c","NODE_PATH=/app/node_modules \
 *             node /app/docker/reconcile-tier.cjs && exec node server/dist/index.js"]
 * NODE_PATH lets the bare require() resolve better-sqlite3 (npm hoists it to
 * /app/node_modules, not server/node_modules); a script at /app/docker also
 * resolves it by normal walk-up, so NODE_PATH is belt-and-braces;
 * `exec` hands PID 1 to node so it still gets SIGTERM. The guard runs to completion
 * and exits BEFORE the server opens the DB, so there is no concurrent-open contention.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const TAG = '[tier-guard]';
function log(msg) { process.stdout.write(`${TAG} ${msg}\n`); }
function fatal(msg) { process.stderr.write(`${TAG} FATAL ${msg}\n`); process.exit(1); }

// --- 1. Resolve the allowlist (file preferred, env fallback) --------------
function allowlistFromFile(p) {
  let raw;
  try { raw = fs.readFileSync(p, 'utf8'); }
  catch (e) { fatal(`cannot read TIER_ALLOWLIST_FILE ${p}: ${e.message}`); }
  let json;
  try { json = JSON.parse(raw); }
  catch (e) { fatal(`TIER_ALLOWLIST_FILE ${p} is not valid JSON: ${e.message}`); }
  const keys = Array.isArray(json.keys) ? json.keys : [];
  const platforms = keys.map((k) => k && k.platform).filter((s) => typeof s === 'string' && s.length);
  return platforms;
}
function allowlistFromEnv(csv) {
  return csv.split(',').map((s) => s.trim()).filter(Boolean);
}

const file = (process.env.TIER_ALLOWLIST_FILE || '').trim();
const env = (process.env.TIER_ALLOWLIST || '').trim();
if (!file && !env) {
  log('no TIER_ALLOWLIST(_FILE) set; not a tiered instance, skipping.');
  process.exit(0);
}
const allow = file ? allowlistFromFile(file) : allowlistFromEnv(env);
if (allow.length === 0) {
  // Empty allowlist would mean "delete every provider": refuse rather than wipe.
  fatal(`allowlist resolved empty (source=${file || 'env'}); refusing to run.`);
}
const allowSet = new Set(allow.map((s) => s.toLowerCase()));

// --- 2. Open the DB (fatal if the driver or file is unavailable) ----------
let Database;
try { Database = require('better-sqlite3'); }
catch (e) { fatal(`cannot load better-sqlite3 (set NODE_PATH=/app/node_modules?): ${e.message}`); }

const dbPath = (process.env.FREEAPI_DB_PATH || '').trim()
  || path.resolve(__dirname, '../server/data/freeapi.db');
let db;
try { db = new Database(dbPath); }
catch (e) { fatal(`cannot open DB ${dbPath}: ${e.message}`); }

// --- 3. Heal: remove any platform not on the allowlist --------------------
try {
  // Scan chat models, media models, AND keys. media_models matters on two counts:
  // (a) media-only platforms (e.g. SiliconFlow) have no chat rows and, after their
  // key is deleted, no key row either, so they would escape an api_keys+models scan;
  // (b) pollinations media is KEYLESS_CAPABLE (media.ts) -- it routes anonymously,
  // so deleting the key does NOT stop it; the media row itself must be removed.
  const platforms = db.prepare('SELECT DISTINCT platform FROM api_keys').all().map((r) => r.platform)
    .concat(db.prepare('SELECT DISTINCT platform FROM models').all().map((r) => r.platform))
    .concat(db.prepare('SELECT DISTINCT platform FROM media_models').all().map((r) => r.platform));
  const offenders = [...new Set(platforms)].filter((p) => p && !allowSet.has(String(p).toLowerCase()));

  if (offenders.length === 0) {
    log(`clean: all providers within allowlist {${[...allowSet].sort().join(', ')}}. No changes.`);
    db.close();
    process.exit(0);
  }

  // Catalog-managed models (platform != 'custom', key_id IS NULL) are re-added by
  // catalog-sync on every sync UNLESS tombstoned. So mirror the app's own "user
  // deleted this model" path (routes/models.ts:177): record a chat tombstone,
  // drop overrides, then delete the model + its fallback. catalog-sync.ts:243
  // consults isCatalogModelTombstoned before insert, so a tombstoned model stays
  // gone across all future syncs instead of resurrecting into the auto-chain.
  // (Plain disable was not enough: the models kept coming back keyless.)
  const catalogModels = db.prepare('SELECT id, model_id FROM models WHERE platform = ? AND key_id IS NULL');
  const tombstone = db.prepare(
    "INSERT INTO catalog_model_tombstones (kind, platform, model_id) VALUES (?, ?, ?) "
    + "ON CONFLICT(kind, platform, model_id) DO UPDATE SET created_at = datetime('now')");
  const delOverrides = db.prepare('DELETE FROM model_overrides WHERE platform = ? AND model_id = ?');
  const delFallbackById = db.prepare('DELETE FROM fallback_config WHERE model_db_id = ?');
  const delModelById = db.prepare('DELETE FROM models WHERE id = ?');
  // Media models: tombstone (kind 'media', catalog-sync.ts:217 honours it) + delete.
  // No fallback_config for media (chat-only). Closes the pollinations keyless hole
  // and catches media-only platforms the chat scan misses.
  const mediaModels = db.prepare('SELECT id, model_id FROM media_models WHERE platform = ?');
  const delMediaById = db.prepare('DELETE FROM media_models WHERE id = ?');
  // Non-catalog rows (an explicit key_id) can't be tombstoned as catalog models;
  // disable them and strip their fallback. Rare, since the offender key is deleted.
  const disableKeyedModels = db.prepare('UPDATE models SET enabled = 0 WHERE platform = ? AND key_id IS NOT NULL AND enabled = 1');
  const delKeyedFallback = db.prepare('DELETE FROM fallback_config WHERE model_db_id IN (SELECT id FROM models WHERE platform = ? AND key_id IS NOT NULL)');
  const delKeys = db.prepare('DELETE FROM api_keys WHERE platform = ?');

  // Report by actual changes, not presence, so a healed instance logs "no changes".
  const summary = [];
  let grandTotal = 0;
  const heal = db.transaction((offs) => {
    for (const p of offs) {
      let tomb = 0;
      let media = 0;
      let fb = 0;
      for (const m of catalogModels.all(p)) {
        tombstone.run('chat', p, m.model_id);
        delOverrides.run(p, m.model_id);
        fb += delFallbackById.run(m.id).changes;
        delModelById.run(m.id);
        tomb++;
      }
      for (const m of mediaModels.all(p)) {
        tombstone.run('media', p, m.model_id);
        delMediaById.run(m.id);
        media++;
      }
      fb += delKeyedFallback.run(p).changes;
      const md = disableKeyedModels.run(p).changes;
      const ky = delKeys.run(p).changes;
      const total = tomb + media + md + ky + fb;
      if (total > 0) {
        grandTotal += total;
        summary.push(`${p}(keys-${ky} chat-${tomb} media-${media} disabled-${md} fallback-${fb})`);
      }
    }
  });
  heal(offenders);

  if (grandTotal === 0) {
    log(`clean: no off-allowlist providers active. allowlist {${[...allowSet].sort().join(', ')}}.`);
  } else {
    log(`HEALED off-allowlist providers: ${summary.join(', ')}`);
    log(`allowlist {${[...allowSet].sort().join(', ')}} enforced against ${dbPath}`);
  }
  db.close();
  process.exit(0);
} catch (e) {
  try { db.close(); } catch (_) { /* ignore */ }
  fatal(`reconcile failed against ${dbPath}: ${e.message}`);
}
