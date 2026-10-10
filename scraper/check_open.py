#!/usr/bin/env python3
"""
Re-check every posting that is open on the job board and find the ones the employer has taken down.

  export AICD3_URL=https://your-job-board.example     # or http://localhost:3000
  export AICD3_INGEST_TOKEN=...                        # the app's SCRAPER_INGEST_TOKEN
  python3 scraper/check_open.py                        # report only
  python3 scraper/check_open.py --apply                # also mark the closed ones "Taken down"

It asks the app for its open postings (GET /api/ingest/open), checks each one's own link at the same
polite pace as the scraper (one request at a time per site, several sites side by side), and with
--apply sends the closed ones to POST /api/ingest/close. One request per posting, so it is much
lighter than a full scrape and can run daily.

How a posting counts as closed:
  * Workday     the job's detail record is gone (404/410) or no longer accepts applications
  * Greenhouse  the job is gone from the company's public job board API (404)
  * other sites the page answers 404/410, redirects away from the job, or says it's no longer open
Anything else (a block page, a timeout, a server error, a link to the company's home page) counts
as "unknown" and is left alone, so a bad day on a career site never closes postings by mistake.
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import re
import sys
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from urllib.parse import parse_qs, urlparse

import requests

import pharma_internships as pi

log = logging.getLogger("check_open")

CLOSED_TEXT = re.compile(
    r"no longer (?:accepting applications|available|open|active)|position has been filled|"
    r"job (?:posting )?(?:has )?(?:expired|closed|been removed)|this (?:job|position|requisition) (?:is )?(?:closed|no longer)|"
    r"the job you are (?:looking for|trying to apply for) (?:is no longer|has been)|"
    r"stelle ist (?:nicht mehr|bereits) (?:verfügbar|besetzt)|offre (?:n'est plus|a été pourvue)",
    re.IGNORECASE,
)
WORKDAY_HOST = re.compile(r"^(?P<tenant>[^.]+)\.(?P<wd>wd\d+)\.myworkdayjobs\.com$", re.IGNORECASE)
GREENHOUSE_TOKENS = {cfg["id"]: cfg["token"] for cfg in pi.COMPANIES.values() if cfg.get("platform") == "greenhouse"}


@dataclass
class Result:
    id: str
    company: str
    title: str
    url: str
    status: str  # open | closed | unknown
    reason: str


def workday_detail_url(url: str) -> str | None:
    """https://amgen.wd1.myworkdayjobs.com/[en-US/]Careers/job/<loc>/<slug>  ->  the cxs detail API URL."""
    u = urlparse(url)
    m = WORKDAY_HOST.match(u.netloc)
    if not m or "/job/" not in u.path:
        return None
    parts = [p for p in u.path.split("/") if p]
    if parts and re.fullmatch(r"[a-z]{2}-[A-Z]{2}", parts[0]):
        parts = parts[1:]  # locale prefix
    if len(parts) < 3 or parts[1] != "job":
        return None
    site, rest = parts[0], "/".join(parts[1:])
    return f"https://{u.netloc}/wday/cxs/{m.group('tenant')}/{site}/{rest}"


def greenhouse_api_url(url: str, company: str) -> str | None:
    u = urlparse(url)
    q = parse_qs(u.query)
    job_id = (q.get("gh_jid") or [None])[0]
    token = GREENHOUSE_TOKENS.get(company)
    m = re.search(r"greenhouse\.io/([^/]+)/jobs/(\d+)", url)
    if m:
        token, job_id = m.group(1), m.group(2)
    if token and job_id and job_id.isdigit():
        return f"https://boards-api.greenhouse.io/v1/boards/{token}/jobs/{job_id}"
    return None


