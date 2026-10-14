# Sets up the vllm-sr/d3 classifier on a Windows PC with a large NVIDIA GPU (an RTX PRO 6000 with 96 GB, or
# any card with 64 GB or more), in its own Python environment (.venv-d3), and hosts it on this PC.
# The Admin page's "Set up d3" button runs this; you can also run it:
#
#   powershell -ExecutionPolicy Bypass -File scraper\setup_d3.ps1
#
# It: checks the GPU and disk, creates .venv-d3 with the scraper's and the model's packages (PyTorch built
# for CUDA 12.8, which Blackwell cards like the RTX PRO 6000 need), downloads the model (about 52 GB, once),
# starts the model server (scraper/d3_server.py on http://127.0.0.1:8765), classifies one sample posting
# through it, makes the server start whenever you sign in to Windows, and points the app's Refresh button
# at this environment. Safe to run again.
# "Continue", not "Stop": Windows PowerShell treats a native tool's stderr (pip's notices) as an error when
# its output is captured, as it is when the app runs this. Each step checks $LASTEXITCODE instead.
param([switch]$NoAutoStart)
$ErrorActionPreference = "Continue"
$ProgressPreference = "SilentlyContinue"
Set-Location (Join-Path $PSScriptRoot "..")
$Root = (Get-Location).Path
$Venv = Join-Path $Root ".venv-d3"
$VPy = Join-Path $Venv "Scripts\python.exe"
$Model = "vllm-sr/d3"
$Start = Join-Path $Root "scraper\start_d3_server.ps1"
function Say($m) { Write-Host ""; Write-Host $m }
function Fail($m) { Write-Host $m; exit 1 }

Say "1/6  Checking this PC"
$smi = Get-Command nvidia-smi -ErrorAction SilentlyContinue
if (-not $smi) { Fail "No NVIDIA driver found (nvidia-smi). d3 needs an NVIDIA GPU on Windows; install the latest NVIDIA driver for your card." }
$gpu = (& nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits | Select-Object -First 1)
$name, $vram = $gpu -split ",\s*"
Write-Host "GPU: $name  ($([math]::Round([int]$vram / 1024)) GB)"
if ([int]$vram -lt 60000) { Fail "d3 needs about 60 GB of GPU memory (52 GB of weights plus working space); this GPU has $([math]::Round([int]$vram / 1024)) GB. The keyword rules will keep working." }
$drive = (Get-Item $Root).PSDrive
$freeGb = [math]::Floor($drive.Free / 1GB)
Write-Host "Free disk on $($drive.Name): $freeGb GB"
$cached = Test-Path (Join-Path $env:USERPROFILE ".cache\huggingface\hub\models--vllm-sr--d3")
if ($freeGb -lt 70 -and -not $cached) { Fail "Need about 70 GB free disk for the model download and packages; drive $($drive.Name): has $freeGb GB." }

function Find-Python {
  # the py launcher, python on PATH (skipping the Microsoft Store placeholder, which fails the version check),
  # then python.org's default install folders, which a fresh install hasn't added to this window's PATH yet
  $cands = @("py -3.12", "py -3.11", "py -3.13", "python")
  foreach ($v in @("312", "311", "313")) {
    $cands += Join-Path $env:LOCALAPPDATA "Programs\Python\Python$v\python.exe"
    $cands += Join-Path $env:ProgramFiles "Python$v\python.exe"
  }
  foreach ($cand in $cands) {
    if (Test-Path $cand -PathType Leaf) { $parts = @($cand) } else { $parts = @($cand -split " ") }
    $exe = $parts[0]; $pre = @($parts | Select-Object -Skip 1)
    if (-not (Get-Command $exe -ErrorAction SilentlyContinue)) { continue }
    & $exe @pre -c "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)" 2>$null
    if ($LASTEXITCODE -eq 0) { return ,$parts }
  }
  return $null
}
$py = Find-Python
if (-not $py) {
  $winget = Get-Command winget -ErrorAction SilentlyContinue
  if (-not $winget) { Fail "Need Python 3.10 or newer: install Python 3.12 from python.org (tick 'Add python.exe to PATH'), then run this again." }
  Write-Host "Python isn't installed; installing Python 3.12 for this user with winget (a minute or two)..."
  & winget install --id Python.Python.3.12 --exact --scope user --silent --accept-package-agreements --accept-source-agreements
  $py = Find-Python
  if (-not $py) { Fail "Installing Python didn't work (see above). Install Python 3.12 from python.org (tick 'Add python.exe to PATH'), then run this again." }
}
$pyExe = $py[0]; $pyPre = @($py | Select-Object -Skip 1)
Write-Host "Python: $(& $pyExe @pyPre --version)"

