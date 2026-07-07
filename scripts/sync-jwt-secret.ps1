# Sync GRUDGE_JWT_SECRET on Vercel card API from Railway game JWT_SECRET
$ErrorActionPreference = "Stop"
$gameDir = "C:\Users\david\Desktop\nexus-nemesis-game"
$cardDir = "C:\Users\david\Desktop\nexus-nemesis"

$json = railway variables --service nexus-nemesis-game --environment production --json 2>$null
if (-not $json) { throw "Failed to read Railway variables" }
$vars = $json | ConvertFrom-Json
if (-not $vars.JWT_SECRET) { throw "JWT_SECRET missing on Railway" }

Push-Location $cardDir
try {
    $vars.JWT_SECRET | vercel env add GRUDGE_JWT_SECRET production --force --yes 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "vercel env add failed" }
    Write-Host "GRUDGE_JWT_SECRET synced from Railway JWT_SECRET"
    vercel deploy --prod --yes
    if ($LASTEXITCODE -ne 0) { throw "vercel deploy failed" }
    Write-Host "Card API redeployed"
} finally {
    Pop-Location
}