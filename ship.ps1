# ship.ps1 - one-command release wrapper around the UNTOUCHED approve.ps1 workflow.
#
# NOTE: this file is deliberately ASCII-only. Do not add smart quotes, em
# dashes, box-drawing characters, or any other non-ASCII punctuation: without
# a BOM, Windows PowerShell decodes this file as ANSI and mojibake bytes can
# read as curly quotes, which the parser treats as string delimiters.
#
# What it adds (and what it deliberately does not):
#   1. BLOCKING evidence gate  - refuses to ship unless SHIP-EVIDENCE.md (delivered
#      next to the bundle) shows every blocking gate as PASS: existing test suite,
#      typecheck, build, deterministic memory regression.
#   2. Git pre-flight          - fetch origin, put the working tree on Main-Branch
#      at origin (the two commands previously run by hand).
#   3. Migration guard         - if the approved commit touches apps/api/drizzle/,
#      STOP. Migrations are never run automatically; review and apply manually,
#      then re-run with -AcknowledgeMigrations.
#   4. approve.ps1             - invoked as-is; every existing safety check
#      (single bundle, parent == Main-Branch HEAD, approved-files-only) is
#      preserved byte-identical. This remains the human approval gate: nothing
#      runs it for you.
#   5. Health verification     - polls /health until the API answers (BLOCKING).
#      Note: /health carries no build version, so this proves the service is up,
#      not that the new commit is the one serving (documented limitation).
#   6. Post-deployment LIVE QA - scripts/qa-memory.mjs (real-LLM smoke + memory
#      recall). Probabilistic by nature: reported as explicit PASS/FAIL/BLOCKED
#      evidence, never collapsed into the deployment result and never a reason
#      to roll back automatically.
#
# Usage:
#   .\ship.ps1                          # full flow against production
#   .\ship.ps1 -ValidateOnly            # run gates 1-3 only; change nothing, deploy nothing
#   .\ship.ps1 -SkipLiveQa              # deploy without the live QA step
#   .\ship.ps1 -AcknowledgeMigrations   # proceed although the commit contains migrations
#
# No credential is read, stored, or passed by this script.

param(
    [string]$ApiBaseUrl = "https://over18-production.up.railway.app",
    [int]$HealthTimeoutSec = 300,
    [switch]$SkipLiveQa,
    [switch]$AcknowledgeMigrations,
    [switch]$ValidateOnly
)

$ErrorActionPreference = "Stop"
$script:Deployment = "BLOCKED"
$script:BlockingQa = "BLOCKED"
$script:LiveSmoke  = "BLOCKED"
$script:LiveRecall = "BLOCKED"

function Write-Summary {
    $live = "BLOCKED"
    if ($script:LiveSmoke -eq "PASS" -and $script:LiveRecall -eq "PASS") { $live = "PASS" }
    elseif ($script:LiveSmoke -eq "FAIL" -or $script:LiveRecall -eq "FAIL") { $live = "FAIL" }

    Write-Host ""
    Write-Host "==================== RELEASE SUMMARY ====================" -ForegroundColor Cyan
    Write-Host ("DEPLOYMENT: {0}" -f $script:Deployment)
    Write-Host ("BLOCKING QA: {0}" -f $script:BlockingQa)
    Write-Host ("LIVE LLM QA: {0}   (smoke: {1}, memory recall: {2})" -f $live, $script:LiveSmoke, $script:LiveRecall)
    if ($script:Deployment -eq "PASS" -and $script:BlockingQa -eq "PASS" -and $live -eq "PASS") {
        Write-Host "RELEASE: COMPLETE - all gates and live evidence green" -ForegroundColor Green
    } elseif ($script:Deployment -eq "PASS") {
        Write-Host ("RELEASE: DEPLOYED, but live QA evidence is {0} - investigate before calling this release good" -f $live) -ForegroundColor Yellow
    } else {
        Write-Host "RELEASE: NOT COMPLETED" -ForegroundColor Red
    }
    Write-Host "=========================================================" -ForegroundColor Cyan

    # Append the same summary to the evidence file, if present.
    if (Test-Path "SHIP-EVIDENCE.md") {
        $stamp = (Get-Date).ToString("u")
        Add-Content "SHIP-EVIDENCE.md" @"

## ship.ps1 result ($stamp)
DEPLOYMENT: $($script:Deployment)
BLOCKING QA: $($script:BlockingQa)
LIVE LLM QA: $live (smoke: $($script:LiveSmoke), memory recall: $($script:LiveRecall))
"@
    }
}

