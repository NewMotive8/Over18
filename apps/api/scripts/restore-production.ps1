<#
.SYNOPSIS
  Restore an OVER18 backup -- database and/or media -- into a Railway service.

.DESCRIPTION
  The other half of backup-production.ps1. A backup nobody has ever restored
  is a hope, not a backup.

  IT DEFAULTS TO REFUSING. Restoring is destructive: it drops and recreates
  every object the dump contains. So the target is never implicit -- you name
  the environment and the service, and if that environment is `production` you
  must also pass -YesReallyProduction. The intended target for a real recovery
  is a NEW, EMPTY database, not the one currently serving customers.

  HOW THE BYTES GET THERE. pg_restore and tar run inside the Railway
  container, reading the archive from stdin, so nothing is written to the
  container's filesystem and no client tools are needed on Windows. Raw binary
  survives `railway ssh` intact in both directions -- verified by round-
  tripping a known file and comparing SHA256 -- so there is no base64 step and
  no need to hold a 640 MB archive in memory.

  LOCALE MATTERS, and this is the one thing a restore can get subtly wrong.
  Production runs en_US.utf8. A cluster created with a different LC_CTYPE will
  sort text indexes differently and will quote composite values differently.
  If you create a replacement database yourself, create it with
  LC_COLLATE/LC_CTYPE of en_US.utf8.

.PARAMETER DumpFile
  database.dump from a backup folder. Restored with --clean --if-exists
  --no-owner --no-privileges, so it is repeatable and lands cleanly in a
  database whose role names differ.

.PARAMETER MediaArchive
  media.tar.gz from a backup folder. Extracted over /app/var/media.

.PARAMETER Environment
  Railway environment to restore INTO. No default, on purpose.

.EXAMPLE
  # Rehearse into staging's database service (NOT the live staging database --
  # point -DatabaseName at a scratch database you created for the purpose):
  .\restore-production.ps1 -Environment staging -PostgresService Postgres-1TcV `
      -DumpFile C:\Users\you\Over18-Backups\2026-10-26_1131\database.dump `
      -DatabaseName restore_check

.EXAMPLE
  # Real recovery of the database into production, after creating it empty:
  .\restore-production.ps1 -Environment production -PostgresService Postgres `
      -DumpFile ...\database.dump -DatabaseName railway -YesReallyProduction
#>

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Environment,
  [string]$PostgresService,
  [string]$ApiService = 'Over18',
  [string]$DumpFile,
  [string]$MediaArchive,
  [string]$DatabaseName = 'railway',
  [string]$DatabaseUser = 'postgres',
  [string]$MediaRoot = '/app/var/media',
  [switch]$YesReallyProduction,
  [switch]$ListOnly
)

$ErrorActionPreference = 'Stop'
$ProjectId = '70fbf63f-4ffa-482c-9682-2f16c13344da'

function Write-Step { param([string]$Text) Write-Host "`n==> $Text" -ForegroundColor Cyan }
function Write-Ok   { param([string]$Text) Write-Host "    OK  $Text" -ForegroundColor Green }

if (-not $DumpFile -and -not $MediaArchive) {
  throw "Nothing to do: pass -DumpFile and/or -MediaArchive."
}
if ($DumpFile -and -not $PostgresService) {
  throw "-DumpFile needs -PostgresService (the Railway Postgres service name)."
}
if ($Environment -eq 'production' -and -not $YesReallyProduction -and -not $ListOnly) {
  throw @"
Refusing to restore into production without -YesReallyProduction.

A restore DROPS AND RECREATES every object in the dump. If Production is
currently serving customers, restore into a NEW database instead and
repoint the app once you have checked it.
"@
}

if (-not (Get-Command railway -ErrorAction SilentlyContinue)) {
  throw "The Railway CLI is not on PATH. Install it, run 'railway login', then try again."
}

