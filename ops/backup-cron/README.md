# Scheduled Production database backup → Cloudflare R2

**Not deployed.** These files are ready; the Railway service does not exist yet.

## Why it is shaped this way

The Production database has **no public proxy** — `PGHOST` is `postgres.railway.internal` and there are no `*_PUBLIC_*` variables. Nothing outside the Railway environment can reach it. That rules out GitHub Actions unless you either expose the database to the internet or hand CI an SSH key with your whole Railway account's privileges. Neither is a good trade for a backup job.

A service **inside** the production environment talks to the database over private networking: no public exposure, no account-wide credential, and it runs in Railway's cloud so nothing depends on your PC being on.

## What it does not do, and why that is fine

**It does not back up the media volume.** A Railway volume attaches to exactly one service, so this service cannot read the API's `/app/var/media` whatever you give it.

That asymmetry matches the data. The database changes with every conversation — it is irreplaceable and needs a daily automated copy. Media changes **only when you upload content**. So media stays a workstation job via `apps/api/scripts/backup-production.ps1`, run after you add clips and monthly regardless.

## Setup

### 1. Cloudflare R2

1. Cloudflare dashboard → **R2** → **Create bucket**, e.g. `over18-backups`.
2. **Manage R2 API Tokens** → create a token with **Object Read & Write**, scoped to that bucket only.
3. Note the **Access Key ID**, **Secret Access Key**, and your account's S3 endpoint: `https://<account-id>.r2.cloudflarestorage.com`

R2's free tier is 10 GB with no egress fees. A 522 KB dump a day for a year is about 190 MB, so retention is not a cost concern.

### 2. Railway service

In the **production** environment of project `OVER18`:

1. **New** → **GitHub Repo** → this repo.
2. Service **Settings → Build**: set **Root Directory** to `ops/backup-cron`. It will use the Dockerfile there.
3. Service **Settings → Deploy**: set **Cron Schedule** to `0 3 * * *` (03:00 UTC daily).
4. Name it something obvious, e.g. `backup-cron`.

A cron service must **exit** when finished. `backup.sh` does; do not add a long-running wrapper, or you will be billed as though it never stopped.

### 3. Variables

| Variable | Value |
|---|---|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` — a reference, not a copy, so it survives a credential rotation |
| `R2_BUCKET` | `over18-backups` |
| `RETENTION_DAYS` | `30` |
| `RCLONE_CONFIG_R2_TYPE` | `s3` |
| `RCLONE_CONFIG_R2_PROVIDER` | `Cloudflare` |
| `RCLONE_CONFIG_R2_ENDPOINT` | `https://<account-id>.r2.cloudflarestorage.com` |
| `RCLONE_CONFIG_R2_REGION` | `auto` |
| `RCLONE_CONFIG_R2_ACCESS_KEY_ID` | from step 1 |
| `RCLONE_CONFIG_R2_SECRET_ACCESS_KEY` | from step 1 |

`rclone` is configured entirely through those `RCLONE_CONFIG_R2_*` variables, so there is no config file to mount and no secret baked into the image.

### 4. First run

Use **Deploy** once manually rather than waiting for 03:00. A good run logs:

```
[hh:mm:ss] dumping
[hh:mm:ss] dump is 522059 bytes
[hh:mm:ss] verified: valid PGDMP archive, 61 table-data entries
[hh:mm:ss] uploading to r2:over18-backups/database/....dump
[hh:mm:ss] upload confirmed at 522059 bytes
[hh:mm:ss] pruning backups older than 30 days
[hh:mm:ss] done -- 1 backup(s) in the bucket
```

**The first deploy is also the build test.** I cannot build this image here — there is no Docker on this machine — so `apk add rclone` resolving and `postgres:18-alpine` being the right base are verified by that first run, not by me. If the build fails on the package, the fix is to enable Alpine's community repository explicitly in the `apk add` line.

## The safety properties worth knowing

- **It verifies before it uploads.** The `PGDMP` header proves `pg_dump` wrote an archive rather than an error message; `pg_restore --list` proves the archive decodes. A failure exits non-zero and uploads nothing — so a broken dump can never replace your newest good one.
- **It prunes last, and only after a confirmed upload.** Deleting old backups is only safe once the new one is known good *and* known to have arrived. The upload is re-read and its size compared before anything is deleted.
- **A failed prune is a warning, not a failure.** The new backup is already safe by then, so a transient R2 error should not mark the run failed.

## Restoring from R2

```powershell
rclone copyto r2:over18-backups/database/2026-10-27T030000Z.dump .\database.dump
.\apps\api\scripts\restore-production.ps1 -Environment production -PostgresService Postgres `
    -DumpFile .\database.dump -ListOnly
```

Drop `-ListOnly` and add `-YesReallyProduction` only when you mean it. **Create the recovery cluster with `--locale=en_US.utf8`** to match Production — collation affects text index ordering, and a mismatch is the kind of thing that looks fine until it does not.
