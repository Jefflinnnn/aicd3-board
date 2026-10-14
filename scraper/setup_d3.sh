#!/usr/bin/env bash
# Sets up the vllm-sr/d3 classifier in its own Python environment (.venv-d3) on a Linux machine with a large
# NVIDIA GPU (64 GB or more), and starts the model server (scraper/d3_server.py on http://127.0.0.1:8765).
# On Windows, use scraper/setup_d3.ps1. The Admin page's "Set up d3" button runs the right one.
#
#   bash scraper/setup_d3.sh
#
# It: checks the GPU and disk, creates .venv-d3 with the scraper's and the model's packages, downloads the
# model (about 52 GB, once), starts the server, classifies one sample posting through it, and points the
# app's Refresh button at this environment (SCRAPER_PYTHON in .env.local). Safe to run again.
# To start the server again later (after a reboot):
#   setsid .venv-d3/bin/python scraper/d3_server.py >> scraper/out/logs/d3-server.log 2>&1 < /dev/null &
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
VENV="$ROOT/.venv-d3"
MODEL="vllm-sr/d3"
PORT="${D3_PORT:-8765}"

say() { printf "\n\033[1m%s\033[0m\n" "$*"; }

say "1/6  Checking this computer"
FREE_GB=$(( $(df -Pk "$ROOT" | awk 'NR==2 {print $4}') / 1048576 ))
if [[ "$(uname -s)" == "Linux" ]] && command -v nvidia-smi >/dev/null; then
  IFS=, read -r GPU VRAM < <(nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits | head -1)
  echo "GPU: ${GPU}  ($(( VRAM / 1024 )) GB)   Free disk: ${FREE_GB} GB"
  if (( VRAM < 60000 )); then echo "d3 needs about 60 GB of GPU memory; this GPU has $(( VRAM / 1024 )) GB. The keyword rules will keep working."; exit 1; fi
else
  echo "d3 needs a Linux or Windows PC with an NVIDIA GPU with 64 GB or more. On Windows use scraper/setup_d3.ps1."; exit 1
fi
if (( FREE_GB < 70 )) && [[ ! -d "$HOME/.cache/huggingface/hub/models--vllm-sr--d3" ]]; then
  echo "Need about 70 GB free disk for the model download and packages; you have ${FREE_GB} GB."; exit 1
fi

PY=""
for c in python3.12 python3.11 python3.13 python3; do
  if command -v "$c" >/dev/null && "$c" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' 2>/dev/null; then PY="$(command -v "$c")"; break; fi
done
[[ -z "$PY" ]] && { echo "Need Python 3.10 or newer."; exit 1; }
echo "Python: $PY ($("$PY" --version))"

say "2/6  Creating $VENV"
[[ -d "$VENV" ]] || "$PY" -m venv "$VENV"
rm -f "$VENV/D3_OK"   # not ready until this run finishes
pkill -f "scraper/d3_server.py" 2>/dev/null || true   # an older server would hold the GPU
"$VENV/bin/python" -m pip install --quiet --upgrade pip

say "3/6  Installing packages (a few minutes the first time)"
"$VENV/bin/pip" install --quiet -r scraper/requirements.txt
# CUDA 12.8 builds also cover RTX 50-series / RTX PRO Blackwell cards
"$VENV/bin/pip" install --quiet torch torchvision --index-url https://download.pytorch.org/whl/cu128
"$VENV/bin/pip" install --quiet "transformers==5.17.0" pillow opencv-python-headless safetensors accelerate huggingface_hub
"$VENV/bin/python" -c "import torch, sys; ok = torch.cuda.is_available(); print('PyTorch', torch.__version__, '| CUDA available:', ok, '|', torch.cuda.get_device_name(0) if ok else ''); sys.exit(0 if ok else 1)" \
  || { echo "PyTorch can't see the GPU; update the NVIDIA driver and try again."; exit 1; }

say "4/6  Downloading the model"
echo "(about 52 GB the first time; later runs reuse ~/.cache/huggingface)"
"$VENV/bin/python" - "$MODEL" <<'PYEOF'
import sys
from huggingface_hub import snapshot_download, HfApi
model = sys.argv[1]
sha = HfApi().model_info(model).sha
path = snapshot_download(model, revision=sha)
print("Downloaded to", path)
print("Model version (commit):", sha)
open(".venv-d3/D3_REVISION", "w").write(sha)
PYEOF

say "5/6  Saving settings and starting the model server"
touch .env.local
set_env() {   # set KEY=VALUE in .env.local without printing or touching other lines
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
set_env D3_MODEL "$MODEL"
set_env D3_REVISION "$(cat "$VENV/D3_REVISION")"
echo "Set SCRAPER_PYTHON, D3_MODEL and D3_REVISION in .env.local (D3_REVISION pins the model's code to the version just downloaded)."
mkdir -p scraper/out/logs
# setsid: its own session, so it outlives this script (and the app run that started it)
setsid "$VENV/bin/python" scraper/d3_server.py --port "$PORT" >> scraper/out/logs/d3-server.log 2>&1 < /dev/null &
SERVER_PID=$!
for _ in $(seq 1 180); do
  if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then break; fi
  kill -0 "$SERVER_PID" 2>/dev/null || { echo "The model server stopped while loading:"; tail -25 scraper/out/logs/d3-server.log; exit 1; }
  sleep 5
done
curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null || { echo "The model server didn't answer within 15 minutes; see scraper/out/logs/d3-server.log"; exit 1; }
echo "The d3 server is ready at http://127.0.0.1:$PORT"

say "6/6  Classifying a sample posting through the server"
"$VENV/bin/python" scraper/classify.py --check

date > "$VENV/D3_OK"   # tells the app's Refresh button to use this environment from now on
say "Done. The next Refresh classifies with d3 (if you ran this in a terminal, restart pnpm dev first)."
echo "After a reboot, start the server again with the setsid line at the top of this file."
