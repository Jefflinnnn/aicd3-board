#!/usr/bin/env python3
"""
Re-check every posting that is open on the job board and find the ones the employer has taken down.

  export AICD3_URL=https://your-job-board.example     # or http://localhost:3000
  export AICD3_INGEST_TOKEN=...                        # the app's SCRAPER_INGEST_TOKEN
  python3 scraper/check_open.py                        # report only
  python3 scraper/check_open.py --apply                # also mark the closed ones "Taken down" and send
                                                       # the ones it can't confirm to the review queue

It asks the app for its open postings (GET /api/ingest/open), checks each one's own link at the same
polite pace as the scraper (one request at a time per site, several sites side by side), and with
--apply sends the closed ones to POST /api/ingest/close and the ones it couldn't confirm to
POST /api/ingest/flag. One request per posting, so it is much lighter than a full scrape and can
run daily.

How a posting counts as closed:
  * Workday     the job's detail record is gone (404/410) or no longer accepts applications
  * Greenhouse  the job is gone from the company's public job board API (404)
  * Ashby       the job is no longer in the company's public job board API
  * Lever       the job is gone from the company's public postings API (404)
  * Eightfold   the job's record is gone from the site's job API (404/410)
  * other sites the page answers 404/410, redirects away from the job, or says it's no longer open
Anything else (a block page, a timeout, a server error, a link to the company's home page) counts
as "unknown": it is never closed automatically. With --apply it goes to the staff review queue
("Couldn't confirm it's still open"), off the job board until staff Approve it (back on the board)
or Reject it (kept off).

One exception: when every posting on a site comes back unknown (the whole site is down, in
maintenance or blocking us), the postings stay on the board and are only reported, so one bad
morning on a career site doesn't empty that company from the board. Use --flag-site-outages to
send them to review anyway.
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
    site_down: bool = False  # unknown because the whole site failed, not this posting


SITE_DOWN_MIN = 3  # a site needs at least this many postings, all unknown, to count as down


def mark_site_outages(results: list["Result"], postings: list[dict]) -> None:
    """Mark the unknown results of sites where every posting came back unknown."""
    host_of = {p["id"]: site_key(p) for p in postings}
    by_host: dict[str, list[Result]] = defaultdict(list)
    for r in results:
        by_host[host_of.get(r.id, "")].append(r)
    for host, rs in by_host.items():
        if host and len(rs) >= SITE_DOWN_MIN and all(r.status == "unknown" for r in rs):
            for r in rs:
                r.site_down = True


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


LEVER_URL = re.compile(r"^https://jobs\.lever\.co/(?P<site>[^/]+)/(?P<id>[0-9a-f-]{36})", re.I)
# Eightfold job pages (talent.bayer.com/careers/job/562949978740495) are app shells that answer 200 either way
EIGHTFOLD_SITES = {urlparse(cfg["base"]).netloc: cfg["domain"] for cfg in pi.COMPANIES.values() if cfg.get("platform") == "eightfold"}
EIGHTFOLD_URL = re.compile(r"^https://(?P<host>[^/]+)/careers/job/(?P<id>\d+)", re.I)


def lever_api_url(url: str) -> str | None:
    m = LEVER_URL.match(url)
    return f"https://api.lever.co/v0/postings/{m.group('site')}/{m.group('id')}" if m else None


def eightfold_api_url(url: str) -> str | None:
    m = EIGHTFOLD_URL.match(url)
    if not m or m.group("host").lower() not in EIGHTFOLD_SITES:
        return None
    return f"https://{m.group('host')}/api/apply/v2/jobs/{m.group('id')}?domain={EIGHTFOLD_SITES[m.group('host').lower()]}"


ASHBY_URL = re.compile(r"^https://jobs\.ashbyhq\.com/(?P<org>[^/]+)/(?P<id>[0-9a-f-]{36})", re.I)
_ashby_boards: dict[str, set[str]] = {}


def ashby_open_ids(client: pi.PoliteClient, org: str) -> set[str]:
    """Ids of every job on an Ashby board, fetched once per run."""
    if org not in _ashby_boards:
        r = client.get(f"https://api.ashbyhq.com/posting-api/job-board/{org}", headers={"Accept": "application/json"})
        r.raise_for_status()
        _ashby_boards[org] = {j.get("id") for j in r.json().get("jobs", [])}
    return _ashby_boards[org]


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

        m = ASHBY_URL.match(url)
        if m:   # the job page itself is an app shell that answers 200 even for removed jobs
            ids = ashby_open_ids(client, m.group("org"))
            if not ids:
                return res("unknown", "the Ashby job board came back empty")
            return res("open", "on the Ashby job board") if m.group("id") in ids else res("closed", "gone from the Ashby job board")

        api = lever_api_url(url)
        if api:
            r = client.get(api, headers={"Accept": "application/json"})
            if r.status_code == 404:
                return res("closed", "gone from the Lever postings API")
            return res("open" if r.status_code == 200 else "unknown", f"Lever answered {r.status_code}")

        api = eightfold_api_url(url)
        if api:
            r = client.get(api, headers={"Accept": "application/json"})
            if r.status_code in (404, 410):
                return res("closed", f"Eightfold job API answered {r.status_code}")
            if r.status_code != 200:
                return res("unknown", f"Eightfold job API answered {r.status_code}")
            return res("open", "Eightfold posting is live") if (r.json() or {}).get("id") else res("unknown", "Eightfold returned no posting")

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
    except pi.UnavailableError:
        return res("unknown", "the site is down for maintenance")
    except pi.BlockedError:
        return res("unknown", "the site showed a bot check")
    except (requests.RequestException, ValueError, KeyError) as e:
        return res("unknown", f"request failed: {e.__class__.__name__}")


# Workday hosts of companies marked "impersonate" in pharma_internships.COMPANIES (Eli Lilly's wd115)
IMPERSONATE_HOSTS = {f"{b[0]}.{b[1]}.myworkdayjobs.com" for cfg in pi.COMPANIES.values()
                     if cfg.get("impersonate") and cfg.get("platform") == "workday" for b in cfg["boards"]}


def site_key(p: dict) -> str:
    url = p.get("url") or ""
    if ASHBY_URL.match(url):
        return "api.ashbyhq.com"
    return urlparse(workday_detail_url(url) or lever_api_url(url) or greenhouse_api_url(url, p.get("company", "")) or url).netloc


def check_all(postings: list[dict], client: pi.PoliteClient, workers: int) -> list[Result]:
    """One thread per site (host), so each site still sees one request at a time at the polite pace."""
    by_host: dict[str, list[dict]] = defaultdict(list)
    for p in postings:
        by_host[site_key(p)].append(p)

    def run_host(items: list[dict]) -> list[Result]:
        c = client if workers <= 1 else client.clone()
        if site_key(items[0]) in IMPERSONATE_HOSTS:   # behind a bot check that refuses Python's handshake
            c = c.impersonating()
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
    ap.add_argument("--apply", action="store_true",
                    help="mark the closed postings 'Taken down' and send the unconfirmed ones to the review queue")
    ap.add_argument("--flag-site-outages", action="store_true",
                    help="with --apply, also send postings to review when their whole site was down")
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

    mark_site_outages(results, postings)
    closed = [r for r in results if r.status == "closed"]
    unknown = [r for r in results if r.status == "unknown"]
    to_flag = [r for r in unknown if args.flag_site_outages or not r.site_down]
    down = sorted({r.company for r in unknown if r.site_down})
    os.makedirs(os.path.dirname(args.report) or ".", exist_ok=True)
    with open(args.report, "w", encoding="utf-8") as f:
        json.dump([r.__dict__ for r in results], f, ensure_ascii=False, indent=2)
    print(f"\n{len(results) - len(closed) - len(unknown)} still open, {len(closed)} closed, "
          f"{len(unknown)} couldn't be confirmed ({len(to_flag)} for manual review)")
    for r in closed:
        print(f"  CLOSED  {r.company:<12} {r.title[:60]:<60}  {r.reason}")
    for r in to_flag[:50]:
        print(f"  REVIEW  {r.company:<12} {r.title[:60]:<60}  {r.reason}")
    if len(to_flag) > 50:
        print(f"  … and {len(to_flag) - 50} more for review (see the report)")
    if down and not args.flag_site_outages:
        print(f"  Site down, left on the board: {', '.join(down)} (every posting failed; try again later)")
    print(f"Full results: {args.report}")

    if not args.apply:
        if closed or to_flag:
            print("Run again with --apply to mark the closed ones taken down and send the rest to the review queue.")
        return 0
    if closed:
        out = app_call("POST", "/api/ingest/close", args.url, token,
                       {"ids": [r.id for r in closed], "reasons": {r.id: r.reason for r in closed}})
        print(f"Marked {out['closed']} as taken down.")
    if to_flag:
        out = app_call("POST", "/api/ingest/flag", args.url, token,
                       {"ids": [r.id for r in to_flag], "reasons": {r.id: r.reason[:250] for r in to_flag}})
        print(f"Sent {out['flagged']} to the review queue for a manual check.")
    return 0

if __name__ == "__main__":
    sys.exit(main())