function Invoke-RailwayWithStdin {
  param(
    [Parameter(Mandatory = $true)][string]$Service,
    [Parameter(Mandatory = $true)][string]$RemoteCommand,
    [Parameter(Mandatory = $true)][string]$InputFile
  )
  $inner = $RemoteCommand.Replace('"', '""')
  $line = "railway ssh --project $ProjectId --environment $Environment --service $Service -- sh -c ""$inner"" < ""$InputFile"""
  cmd /c $line
  if ($LASTEXITCODE -ne 0) { throw "railway ssh failed (exit $LASTEXITCODE)" }
}

Write-Host ""
Write-Host "OVER18 restore" -ForegroundColor White
Write-Host "  environment : $Environment"
if ($DumpFile)     { Write-Host "  database    : $DumpFile -> $DatabaseName on $PostgresService" }
if ($MediaArchive) { Write-Host "  media       : $MediaArchive -> $MediaRoot on $ApiService" }

# ---- Inspect before touching anything -------------------------------

if ($DumpFile) {
  if (-not (Test-Path $DumpFile)) { throw "No such dump file: $DumpFile" }
  Write-Step "Inspecting the dump (read-only)"
  # Listing the archive proves it decodes before we let it near a database.
  Invoke-RailwayWithStdin -Service $PostgresService `
    -RemoteCommand 'pg_restore --list | grep -c "TABLE DATA"' -InputFile $DumpFile
  Write-Ok "the archive decodes and reports its table-data entries"
}

if ($MediaArchive) {
  if (-not (Test-Path $MediaArchive)) { throw "No such media archive: $MediaArchive" }
  Write-Step "Inspecting the media archive (read-only, locally)"
  $entries = & tar -tzf $MediaArchive 2>$null
  if ($LASTEXITCODE -ne 0) { throw "The media archive could not be listed; it is unusable." }
  $count = ($entries | Where-Object { $_ -and (-not $_.EndsWith('/')) }).Count
  Write-Ok "$count files in the archive"
}

if ($ListOnly) {
  Write-Host "`n-ListOnly: nothing was changed." -ForegroundColor Yellow
  exit 0
}

# ---- Restore --------------------------------------------------------

if ($DumpFile) {
  Write-Step "Restoring the database"
  Write-Host "    pg_restore --clean --if-exists --no-owner --no-privileges"
  # --clean --if-exists makes this repeatable; --no-owner/--no-privileges let
  # it land in a database whose role names differ from the source.
  Invoke-RailwayWithStdin -Service $PostgresService `
    -RemoteCommand "pg_restore --clean --if-exists --no-owner --no-privileges -U $DatabaseUser -d $DatabaseName" `
    -InputFile $DumpFile
  Write-Ok "database restored"

  Write-Step "Verifying the database"
  $inner = "psql -U $DatabaseUser -d $DatabaseName -At -c ""select 'tables=' || count(*) from information_schema.tables where table_schema='public' and table_type='BASE TABLE'"""
  $esc = $inner.Replace('"', '""')
  cmd /c "railway ssh --project $ProjectId --environment $Environment --service $PostgresService -- sh -c ""$esc"" 2>nul"
}

if ($MediaArchive) {
  Write-Step "Restoring the media volume"
  Write-Host "    extracting over $MediaRoot -- existing files with the same names are replaced"
  Invoke-RailwayWithStdin -Service $ApiService `
    -RemoteCommand "mkdir -p $MediaRoot && cd $MediaRoot && tar -xzf -" `
    -InputFile $MediaArchive
  Write-Ok "media extracted"

  Write-Step "Verifying the media volume"
  cmd /c "railway ssh --project $ProjectId --environment $Environment --service $ApiService -- sh -c ""find $MediaRoot -type f | wc -l"" 2>nul"
  Write-Host "    compare that against filesInArchive in the backup's manifest.json"
}

Write-Host "`nRestore finished." -ForegroundColor Green
Write-Host "Check the app before considering the recovery complete: open a"
Write-Host "character, play a clip, and confirm a conversation still loads."
Write-Host ""
