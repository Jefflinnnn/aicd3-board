# Registers the scheduled job data refresh on this PC as a Windows scheduled task ("AICD3 daily refresh", the name
# kept from when it ran daily), which runs scraper\daily_refresh.ps1: scrape, classify with d3, and update the live
# site directly. No local server (pnpm dev / pnpm start) is needed. Run it once:
#
#   powershell -ExecutionPolicy Bypass -File scraper\register_daily_refresh.ps1 -Url https://<your-live-site>
#   ... -At 9:00AM,9:00PM                # times of day (default 9 AM and 9 PM); one or more
#   ... -Days Daily                      # which days (default every day); or day names, e.g. -Days Monday,Thursday
#   ... -Status                          # is it registered, when did it last run and how did it go
#   ... -Remove                          # stop the scheduled refresh
#
# Before registering, it checks that SCRAPER_INGEST_TOKEN in .env.local is the same value as the live site's
# (Vercel -> Settings -> Environment Variables -> Production), without printing it.
# The task runs while you're signed in to Windows (a locked screen is fine; no password is stored). It wakes the PC
# from sleep to run; if the PC was off or you were signed out at that time, it runs as soon as it can after you sign in.
# Only one refresh runs at a time.
param([string]$Url = "", [string[]]$At = @("9:00AM", "9:00PM"), [string[]]$Days = @("Daily"), [switch]$Remove, [switch]$Status)
$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$TaskName = "AICD3 daily refresh"
$EnvFile = Join-Path $Root ".env.local"

if ($Status) {
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if (-not $task) { Write-Host "The scheduled refresh isn't registered on this PC. Register it with -Url https://<your-live-site>." }
  else {
    $info = Get-ScheduledTaskInfo -TaskName $TaskName
    $when = ($task.Triggers | ForEach-Object { "$(if ($_.DaysOfWeek) { 'weekly' } else { 'daily' }) at $(([datetime]$_.StartBoundary).ToString('h:mm tt'))" }) -join ", "
    $result = if ($info.LastTaskResult -eq 0) { "succeeded" } elseif ($info.LastTaskResult -eq 267011) { "never run yet" } else { "exit code $($info.LastTaskResult)" }
    Write-Host "Task '$TaskName': $($task.State) ($when). Last run: $($info.LastRunTime) ($result). Next run: $($info.NextRunTime)."
  }
  $log = Join-Path $Root "scraper\out\logs\daily-refresh.log"
  if (Test-Path $log) { Write-Host "Recent runs:"; Get-Content $log -Tail 8 } else { Write-Host "No runs logged yet ($log)." }
  exit 0
}

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
  # named $httpStatus because PowerShell names are case-insensitive and $Status is the -Status switch
  $httpStatus = $_.Exception.Response.StatusCode.value__
  if ($httpStatus -eq 404) { Write-Host "$Url answered 404 Not Found for /api/ingest/open: that isn't the real job board. Use the address students sign in at (Vercel -> the real project, not the demo -> Settings -> Domains). The public demo has no import endpoint." }
  elseif ($httpStatus -eq 401) { Write-Host "The live site refused the token: SCRAPER_INGEST_TOKEN in .env.local isn't the same as Vercel's Production value. Copy Vercel's value into .env.local, then run this again." }
  elseif ($httpStatus -eq 503) { Write-Host "The live site has no SCRAPER_INGEST_TOKEN set (Vercel -> Settings -> Environment Variables -> Production). Add it there, redeploy, then run this again." }
  else { Write-Host "Couldn't reach $Url/api/ingest/open ($($_.Exception.Message)). Check the address." }
  exit 1
}
Set-EnvLine "AICD3_URL" $Url

$runner = Join-Path $Root "scraper\daily_refresh.ps1"
$action = New-ScheduledTaskAction -Execute "powershell.exe" -WorkingDirectory $Root `
  -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$runner`""
$Days = @($Days | ForEach-Object { $_ -split "," } | ForEach-Object { $_.Trim() } | Where-Object { $_ })
$At = @($At | ForEach-Object { $_ -split "," } | ForEach-Object { $_.Trim() } | Where-Object { $_ })
$trigger = @()
foreach ($t in $At) {
  try { $null = [datetime]::Parse($t) } catch { Write-Host "-At takes times such as 9:00AM,9:00PM (got $t)."; exit 1 }
  if ($Days.Count -eq 1 -and $Days[0] -eq "Daily") { $trigger += New-ScheduledTaskTrigger -Daily -At $t }
  else {
    try { $trigger += New-ScheduledTaskTrigger -Weekly -DaysOfWeek $Days -At $t }
    catch { Write-Host "-Days takes day names such as Monday,Thursday (or Daily)."; exit 1 }
  }
}
$schedule = "$(if ($Days.Count -eq 1 -and $Days[0] -eq 'Daily') { 'every day' } else { 'every ' + ($Days -join ' and ') }) at $($At -join ' and ')"
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -WakeToRun -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Hours 4) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
  -Description "Scrapes internships, classifies them with vllm-sr/d3 on this PC, and updates the AICD3 job board at $Url" -Force | Out-Null

$next = (Get-ScheduledTaskInfo -TaskName $TaskName).NextRunTime
Write-Host "Registered '$TaskName': $schedule (next run $next), updating $Url. No local server needs to run."
Write-Host "Try it now:            Start-ScheduledTask -TaskName '$TaskName'"
Write-Host "Check how runs went:   powershell -ExecutionPolicy Bypass -File scraper\register_daily_refresh.ps1 -Status"
Write-Host "Stop it:               powershell -ExecutionPolicy Bypass -File scraper\register_daily_refresh.ps1 -Remove"
