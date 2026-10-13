# Sets up the vllm-sr/d3-flash classifier on a Windows PC with an NVIDIA GPU, in its own Python
# environment (.venv-d3). The Admin page's "Set up d3-flash" button runs this; you can also run it:
#
#   powershell -ExecutionPolicy Bypass -File scraper\setup_d3.ps1
#
# It: checks the GPU, creates .venv-d3 with the scraper's and the model's packages (PyTorch built for
# CUDA 12.8, which RTX 50-series and RTX PRO 6000 Blackwell cards need), downloads the model (about
# 17 GB, once), classifies one sample posting, and points the app's Refresh button at this environment.
# Safe to run again.
# "Continue", not "Stop": Windows PowerShell treats a native tool's stderr (pip's notices) as an error when
# its output is captured, as it is when the app runs this. Each step checks $LASTEXITCODE instead.
$ErrorActionPreference = "Continue"
$ProgressPreference = "SilentlyContinue"
Set-Location (Join-Path $PSScriptRoot "..")
$Root = (Get-Location).Path
$Venv = Join-Path $Root ".venv-d3"
$VPy = Join-Path $Venv "Scripts\python.exe"
function Say($m) { Write-Host ""; Write-Host $m }
function Fail($m) { Write-Host $m; exit 1 }

Say "1/5  Checking this PC"
$smi = Get-Command nvidia-smi -ErrorAction SilentlyContinue
if (-not $smi) { Fail "No NVIDIA driver found (nvidia-smi). d3-flash needs an NVIDIA GPU on Windows; install the latest Studio or Game Ready driver." }
$gpu = (& nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits | Select-Object -First 1)
$name, $vram = $gpu -split ",\s*"
Write-Host "GPU: $name  ($([math]::Round([int]$vram / 1024)) GB)"
if ([int]$vram -lt 20000) { Fail "d3-flash needs about 18 GB of GPU memory; this GPU has $([math]::Round([int]$vram / 1024)) GB. The keyword rules will keep working." }
$drive = (Get-Item $Root).PSDrive
$freeGb = [math]::Floor($drive.Free / 1GB)
Write-Host "Free disk on $($drive.Name): $freeGb GB"
if ($freeGb -lt 25) { Fail "Need about 25 GB free disk for the model download; drive $($drive.Name): has $freeGb GB." }

$py = $null
foreach ($cand in @("py -3.12", "py -3.11", "py -3.13", "python")) {
  $parts = $cand -split " "
  $exe = $parts[0]; $pre = @($parts | Select-Object -Skip 1)
  if (-not (Get-Command $exe -ErrorAction SilentlyContinue)) { continue }
  & $exe @pre -c "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)" 2>$null
  if ($LASTEXITCODE -eq 0) { $py = $parts; break }
}
if (-not $py) { Fail "Need Python 3.10 or newer from python.org (tick 'Add python.exe to PATH'), then run this again." }
$pyExe = $py[0]; $pyPre = @($py | Select-Object -Skip 1)
Write-Host "Python: $(& $pyExe @pyPre --version)"

Say "2/5  Creating $Venv"
if (-not (Test-Path $VPy)) { & $pyExe @pyPre -m venv $Venv }
if (-not (Test-Path $VPy)) { Fail "Couldn't create the Python environment at $Venv." }
Remove-Item (Join-Path $Venv "D3_OK") -ErrorAction SilentlyContinue   # not ready until this run finishes
& $VPy -m pip install --quiet --upgrade pip

Say "3/5  Installing packages (several minutes the first time; PyTorch for CUDA is about 3 GB)"
& $VPy -m pip install --quiet -r scraper\requirements.txt
if ($LASTEXITCODE -ne 0) { Fail "Installing the scraper's packages failed (see above)." }
& $VPy -m pip install --quiet torch torchvision --index-url https://download.pytorch.org/whl/cu128
if ($LASTEXITCODE -ne 0) { Fail "Installing PyTorch for CUDA failed (see above)." }
& $VPy -m pip install --quiet "transformers==5.17.0" pillow opencv-python-headless safetensors accelerate huggingface_hub
if ($LASTEXITCODE -ne 0) { Fail "Installing the model's packages failed (see above)." }
& $VPy -c "import torch, sys; ok = torch.cuda.is_available(); print('PyTorch', torch.__version__, '| CUDA available:', ok, '|', torch.cuda.get_device_name(0) if ok else ''); sys.exit(0 if ok else 1)"
if ($LASTEXITCODE -ne 0) { Fail "PyTorch can't see the GPU. Update the NVIDIA driver and run this again." }

Say "4/5  Downloading the model and classifying a sample posting"
Write-Host "(about 17 GB the first time; later runs reuse the Hugging Face cache)"
$dl = Join-Path $env:TEMP "aicd3_d3_download.py"
@'
from huggingface_hub import snapshot_download, HfApi
path = snapshot_download("vllm-sr/d3-flash")
sha = HfApi().model_info("vllm-sr/d3-flash").sha
print("Downloaded to", path)
print("Model version (commit):", sha)
open(".venv-d3/D3_REVISION", "w").write(sha)
'@ | Set-Content -Encoding UTF8 $dl
& $VPy $dl
if ($LASTEXITCODE -ne 0) { Fail "The model download failed (see above)." }
$env:D3_REVISION = (Get-Content (Join-Path $Venv "D3_REVISION") -Raw).Trim()
& $VPy scraper\classify.py --check
if ($LASTEXITCODE -ne 0) { Fail "The model downloaded but didn't classify the sample (see above)." }

Say "5/5  Pointing the app's Refresh button at this environment"
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
Set-EnvLine "D3_REVISION" $env:D3_REVISION
Get-Date | Set-Content (Join-Path $Venv "D3_OK")   # tells the app's Refresh button to use this environment
Write-Host "Set SCRAPER_PYTHON and D3_REVISION in .env.local (D3_REVISION pins the model's code to the version just checked)."
Say "Done. The next Refresh uses d3-flash."
