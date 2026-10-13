#!/usr/bin/env bash
# Installs what the scraper needs into the Python the app's Refresh button uses, then checks
# Eli Lilly (the site behind Cloudflare) with a dry run that saves nothing.
#
#   bash scripts/setup-scraper.sh
#
# Every step prints as it goes; the dry run also writes a full log under scraper/out/logs/.
set -euo pipefail
cd "$(dirname "$0")/.."
export PYTHONUNBUFFERED=1
step() { printf "\n\033[1m[%s] %s\033[0m\n" "$(date +%H:%M:%S)" "$*"; }

PY="${SCRAPER_PYTHON:-python3}"
if [ -f .env.local ] && grep -q '^SCRAPER_PYTHON=' .env.local; then
  PY="$(grep '^SCRAPER_PYTHON=' .env.local | tail -1 | cut -d= -f2- | tr -d '"' | tr -d "'")"
fi
step "Python: $PY ($("$PY" --version 2>&1), at $(command -v "$PY" || echo "$PY"))"

step "1/5  Scraper packages (requests, BeautifulSoup, lxml, curl_cffi, anthropic)"
"$PY" -m pip install --upgrade --progress-bar on -r scraper/requirements.txt

step "2/5  Checking curl_cffi can connect like Chrome"
"$PY" - <<'PYEOF'
from curl_cffi import requests as r
x = r.get("https://lilly.wd115.myworkdayjobs.com/CMP", impersonate="chrome", timeout=30)
print("Lilly campus board answered HTTP", x.status_code, "| server:", x.headers.get("server"),
      "| Cloudflare challenge page:", "yes" if ("_cf_chl_opt" in x.text or "/orchestrate/" in x.text) else "no")
PYEOF

step "3/5  Headless Chromium for Lilly's fallback route (about 150 MB, once)"
"$PY" -m pip install --upgrade --progress-bar on playwright
"$PY" -m playwright install chromium

step "4/5  Checking Claude (settings from .env.local; UCSF's gateway needs the UCSF VPN)"
"$PY" scraper/classify.py --check --classifier llm || echo "Claude isn't reachable with these settings; refreshes will use keyword rules. The error above says why."

step "5/5  Dry run for Eli Lilly (nothing is saved; full log in scraper/out/logs/)"
"$PY" scraper/pipeline.py --companies Lilly --dry-run --no-check --workers 1 || true
step "Done. Look for 'Eli Lilly: N internship postings' above. The next Refresh uses all of this."
