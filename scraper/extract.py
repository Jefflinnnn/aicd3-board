#!/usr/bin/env python3
"""
Turn a scraper run into postings for the web app, with Claude filling in the parts that
need reading: a short summary, responsibilities, qualifications, category, term and work mode.

  1. python scraper/pharma_internships.py --details --workers 5 \
         --out scraper/out/raw --import-out scraper/out/import.base.json
  2. python scraper/extract.py split scraper/out/raw.json --batch 25
         -> scraper/out/batches/batch_01.json, batch_02.json, ...
  3. Claude Code reads each batch and writes batch_NN.out.jsonl next to it
     (the /scrape-internships skill runs several posting-extractor subagents at once).
  4. python scraper/extract.py merge scraper/out/import.base.json scraper/out/batches
         -> scraper/out/import.json (+ import.report.txt)
  5. python scraper/extract.py push scraper/out/import.json --dry-run
     python scraper/extract.py push scraper/out/import.json
         (or upload import.json on the Admin page: Import postings)

Step 3 is optional: without it, merge keeps the scraper's own best-effort fields.
Everything Claude writes is checked here (types, lengths, allowed values) before it is used.
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import re
import sys

CATEGORIES = {"discovery", "development", "tech", "other"}
MODES = {"Onsite", "Hybrid", "Remote (US)", "Remote"}
DESC_LIMIT = 7000


def split(raw_path: str, outdir: str, batch: int) -> None:
    with open(raw_path, encoding="utf-8") as f:
        raw = json.load(f)
    os.makedirs(outdir, exist_ok=True)
    for old in glob.glob(os.path.join(outdir, "batch_*.json")):
        os.remove(old)
    items = [{
        "key": p["key"],
        "company": p["company"],
        "title": p["title"],
        "locations": p.get("locations") or [p.get("location", "")],
        "pay_found_by_scraper": p.get("pay", ""),
        "deadline_found_by_scraper": p.get("deadline", ""),
        "remote_type": (p.get("extra") or {}).get("remoteType", ""),
        "description": (p.get("description") or "")[:DESC_LIMIT],
    } for p in raw]
    n = 0
    for i in range(0, len(items), batch):
        n += 1
        with open(os.path.join(outdir, f"batch_{n:02d}.json"), "w", encoding="utf-8") as f:
            json.dump(items[i:i + batch], f, ensure_ascii=False, indent=1)
    missing = sum(1 for p in items if not p["description"])
    print(f"{len(items)} postings -> {n} batches in {outdir}" + (f" ({missing} without a description)" if missing else ""))


def _s(v, n: int) -> str:
    return re.sub(r"\s+", " ", v).strip()[:n] if isinstance(v, str) else ""


def _list(v, n: int = 8, each: int = 300) -> list[str]:
    return [x for x in (_s(i, each) for i in v[:n]) if x] if isinstance(v, list) else []


def clean_extraction(d: dict) -> dict:
    """Keep only well-formed fields from Claude's answer for one posting."""
    out: dict = {}
    if isinstance(d.get("is_internship"), bool):
        out["is_internship"] = d["is_internship"]
    if d.get("category") in CATEGORIES:
        out["category"] = d["category"]
    if d.get("mode") in MODES:
        out["mode"] = d["mode"]
    for k, n in (("summary", 600), ("term", 40), ("pay", 120)):
        if _s(d.get(k), n):
            out[k] = _s(d.get(k), n)
    if isinstance(d.get("deadline"), str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", d["deadline"]):
        out["deadline"] = d["deadline"]
    for k in ("responsibilities", "qualifications"):
        if _list(d.get(k)):
            out[k] = _list(d.get(k))
    return out


def read_extractions(batch_dir: str) -> dict[str, dict]:
    found: dict[str, dict] = {}
    for path in sorted(glob.glob(os.path.join(batch_dir, "batch_*.out.jsonl"))):
        with open(path, encoding="utf-8") as f:
            for line_no, line in enumerate(f, 1):
                line = line.strip()
                if not line:
                    continue
                try:
                    d = json.loads(line)
                except ValueError:
                    print(f"  skipped unreadable line {line_no} in {os.path.basename(path)}", file=sys.stderr)
                    continue
                if isinstance(d, dict) and isinstance(d.get("key"), str):
                    found[d["key"]] = clean_extraction(d)
    return found


def merge(base_path: str, batch_dir: str, out_path: str, keep_non_interns: bool) -> None:
    with open(base_path, encoding="utf-8") as f:
        base = json.load(f)["postings"]
    ex = read_extractions(batch_dir)
    merged, dropped, missing = [], [], []
    for rec in base:
        e = ex.get(rec["key"])
        if e is None:
            missing.append(rec)
        else:
            if e.get("is_internship") is False and not keep_non_interns:
                dropped.append(rec)
                continue
            rec = {**rec}
            for k_out, k_in in (("category", "category"), ("mode", "mode"), ("term", "term"), ("pay", "pay"),
                                ("deadline", "deadline"), ("description", "summary"),
                                ("responsibilities", "responsibilities"), ("qualifications", "qualifications")):
                if e.get(k_in):
                    rec[k_out] = e[k_in]
        merged.append({k: v for k, v in rec.items() if k != "key"})
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump({"postings": merged}, f, ensure_ascii=False, indent=2)
    report = os.path.splitext(out_path)[0] + ".report.txt"
    with open(report, "w", encoding="utf-8") as f:
        f.write(f"{len(merged)} postings written to {out_path}\n")
        f.write(f"{len(base) - len(missing)} had Claude's extraction, {len(missing)} kept the scraper's own fields\n\n")
        if dropped:
            f.write("Left out because Claude judged them not to be internships:\n")
            f.writelines(f"  {r['company']}: {r['title']}  {r['url']}\n" for r in dropped)
    print(f"{len(merged)} postings -> {out_path}; {len(missing)} without extraction; {len(dropped)} left out (see {report})")


def push(path: str, url: str, token: str, dry_run: bool, close_missing: bool, review_all: bool) -> int:
    import requests
    with open(path, encoding="utf-8") as f:
        body = f.read()
    qs = f"?dryRun={int(dry_run)}&closeMissing={int(close_missing)}&reviewAll={int(review_all)}"
    r = requests.post(url.rstrip("/") + "/api/ingest" + qs, data=body.encode("utf-8"), timeout=180,
                      headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
    try:
        data = r.json()
    except ValueError:
        data = {"error": r.text[:300]}
    if r.status_code != 200:
        print(f"Ingest failed: HTTP {r.status_code} {data.get('error', '')}", file=sys.stderr)
        return 1
    label = "Dry run (nothing saved)" if dry_run else "Imported"
    print(f"{label}: {data['staged']} new to review, {data['restaged']} updated in review, {data['added']} published, "
          f"{data['updated']} updated, {data['closed']} closed, {data['unchanged']} unchanged, "
          f"{data['rejected']} previously rejected")
    for e in data.get("errors", [])[:20]:
        print(f"  row {e['row']}: {e['reason']}")
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("split", help="cut the scraper's raw JSON into batches for Claude")
    a.add_argument("raw")
    a.add_argument("--outdir", default="scraper/out/batches")
    a.add_argument("--batch", type=int, default=25)
    b = sub.add_parser("merge", help="combine Claude's batch outputs with the scraper's import file")
    b.add_argument("base", help="the --import-out file from the scraper")
    b.add_argument("batches", help="folder with batch_NN.out.jsonl files")
    b.add_argument("--out", default="scraper/out/import.json")
    b.add_argument("--keep-non-interns", action="store_true")
    c = sub.add_parser("push", help="send an import file to the app's /api/ingest")
    c.add_argument("file")
    c.add_argument("--url", default=os.environ.get("AICD3_URL", "http://localhost:3000"))
    c.add_argument("--dry-run", action="store_true")
    c.add_argument("--close-missing", action="store_true", help="mark listed postings that weren't seen this run as closed")
    c.add_argument("--publish-clean", action="store_true",
                   help="publish new postings that pass the checks instead of sending all of them to review")
    args = ap.parse_args(argv)
    if args.cmd == "split":
        split(args.raw, args.outdir, max(1, args.batch))
    elif args.cmd == "merge":
        merge(args.base, args.batches, args.out, args.keep_non_interns)
    else:
        token = os.environ.get("AICD3_INGEST_TOKEN", "")
        if not token:
            print("Set AICD3_INGEST_TOKEN (the app's SCRAPER_INGEST_TOKEN).", file=sys.stderr)
            return 1
        return push(args.file, args.url, token, args.dry_run, args.close_missing, not args.publish_clean)
    return 0


if __name__ == "__main__":
    sys.exit(main())
