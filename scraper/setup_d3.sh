#!/usr/bin/env bash
# Sets up the vllm-sr/d3-flash classifier in its own Python environment (.venv-d3), on an Apple-silicon
# Mac (Apple GPU; Docker on a Mac can't use it) or a Linux machine with an NVIDIA GPU.
# On Windows, use scraper/setup_d3.ps1. The Admin page's "Set up d3-flash" button runs the right one.
#
#   bash scraper/setup_d3.sh
#
# It: checks the Mac, creates .venv-d3 with the scraper's and the model's packages, downloads the
# model (about 17 GB, once), classifies one sample posting to prove it works, and points the app's
# Refresh button at this environment (SCRAPER_PYTHON in .env.local). Safe to run again.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
VENV="$ROOT/.venv-d3"

say() { printf "\n\033[1m%s\033[0m\n" "$*"; }

say "1/5  Checking this computer"
FREE_GB=$(( $(df -Pk "$ROOT" | awk 'NR==2 {print $4}') / 1048576 ))
if [[ "$(uname -s)" == "Darwin" && "$(uname -m)" == "arm64" ]]; then
  KIND=mps
  MEM_GB=$(( $(sysctl -n hw.memsize) / 1073741824 ))
  echo "Chip: $(sysctl -n machdep.cpu.brand_string)   Memory: ${MEM_GB} GB   Free disk: ${FREE_GB} GB"
  if (( MEM_GB < 24 )); then
    echo "d3-flash needs about 18 GB of memory for itself; with ${MEM_GB} GB it won't fit. The keyword rules will keep working."; exit 1
  fi
  (( MEM_GB < 32 )) && echo "Note: ${MEM_GB} GB works, but close other big apps while a refresh runs."
elif [[ "$(uname -s)" == "Linux" ]] && command -v nvidia-smi >/dev/null; then
  KIND=cuda
  IFS=, read -r GPU VRAM < <(nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits | head -1)
  echo "GPU: ${GPU}  ($(( VRAM / 1024 )) GB)   Free disk: ${FREE_GB} GB"
  if (( VRAM < 20000 )); then echo "d3-flash needs about 18 GB of GPU memory; this GPU has $(( VRAM / 1024 )) GB."; exit 1; fi
else
  echo "This script handles Apple-silicon Macs and Linux with an NVIDIA GPU. On Windows use scraper/setup_d3.ps1."; exit 1
fi
if (( FREE_GB < 25 )); then echo "Need about 25 GB free disk for the model download; you have ${FREE_GB} GB."; exit 1; fi

PY=""
for c in python3.12 python3.11 python3.13 python3; do
  if command -v "$c" >/dev/null && "$c" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' 2>/dev/null; then PY="$(command -v "$c")"; break; fi
done
[[ -z "$PY" ]] && { echo "Need Python 3.10 or newer (e.g. brew install python@3.12)."; exit 1; }
echo "Python: $PY ($("$PY" --version))"

say "2/5  Creating $VENV"
[[ -d "$VENV" ]] || "$PY" -m venv "$VENV"
rm -f "$VENV/D3_OK"   # not ready until this run finishes
"$VENV/bin/python" -m pip install --quiet --upgrade pip

say "3/5  Installing packages (a few minutes the first time)"
"$VENV/bin/pip" install --quiet -r scraper/requirements.txt
if [[ "$KIND" == cuda ]]; then   # CUDA 12.8 builds also cover RTX 50-series / RTX PRO Blackwell cards
  "$VENV/bin/pip" install --quiet torch torchvision --index-url https://download.pytorch.org/whl/cu128
fi
"$VENV/bin/pip" install --quiet "transformers==5.17.0" torch torchvision pillow opencv-python-headless safetensors accelerate huggingface_hub
KIND="$KIND" "$VENV/bin/python" - <<'PYEOF'
import os, torch
if os.environ["KIND"] == "cuda":
    ok = torch.cuda.is_available()
    print("PyTorch", torch.__version__, "| CUDA available:", ok, "|", torch.cuda.get_device_name(0) if ok else "")
    if not ok:
        raise SystemExit("PyTorch can't see the GPU; update the NVIDIA driver and try again.")
else:
    print("PyTorch", torch.__version__, "| Apple GPU (MPS) available:", torch.backends.mps.is_available())
    if not torch.backends.mps.is_available():
        raise SystemExit("The Apple GPU isn't available to PyTorch; update macOS (14 or later) and try again.")
PYEOF

say "4/5  Downloading the model and classifying a sample posting"
echo "(about 17 GB the first time; later runs reuse ~/.cache/huggingface)"
"$VENV/bin/python" - <<'PYEOF'
from huggingface_hub import snapshot_download, HfApi
path = snapshot_download("vllm-sr/d3-flash")
sha = HfApi().model_info("vllm-sr/d3-flash").sha
print("Downloaded to", path)
print("Model version (commit):", sha)
open(".venv-d3/D3_REVISION", "w").write(sha)
PYEOF
D3_REVISION="$(cat "$VENV/D3_REVISION")" "$VENV/bin/python" scraper/classify.py --check

say "5/5  Pointing the app's Refresh button at this environment"
touch .env.local
set_env() {   # set KEY=VALUE in .env.local without printing or touching other lines (works on macOS and Linux)
  "$VENV/bin/python" - "$1" "$2" <<'PYEOF'
import sys
key, value = sys.argv[1], sys.argv[2]
lines = open(".env.local", encoding="utf-8").read().splitlines()
out, hit = [], False
for l in lines:
    if l.startswith(key + "="):
        out.append(f"{key}={value}"); hit = True
    else:
        out.append(l)
if not hit:
    out.append(f"{key}={value}")
open(".env.local", "w", encoding="utf-8").write("\n".join(out) + "\n")
PYEOF
}
set_env SCRAPER_PYTHON "$VENV/bin/python"
set_env D3_REVISION "$(cat "$VENV/D3_REVISION")"
echo "Set SCRAPER_PYTHON and D3_REVISION in .env.local (D3_REVISION pins the model's code to the version just checked)."

date > "$VENV/D3_OK"   # tells the app's Refresh button to use this environment from now on
say "Done. The next Refresh uses d3-flash (if you ran this in a terminal, restart pnpm dev first)."
echo "The Refresh panel shows 'Classifier: d3-flash' for runs that used it."
