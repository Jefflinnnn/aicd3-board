# Lets other computers you own (your Mac's local copy of the app, say) classify with the d3 model on this GPU PC,
# instead of falling back to keyword rules. Run once, in PowerShell **as Administrator** (it opens a firewall port):
#
#   powershell -ExecutionPolicy Bypass -File scraper\share_d3.ps1            # share d3, print what the other computer needs
#   powershell -ExecutionPolicy Bypass -File scraper\share_d3.ps1 -Status    # shared? reachable? the other computer's settings
#   powershell -ExecutionPolicy Bypass -File scraper\share_d3.ps1 -Off       # back to this PC only
#
# What it does:
#   - .env.local: D3_HOST=0.0.0.0 (answer on the network) and a D3_TOKEN, a random secret every request from another
#     computer must carry. Requests from this PC itself (its own 9 AM / 9 PM refreshes) don't need it.
#   - Windows Firewall: lets in port 8765 only from your local network and from Tailscale (100.64.0.0/10), never from
#     the internet at large.
#   - restarts the d3 server so it listens that way, and prints the two lines for the other computer's .env.local.
# The other computer then reaches d3 at http://<this PC>:8765 while both are on the same network (home Wi-Fi), or from
# anywhere when both are signed in to Tailscale (https://tailscale.com, free for personal use).
param([switch]$Off, [switch]$Status, [int]$Port = 0)
$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$EnvFile = Join-Path $Root ".env.local"
$Rule = "AICD3 d3 server"
$Start = Join-Path $Root "scraper\start_d3_server.ps1"

function Read-EnvLocal($key) {
  if (-not (Test-Path $EnvFile)) { return "" }
  foreach ($l in Get-Content $EnvFile) { if ($l -match "^\s*(export\s+)?$key=(.*)$") { return $Matches[2].Trim().Trim('"').Trim("'") } }
  return ""
}
function Write-EnvLines($out) { [System.IO.File]::WriteAllLines($EnvFile, [string[]]@($out), (New-Object System.Text.UTF8Encoding $false)) }
function Set-EnvLine($key, $value) {   # set KEY=VALUE in .env.local without touching other lines
  $lines = @(Get-Content $EnvFile -ErrorAction SilentlyContinue)
  $hit = $false
  $out = foreach ($l in $lines) { if ($l -match "^$key=") { $hit = $true; "$key=$value" } else { $l } }
  if (-not $hit) { $out = @($out) + "$key=$value" }
  Write-EnvLines $out
}
function Remove-EnvLine($key) { Write-EnvLines (@(Get-Content $EnvFile -ErrorAction SilentlyContinue) | Where-Object { $_ -notmatch "^$key=" }) }

if (-not $Port) { $p = Read-EnvLocal "D3_PORT"; $Port = if ($p) { [int]$p } else { 8765 } }

# where the other computer can find this PC: its local network addresses, and its Tailscale address if it has one
function Get-Addresses {
  $lan = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -notmatch "^(127\.|169\.254\.)" -and $_.InterfaceAlias -notmatch "Loopback|vEthernet|WSL" } |
    Select-Object -ExpandProperty IPAddress)
  $ts = ""
  $tsExe = Get-Command tailscale -ErrorAction SilentlyContinue
  if ($tsExe) { try { $ts = (& $tsExe.Source ip -4 2>$null | Select-Object -First 1).Trim() } catch {} }
  return @{ lan = @($lan | Where-Object { $_ -notmatch "^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\." }); ts = $ts }
}