try {
    # -- 1. Blocking-evidence gate -------------------------------------------
    if (-not (Test-Path "SHIP-EVIDENCE.md")) {
        throw "SHIP-EVIDENCE.md not found. Blocking QA (tests/typecheck/build/memory regression) is unverified - nothing ships without it."
    }
    $evidence = Get-Content "SHIP-EVIDENCE.md" -Raw
    $gateSection = ($evidence -split "POST-DEPLOYMENT")[0]
    if ($gateSection -notmatch "BLOCKING GATES") {
        throw "SHIP-EVIDENCE.md has no 'BLOCKING GATES' section."
    }
    $badGates = @([regex]::Matches($gateSection, "(?m)^\s*[A-Z][^:\r\n]{2,60}:\s*(FAIL|BLOCKED)"))
    if ($badGates.Count -gt 0) {
        $badGates | ForEach-Object { Write-Host ("  blocking gate not green: {0}" -f $_.Groups[0].Value.Trim()) -ForegroundColor Red }
        throw "One or more BLOCKING gates are not PASS. Shipping refused."
    }
    $script:BlockingQa = "PASS"
    Write-Host "1. Blocking QA evidence: PASS (SHIP-EVIDENCE.md)" -ForegroundColor Green

    # -- 2. Git pre-flight ---------------------------------------------------
    if ($ValidateOnly) {
        Write-Host "2. Git pre-flight skipped (-ValidateOnly changes nothing)." -ForegroundColor Yellow
    } else {
        Write-Host "2. Git pre-flight: fetch origin + checkout Main-Branch" -ForegroundColor Cyan
        git fetch origin
        git checkout -B Main-Branch origin/Main-Branch
    }

    # -- 3. Migration guard (never auto-run migrations) ----------------------
    $bundles = @(Get-ChildItem -Filter "over18-us*.bundle" -File)
    if ($bundles.Count -ne 1) {
        throw "Expected exactly one over18-us*.bundle, found $($bundles.Count). (approve.ps1 enforces the same rule.)"
    }
    git bundle verify $bundles[0].FullName | Out-Null
    git fetch $bundles[0].FullName Main-Branch
    $approvedFiles = @(git diff --name-only Main-Branch FETCH_HEAD)
    $migrations = @($approvedFiles | Where-Object { $_ -like "apps/api/drizzle/*" })
    if ($migrations.Count -gt 0 -and -not $AcknowledgeMigrations) {
        $migrations | ForEach-Object { Write-Host ("  migration file in commit: {0}" -f $_) -ForegroundColor Yellow }
        throw "This commit contains database migrations. Review them, apply manually (npm run db:migrate -w apps/api), then re-run with -AcknowledgeMigrations."
    }
    Write-Host "3. Migration guard: OK ($($migrations.Count) migration files$(if ($migrations.Count) { ' - acknowledged' }))" -ForegroundColor Green

    if ($ValidateOnly) {
        $script:Deployment = "BLOCKED"
        Write-Host ""
        Write-Host "-ValidateOnly: all pre-flight gates green. Nothing was changed or deployed." -ForegroundColor Yellow
        exit 0  # the finally block prints the summary
    }

    # -- 4. The existing human approval gate, untouched ----------------------
    Write-Host "4. Running approve.ps1 (unchanged safety checks + push)..." -ForegroundColor Cyan
    & .\approve.ps1
    if ($LASTEXITCODE -ne $null -and $LASTEXITCODE -ne 0) { throw "approve.ps1 failed." }

    # -- 5. Health verification (blocking) -----------------------------------
    Write-Host "5. Waiting for $ApiBaseUrl/health (Railway auto-deploy)..." -ForegroundColor Cyan
    $deadline = (Get-Date).AddSeconds($HealthTimeoutSec)
    $healthy = $false
    while ((Get-Date) -lt $deadline) {
        try {
            $h = Invoke-RestMethod -Uri "$ApiBaseUrl/health" -TimeoutSec 10
            if ($h.status -eq "ok") { $healthy = $true; break }
        } catch { }
        Start-Sleep -Seconds 10
    }
    if (-not $healthy) {
        $script:Deployment = "FAIL"
        throw "API did not answer /health within $HealthTimeoutSec s. The push succeeded; investigate the Railway deploy."
    }
    $script:Deployment = "PASS"
    Write-Host "   Health: ok. (Note: /health has no version field - this proves the service is up, not which commit serves.)" -ForegroundColor Green

    # -- 6. Post-deployment live QA (evidence, not a gate) -------------------
    if ($SkipLiveQa) {
        Write-Host "6. Live QA skipped (-SkipLiveQa). Results stay BLOCKED in the summary." -ForegroundColor Yellow
    } else {
        Write-Host "6. Live QA: real-LLM smoke + production memory recall..." -ForegroundColor Cyan
        $qaOutput = & node "apps/api/scripts/qa-memory.mjs" --base-url $ApiBaseUrl 2>&1
        $qaOutput | ForEach-Object { Write-Host $_ }
        $joined = $qaOutput -join "`n"
        if ($joined -match "LIVE SMOKE:\s*(PASS|FAIL|BLOCKED)") { $script:LiveSmoke = $Matches[1] }
        if ($joined -match "LIVE MEMORY RECALL:\s*(PASS|FAIL|BLOCKED)") { $script:LiveRecall = $Matches[1] }
    }
} catch {
    $script:Stopped = $true
    Write-Host ""
    Write-Host "STOPPED: $($_.Exception.Message)" -ForegroundColor Red
} finally {
    Write-Summary
}
if ($script:Stopped) { exit 1 }