def check(client: pi.PoliteClient, p: dict) -> Result:
    def res(status: str, reason: str) -> Result:
        return Result(p["id"], p["company"], p["title"], p["url"], status, reason)

    url = p.get("url") or ""
    if not url.startswith("http"):
        return res("unknown", "no link")
    u = urlparse(url)
    if u.path.strip("/") == "" and not u.query:
        return res("unknown", "link is a company home page, not a posting")
    try:
        api = workday_detail_url(url)
        if api:
            r = client.get(api, headers={"Accept": "application/json"})
            if r.status_code in (404, 410):
                return res("closed", f"Workday detail answered {r.status_code}")
            if r.status_code != 200:
                return res("unknown", f"Workday detail answered {r.status_code}")
            info = (r.json() or {}).get("jobPostingInfo")
            if not info:
                return res("closed", "Workday returned no posting")
            if info.get("canApply") is False:
                return res("closed", "Workday says it no longer accepts applications")
            return res("open", "Workday posting is live")

        api = greenhouse_api_url(url, p.get("company", ""))
        if api:
            r = client.get(api, headers={"Accept": "application/json"})
            if r.status_code == 404:
                return res("closed", "gone from the Greenhouse job board")
            return res("open" if r.status_code == 200 else "unknown", f"Greenhouse answered {r.status_code}")

        r = client.get(url, headers={"Accept": "text/html"}, allow_redirects=True)
        if r.status_code in (404, 410):
            return res("closed", f"posting page answered {r.status_code}")
        if r.status_code != 200:
            return res("unknown", f"posting page answered {r.status_code}")
        final = urlparse(r.url)
        job_marker = re.search(r"(\d{5,}|jid-\d+|R-?\d{4,})", u.path + "?" + u.query)
        if final.path.rstrip("/") != u.path.rstrip("/") and job_marker and job_marker.group(1) not in (final.path + "?" + final.query):
            return res("closed", f"redirected away from the posting to {final.path or '/'}")
        if CLOSED_TEXT.search(r.text[:200000]):
            return res("closed", "page says the job is no longer open")
        return res("open", "posting page is live")
    except pi.BlockedError:
        return res("unknown", "the site showed a bot check")
    except (requests.RequestException, ValueError) as e:
        return res("unknown", f"request failed: {e.__class__.__name__}")


def check_all(postings: list[dict], client: pi.PoliteClient, workers: int) -> list[Result]:
    """One thread per site (host), so each site still sees one request at a time at the polite pace."""
    by_host: dict[str, list[dict]] = defaultdict(list)
    for p in postings:
        url = p.get("url") or ""
        api = workday_detail_url(url) or greenhouse_api_url(url, p.get("company", "")) or url
        by_host[urlparse(api).netloc].append(p)

    def run_host(items: list[dict]) -> list[Result]:
        c = client if workers <= 1 else client.clone()
        return [check(c, p) for p in items]

    results: list[Result] = []
    if workers <= 1:
        for items in by_host.values():
            results += run_host(items)
        return results
    with ThreadPoolExecutor(max_workers=workers) as pool:
        for f in as_completed([pool.submit(run_host, items) for items in by_host.values()]):
            results += f.result()
    return results


def app_call(method: str, path: str, url: str, token: str, body: dict | None = None) -> dict:
    r = requests.request(method, url.rstrip("/") + path, json=body, timeout=120,
                         headers={"Authorization": f"Bearer {token}", "Accept": "application/json"})
    if r.status_code != 200:
        raise SystemExit(f"{method} {path} failed: HTTP {r.status_code} {r.text[:200]}")
    return r.json()


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--apply", action="store_true", help="mark the closed postings 'Taken down' on the board")
    ap.add_argument("--url", default=os.environ.get("AICD3_URL", "http://localhost:3000"))
    ap.add_argument("--workers", type=int, default=5, help="sites checked side by side (each one politely); max 6")
    ap.add_argument("--min-delay", type=float, default=1.5)
    ap.add_argument("--max-delay", type=float, default=3.0)
    ap.add_argument("--report", default="scraper/out/check_open.json", help="where to save the full results")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO, format="%(asctime)s %(message)s", datefmt="%H:%M:%S")
    token = os.environ.get("AICD3_INGEST_TOKEN", "")
    if not token:
        print("Set AICD3_INGEST_TOKEN (the app's SCRAPER_INGEST_TOKEN).", file=sys.stderr)
        return 1

    postings = app_call("GET", "/api/ingest/open", args.url, token)["postings"]
    print(f"Checking {len(postings)} open postings…")
    client = pi.PoliteClient(args.min_delay, args.max_delay)
    results = check_all(postings, client, max(1, min(args.workers, 6)))

    closed = [r for r in results if r.status == "closed"]
    unknown = [r for r in results if r.status == "unknown"]
    os.makedirs(os.path.dirname(args.report) or ".", exist_ok=True)
    with open(args.report, "w", encoding="utf-8") as f:
        json.dump([r.__dict__ for r in results], f, ensure_ascii=False, indent=2)
    print(f"\n{len(results) - len(closed) - len(unknown)} still open, {len(closed)} closed, {len(unknown)} couldn't be checked")
    for r in closed:
        print(f"  CLOSED  {r.company:<12} {r.title[:60]:<60}  {r.reason}")
    for r in unknown[:30]:
        print(f"  ?       {r.company:<12} {r.title[:60]:<60}  {r.reason}")
    print(f"Full results: {args.report}")

    if closed and args.apply:
        out = app_call("POST", "/api/ingest/close", args.url, token,
                       {"ids": [r.id for r in closed], "reasons": {r.id: r.reason for r in closed}})
        print(f"Marked {out['closed']} as taken down.")
    elif closed:
        print("Run again with --apply to mark them taken down.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
