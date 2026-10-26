#!/bin/sh
#
# One scheduled Production database backup, verified before it is uploaded.
#
# -- IT VERIFIES BEFORE IT UPLOADS ------------------------------------------
#
# An unverified backup is worse than no backup, because it is believed. So the
# dump is checked twice before anything leaves this container: the PGDMP magic
# proves pg_dump wrote an archive rather than an error message, and
# `pg_restore --list` proves the archive's table of contents actually decodes.
# A failure here exits non-zero, Railway marks the run failed, and crucially
# NOTHING is uploaded and NOTHING is pruned -- so the last good backup stays
# the newest object in the bucket rather than being replaced by a broken one.
#
# -- RETENTION PRUNES ONLY AFTER A GOOD UPLOAD -----------------------------
#
# Same reasoning. Deleting old backups is only safe once a new one is known to
# be good and known to have arrived, so the prune is the last step and runs
# only if everything before it succeeded.
#
# -- WHAT THIS DELIBERATELY DOES NOT DO ------------------------------------
#
# The media volume. A Railway volume attaches to exactly one service, so this
# service cannot read the API's /app/var/media no matter what it is given.
# Media is backed up from a workstation with apps/api/scripts/backup-production.ps1,
# which is acceptable because media only changes when an operator uploads --
# unlike the database, which changes with every conversation.
#
# Required environment:
#   DATABASE_URL      reference to the Postgres service, e.g. ${{Postgres.DATABASE_URL}}
#   R2_BUCKET         destination bucket name
#   RETENTION_DAYS    how long to keep backups (default 30)
#   RCLONE_CONFIG_R2_TYPE=s3
#   RCLONE_CONFIG_R2_PROVIDER=Cloudflare
#   RCLONE_CONFIG_R2_ENDPOINT          https://<account>.r2.cloudflarestorage.com
#   RCLONE_CONFIG_R2_ACCESS_KEY_ID
#   RCLONE_CONFIG_R2_SECRET_ACCESS_KEY
#   RCLONE_CONFIG_R2_REGION=auto
#
set -eu

RETENTION_DAYS="${RETENTION_DAYS:-30}"
STAMP="$(date -u +%Y-%m-%dT%H%M%SZ)"
DUMP="/tmp/over18-${STAMP}.dump"
REMOTE="r2:${R2_BUCKET}/database/${STAMP}.dump"

log() { echo "[$(date -u +%H:%M:%S)] $*"; }
fail() { echo "[$(date -u +%H:%M:%S)] FAILED: $*" >&2; exit 1; }

for v in DATABASE_URL R2_BUCKET RCLONE_CONFIG_R2_ENDPOINT \
         RCLONE_CONFIG_R2_ACCESS_KEY_ID RCLONE_CONFIG_R2_SECRET_ACCESS_KEY; do
  eval "value=\${$v:-}"
  [ -n "$value" ] || fail "$v is not set"
done

log "dumping"
pg_dump "$DATABASE_URL" -Fc -Z9 > "$DUMP" || fail "pg_dump failed"

SIZE="$(wc -c < "$DUMP" | tr -d ' ')"
log "dump is ${SIZE} bytes"

# A dump that is suspiciously small is usually an auth failure captured as
# text. The real article is a few hundred KB and growing.
[ "$SIZE" -gt 100000 ] || fail "dump is only ${SIZE} bytes, which is implausible"

# 'PGDMP' is the custom-format header.
MAGIC="$(head -c 5 "$DUMP")"
[ "$MAGIC" = "PGDMP" ] || fail "dump does not start with PGDMP (got '${MAGIC}')"

TOC="$(pg_restore --list "$DUMP" | grep -c 'TABLE DATA' || true)"
[ "$TOC" -gt 0 ] || fail "the archive decoded no table data"
log "verified: valid PGDMP archive, ${TOC} table-data entries"

log "uploading to ${REMOTE}"
rclone copyto "$DUMP" "$REMOTE" --s3-no-check-bucket || fail "upload failed"

# Confirm it is actually there and the right size, rather than trusting that
# the upload command returned zero.
REMOTE_SIZE="$(rclone size "$REMOTE" --json 2>/dev/null | sed -n 's/.*"bytes":\([0-9]*\).*/\1/p')"
[ "$REMOTE_SIZE" = "$SIZE" ] || fail "uploaded ${REMOTE_SIZE} bytes but the dump is ${SIZE}"
log "upload confirmed at ${REMOTE_SIZE} bytes"

rm -f "$DUMP"

log "pruning backups older than ${RETENTION_DAYS} days"
rclone delete "r2:${R2_BUCKET}/database" --min-age "${RETENTION_DAYS}d" || \
  log "WARNING: prune failed; the new backup is safe, so this is not fatal"

KEPT="$(rclone lsf "r2:${R2_BUCKET}/database" | wc -l | tr -d ' ')"
log "done -- ${KEPT} backup(s) in the bucket"
