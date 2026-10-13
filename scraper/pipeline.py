#!/usr/bin/env python3
"""
One command from career sites to the job board:

  1. scrape    every tracked company's US internships, with full descriptions
  2. classify  each one (scraper/classify.py, vllm-sr/d3-flash or keyword rules):
                 computational work?   yes -> publish,  unsure -> staff review queue,  no -> left out
                 area                  discovery | development | tech | other
  3. import    into the app's database through POST /api/ingest; postings already on the board are
               updated, ones a company has taken down since the last run are marked closed
  4. check     every open posting's own page (check_open.py) and close or flag what's gone

  python3 scraper/pipeline.py                  # everything, against the app at AICD3_URL (default localhost:3000)
  python3 scraper/pipeline.py --dry-run        # show what would change; nothing is saved
  python3 scraper/pipeline.py --companies Gilead Biogen --classifier rules
  python3 scraper/pipeline.py --url https://your-app.vercel.app

The app's ingest token comes from AICD3_INGEST_TOKEN, or SCRAPER_INGEST_TOKEN in .env.local / .env
(the same value the app reads). Every run leaves scraper/out/pipeline/ with the import file and a
fit report (fit.csv) listing every posting, its decision and why.
"""
from __future__ import annotations

import argparse
import csv
import json
import logging
import os
import sys
from datetime import datetime

import requests

import pharma_internships as pi
from classify import FIT_MIN, Classifier

log = logging.getLogger("pipeline")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def read_env(names: tuple[str, ...]) -> str:
    """First of `names` from the environment, else from .env.local / .env (values never printed)."""
    for n in names:
        if os.environ.get(n):
            return os.environ[n]
    for fname in (".env.local", ".env"):
        path = os.path.join(ROOT, fname)
        if not os.path.exists(path):
            continue
        with open(path, encoding="utf-8") as f:
            for line in f:
                k, sep, v = line.strip().partition("=")
                k = k.removeprefix("export ").strip()
                if sep and k in names and v.strip():
                    return v.strip().strip('"').strip("'")
    return ""


def build_records(postings: list[pi.Posting], clf: Classifier) -> tuple[list[dict], list[dict]]:
    """Import records for the app, and one report row per posting."""
    records, report = [], []
    for p in postings:
        v = clf.classify(p.title, p.company, p.description)
        report.append({"decision": v.decision, "computational": v.computational, "category": v.category,
                       "category_p": v.category_p, "backend": v.backend, "company": p.company, "title": p.title,
                       "url": p.url, "note": v.note})
        rec = pi.to_import_record(p)
        rec["category"] = v.category
        if v.decision == "skip":
            # sent along marked as not a fit: never added, and if it's already on the board the app moves it to
            # the bin (staff can restore it) instead of marking it "taken down" for not appearing in this run
            records.append({**rec, "fit": "no"})
            continue
        if v.decision == "review":
            rec["review_reason"] = (
                f"ML/automation-focused, but outside drug discovery and development ({v.backend})"
                if v.computational >= FIT_MIN else
                f"Unsure ML or computational automation is central ({round(v.computational * 100)}% by {v.backend}; "
                f"{round(FIT_MIN * 100)}% needed to publish)")
        records.append(rec)
    return records, report


