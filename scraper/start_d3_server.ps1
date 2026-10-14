# Starts the d3 model server (scraper/d3_server.py) in the background on this PC, unless it's already
# running. setup_d3.ps1 puts a shortcut to this in your Startup folder, so it also starts when you sign in.
#
#   powershell -ExecutionPolicy Bypass -File scraper\start_d3_server.ps1           # start (no-op if running)
#   powershell -ExecutionPolicy Bypass -File scraper\start_d3_server.ps1 -Wait     # start and wait until it answers
#   powershell -ExecutionPolicy Bypass -File scraper\start_d3_server.ps1 -Stop     # stop it
#   powershell -ExecutionPolicy Bypass -File scraper\start_d3_server.ps1 -Status   # is it answering?
#
# Loading the model takes a minute or two (longer the very first time, while Windows reads 52 GB from disk).
# Its log is scraper\out\logs\d3-server.log.
param([switch]$Wait, [switch]$Stop, [switch]$Status, [int]$Port = 0, [int]$WaitMinutes = 15)
$ErrorActionPreference = "Continue"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$VPy = Join-Path $Root ".venv-d3\Scripts\python.exe"
$Server = Join-Path $Root "scraper\d3_server.py"
$LogDir = Join-Path $Root "scraper\out\logs"

function Read-EnvLocal($key) {
  $f = Join-Path $Root ".env.local"
  if (-not (Test-Path $f)) { return "" }
  foreach ($l in Get-Content $f) { if ($l -match "^\s*(export\s+)?$key=(.*)$") { return $Matches[2].Trim().Trim('"').Trim("'") } }
  return ""
}
if (-not $Port) { $p = Read-EnvLocal "D3_PORT"; $Port = if ($p) { [int]$p } else { 8765 } }
$Url = "http://127.0.0.1:$Port"

function Test-Up {
  try { $h = Invoke-RestMethod -Uri "$Url/health" -TimeoutSec 3; return [bool]$h.ok } catch { return $false }
}
function Get-ServerProcs {
  Get-CimInstance Win32_Process -Filter "Name='python.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -like "*d3_server.py*" }
}

if ($Status) {
  if (Test-Up) { $h = Invoke-RestMethod -Uri "$Url/health" -TimeoutSec 3; Write-Host "d3 server is up at ${Url}: $($h.model) on $($h.gpu) (since $($h.loaded_at))"; exit 0 }
  if (Get-ServerProcs) { Write-Host "d3 server is starting (loading the model). Log: $LogDir\d3-server.log"; exit 3 }
  Write-Host "d3 server isn't running."; exit 1
}

if ($Stop) {
  $procs = @(Get-ServerProcs)
  foreach ($p in $procs) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
  Write-Host $(if ($procs.Count) { "Stopped the d3 server." } else { "The d3 server wasn't running." })
  exit 0
}

if (Test-Up) { Write-Host "The d3 server is already running at $Url."; exit 0 }
if (-not (Test-Path $VPy)) { Write-Host "No .venv-d3 yet. Run scraper\setup_d3.ps1 first."; exit 1 }

if (-not (Get-ServerProcs)) {
  New-Item -ItemType Directory -Force $LogDir | Out-Null
  $out = Join-Path $LogDir "d3-server.log"
  $err = Join-Path $LogDir "d3-server.err.log"
  foreach ($f in @($out, $err)) {   # keep the previous run's log next to it
    if (Test-Path $f) { Move-Item -Force $f ($f -replace "\.log$", ".previous.log") -ErrorAction SilentlyContinue }
  }
  # Started through WMI rather than Start-Process, so the server is fully detached: it doesn't hold on to the
  # output of whatever ran this script (the app's Admin page waits for that to close) and outlives it.
  $cmd = "cmd.exe /d /c `"set PYTHONUNBUFFERED=1&& set PYTHONIOENCODING=utf-8&& set PYTHONUTF8=1&& " +
         "`"$VPy`" `"$Server`" --port $Port > `"$out`" 2> `"$err`"`""
  $startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }
  $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
    CommandLine = $cmd; CurrentDirectory = $Root; ProcessStartupInformation = $startup }
  if ($r.ReturnValue -ne 0) { Write-Host "Couldn't start the d3 server (Win32_Process.Create returned $($r.ReturnValue))."; exit 1 }
  Write-Host "Started the d3 server; it's loading the model. Log: $err"
} else {
  Write-Host "The d3 server is already starting (loading the model)."
}

if ($Wait) {
  $deadline = (Get-Date).AddMinutes($WaitMinutes)
  while ((Get-Date) -lt $deadline) {
    if (Test-Up) { Write-Host "The d3 server is ready at $Url."; exit 0 }
    if (-not (Get-ServerProcs)) {
      Write-Host "The d3 server stopped while loading. The end of its log:"
      Get-Content (Join-Path $LogDir "d3-server.err.log") -Tail 25 -ErrorAction SilentlyContinue
      exit 1
    }
    Start-Sleep -Seconds 5
  }
  Write-Host "The d3 server didn't answer within $WaitMinutes minutes. See $LogDir\d3-server.err.log"
  exit 1
}
exit 0
