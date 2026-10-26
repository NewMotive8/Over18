<#
.SYNOPSIS
  Copy the new characters' media files from Staging to Production, resumably,
  and verify every byte by checksum afterwards.

.DESCRIPTION
  The content sync inserts database rows; this moves the files those rows
  point at. It must run FIRST, because content-sync.mjs refuses to insert a
  row whose file is not already on the destination volume -- an orphaned file
  is invisible and harmless, a row pointing at nothing is a broken card in
  front of a customer.

  WHY THIS IS A SCRIPT YOU RUN. Writing files inside the Production container
  is something my permissions refuse, and correctly: it is a privileged write
  to a live service. So the work is here, in the same shape as the backup
  scripts, for you to run and watch.

  WHY IT BATCHES BY CHARACTER. Each `railway ssh` call costs several seconds
  of setup, so 290 files transferred one at a time would mean hours. Tarring
  one character's folder at a time gives 25 batches instead of 290 round
  trips, keeps each transfer small enough to retry cheaply, and makes a
  character the natural unit of resume -- which matches how content-sync
  inserts them.

  WHY THE PATHS NEED NO REWRITING. The sync preserves the Staging character
  UUIDs, and media lives at <root>/<characterId>/uploads/<file>. So the
  destination path is identical to the source path, and a tar taken relative
  to the media root extracts to exactly the right place.

  RESUME. Progress is recorded per character in transfer-state.json in the
  working folder. Re-running skips characters already verified, so an
  interrupted run costs only the character it was in the middle of. Nothing
  is ever deleted from Production: tar extraction replaces same-named files
  and adds new ones, and these are new characters, so nothing of Production's
  shares a path.

  CHECKSUMS. SHA256 of every file is read from Staging before the transfer and
  from Production after it, and compared per file. Sizes alone would miss a
  truncated-then-padded transfer; a tar that extracted cleanly still proves
  nothing about the bytes inside it.

.PARAMETER Execute
  Required to actually transfer. Without it this reports what it would do and
  changes nothing.

.PARAMETER WorkFolder
  Where the temporary per-character archives and the resume state live.
  Defaults to Over18-MediaTransfer in your user profile. Archives are deleted
  as each character completes unless -KeepArchives is set.

.EXAMPLE
  .\transfer-media.ps1
  .\transfer-media.ps1 -Execute
  .\transfer-media.ps1 -Execute          # again, after an interruption: resumes
#>

[CmdletBinding()]
param(
  [switch]$Execute,
  [string]$WorkFolder = (Join-Path $env:USERPROFILE 'Over18-MediaTransfer'),
  [switch]$KeepArchives,
  [switch]$Recheck
)

$ErrorActionPreference = 'Stop'

$ProjectId         = '70fbf63f-4ffa-482c-9682-2f16c13344da'
$StagingEnv        = 'staging'
$StagingApiService = 'Over18 API Staging'
$ProdEnv           = 'production'
$ProdApiService    = 'Over18'
$MediaRoot         = '/app/var/media'

function Write-Step { param([string]$T) Write-Host "`n==> $T" -ForegroundColor Cyan }
function Write-Ok   { param([string]$T) Write-Host "    OK  $T" -ForegroundColor Green }
function Write-Bad  { param([string]$T) Write-Host "    !!  $T" -ForegroundColor Red }

if (-not (Get-Command railway -ErrorAction SilentlyContinue)) {
  throw "The Railway CLI is not on PATH. Install it, run 'railway login', then try again."
}

function Invoke-RemoteText {
  param([string]$Env, [string]$Service, [string]$Command)
  $inner = $Command.Replace('"', '""')
  $raw = cmd /c "railway ssh --project $ProjectId --environment $Env --service ""$Service"" -- sh -c ""$inner"" 2>nul"
  if ($LASTEXITCODE -ne 0) { throw "railway ssh failed (exit $LASTEXITCODE) on $Service" }
  return ($raw | Out-String)
}

# Binary out: cmd redirection, because PowerShell's pipeline is text and would
# re-encode the archive.
function Invoke-RemoteToFile {
  param([string]$Env, [string]$Service, [string]$Command, [string]$OutFile)
  $inner = $Command.Replace('"', '""')
  cmd /c "railway ssh --project $ProjectId --environment $Env --service ""$Service"" -- sh -c ""$inner"" > ""$OutFile"" 2>nul"
  if ($LASTEXITCODE -ne 0) { throw "railway ssh failed (exit $LASTEXITCODE) on $Service" }
}

