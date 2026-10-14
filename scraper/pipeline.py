#!/usr/bin/env python3
"""
One command from career sites to the job board:

  1. scrape    every tracked company's US internships, with full descriptions
  2. classify  each one (scraper/classify.py: vllm-sr/d3 on this PC's GPU through scraper/d3_server.py, or
               keyword rules with a warning if that server isn't answering):
                 undergraduate only / outside the US?   left out (unsure -> staff review queue)
                 fit for AICD3 (ML/computational work)?  yes -> publish,  unsure -> staff review queue,  no -> left out
                 area                                    discovery | development | tech | other
  3. import    into the app's database through POST /api/ingest; postings already on the board are
               updated, ones a company has taken down since the last run are marked closed
  4. check     every open posting's own page (check_open.py) and close or flag what's gone

  python3 scraper/pipeline.py                  # everything, against the app at AICD3_URL (default localhost:3000)
  python3 scraper/pipeline.py --dry-run        # show what would change; nothing is saved
  python3 scraper/pipeline.py --companies Gilead Biogen --classifier rules
  python3 scraper/pipeline.py --url https://your-app.vercel.app

The app's ingest token comes from AICD3_INGEST_TOKEN, or SCRAPER_INGEST_TOKEN in .env.local / .env
(the same value the app reads). Every run leaves scraper/out/pipeline/ with the import file and a
fit report (fit.csv) listing every posting, its decision and why, and a full log of the run in
scraper/out/logs/ (the last 30 runs are kept; AICD3_LOG_FILE picks another path).
"""
from __future__ import annotations

import argparse
import csv
import json
import logging
import os
import sys
import time
import traceback
from datetime import datetime

import requests

import pharma_internships as pi
import progress as live
from classify import Classifier

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


def where(p: pi.Posting) -> str:
    return " | ".join(x for x in [*(p.locations or []), p.location] if x)[:400]


def build_records(postings: list[pi.Posting], clf: Classifier, on_progress=None) -> tuple[list[dict], list[dict]]:
    """Import records for the app, and one report row per posting."""
    records, report = [], []
    # the model classifies the new or changed ones first (Claude several at a time); the loop below reads its cache
    clf.warm([(p.title, p.company, p.description, where(p)) for p in postings if not pi.undergrad_only(p.title, p.description)],
             on_progress=on_progress)
    for p in postings:
        if pi.undergrad_only(p.title, p.description):
            # UCSF students are graduate and professional students: undergraduate-only roles and co-ops are
            # left out (and moved to the bin if an earlier run published them), without asking the classifier
            report.append({"decision": "undergrad", "computational": "", "category": "", "category_p": "",
                           "undergrad_p": "", "us_p": "", "backend": "rules", "company": p.company, "title": p.title,
                           "url": p.url, "note": "undergraduate only (keyword rules)"})
            records.append({**pi.to_import_record(p), "fit": "no"})
            continue
        v = clf.classify(p.title, p.company, p.description, where(p))
        decision = v.decision
        if decision == "skip" and v.skip_reason == "undergraduate only":
            decision = "undergrad"
        elif decision == "skip" and v.skip_reason == "not in the US":
            decision = "not_us"
        report.append({"decision": decision, "computational": v.computational, "category": v.category,
                       "category_p": v.category_p, "undergrad_p": "" if v.undergrad < 0 else v.undergrad,
                       "us_p": "" if v.us < 0 else v.us, "backend": v.backend, "company": p.company,
                       "title": p.title, "url": p.url, "note": v.note})
        rec = pi.to_import_record(p)
        rec["category"] = v.category
        # Claude's own reading of the posting, when it wrote one (better than heading-matching on odd formats)
        if v.summary:
            rec["description"] = v.summary
        if v.resp:
            rec["responsibilities"] = v.resp
        if v.quals:
            rec["qualifications"] = v.quals
        if v.decision == "skip":
            # sent along marked as not a fit: never added, and if it's already on the board the app moves it to
            # the bin (staff can restore it) instead of marking it "taken down" for not appearing in this run
            records.append({**rec, "fit": "no"})
            continue
        if v.decision == "review":
            rec["review_reason"] = v.review_reason()
        records.append(rec)
    return records, report


