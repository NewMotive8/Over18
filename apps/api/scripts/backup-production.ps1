<#
.SYNOPSIS
  Back up OVER18 Production -- the PostgreSQL database AND the media volume --
  to a folder outside Railway and outside this repository, then verify both.

.DESCRIPTION
  Railway's own scheduled backups need a Pro plan. This needs nothing: pg_dump
  already lives in the Production Postgres container and the database is small
  (about 14 MB, roughly a 520 KB compressed dump).

  BOTH HALVES OR IT IS NOT A BACKUP. The clips are not in the database; they
  are files on the API service's volume. Restore the database alone and every
  card in the app points at a file that is not there. So this takes both and
  refuses to call a database-only run complete.

  WHY IT WRITES WITH cmd AND NOT POWERSHELL REDIRECTION. PowerShell's pipeline
  is text: it would re-encode the dump and corrupt it. `cmd /c ... > file`
  writes the bytes through untouched, which was verified by streaming a known
  file out and comparing SHA256 end to end. The same test is why there is no
  base64 here -- raw binary survives `railway ssh` intact, and base64 would
  mean holding roughly 870 MB of string in memory for the media archive.

.PARAMETER Destination
  Where backups are kept. Defaults to Over18-Backups in your user profile.
  The script REFUSES to write inside a git repository, so a backup full of
  customer data cannot be committed by accident.

.PARAMETER Keep
  How many dated backups to retain. Older ones are deleted after a successful
  run. Defaults to 14.

.EXAMPLE
  .\backup-production.ps1
  .\backup-production.ps1 -Destination D:\Backups\Over18 -Keep 30
  .\backup-production.ps1 -SkipMedia      # database only; reports as PARTIAL
#>

[CmdletBinding()]
param(
  [string]$Destination = (Join-Path $env:USERPROFILE 'Over18-Backups'),
  [int]$Keep = 14,
  [switch]$SkipMedia,
  [switch]$SkipDatabase
)

$ErrorActionPreference = 'Stop'

$ProjectId      = '70fbf63f-4ffa-482c-9682-2f16c13344da'
$Environment    = 'production'
$PostgresService = 'Postgres'
$ApiService     = 'Over18'
$MediaRoot      = '/app/var/media'

function Write-Step { param([string]$Text) Write-Host "`n==> $Text" -ForegroundColor Cyan }
function Write-Ok   { param([string]$Text) Write-Host "    OK  $Text" -ForegroundColor Green }
function Write-Bad  { param([string]$Text) Write-Host "    !!  $Text" -ForegroundColor Red }

# A backup of customer data must never land somewhere that gets committed.
function Assert-OutsideGitRepo {
  param([string]$Path)
  $probe = [System.IO.Path]::GetFullPath($Path)
  while ($probe) {
    if (Test-Path (Join-Path $probe '.git')) {
      throw "Refusing to write backups inside a git repository ($probe). Choose a -Destination outside your code."
    }
    $parent = Split-Path $probe -Parent
    if ($parent -eq $probe) { break }
    $probe = $parent
  }
}

# Stream a remote command's stdout straight to a file, bytes untouched.
function Invoke-RailwayToFile {
  param(
    [Parameter(Mandatory = $true)][string]$Service,
    [Parameter(Mandatory = $true)][string]$RemoteCommand,
    [Parameter(Mandatory = $true)][string]$OutFile
  )
  $inner = $RemoteCommand.Replace('"', '""')
  $line = "railway ssh --project $ProjectId --environment $Environment --service $Service -- sh -c ""$inner"" > ""$OutFile"" 2>nul"
  cmd /c $line
  if ($LASTEXITCODE -ne 0) { throw "railway ssh failed (exit $LASTEXITCODE) for service $Service" }
  if (-not (Test-Path $OutFile)) { throw "No output file was produced: $OutFile" }
}