function Invoke-RemoteFromFile {
  param([string]$Env, [string]$Service, [string]$Command, [string]$InFile)
  $inner = $Command.Replace('"', '""')
  cmd /c "railway ssh --project $ProjectId --environment $Env --service ""$Service"" -- sh -c ""$inner"" < ""$InFile"""
  if ($LASTEXITCODE -ne 0) { throw "railway ssh failed (exit $LASTEXITCODE) on $Service" }
}

New-Item -ItemType Directory -Force -Path $WorkFolder | Out-Null
$statePath = Join-Path $WorkFolder 'transfer-state.json'

# ---- Which characters, and which files -------------------------------

Write-Host ""
Write-Host "OVER18 media transfer: Staging -> Production" -ForegroundColor White
Write-Host "  work folder : $WorkFolder"
Write-Host "  media root  : $MediaRoot"

Write-Step "Working out which characters are new to Production"

# Node is already in both containers and reaches each environment's own
# database, so the candidate set is derived live rather than from a file that
# could be stale.
$listScript = @'
const { Client } = require("pg");
(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  const r = await c.query("select id, name from characters order by name");
  console.log("ROWS" + JSON.stringify(r.rows));
  await c.end();
})().catch(e => { console.error(e.message); process.exit(1); });
'@
$listFile = Join-Path $WorkFolder '_list.js'
[System.IO.File]::WriteAllText($listFile, $listScript)

function Get-Characters {
  param([string]$Env, [string]$Service)
  $inner = 'cd /app && node'
  $raw = cmd /c "railway ssh --project $ProjectId --environment $Env --service ""$Service"" -- sh -c ""$inner"" < ""$listFile"" 2>nul"
  $line = ($raw | Out-String) -split "`n" | Where-Object { $_ -like 'ROWS*' } | Select-Object -First 1
  if (-not $line) { throw "Could not read characters from $Service" }
  return ($line.Substring(4) | ConvertFrom-Json)
}

$stagingChars = Get-Characters -Env $StagingEnv -Service $StagingApiService
$prodChars    = Get-Characters -Env $ProdEnv    -Service $ProdApiService
$prodNames    = @($prodChars | ForEach-Object { $_.name })
$new          = @($stagingChars | Where-Object { $prodNames -notcontains $_.name } | Sort-Object name)

Write-Ok "$($stagingChars.Count) on Staging, $($prodChars.Count) on Production, $($new.Count) new"
if ($new.Count -eq 0) { Write-Host "`nNothing to transfer." -ForegroundColor Yellow; exit 0 }

Write-Step "Reading checksums from Staging"
$ids = ($new | ForEach-Object { './' + $_.id }) -join ' '
# One call for all 290 files: a call per file would cost hours in ssh setup.
$shaRaw = Invoke-RemoteText -Env $StagingEnv -Service $StagingApiService `
  -Command "cd $MediaRoot && find $ids -type f -exec sha256sum {} + 2>/dev/null"
$sourceFiles = @{}
foreach ($line in ($shaRaw -split "`n")) {
  $t = $line.Trim()
  if ($t -match '^([0-9a-f]{64})\s+(.+)$') { $sourceFiles[$Matches[2].Trim()] = $Matches[1] }
}
Write-Ok "$($sourceFiles.Count) files, checksummed at source"

$byCharacter = @{}
foreach ($c in $new) {
  $prefix = './' + $c.id + '/'
  $byCharacter[$c.name] = @($sourceFiles.Keys | Where-Object { $_.StartsWith($prefix) })
}

# ---- Resume state ----------------------------------------------------

$state = @{}
if (Test-Path $statePath) {
  $loaded = Get-Content $statePath -Raw | ConvertFrom-Json
  foreach ($p in $loaded.PSObject.Properties) { $state[$p.Name] = $p.Value }
  $done = @($state.Keys | Where-Object { $state[$_] -eq 'verified' })
  if ($done.Count -gt 0) { Write-Host "    resuming: $($done.Count) character(s) already verified" -ForegroundColor Yellow }
}
if ($Recheck) { $state = @{}; Write-Host "    -Recheck: ignoring previous progress" -ForegroundColor Yellow }

function Save-State { [System.IO.File]::WriteAllText($statePath, ($state | ConvertTo-Json)) }

$todo = @($new | Where-Object { $state[$_.name] -ne 'verified' })

# ---- Plan ------------------------------------------------------------