def ingest(url: str, token: str, records: list[dict], dry_run: bool) -> dict:
    qs = f"?dryRun={int(dry_run)}&closeMissing=1&reviewAll=0"
    r = requests.post(url.rstrip("/") + "/api/ingest" + qs, timeout=300,
                      data=json.dumps({"postings": records}, ensure_ascii=False).encode("utf-8"),
                      headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
    try:
        data = r.json()
    except ValueError:
        data = {"error": r.text[:300]}
    if r.status_code != 200:
        hint = {401: " (the token doesn't match the app's SCRAPER_INGEST_TOKEN)",
                503: " (the app has no SCRAPER_INGEST_TOKEN set; add it and restart the app)"}.get(r.status_code, "")
        raise SystemExit(f"Import failed: HTTP {r.status_code} {data.get('error', '')}{hint}")
    return data


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--companies", nargs="+", help="subset (case-insensitive substring), default all")
    ap.add_argument("--classifier", choices=["auto", "d3", "rules"], default="auto")
    ap.add_argument("--url", default=os.environ.get("AICD3_URL", "http://localhost:3000"))
    ap.add_argument("--dry-run", action="store_true", help="ask the app what would change; save nothing")
    ap.add_argument("--no-check", action="store_true", help="skip re-checking open postings afterwards")
    ap.add_argument("--workers", type=int, default=5)
    ap.add_argument("--out", default=os.path.join(ROOT, "scraper", "out", "pipeline"))
    ap.add_argument("--summary-json", metavar="PATH", help="also write the run's counts as JSON (the app's Refresh button reads it)")
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s", datefmt="%H:%M:%S")

    token = read_env(("AICD3_INGEST_TOKEN", "SCRAPER_INGEST_TOKEN"))
    if not token:
        print("No ingest token. Put SCRAPER_INGEST_TOKEN=<long random value> in .env.local (for example the "
              "output of `openssl rand -hex 32`), restart the app, and run this again.", file=sys.stderr)
        return 1

    names = list(pi.COMPANIES)
    if args.companies:
        names = [n for n in pi.COMPANIES if any(c.lower() in n.lower() for c in args.companies)]
        if not names:
            ap.error(f"no company matches {args.companies}")

    # 1. scrape
    client = pi.PoliteClient()
    postings, status = pi.run(names, details=True, us_only=True, client=client, workers=max(1, min(args.workers, 6)),
                              ignore_robots=True)
    # 2. classify
    clf = Classifier(args.classifier)
    records, report = build_records(postings, clf)
    clf.save()

    os.makedirs(args.out, exist_ok=True)
    with open(os.path.join(args.out, "import.json"), "w", encoding="utf-8") as f:
        json.dump({"postings": records}, f, ensure_ascii=False, indent=1)
    with open(os.path.join(args.out, "fit.csv"), "w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=list(report[0]) if report else ["decision"])
        w.writeheader()
        w.writerows(sorted(report, key=lambda r: (r["decision"], r["company"], r["title"])))

    # 3. import
    data = ingest(args.url, token, records, args.dry_run)

    counts = {d: sum(1 for r in report if r["decision"] == d) for d in ("publish", "review", "skip")}
    print(f"\n{datetime.now():%Y-%m-%d %H:%M}  classifier: {clf.name}")
    for name, s in status.items():
        print(f"  {name:<24} {s}")
    print(f"\n{len(postings)} US internships scraped: {counts['publish']} computational, {counts['review']} unsure "
          f"(to review), {counts['skip']} left out as not ML/automation-focused (see fit.csv)")
    print(("Dry run, nothing saved: " if args.dry_run else "Database: ") +
          f"{data['added']} published, {data['staged']} to review, {data['updated']} updated, "
          f"{data['closed']} closed, {data['unchanged']} unchanged, {data['rejected']} previously rejected, "
          f"{data.get('dropped', 0)} cleared from review, {data.get('unlisted', 0)} no longer a fit (moved to the bin)")
    for e in data.get("errors", [])[:20]:
        print(f"  row {e['row']}: {e['reason']}")

    # 4. check what's still open
    checked = None
    if not args.no_check and not args.dry_run:
        import check_open
        os.environ["AICD3_INGEST_TOKEN"] = token
        print("\nRe-checking open postings…", flush=True)
        report_path = os.path.join(args.out, "check_open.json")
        check_open.main(["--apply", "--url", args.url, "--report", report_path])
        try:
            with open(report_path, encoding="utf-8") as f:
                res = json.load(f)
            checked = {k: sum(1 for r in res if r["status"] == k) for k in ("open", "closed", "unknown")}
        except (OSError, ValueError):
            pass
    bad = [n for n, s in status.items() if s.startswith(("BLOCKED", "UNAVAILABLE", "error"))]
    if args.summary_json:
        with open(args.summary_json, "w", encoding="utf-8") as f:
            json.dump({"classifier": clf.name, "scraped": len(postings), **counts,
                       "database": {k: data.get(k, 0) for k in ("added", "staged", "updated", "closed", "unchanged", "rejected", "dropped", "unlisted")},
                       "errors": len(data.get("errors", [])), "checked": checked,
                       "companies": status, "failed": bad}, f)
    return 2 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
