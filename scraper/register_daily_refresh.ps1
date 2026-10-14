# Registers the daily job data refresh on this PC as a Windows scheduled task ("AICD3 daily refresh"), which
# runs scraper\daily_refresh.ps1: scrape, classify with d3, and update the live site. Run it once:
#
#   powershell -ExecutionPolicy Bypass -File scraper\register_daily_refresh.ps1 -Url https://<your-live-site>
#   ... -At 6:47AM          # another time of day (default 6:47 AM)
#   ... -Remove             # stop the daily refresh
#
# Before registering, it checks that SCRAPER_INGEST_TOKEN in .env.local is the same value as the live site's
# (Vercel -> Settings -> Environment Variables -> Production), without printing it.
# The task runs while you're signed in to Windows (no password is stored); if the PC was off or asleep at
# that time, it runs as soon as it can. Only one refresh runs at a time.
param([string]$Url = "", [string]$At = "6:47AM", [switch]$Remove)
$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$TaskName = "AICD3 daily refresh"
$EnvFile = Join-Path $Root ".env.local"

if ($Remove) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "Removed the '$TaskName' task. The PC no longer refreshes the live site on its own."
  exit 0
}

function Read-EnvLocal($key) {
  if (-not (Test-Path $EnvFile)) { return "" }
  foreach ($l in Get-Content $EnvFile) { if ($l -match "^\s*(export\s+)?$key=(.*)$") { return $Matches[2].Trim().Trim('"').Trim("'") } }
  return ""
}
function Set-EnvLine($key, $value) {   # set KEY=VALUE in .env.local without touching other lines (UTF-8, no BOM)
  $lines = @(Get-Content $EnvFile -ErrorAction SilentlyContinue)
  $hit = $false
  $out = foreach ($l in $lines) { if ($l -match "^$key=") { $hit = $true; "$key=$value" } else { $l } }
  if (-not $hit) { $out = @($out) + "$key=$value" }
  [System.IO.File]::WriteAllLines($EnvFile, [string[]]$out, (New-Object System.Text.UTF8Encoding $false))
}

if (-not $Url) { $Url = Read-EnvLocal "AICD3_URL" }
if (-not $Url) { Write-Host "Give the live site's address: -Url https://<your-live-site>"; exit 1 }
$Url = $Url.Trim().TrimEnd("/")
if ($Url -notmatch "^https://") { Write-Host "The live site's address should start with https:// (got $Url)."; exit 1 }
if (-not (Test-Path (Join-Path $Root ".venv-d3\Scripts\python.exe"))) { Write-Host "Run scraper\setup_d3.ps1 first."; exit 1 }

# the token must be the live site's: ask the site, without printing the token
$token = Read-EnvLocal "SCRAPER_INGEST_TOKEN"
if (-not $token) { Write-Host "No SCRAPER_INGEST_TOKEN in .env.local. Copy the value from Vercel (Settings -> Environment Variables -> Production) into .env.local, then run this again."; exit 1 }
try {
  $r = Invoke-WebRequest -Uri "$Url/api/ingest/open" -Headers @{ Authorization = "Bearer $token" } -UseBasicParsing -TimeoutSec 30
  $n = (ConvertFrom-Json $r.Content).postings.Count
  Write-Host "The live site accepted this PC's token ($n open postings on the board)."
} catch {
  $status = $_.Exception.Response.StatusCode.value__
  if ($status -eq 401) { Write-Host "The live site refused the token: SCRAPER_INGEST_TOKEN in .env.local isn't the same as Vercel's Production value. Copy Vercel's value into .env.local, then run this again." }
  elseif ($status -eq 503) { Write-Host "The live site has no SCRAPER_INGEST_TOKEN set (Vercel -> Settings -> Environment Variables -> Production). Add it there, redeploy, then run this again." }
  else { Write-Host "Couldn't reach $Url/api/ingest/open ($($_.Exception.Message)). Check the address." }
  exit 1
}
Set-EnvLine "AICD3_URL" $Url

$runner = Join-Path $Root "scraper\daily_refresh.ps1"
$action = New-ScheduledTaskAction -Execute "powershell.exe" -WorkingDirectory $Root `
  -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$runner`""
$trigger = New-ScheduledTaskTrigger -Daily -At $At
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Hours 4) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
  -Description "Scrapes internships, classifies them with vllm-sr/d3 on this PC, and updates the AICD3 job board at $Url" -Force | Out-Null

$next = (Get-ScheduledTaskInfo -TaskName $TaskName).NextRunTime
Write-Host "Registered '$TaskName': every day at $At (next run $next), updating $Url."
Write-Host "Try it now:            Start-ScheduledTask -TaskName '$TaskName'"
Write-Host "Check how runs went:   Get-Content scraper\out\logs\daily-refresh.log -Tail 10"
Write-Host "Stop it:               powershell -ExecutionPolicy Bypass -File scraper\register_daily_refresh.ps1 -Remove"
