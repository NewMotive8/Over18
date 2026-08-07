$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "=== OVER18 Approval & Push ===" -ForegroundColor Cyan
Write-Host ""

if ((git branch --show-current) -ne "Main-Branch") {
    throw "You must be on Main-Branch."
}

$bundles = @(Get-ChildItem -Filter "over18-us*.bundle" -File)

if ($bundles.Count -eq 0) {
    throw "No over18-us*.bundle found. Ask the developer to prepare the approved bundle."
}

if ($bundles.Count -gt 1) {
    throw "Multiple OVER18 bundles found. Keep only the bundle you want to approve."
}

$bundle = $bundles[0]

Write-Host "Bundle: $($bundle.Name)" -ForegroundColor Yellow

Write-Host "`n1. Verifying bundle..." -ForegroundColor Cyan
git bundle verify $bundle.FullName

$currentHead = (git rev-parse Main-Branch).Trim()

Write-Host "`n2. Reading approved commit..." -ForegroundColor Cyan
git fetch $bundle.FullName Main-Branch

$bundleHead = (git rev-parse FETCH_HEAD).Trim()
$bundleParent = (git rev-parse FETCH_HEAD^).Trim()

Write-Host "Current HEAD:  $currentHead"
Write-Host "Bundle HEAD:   $bundleHead"
Write-Host "Bundle parent: $bundleParent"

if ($bundleParent -ne $currentHead) {
    throw "SAFETY CHECK FAILED: bundle parent does not match current Main-Branch."
}

Write-Host "`n3. Checking local changes against approved commit..." -ForegroundColor Cyan

# Every file changed by the approved commit.
$approvedFiles = @(git diff --name-only $currentHead $bundleHead)

# Normalize Git paths to forward slashes.
$approvedFiles = @(
    $approvedFiles |
    ForEach-Object { $_.Trim().Replace("\", "/") } |
    Where-Object { $_ -ne "" }
)

# Find every actual untracked file recursively.
$untrackedFiles = @(git ls-files --others --exclude-standard)

$unexpected = @()

foreach ($path in $untrackedFiles) {

    $normalizedPath = $path.Trim().Replace("\", "/")

    # Local approval tooling is intentionally not part of the story.
    if ($normalizedPath -eq "approve.ps1") {
        continue
    }

    # The bundle currently being processed is intentionally untracked.
    if ($normalizedPath -eq $bundle.Name) {
        continue
    }

    # An untracked file is allowed only if the approved commit contains
    # that exact file.
    if ($approvedFiles -notcontains $normalizedPath) {
        $unexpected += $normalizedPath
    }
}

# Check modified/deleted tracked files.
$trackedChanges = @(git diff --name-only)

foreach ($path in $trackedChanges) {

    $normalizedPath = $path.Trim().Replace("\", "/")

    if ($approvedFiles -notcontains $normalizedPath) {
        $unexpected += $normalizedPath
    }
}

if ($unexpected.Count -gt 0) {
    Write-Host "Unexpected changes detected:" -ForegroundColor Red

    $unexpected |
        Sort-Object -Unique |
        ForEach-Object {
            Write-Host "  $_" -ForegroundColor Red
        }

    throw "Approval stopped for safety."
}

Write-Host "Local changes match the approved bundle." -ForegroundColor Green

Write-Host "`nApproved files:" -ForegroundColor Cyan
$approvedFiles | ForEach-Object {
    Write-Host "  $_"
}

Write-Host "`n4. Applying approved commit..." -ForegroundColor Cyan
git reset --hard FETCH_HEAD

Write-Host "`n5. Pushing to GitHub..." -ForegroundColor Cyan
git push origin Main-Branch

Write-Host "`n6. Verifying remote..." -ForegroundColor Cyan
git fetch origin Main-Branch

$localHead = (git rev-parse Main-Branch).Trim()
$remoteHead = (git rev-parse origin/Main-Branch).Trim()

if ($localHead -ne $remoteHead) {
    throw "Local and remote commits do not match. Bundle will NOT be deleted."
}

Write-Host "GitHub matches approved commit: $localHead" -ForegroundColor Green

Write-Host "`n7. Deleting bundle..." -ForegroundColor Cyan
Remove-Item $bundle.FullName -Force

Write-Host "`n8. Final status..." -ForegroundColor Cyan
git status

Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host " APPROVAL + PUSH SUCCESSFUL" -ForegroundColor Green
Write-Host " Commit: $localHead" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Write-Host ""
