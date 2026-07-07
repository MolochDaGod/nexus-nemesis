# Deploy nexus-nemesis card API to Vercel production
# Maps Railway game secrets → card API env vars (never prints values)
param(
    [string]$CardApiUrl = "https://nexus-nemesis.vercel.app"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$railwayVarsPath = "C:\Users\david\Desktop\nexus-nemesis-game\.railway-vars.json"

if (-not (Test-Path $railwayVarsPath)) {
    Write-Error "Railway vars not found. Run: cd nexus-nemesis-game; railway variables --service nexus-nemesis-game --environment production --json > .railway-vars.json"
}

$rv = Get-Content $railwayVarsPath -Raw | ConvertFrom-Json

# Map game Railway vars → card API env names
$envMap = @{
    DATABASE_URL              = $rv.DATABASE_URL
    CROSSMINT_API_KEY         = if ($rv.CROSSMINT_SERVER_API_KEY) { $rv.CROSSMINT_SERVER_API_KEY } else { $rv.CROSSMINT_API_KEY }
    CROSSMINT_CLIENT_KEY      = $rv.CROSSMINT_CLIENT_KEY
    CROSSMINT_PROJECT_ID      = $rv.CROSSMINT_PROJECT_ID
    CROSSMINT_COLLECTION_ID   = if ($rv.CROSSMINT_CARD_COLLECTION_ID) { $rv.CROSSMINT_CARD_COLLECTION_ID } else { $rv.CROSSMINT_COLLECTION_ID }
    CROSSMINT_WEBHOOK_SECRET  = $rv.CROSSMINT_WEBHOOK_SECRET
    GRUDGE_JWT_SECRET         = $rv.JWT_SECRET
    GRUDGE_AUTH_URL           = "https://id.grudge-studio.com"
    GBUX_MINT_ADDRESS         = if ($rv.GBUX_MINT_ADDRESS) { $rv.GBUX_MINT_ADDRESS } else { "55TpSoMNxbfsNJ9U1dQoo9H3dRtDmjBZVMcKqvU2nray" }
    DISCORD_WEBHOOK_CARDS     = $rv.DISCORD_WEBHOOK_CARDS_URL
    DISCORD_WEBHOOK_CARDOPEN  = $rv.DISCORD_WEBHOOK_URL_NFT
    ADMIN_WALLET_ADDRESS      = $rv.AI_AGENT_SOL_ADDRESS
    NODE_ENV                  = "production"
    VERCEL                    = "1"
}

Push-Location $root
try {
    foreach ($entry in $envMap.GetEnumerator()) {
        if (-not $entry.Value) {
            Write-Host "SKIP (empty): $($entry.Key)"
            continue
        }
        $entry.Value | vercel env add $entry.Key production --force --yes 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) { Write-Warning "Failed to set $($entry.Key)" }
        else { Write-Host "SET: $($entry.Key)" }
    }

    Write-Host "`nDeploying card API to production..."
    vercel deploy --prod --yes
    if ($LASTEXITCODE -ne 0) { throw "Vercel deploy failed" }

    Write-Host "`nCard API deployed at $CardApiUrl"
} finally {
    Pop-Location
}