Write-Step "Plan"
$totalFiles = 0
foreach ($c in $todo) { $totalFiles += $byCharacter[$c.name].Count }
Write-Host "    characters to transfer : $($todo.Count) of $($new.Count)"
Write-Host "    files to transfer      : $totalFiles of $($sourceFiles.Count)"
foreach ($c in $todo) {
  Write-Host ("      {0,-14} {1,3} files" -f $c.name, $byCharacter[$c.name].Count)
}

if (-not $Execute) {
  Write-Host "`nDRY RUN -- nothing was transferred. Re-run with -Execute." -ForegroundColor Yellow
  Write-Host ""
  exit 0
}

# ---- Transfer --------------------------------------------------------

$failures = @()
$index = 0
foreach ($c in $todo) {
  $index++
  $files = $byCharacter[$c.name]
  Write-Step "[$index/$($todo.Count)] $($c.name) -- $($files.Count) files"
  $archive = Join-Path $WorkFolder ("{0}.tar.gz" -f $c.name)

  try {
    $state[$c.name] = 'transferring'; Save-State

    Invoke-RemoteToFile -Env $StagingEnv -Service $StagingApiService `
      -Command "cd $MediaRoot && tar -czf - ./$($c.id)" -OutFile $archive
    $mb = [math]::Round((Get-Item $archive).Length / 1MB, 1)
    Write-Host "    pulled $mb MB from Staging"

    # Extraction only adds or replaces same-named files. These are new
    # characters, so nothing of Production's shares a path.
    Invoke-RemoteFromFile -Env $ProdEnv -Service $ProdApiService `
      -Command "mkdir -p $MediaRoot && cd $MediaRoot && tar -xzf -" -InFile $archive
    Write-Host "    extracted on Production"

    $verifyRaw = Invoke-RemoteText -Env $ProdEnv -Service $ProdApiService `
      -Command "cd $MediaRoot && find ./$($c.id) -type f -exec sha256sum {} + 2>/dev/null"
    $destFiles = @{}
    foreach ($line in ($verifyRaw -split "`n")) {
      $t = $line.Trim()
      if ($t -match '^([0-9a-f]{64})\s+(.+)$') { $destFiles[$Matches[2].Trim()] = $Matches[1] }
    }

    $bad = @()
    foreach ($f in $files) {
      if (-not $destFiles.ContainsKey($f)) { $bad += "$f : missing on Production" }
      elseif ($destFiles[$f] -ne $sourceFiles[$f]) { $bad += "$f : checksum differs" }
    }

    if ($bad.Count -eq 0) {
      $state[$c.name] = 'verified'; Save-State
      Write-Ok "$($files.Count) files verified by SHA256"
      if (-not $KeepArchives) { Remove-Item $archive -Force -ErrorAction SilentlyContinue }
    }
    else {
      $state[$c.name] = 'failed'; Save-State
      foreach ($b in $bad | Select-Object -First 5) { Write-Bad $b }
      if ($bad.Count -gt 5) { Write-Bad "...and $($bad.Count - 5) more" }
      $failures += $c.name
    }
  }
  catch {
    $state[$c.name] = 'failed'; Save-State
    Write-Bad $_.Exception.Message
    $failures += $c.name
  }
}

# ---- Verdict ---------------------------------------------------------

Remove-Item $listFile -Force -ErrorAction SilentlyContinue

$verified = @($new | Where-Object { $state[$_.name] -eq 'verified' })
Write-Host ""
Write-Host "================================================================" -ForegroundColor White
if ($failures.Count -eq 0 -and $verified.Count -eq $new.Count) {
  Write-Host "MEDIA TRANSFER COMPLETE AND VERIFIED" -ForegroundColor Green
  Write-Host "  $($verified.Count) characters, $($sourceFiles.Count) files, every one checksum-matched"
  Write-Host ""
  Write-Host "  Next: run the content sync to insert the database rows." -ForegroundColor White
  Write-Host "  It will re-verify these files are present before writing anything."
}
else {
  Write-Host "MEDIA TRANSFER INCOMPLETE" -ForegroundColor Yellow
  Write-Host "  verified : $($verified.Count) of $($new.Count)"
  Write-Host "  failed   : $($failures -join ', ')"
  Write-Host ""
  Write-Host "  Re-run with -Execute to retry only the ones that did not finish." -ForegroundColor Yellow
  Write-Host "  Files already on Production are harmless until rows reference them."
}
Write-Host "================================================================" -ForegroundColor White
Write-Host ""
if ($failures.Count -gt 0) { exit 1 }
