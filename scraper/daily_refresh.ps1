# One job data refresh on this PC, sent straight to the live site (no local server needed). Windows Task Scheduler
# runs this twice a day, at 9 AM and 9 PM (register it with scraper\register_daily_refresh.ps1); you can also run it by hand:
#
#   powershell -ExecutionPolicy Bypass -File scraper\daily_refresh.ps1             # a real refresh
#   powershell -ExecutionPolicy Bypass -File scraper\daily_refresh.ps1 -DryRun     # what would change; nothing saved
#   ... -AllowRules     # if d3 can't be reached, classify with keyword rules instead of stopping
#
# It makes sure the d3 model server is up (starting it if needed), then runs scraper\pipeline.py against
# AICD3_URL from .env.local: scrape, classify with d3, import into the live site, re-check open postings.
# The live site and this PC share the production database, so the board updates as soon as it finishes.
# The run reports its progress as it goes, so the Admin page (here or on the live site) draws it live.
# Only d3 decides: if its server can't be started, the run stops before scraping and changes nothing (the Admin page
# shows it as failed, with the reason); if d3 stops answering partway, nothing is imported; a posting d3 couldn't
# classify goes to the review queue. -AllowRules goes back to classifying with keyword rules when d3 is down.
# Logs: scraper\out\logs\pipeline-<date>-<time>.log (full run) and scraper\out\logs\daily-refresh.log (one line per run).
param([switch]$DryRun, [switch]$AllowRules)
$ErrorActionPreference = "Continue"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location $Root
$VPy = Join-Path $Root ".venv-d3\Scripts\python.exe"
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

$url = Read-EnvLocal "AICD3_URL"
if (-not $url) { Note "FAILED: no AICD3_URL in .env.local (run scraper\register_daily_refresh.ps1 -Url https://<your-live-site>)"; exit 1 }
if (-not (Test-Path $VPy)) { Note "FAILED: .venv-d3 is missing; run scraper\setup_d3.ps1"; exit 1 }

# d3: start the server if it isn't running (e.g. the PC restarted), and wait for it to load
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root "scraper\start_d3_server.ps1") -Wait -WaitMinutes 20 | Out-Null
if ($LASTEXITCODE -ne 0) {
  if ($AllowRules) { Note "warning: the d3 server isn't answering; this run classifies with keyword rules" }
  else { Note "warning: the d3 server isn't answering; the run will stop without changing anything (see scraper\out\logs\d3-server.err.log)" }
}

Remove-Item "scraper\out\pipeline\last-summary.json" -ErrorAction SilentlyContinue   # never report an older run's counts
$env:PYTHONUNBUFFERED = "1"; $env:PYTHONIOENCODING = "utf-8"; $env:PYTHONUTF8 = "1"
$pyArgs = @("scraper\pipeline.py", "--url", $url, "--trigger", "schedule", "--summary-json", "scraper\out\pipeline\last-summary.json")
if ($AllowRules) { $pyArgs += @("--classifier", "auto") } else { $pyArgs += "--require-d3" }
if ($DryRun) { $pyArgs += "--dry-run" }
Note "refresh started$(if ($DryRun) { ' (dry run)' }) -> $url"
& $VPy @pyArgs
$code = $LASTEXITCODE
$what = switch ($code) {
  0 { "finished" }
  2 { "finished, but some companies couldn't be scraped" }
  3 { "skipped: another refresh was already running" }
  130 { "stopped from the Admin page before it changed anything more" }
  default { "FAILED (exit $code)" }
}
$summary = ""
try {
  $s = Get-Content "scraper\out\pipeline\last-summary.json" -Raw | ConvertFrom-Json
  $d = $s.database
  $summary = "classifier $($s.classifier); $($s.scraped) scraped; $($d.added) published, $($d.staged) to review, $($d.updated) updated, $($d.closed) closed, $($d.unlisted) moved to the bin"
} catch {}
Note "refresh $what. $summary"
exit $code