# Capture a remote command's text output (small results only).
function Invoke-RailwayText {
  param(
    [Parameter(Mandatory = $true)][string]$Service,
    [Parameter(Mandatory = $true)][string]$RemoteCommand
  )
  $inner = $RemoteCommand.Replace('"', '""')
  $raw = cmd /c "railway ssh --project $ProjectId --environment $Environment --service $Service -- sh -c ""$inner"" 2>nul"
  if ($LASTEXITCODE -ne 0) { throw "railway ssh failed (exit $LASTEXITCODE) for service $Service" }
  return ($raw | Out-String).Trim()
}

function Get-Sha256 {
  param([string]$Path)
  return (Get-FileHash -Path $Path -Algorithm SHA256).Hash.ToLower()
}

function Test-Magic {
  param([string]$Path, [byte[]]$Expected)
  $stream = [System.IO.File]::OpenRead($Path)
  try {
    $buffer = New-Object byte[] $Expected.Length
    $read = $stream.Read($buffer, 0, $Expected.Length)
    if ($read -ne $Expected.Length) { return $false }
    for ($i = 0; $i -lt $Expected.Length; $i++) {
      if ($buffer[$i] -ne $Expected[$i]) { return $false }
    }
    return $true
  } finally { $stream.Dispose() }
}

# ---------------------------------------------------------------- run

Assert-OutsideGitRepo -Path $Destination

if (-not (Get-Command railway -ErrorAction SilentlyContinue)) {
  throw "The Railway CLI is not on PATH. Install it, run 'railway login', then try again."
}

$stamp = Get-Date -Format 'yyyy-MM-dd_HHmm'
$folder = Join-Path $Destination $stamp
New-Item -ItemType Directory -Force -Path $folder | Out-Null

Write-Host ""
Write-Host "OVER18 Production backup" -ForegroundColor White
Write-Host "  destination : $folder"
Write-Host "  started     : $(Get-Date -Format 'u')"

$report = [ordered]@{
  takenAt     = (Get-Date).ToUniversalTime().ToString('o')
  destination = $folder
  database    = $null
  media       = $null
  complete    = $false
}
$failures = @()

# ---- PostgreSQL ------------------------------------------------------