def ingest(url: str, token: str, records: list[dict], dry_run: bool) -> dict:
    qs = f"?dryRun={int(dry_run)}&closeMissing=1&reviewAll=0"
    body = json.dumps({"postings": records}, ensure_ascii=False).encode("utf-8")
    print(f"POST {url.rstrip('/')}/api/ingest{qs}  ({len(body) / 1e6:.1f} MB)", flush=True)
    started = time.monotonic()
    try:
        r = requests.post(url.rstrip("/") + "/api/ingest" + qs, timeout=300, data=body,
                          headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
    except requests.ConnectionError as e:
        raise SystemExit(f"Import failed: couldn't reach the app at {url} ({e.__class__.__name__}). "
                         "Is it running (pnpm dev / pnpm start), and on that address?")
    except requests.Timeout:
        raise SystemExit(f"Import failed: the app at {url} didn't answer within 5 minutes.")
    print(f"answered HTTP {r.status_code} in {time.monotonic() - started:.1f}s", flush=True)
    try:
        data = r.json()
    except ValueError:
        data = {"error": r.text[:300]}
    if r.status_code != 200:
        hint = {401: " (the token doesn't match the app's SCRAPER_INGEST_TOKEN)",
                503: " (the app has no SCRAPER_INGEST_TOKEN set; add it and restart the app)"}.get(r.status_code, "")
        raise SystemExit(f"Import failed: HTTP {r.status_code} {data.get('error', '') or r.text[:500]}{hint}")
    return data


LOG_DIR = os.path.join(ROOT, "scraper", "out", "logs")
KEEP_LOGS = 30
_step = {"name": "starting", "at": time.monotonic(), "t0": time.monotonic()}
_run: dict = {"progress": None, "summary": None}   # this run's live progress reporter and final counts, for main()
STOPPED = 130   # exit code when staff stopped the run from the Admin page


class _Tee:
    """Writes everything printed (prints, logging, tracebacks) to the console and the run's log file."""
    def __init__(self, stream, f):
        self.stream, self.f = stream, f

    def write(self, s):
        self.stream.write(s)
        try:
            self.f.write(s)
            self.f.flush()
        except (OSError, ValueError):
            pass
        return len(s)

    def flush(self):
        self.stream.flush()

    def __getattr__(self, name):
        return getattr(self.stream, name)


def _open_log() -> str:
    path = os.environ.get("AICD3_LOG_FILE") or os.path.join(LOG_DIR, f"pipeline-{datetime.now():%Y%m%d-%H%M%S}.log")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    f = open(path, "a", encoding="utf-8", buffering=1)
    if isinstance(sys.stdout, _Tee):   # called again in the same process (tests): switch files
        try:
            sys.stdout.f.close()
        except OSError:
            pass
        sys.stdout.f = sys.stderr.f = f
    else:
        sys.stdout, sys.stderr = _Tee(sys.stdout, f), _Tee(sys.stderr, f)
    try:   # keep the newest KEEP_LOGS
        old = sorted(n for n in os.listdir(LOG_DIR) if n.startswith("pipeline-") and n.endswith(".log"))
        for n in old[:-KEEP_LOGS]:
            os.remove(os.path.join(LOG_DIR, n))
    except OSError:
        pass
    return path


def _mins(sec: float) -> str:
    return f"{int(sec // 60)}m {int(sec % 60):02d}s"


def step(name: str, detail: str = "") -> None:
    """Marks the start of a stage, so a log shows how far a run got and how long each stage took."""
    now = time.monotonic()
    if _step["name"] != "starting":
        print(f"[step] {_step['name']} done in {_mins(now - _step['at'])}", flush=True)
    _step.update(name=name, at=now)
    print(f"\n[step] {name}{' - ' + detail if detail else ''}  ({datetime.now():%H:%M:%S})", flush=True)


def _tail(path: str, lines: int = 400) -> str:
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            return "".join(f.readlines()[-lines:])
    except OSError:
        return ""


def _report_end(code: int, log_path: str) -> None:
    """Tell the app how the run ended (it draws the run's last state and keeps its log)."""
    prog = _run["progress"]
    if not prog:
        return
    status = {0: "succeeded", 2: "partial", STOPPED: "cancelled"}.get(code, "failed")
    try:
        sys.stdout.flush()
        prog.finish(status, _run["summary"], _tail(log_path))
    except Exception as e:   # never let reporting change how the run ends
        print(f"[warning] couldn't report the end of the run to the app: {e}", flush=True)


def main(argv: list[str] | None = None) -> int:
    _run.update(progress=None, summary=None)
    log_path = _open_log()
    print(f"[run] pipeline started {datetime.now():%Y-%m-%d %H:%M:%S}  python {sys.version.split()[0]}  "
          f"args: {' '.join(argv if argv is not None else sys.argv[1:]) or '(none)'}", flush=True)
    print(f"[run] full log: {log_path}", flush=True)
    try:
        code = _main(argv)
    except KeyboardInterrupt:
        print(f"\n[run] STOPPED during step: {_step['name']}", flush=True)
        _report_end(STOPPED, log_path)
        raise
    except SystemExit as e:   # argparse errors, "Import failed: ..." and other deliberate exits
        code = e.code if isinstance(e.code, int) else 1
        if code:
            if e.code and not isinstance(e.code, int):
                print(f"[error] {e.code}", file=sys.stderr, flush=True)
            print(f"\n[run] {'STOPPED from the Admin page' if code == STOPPED else 'FAILED'} during step: {_step['name']} (exit {code})", flush=True)
            print(f"[run] full log: {log_path}", flush=True)
        _report_end(code, log_path)
        return code
    except Exception as e:
        traceback.print_exc()
        print(f"\n[run] FAILED during step: {_step['name']}: {type(e).__name__}: {e}", flush=True)
        print(f"[run] full log: {log_path}", flush=True)
        _report_end(1, log_path)
        return 1
    total = _mins(time.monotonic() - _step["t0"])
    print(f"[step] {_step['name']} done in {_mins(time.monotonic() - _step['at'])}", flush=True)
    print(f"\n[run] {'finished' if code == 0 else 'finished with problems (some companies could not be scraped)'} "
          f"in {total} (exit {code})", flush=True)
    print(f"[run] full log: {log_path}", flush=True)
    _report_end(code, log_path)
    return code


def _stop_if_asked(prog: live.Progress) -> None:
    if prog.stop_requested:
        raise SystemExit(STOPPED)


def _main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--companies", nargs="+", help="subset (case-insensitive substring), default all")
    ap.add_argument("--classifier", choices=["auto", "llm", "d3", "rules"], default="auto")
    ap.add_argument("--url", default=os.environ.get("AICD3_URL", "http://localhost:3000"))
    ap.add_argument("--dry-run", action="store_true", help="ask the app what would change; save nothing")
    ap.add_argument("--no-check", action="store_true", help="skip re-checking open postings afterwards")
    ap.add_argument("--workers", type=int, default=5)
    ap.add_argument("--out", default=os.path.join(ROOT, "scraper", "out", "pipeline"))
    ap.add_argument("--summary-json", metavar="PATH", help="also write the run's counts as JSON (the app's Refresh button reads it)")
    ap.add_argument("--trigger", choices=["manual", "schedule"], default="manual",
                    help="how the Admin page labels this run (the daily scheduled task passes schedule)")
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

    # live progress for the Admin page (the refresh Sankey); also refuses to start beside another refresh
    prog = live.from_env(args.url, token, names, trigger=args.trigger, dry_run=args.dry_run)
    try:
        prog.start()
    except live.AlreadyRunning as e:
        print(f"Not starting: {e}. Try again when it has finished.", file=sys.stderr)
        return 3
    _run["progress"] = prog

    step("1/4 scrape", f"{len(names)} companies: {', '.join(names)}")
    client = pi.PoliteClient()
    postings, status = pi.run(names, details=True, us_only=True, client=client, workers=max(1, min(args.workers, 6)),
                              ignore_robots=True, on_company=prog.company)
    _stop_if_asked(prog)
    step("2/4 classify", f"{len(postings)} postings")
    prog.step("classify")
    clf = Classifier(args.classifier)
    prog.classifier(clf.name)
    print(f"classifier: {clf.name}", flush=True)
    if clf.fallback_reason:
        print(f"[warning] {clf.fallback_reason}", flush=True)
    records, report = build_records(postings, clf, on_progress=prog.classify)
    prog.classify(len(postings), len(postings))
    clf.save()
    _stop_if_asked(prog)

    os.makedirs(args.out, exist_ok=True)
    with open(os.path.join(args.out, "import.json"), "w", encoding="utf-8") as f:
        json.dump({"postings": records}, f, ensure_ascii=False, indent=1)
    with open(os.path.join(args.out, "fit.csv"), "w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=list(report[0]) if report else ["decision"])
        w.writeheader()
        w.writerows(sorted(report, key=lambda r: (r["decision"], r["company"], r["title"])))

    counts = {d: sum(1 for r in report if r["decision"] == d) for d in ("publish", "review", "skip", "undergrad", "not_us")}
    prog.outcome(counts)
    step("3/4 import", f"{len(records)} records to {args.url}{' (dry run)' if args.dry_run else ''}")
    prog.step("import")
    data = ingest(args.url, token, records, args.dry_run)

    print(f"\n{datetime.now():%Y-%m-%d %H:%M}  classifier: {clf.name}")
    for name, s in status.items():
        print(f"  {name:<24} {s}")
    print(f"\n{len(postings)} US internships scraped: {counts['publish']} computational, {counts['review']} unsure "
          f"(to review), {counts['skip']} left out as not a fit for AICD3, "
          f"{counts['undergrad']} left out as undergraduate-only, {counts['not_us']} left out as outside the US (see fit.csv)")
    print(("Dry run, nothing saved: " if args.dry_run else "Database: ") +
          f"{data['added']} published, {data['staged']} to review, {data['updated']} updated, "
          f"{data['closed']} closed, {data['unchanged']} unchanged, {data['rejected']} previously rejected, "
          f"{data.get('dropped', 0)} cleared from review, {data.get('unlisted', 0)} no longer a fit (moved to the bin)")
    for e in data.get("errors", [])[:20]:
        print(f"  row {e['row']}: {e['reason']}")

    # 4. check what's still open
    checked = None
    checked_error = None
    if not args.no_check and not args.dry_run:
        _stop_if_asked(prog)
        step("4/4 re-check open postings")
        prog.step("check")
        import check_open
        os.environ["AICD3_INGEST_TOKEN"] = token
        print("\nRe-checking open postings…", flush=True)
        report_path = os.path.join(args.out, "check_open.json")
        try:   # the postings are already imported; a problem here shouldn't lose the run's results
            rc = check_open.main(["--apply", "--url", args.url, "--report", report_path])
            if rc:
                print(f"[warning] re-check stopped early (exit {rc}); see the lines above", flush=True)
                checked_error = f"exit {rc}"
        except Exception as e:
            traceback.print_exc()
            print(f"[warning] re-check failed: {type(e).__name__}: {e}. The import above was saved.", flush=True)
            checked_error = f"{type(e).__name__}: {e}"
        try:
            with open(report_path, encoding="utf-8") as f:
                res = json.load(f)
            checked = {k: sum(1 for r in res if r["status"] == k) for k in ("open", "closed", "unknown")}
        except (OSError, ValueError):
            pass
    prog.checked(checked)
    bad = [n for n, s in status.items() if s.startswith(("BLOCKED", "UNAVAILABLE", "error"))]
    summary = {"classifier": clf.name, "classifierNote": clf.fallback_reason, "scraped": len(postings), **counts,
               "database": {k: data.get(k, 0) for k in ("added", "staged", "updated", "closed", "unchanged", "rejected", "dropped", "unlisted")},
               "errors": len(data.get("errors", [])), "checked": checked, "checkError": checked_error,
               "companies": status, "failed": bad, "dryRun": args.dry_run}
    _run["summary"] = summary
    if args.summary_json:
        with open(args.summary_json, "w", encoding="utf-8") as f:
            json.dump(summary, f)
    return 2 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
