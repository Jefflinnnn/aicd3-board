# Picks up "Refresh now" from the live site's Admin page. The live site (Vercel) can't run the scraper, so the button
# leaves a request; Windows Task Scheduler runs this every 5 minutes ("AICD3 refresh requests", registered by
# scraper\register_daily_refresh.ps1). When there's a request and no refresh is running, it takes the request and
# runs scraper\daily_refresh.ps1 -Manual: the same d3-only refresh as the 9 AM / 9 PM ones. While a refresh is
# running (scheduled or not) it leaves the request waiting, so two never overlap.
#
#   powershell -ExecutionPolicy Bypass -File scraper\refresh_requests.ps1     # check once, by hand
#
# Quiet when there's nothing to do; each request it handles gets lines in scraper\out\logs\daily-refresh.log.
$ErrorActionPreference = "Continue"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location $Root
$LogDir = Join-Path $Root "scraper\out\logs"
New-Item -ItemType Directory -Force $LogDir | Out-Null
$Daily = Join-Path $LogDir "daily-refresh.log"
function Note($m) { $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $m"; Write-Host $line; Add-Content -Path $Daily -Value $line }

function Read-EnvLocal($key) {
  $f = Join-Path $Root ".env.local"
  if (-not (Test-Path $f)) { return "" }
  foreach ($l in Get-Content $f) { if ($l -match "^\s*(export\s+)?$key=(.*)$") { return $Matches[2].Trim().Trim('"').Trim("'") } }
  return ""
}

$url = (Read-EnvLocal "AICD3_URL").TrimEnd("/")
$token = Read-EnvLocal "AICD3_INGEST_TOKEN"
if (-not $token) { $token = Read-EnvLocal "SCRAPER_INGEST_TOKEN" }
if (-not $url -or -not $token) { exit 1 }   # not set up; register_daily_refresh.ps1 explains
# the computer's name goes along, so the Admin page can show that this PC is checking and when it last did
$headers = @{ Authorization = "Bearer $token"; "X-AICD3-Host" = $env:COMPUTERNAME }

try {
  $state = Invoke-RestMethod -Uri "$url/api/ingest/request" -Headers $headers -TimeoutSec 30
} catch {
  exit 0   # offline or the site is redeploying: try again in 5 minutes, without filling the log
}
if (-not $state.requested -or $state.running) { exit 0 }
# a refresh may still be busy with its full-time roles part, which the site doesn't see: leave the request waiting
$held = Get-Content (Join-Path $Root "scraper\out\refresh.lock") -ErrorAction SilentlyContinue | Select-Object -First 1
if ($held -and (Get-Process -Id ([int]$held) -ErrorAction SilentlyContinue)) { exit 0 }

$claim = Invoke-RestMethod -Uri "$url/api/ingest/request" -Method Post -Headers $headers -ContentType "application/json" `
  -Body '{"action":"claim"}' -TimeoutSec 30
if (-not $claim.claimed) { exit 0 }   # someone else took it

Note "Refresh now was pressed on the Admin page; starting a manual refresh"
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root "scraper\daily_refresh.ps1") -Manual
$code = $LASTEXITCODE
if ($code -eq 3) {
  # a scheduled refresh started in the same moment: put the request back for the next check
  try {
    Invoke-RestMethod -Uri "$url/api/ingest/request" -Method Post -Headers $headers -ContentType "application/json" `
      -Body '{"action":"requeue"}' -TimeoutSec 30 | Out-Null
    Note "another refresh was running; the request waits for the next check"
  } catch {}
}
exit $code