Say "2/6  Creating $Venv"
if (-not (Test-Path $VPy)) { & $pyExe @pyPre -m venv $Venv }
if (-not (Test-Path $VPy)) { Fail "Couldn't create the Python environment at $Venv." }
Remove-Item (Join-Path $Venv "D3_OK") -ErrorAction SilentlyContinue   # not ready until this run finishes
& powershell -NoProfile -ExecutionPolicy Bypass -File $Start -Stop | Out-Null   # an older server would hold the GPU and files
& $VPy -m pip install --quiet --upgrade pip

Say "3/6  Installing packages (several minutes the first time; PyTorch for CUDA is about 3 GB)"
& $VPy -m pip install --quiet -r scraper\requirements.txt
if ($LASTEXITCODE -ne 0) { Fail "Installing the scraper's packages failed (see above)." }
& $VPy -m pip install --quiet torch torchvision --index-url https://download.pytorch.org/whl/cu128
if ($LASTEXITCODE -ne 0) { Fail "Installing PyTorch for CUDA failed (see above)." }
& $VPy -m pip install --quiet "transformers==5.17.0" pillow opencv-python-headless safetensors accelerate huggingface_hub
if ($LASTEXITCODE -ne 0) { Fail "Installing the model's packages failed (see above)." }
& $VPy -c "import torch, sys; ok = torch.cuda.is_available(); print('PyTorch', torch.__version__, '| CUDA available:', ok, '|', torch.cuda.get_device_name(0) if ok else ''); sys.exit(0 if ok else 1)"
if ($LASTEXITCODE -ne 0) { Fail "PyTorch can't see the GPU. Update the NVIDIA driver and run this again." }

Say "4/6  Downloading the model"
Write-Host "(about 52 GB the first time; later runs reuse the Hugging Face cache)"
$dl = Join-Path $env:TEMP "aicd3_d3_download.py"
@'
import sys
from huggingface_hub import snapshot_download, HfApi
model = sys.argv[1]
sha = HfApi().model_info(model).sha
path = snapshot_download(model, revision=sha)
print("Downloaded to", path)
print("Model version (commit):", sha)
open(".venv-d3/D3_REVISION", "w").write(sha)
'@ | Set-Content -Encoding UTF8 $dl
& $VPy $dl $Model
if ($LASTEXITCODE -ne 0) { Fail "The model download failed (see above)." }
$rev = (Get-Content (Join-Path $Venv "D3_REVISION") -Raw).Trim()

Say "5/6  Saving settings and starting the model server"
$envFile = Join-Path $Root ".env.local"
if (-not (Test-Path $envFile)) { New-Item -ItemType File $envFile | Out-Null }
function Set-EnvLine($key, $value) {   # set KEY=VALUE in .env.local without printing or touching other lines
  $lines = @(Get-Content $envFile -ErrorAction SilentlyContinue)
  $hit = $false
  $out = foreach ($l in $lines) { if ($l -match "^$key=") { $hit = $true; "$key=$value" } else { $l } }
  if (-not $hit) { $out = @($out) + "$key=$value" }
  # UTF-8 without a byte-order mark: a BOM would corrupt the first variable name for Next.js
  [System.IO.File]::WriteAllLines($envFile, [string[]]$out, (New-Object System.Text.UTF8Encoding $false))
}
Set-EnvLine "SCRAPER_PYTHON" ($VPy -replace "\\", "/")
Set-EnvLine "D3_MODEL" $Model
Set-EnvLine "D3_REVISION" $rev
Write-Host "Set SCRAPER_PYTHON, D3_MODEL and D3_REVISION in .env.local (D3_REVISION pins the model's code to the version just downloaded)."
& powershell -NoProfile -ExecutionPolicy Bypass -File $Start -Wait
if ($LASTEXITCODE -ne 0) { Fail "The model server didn't start (see above)." }

Say "6/6  Classifying a sample posting through the server"
& $VPy scraper\classify.py --check
if ($LASTEXITCODE -ne 0) { Fail "The server is running but didn't classify the sample (see above)." }

if (-not $NoAutoStart) {
  # a shortcut in this user's Startup folder: starts the server, hidden, whenever you sign in (no admin rights needed)
  $startup = [Environment]::GetFolderPath("Startup")
  $lnk = Join-Path $startup "AICD3 d3 model server.lnk"
  $ws = New-Object -ComObject WScript.Shell
  $sc = $ws.CreateShortcut($lnk)
  $sc.TargetPath = (Get-Command powershell.exe).Source
  $sc.Arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$Start`""
  $sc.WorkingDirectory = $Root
  $sc.WindowStyle = 7   # minimized
  $sc.Description = "Hosts the vllm-sr/d3 classifier for the AICD3 job board"
  $sc.Save()
  Write-Host "The server will start whenever you sign in to Windows ($lnk). Delete that shortcut to stop this."
}
Get-Date | Set-Content (Join-Path $Venv "D3_OK")   # tells the app's Refresh button to use this environment
Say "Done. The d3 server is running on http://127.0.0.1:8765, and the next Refresh classifies with it."