function Show-OtherComputer($token) {
  $a = Get-Addresses
  Write-Host ""
  Write-Host "On the other computer (your Mac), add these two lines to the app's .env.local, then restart pnpm dev:"
  Write-Host ""
  if ($a.ts) {
    Write-Host "  D3_URL=http://$($a.ts):$Port        # Tailscale: works from anywhere both are signed in"
  }
  foreach ($ip in $a.lan) { Write-Host "  D3_URL=http://${ip}:$Port        # same network as this PC (e.g. home Wi-Fi)" }
  if (-not $a.ts -and -not $a.lan) { Write-Host "  D3_URL=http://$($env:COMPUTERNAME):$Port" }
  Write-Host "  D3_TOKEN=$token"
  Write-Host ""
  Write-Host "(Use one D3_URL line. Keep the token private: it's what lets a computer use this GPU.)"
}

if ($Status) {
  $hostSetting = Read-EnvLocal "D3_HOST"
  $shared = $hostSetting -and $hostSetting -notin @("127.0.0.1", "localhost", "::1")
  $fw = Get-NetFirewallRule -DisplayName $Rule -ErrorAction SilentlyContinue
  Write-Host "d3 shared with other computers: $(if ($shared) { "yes (D3_HOST=$hostSetting)" } else { 'no (this PC only)' })"
  Write-Host "Firewall rule '$Rule': $(if ($fw) { 'present' } else { 'missing' })"
  & powershell -NoProfile -ExecutionPolicy Bypass -File $Start -Status
  if ($shared -and (Read-EnvLocal "D3_TOKEN")) { Show-OtherComputer (Read-EnvLocal "D3_TOKEN") }
  exit 0
}

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) {
  Write-Host "Run this in PowerShell as Administrator (right-click PowerShell > Run as administrator): it changes the firewall."
  exit 1
}

if ($Off) {
  Remove-EnvLine "D3_HOST"
  Get-NetFirewallRule -DisplayName $Rule -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  Write-Host "d3 is back to this PC only (the firewall rule is removed). Restarting the d3 server..."
  & powershell -NoProfile -ExecutionPolicy Bypass -File $Start -Stop | Out-Null
  & powershell -NoProfile -ExecutionPolicy Bypass -File $Start -Wait -WaitMinutes 20
  Write-Host "Other computers will fall back to keyword rules; remove D3_URL and D3_TOKEN from their .env.local."
  exit 0
}

$token = Read-EnvLocal "D3_TOKEN"
if (-not $token -or $token.Length -lt 32) {
  $bytes = New-Object byte[] 32
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $token = ($bytes | ForEach-Object { $_.ToString("x2") }) -join ""
  Set-EnvLine "D3_TOKEN" $token
}
Set-EnvLine "D3_HOST" "0.0.0.0"

Get-NetFirewallRule -DisplayName $Rule -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName $Rule -Description "vllm-sr/d3 for the AICD3 job board (scraper\share_d3.ps1)" `
  -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port -RemoteAddress @("LocalSubnet", "100.64.0.0/10") `
  -Profile Any | Out-Null
Write-Host "Firewall: port $Port open to your local network and Tailscale only."

Write-Host "Restarting the d3 server to listen on the network (loading the model takes a minute or two)..."
& powershell -NoProfile -ExecutionPolicy Bypass -File $Start -Stop | Out-Null
Start-Sleep -Seconds 3
& powershell -NoProfile -ExecutionPolicy Bypass -File $Start -Wait -WaitMinutes 20
if ($LASTEXITCODE -ne 0) { Write-Host "The d3 server didn't come back; see scraper\out\logs\d3-server.err.log"; exit 1 }

# check it answers on the network address too, with the token, as the other computer will ask
$a = Get-Addresses
$probe = @($a.ts) + $a.lan | Where-Object { $_ } | Select-Object -First 1
if ($probe) {
  try {
    $h = Invoke-RestMethod -Uri "http://${probe}:$Port/health" -Headers @{ Authorization = "Bearer $token" } -TimeoutSec 5
    if ($h.ok) { Write-Host "Checked: d3 answers at http://${probe}:$Port with the token." }
  } catch { Write-Host "Note: couldn't reach d3 at http://${probe}:$Port from this PC ($($_.Exception.Message))." }
}
Show-OtherComputer $token