if (-not $SkipDatabase) {
  Write-Step "PostgreSQL"
  $dumpPath = Join-Path $folder 'database.dump'

  $expected = Invoke-RailwayText -Service $PostgresService `
    -RemoteCommand 'psql -U postgres -d railway -At -c "select count(*) from information_schema.tables where table_schema=''public'' and table_type=''BASE TABLE''"'
  Write-Host "    production reports $expected public tables"

  Invoke-RailwayToFile -Service $PostgresService `
    -RemoteCommand 'pg_dump -U postgres -d railway -Fc -Z9' `
    -OutFile $dumpPath

  $size = (Get-Item $dumpPath).Length
  # 'PGDMP' is the custom-format archive header. Its absence means the dump
  # failed and we captured an error message or nothing at all.
  $isDump = Test-Magic -Path $dumpPath -Expected ([byte[]](0x50, 0x47, 0x44, 0x4D, 0x50))

  if (-not $isDump) { Write-Bad "database.dump does not start with PGDMP -- not a valid dump"; $failures += 'database:bad-header' }
  elseif ($size -lt 100000) { Write-Bad "database.dump is only $size bytes, which is implausibly small"; $failures += 'database:too-small' }
  else { Write-Ok "database.dump  $([math]::Round($size/1KB,1)) KB  valid PGDMP archive" }

  $report.database = [ordered]@{
    file = 'database.dump'; bytes = $size; sha256 = (Get-Sha256 $dumpPath)
    validHeader = $isDump; expectedTables = $expected
  }
}
else { Write-Step "PostgreSQL -- SKIPPED (-SkipDatabase)" }

# ---- Media volume ----------------------------------------------------

if (-not $SkipMedia) {
  Write-Step "Media volume"
  $mediaPath = Join-Path $folder 'media.tar.gz'

  $remoteCount = Invoke-RailwayText -Service $ApiService -RemoteCommand "find $MediaRoot -type f | wc -l"
  $remoteSize  = Invoke-RailwayText -Service $ApiService -RemoteCommand "du -sb $MediaRoot | cut -f1"
  Write-Host "    production reports $remoteCount files, $([math]::Round([int64]$remoteSize/1MB,1)) MB"
  Write-Host "    transferring -- this is the slow part, expect several minutes"

  Invoke-RailwayToFile -Service $ApiService `
    -RemoteCommand "cd $MediaRoot && tar -czf - ." `
    -OutFile $mediaPath

  $mSize = (Get-Item $mediaPath).Length
  $isGzip = Test-Magic -Path $mediaPath -Expected ([byte[]](0x1F, 0x8B))

  # Windows ships bsdtar, so the archive can be listed and counted locally
  # rather than trusted. A tar that cannot be listed is not a backup.
  $localCount = 0
  $listed = $false
  if ($isGzip) {
    try {
      $entries = & tar -tzf $mediaPath 2>$null
      if ($LASTEXITCODE -eq 0) {
        $listed = $true
        $localCount = ($entries | Where-Object { $_ -and (-not $_.EndsWith('/')) }).Count
      }
    } catch { $listed = $false }
  }

  if (-not $isGzip) { Write-Bad "media.tar.gz is not a gzip archive"; $failures += 'media:bad-header' }
  elseif (-not $listed) { Write-Bad "media.tar.gz could not be listed -- the archive is unreadable"; $failures += 'media:unreadable' }
  elseif ($localCount -ne [int]$remoteCount) {
    Write-Bad "media.tar.gz holds $localCount files but Production has $remoteCount"
    $failures += 'media:count-mismatch'
  }
  else { Write-Ok "media.tar.gz  $([math]::Round($mSize/1MB,1)) MB  $localCount files, matches Production" }

  $report.media = [ordered]@{
    file = 'media.tar.gz'; bytes = $mSize; sha256 = (Get-Sha256 $mediaPath)
    validHeader = $isGzip; listable = $listed
    filesInArchive = $localCount; filesInProduction = [int]$remoteCount
  }
}
else {
  Write-Step "Media volume -- SKIPPED (-SkipMedia)"
  $failures += 'media:skipped'
}

# ---- Verdict and retention ------------------------------------------

$report.complete = ($failures.Count -eq 0)
# WriteAllText rather than Set-Content -Encoding utf8: PowerShell 5.1 writes a
# UTF-8 BOM, and a BOM makes the manifest unreadable to ordinary JSON parsers.
[System.IO.File]::WriteAllText(
  (Join-Path $folder 'manifest.json'),
  ($report | ConvertTo-Json -Depth 5))

Write-Host ""
if ($report.complete) {
  Write-Host "BACKUP COMPLETE AND VERIFIED" -ForegroundColor Green
  Write-Host "  $folder"
}
else {
  Write-Host "BACKUP INCOMPLETE" -ForegroundColor Yellow
  foreach ($f in $failures) { Write-Host "  - $f" -ForegroundColor Yellow }
  if ($failures -contains 'media:skipped') {
    Write-Host "  A database dump without the media volume is only half a backup:" -ForegroundColor Yellow
    Write-Host "  restoring it would leave every clip in the app pointing at nothing." -ForegroundColor Yellow
  }
}

# Only ever prune after a clean run, so a bad run cannot delete good history.
if ($report.complete -and $Keep -gt 0) {
  $all = Get-ChildItem -Path $Destination -Directory | Sort-Object Name -Descending
  if ($all.Count -gt $Keep) {
    $old = $all | Select-Object -Skip $Keep
    foreach ($dir in $old) {
      Remove-Item -Recurse -Force -Confirm:$false -Path $dir.FullName
      Write-Host "  pruned old backup $($dir.Name)"
    }
  }
}

Write-Host ""
if (-not $report.complete) { exit 1 }
