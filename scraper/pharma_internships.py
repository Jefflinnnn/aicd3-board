#!/usr/bin/env python3
"""
pharma_internships.py - collect internship / co-op postings from 15 pharma & biotech
career sites using the public JSON feeds and sitemaps that power those sites.

Platforms covered (verified October 2026):
  * Workday "cxs" JSON API  - Pfizer, Merck/MSD, AstraZeneca, BMS, Sanofi, GSK, Vertex,
                              Regeneron, Genentech (Roche), Amgen, Eli Lilly, Takeda
  * Greenhouse Job Board API - Revolution Medicines
  * SAP SuccessFactors CSB   - Boehringer Ingelheim (server-rendered search pages)
  * Vacancy XML sitemap      - AbbVie (careers.abbvie.com, robots.txt disallows /jobs?*)

Usage:
  pip install -r scraper/requirements.txt
  python pharma_internships.py                         # all companies -> internships.csv/.json
  python pharma_internships.py --details --workers 5   # + full descriptions, pay, start date; 5 companies at a time
  python pharma_internships.py --details --import-out out/import.json   # also write the app's import format
  python pharma_internships.py --companies Pfizer Amgen --details
  python pharma_internships.py --us-only --out us_interns
  python pharma_internships.py --manual-session Lilly  # if a site shows a challenge page

Speed: the wait between requests is per site, so --workers runs several companies side by side
(each on its own host) without sending any one site more traffic. Companies on the same Workday
data centre (e.g. wd5) share a small concurrency cap.

Be a polite client: the defaults use a 1.5-3 s delay per request per host, retry with
exponential backoff on 429/5xx, honour Retry-After, and stop (instead of hammering) when a
site returns a bot challenge. Review each site's terms of use before running at scale.
"""
from __future__ import annotations

import argparse
import csv
import html as htmllib
import json
import logging
import random
import re
import sys
import threading
import time
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import asdict, dataclass, field
from datetime import date, timedelta
from typing import Iterable, Iterator
from urllib.parse import unquote, urlencode, urljoin, urlparse

import requests
from bs4 import BeautifulSoup
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

log = logging.getLogger("pharma_internships")

# --------------------------------------------------------------------------------------
# Company configuration
# --------------------------------------------------------------------------------------
# Workday boards: (tenant, wd host number, site). Tenants occasionally migrate data centres
# (Lilly wd5 -> wd115, Takeda wd3 -> wd502 were both observed); the scraper tries
# `alt_hosts` automatically when the configured host returns 404/406/500.
# `id` is the company's id in the web app (lib/data.ts COMPANIES).
# A Workday board may carry options: {"all": True} lists every posting on a student-only board
# instead of searching it. A company-level "terms" list replaces the default search terms.
COMPANIES: dict[str, dict] = {
    "Pfizer":               {"id": "pfizer", "platform": "workday", "boards": [("pfizer", "wd1", "PfizerCareers")],
                             "terms": ["intern", "internship", "co-op", "undergraduate", "summer associate",
                                       "bachelorstage", "pflichtpraktikant"]},
    "Merck":                {"id": "merck", "platform": "workday", "boards": [("msd", "wd5", "SearchJobs")]},
    "AbbVie":               {"id": "abbvie", "platform": "abbvie_sitemap",
                             "sitemap": "https://careers.abbvie.com/sitemap.xml"},
    "AstraZeneca":          {"id": "astrazeneca", "platform": "workday", "boards": [("astrazeneca", "wd3", "Careers")]},
    "Bristol Myers Squibb": {"id": "bms", "platform": "workday", "boards": [("bristolmyerssquibb", "wd5", "BMS")]},
    "Sanofi":               {"id": "sanofi", "platform": "workday", "boards": [("sanofi", "wd3", "SanofiCareers")],
                             "terms": ["intern", "internship", "co-op", "stage", "alternance"]},
    "GSK":                  {"id": "gsk", "platform": "workday", "boards": [("gsk", "wd5", "GSKCareers")]},
    "Boehringer Ingelheim": {"id": "boehringer", "platform": "successfactors",
                             "base": "https://jobs.boehringer-ingelheim.com",
                             "terms": ["intern", "co-op", "praktikum", "werkstudent"]},
    "Vertex Pharmaceuticals": {"id": "vertex", "platform": "workday",
                               "boards": [("vrtx", "wd501", "vertex_intern", {"all": True}),
                                          ("vrtx", "wd501", "Vertex_Careers")],
                               "alt_hosts": ["wd5"]},
    "Regeneron":            {"id": "regeneron", "platform": "workday", "boards": [("regeneron", "wd1", "Careers")]},
    "Genentech":            {"id": "genentech", "platform": "workday", "boards": [("roche", "wd3", "ROG-A2O-GENE")]},
    "Amgen":                {"id": "amgen", "platform": "workday", "boards": [("amgen", "wd1", "Careers")]},
    "Eli Lilly":            {"id": "lilly", "platform": "workday",
                             "boards": [("lilly", "wd115", "CMP", {"all": True}),   # "Student Career Opportunities"
                                        ("lilly", "wd115", "LLY")],
                             "alt_hosts": ["wd5"]},
    "Revolution Medicines": {"id": "revmed", "platform": "greenhouse", "token": "revolutionmedicines"},
    "Takeda":               {"id": "takeda", "platform": "workday", "boards": [("takeda", "wd502", "External")],
                             "alt_hosts": ["wd3"]},
}

# Titles that count as internships. Letter boundaries keep out "International"/"Internal"
# while still matching "Internship_..." (Takeda) and "Co-Op" variants.
INTERN_RE = re.compile(
    r"(?<![A-Za-z])(intern|interns|internship|internships|co[-\s]?op|summer\s+student|"
    r"student\s+(?:worker|placement|assistant)|placement\s+student|industrial\s+placement|"
    r"praktikum|praktikant(?:in)?|werkstudent(?:in)?|stagiaire|stage|stagista|tirocinio|"
    r"pr[aá]cticas|estagi[aá]ri[oa]|est[aá]gio|alternan(?:ce|t|te)|"
    r"\d{4}\s+summer|undergrad(?:uate)?\s+intern|mba\s+intern|summer\s+associate|"
    r"pflichtpraktik\w*|bachelorstage|stage\s+de\s+fin)(?![A-Za-z])",
    re.IGNORECASE,
)
# "Late-Stage Oncology" / "early-stage" mention a drug's phase, not an internship ("stage").
NOT_INTERN_RE = re.compile(r"(?<![A-Za-z])(early|late|mid)[-\s]stage(?![A-Za-z])", re.IGNORECASE)
WORKDAY_TERMS = ["intern", "internship", "co-op"]

DEFAULT_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/129.0 Safari/537.36")

BLOCK_MARKERS = ("captcha", "cf-chl", "cf_chl", "challenge-platform", "attention required",
                 "access denied", "request unsuccessful. incapsula", "_incapsula_resource",
                 "px-captcha", "perimeterx", "are you a robot", "akamai bot manager")


@dataclass
class Posting:
    company: str
    title: str
    location: str = ""
    posted: str = ""
    req_id: str = ""
    url: str = ""
    source: str = ""
    extra: dict = field(default_factory=dict)
    # filled with --details
    locations: list = field(default_factory=list)
    description: str = ""
    pay: str = ""
    deadline: str = ""
    start_date: str = ""


class BlockedError(RuntimeError):
    """Raised when a site answers with a bot challenge / WAF block page."""


# --------------------------------------------------------------------------------------
# HTTP layer: retries, backoff, per-host pacing, block detection
# --------------------------------------------------------------------------------------
class PoliteClient:
    def __init__(self, min_delay: float = 1.5, max_delay: float = 3.0,
                 user_agent: str = DEFAULT_UA, timeout: float = 30.0):
        self.min_delay, self.max_delay, self.timeout = min_delay, max_delay, timeout
        self._last_hit: dict[str, float] = {}
        self.session = requests.Session()
        retry = Retry(
            total=5, connect=3, read=3, status=5,
            backoff_factor=2.0,                      # 0, 2, 4, 8, 16 s (+ jitter below)
            status_forcelist=(429, 500, 502, 503, 504),
            allowed_methods=frozenset({"GET", "POST"}),
            respect_retry_after_header=True,
            raise_on_status=False,
        )
        adapter = HTTPAdapter(max_retries=retry, pool_connections=8, pool_maxsize=8)
        self.session.mount("https://", adapter)
        self.session.mount("http://", adapter)
        self.session.headers.update({
            "User-Agent": user_agent,
            "Accept-Language": "en-US,en;q=0.9",
        })
        # No-retry session for cheap probes (a wrong Workday host answers 500; retrying it
        # with backoff would just waste half a minute). Shares headers and cookies.
        self.probe_session = requests.Session()
        self.probe_session.headers = self.session.headers
        self.probe_session.cookies = self.session.cookies

    def clone(self) -> "PoliteClient":
        """A separate client (own connection pool and pacing) carrying this one's cookies and
        User-Agent, for running another company on another thread."""
        c = PoliteClient(self.min_delay, self.max_delay, self.session.headers.get("User-Agent", DEFAULT_UA), self.timeout)
        c.session.cookies.update(self.session.cookies)
        return c

    def _pace(self, url: str) -> None:
        host = urlparse(url).netloc
        wait = random.uniform(self.min_delay, self.max_delay)
        elapsed = time.monotonic() - self._last_hit.get(host, 0.0)
        if elapsed < wait:
            time.sleep(wait - elapsed)
        self._last_hit[host] = time.monotonic()

    @staticmethod
    def _check_block(resp: requests.Response) -> None:
        """Turn WAF / bot-challenge answers into a clear BlockedError."""
        ctype = resp.headers.get("Content-Type", "")
        head = resp.text[:20000].lower() if "html" in ctype else ""
        hard_marker = any(m in head for m in ("cf-chl", "challenge-platform", "px-captcha",
                                              "_incapsula_resource", "g-recaptcha", "hcaptcha"))
        soft_marker = any(m in head for m in BLOCK_MARKERS)
        if resp.status_code in (401, 403) or hard_marker or (
                resp.status_code in (429, 503) and soft_marker):
            server = resp.headers.get("Server", "?")
            raise BlockedError(
                f"{resp.request.method} {resp.url} -> HTTP {resp.status_code} (server: {server}). "
                "The site returned a bot challenge/WAF block. Slow down, try the sitemap fallback, "
                "or run with --manual-session to complete the check in a real browser."
            )

    def request(self, method: str, url: str, **kw) -> requests.Response:
        self._pace(url)
        kw.setdefault("timeout", self.timeout)
        resp = self.session.request(method, url, **kw)
        self._check_block(resp)
        return resp

    def get(self, url: str, **kw) -> requests.Response:
        return self.request("GET", url, **kw)

    def probe(self, url: str, **kw) -> requests.Response:
        self._pace(url)
        kw.setdefault("timeout", self.timeout)
        resp = self.probe_session.get(url, **kw)
        self._check_block(resp)
        return resp

    def post(self, url: str, **kw) -> requests.Response:
        return self.request("POST", url, **kw)

    # Manual human step: open the site in a real browser, let the person pass any
    # challenge, then reuse the browser's cookies for the API calls.
    def import_browser_cookies(self, url: str) -> None:
        try:
            from playwright.sync_api import sync_playwright
        except ImportError:  # pragma: no cover
            sys.exit("--manual-session needs Playwright: pip install playwright && playwright install chromium")
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=False)
            ctx = browser.new_context()
            page = ctx.new_page()
            page.goto(url)
            input(f"\nA browser window opened at {url}\n"
                  "Complete any 'verify you are human' check and wait for jobs to load,\n"
                  "then press Enter here to continue... ")
            for c in ctx.cookies():
                self.session.cookies.set(c["name"], c["value"], domain=c["domain"], path=c["path"])
            ua = page.evaluate("navigator.userAgent")
            self.session.headers["User-Agent"] = ua   # cookies are often bound to the UA
            browser.close()


# --------------------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------------------
def is_internship(title: str) -> bool:
    return bool(INTERN_RE.search(title or "")) and not NOT_INTERN_RE.search(title or "")


def clean(text: str | None) -> str:
    return re.sub(r"\s+", " ", text or "").strip()


_BLOCK_TAGS = ("p", "div", "li", "br", "h1", "h2", "h3", "h4", "h5", "h6", "tr", "ul", "ol", "section")


def html_to_text(markup: str | None) -> str:
    """Readable text from a job description's HTML: one line per paragraph, "• " for list items."""
    if not markup:
        return ""
    soup = BeautifulSoup(htmllib.unescape(markup) if "&lt;" in markup else markup, "lxml")
    for el in soup(["script", "style"]):
        el.decompose()
    for li in soup.find_all("li"):
        li.insert(0, "• ")
    for el in soup.find_all(_BLOCK_TAGS):
        el.append("\n")
    lines = [clean(l) for l in soup.get_text("").splitlines()]
    out, blank = [], False
    for l in lines:
        if l in ("", "•"):
            blank = True
            continue
        if blank and out:
            out.append("")
        out.append(l)
        blank = False
    return "\n".join(out).strip()


_MONEY = r"(?:US\$|USD\s?|\$|€|£)\s?\d[\d,]*(?:\.\d+)?\s?[kK]?"
_AMOUNT = r"(?:US\$|USD\s?|\$|€|£)?\s?\d[\d,]*(?:\.\d+)?\s?[kK]?"
SALARY_RE = re.compile(
    rf"{_MONEY}(?:\s*(?:-|–|—|to)\s*{_AMOUNT})?(?:\s*(?:USD|EUR|GBP))?"
    r"(?:\s*(?:/|per|an|a)\s*(?:hour|hr|year|yr|annum|week|month))?",
    re.IGNORECASE,
)


def extract_pay(text: str) -> str:
    """The first pay figure or range in a description, e.g. "$28.87 per hour" or "$45 - $55/hr"."""
    for m in SALARY_RE.finditer(text or ""):
        val = clean(m.group(0))
        if re.search(r"\d{2}", val):          # skip "$1" style noise
            return val
    return ""


SECTION_HEADS = {
    "resp": re.compile(r"^(?:key\s+|your\s+|main\s+|primary\s+)?(?:responsibilit|duties|what you(?:'|’)?ll do|what you will do|"
                       r"the role|role overview|key activities|day to day|day-to-day|in this role|job description|"
                       r"your mission|tasks|what you will be doing)", re.I),
    "quals": re.compile(r"^(?:basic |minimum |preferred |required |desired )?(?:qualifications?|requirements?|"
                        r"what you(?:'|’)?ll bring|what you bring|who you are|eligibility|program eligibility|"
                        r"skills|experience|education|about you|your profile|we(?:'|’)?re looking for)", re.I),
}


def extract_sections(text: str, limit: int = 8) -> dict[str, list[str]]:
    """Bullet points under "Responsibilities"/"Qualifications"-style headings (best effort)."""
    out: dict[str, list[str]] = {"resp": [], "quals": []}
    current = None
    for line in (text or "").splitlines():
        bare = line.strip().rstrip(":").strip()
        if not bare:
            continue
        is_head = len(bare) < 80 and not bare.startswith("•")
        hit = next((k for k, rx in SECTION_HEADS.items() if is_head and rx.search(bare)), None)
        if hit:
            current = hit
            continue
        if is_head and len(bare) < 50 and bare.endswith(":"):
            current = None
            continue
        if current and bare.startswith("•") and len(out[current]) < limit:
            item = bare.lstrip("• ").strip()
            if 3 < len(item) < 400:
                out[current].append(item)
    return out


def jsonld_jobposting(soup: BeautifulSoup) -> dict:
    """The schema.org JobPosting many career pages embed for search engines, if present."""
    for tag in soup.find_all("script", type="application/ld+json"):
        try:
            data = json.loads(tag.string or tag.get_text() or "{}")
        except ValueError:
            continue
        for item in data if isinstance(data, list) else [data, *data.get("@graph", [])] if isinstance(data, dict) else []:
            if isinstance(item, dict) and item.get("@type") in ("JobPosting", ["JobPosting"]):
                return item
    return {}


def jsonld_pay(jp: dict) -> str:
    bs = jp.get("baseSalary") or {}
    if not isinstance(bs, dict):
        return ""
    v = bs.get("value") or {}
    cur = "$" if (bs.get("currency") or "USD") == "USD" else (bs.get("currency") or "") + " "
    lo, hi = (v.get("minValue"), v.get("maxValue")) if isinstance(v, dict) else (v, None)
    unit = (v.get("unitText") if isinstance(v, dict) else "") or ""
    if not lo:
        return ""
    amt = f"{cur}{lo}" + (f" - {cur}{hi}" if hi and hi != lo else "")
    return amt + (f" per {unit.lower()}" if unit else "")


def posted_to_date(text: str, today: date | None = None) -> str:
    """Workday's "Posted 3 Days Ago" / "Posted Today" / "Posted 30+ Days Ago" -> YYYY-MM-DD."""
    today = today or date.today()
    t = (text or "").lower()
    if re.match(r"^\d{4}-\d{2}-\d{2}", t):
        return t[:10]
    if "today" in t:
        return today.isoformat()
    if "yesterday" in t:
        return (today - timedelta(days=1)).isoformat()
    m = re.search(r"(\d+)\+?\s*days?", t)
    return (today - timedelta(days=int(m.group(1)))).isoformat() if m else ""


def apply_detail_text(p: Posting, text: str) -> None:
    p.description = text[:20000]
    if not p.pay:
        p.pay = extract_pay(text)


# --------------------------------------------------------------------------------------
# Workday (cxs JSON API)
# --------------------------------------------------------------------------------------
WD_PAGE = 20  # Workday rejects limit > 20 with HTTP 400


def workday_urls(tenant: str, host: str, site: str) -> tuple[str, str]:
    base = f"https://{tenant}.{host}.myworkdayjobs.com"
    return f"{base}/{site}", f"{base}/wday/cxs/{tenant}/{site}"


def resolve_workday_host(client: PoliteClient, tenant: str, host: str, site: str,
                         alt_hosts: Iterable[str]) -> str:
    """Return the working wdN host. Wrong host/site combos answer 404/406/500."""
    for h in [host, *[a for a in alt_hosts if a != host]]:
        board, _ = workday_urls(tenant, h, site)
        try:
            r = client.probe(board, headers={"Accept": "text/html"})
            if r.status_code == 200:
                if h != host:
                    log.warning("%s/%s moved from %s to %s - update COMPANIES", tenant, site, host, h)
                return h
            log.debug("%s -> %s", board, r.status_code)
        except BlockedError:
            raise
        except requests.RequestException as e:
            log.debug("%s -> %s", board, e)
    raise RuntimeError(f"No working Workday host for {tenant}/{site} (tried {host}, {list(alt_hosts)})")


def workday_search(client: PoliteClient, tenant: str, host: str, site: str,
                   term: str, max_pages: int = 50) -> Iterator[dict]:
    board, api = workday_urls(tenant, host, site)
    headers = {"Accept": "application/json", "Content-Type": "application/json",
               "Origin": board.rsplit("/", 1)[0], "Referer": board}
    total, offset = None, 0
    for _ in range(max_pages):
        payload = {"appliedFacets": {}, "limit": WD_PAGE, "offset": offset, "searchText": term}
        r = client.post(f"{api}/jobs", json=payload, headers=headers)
        if r.status_code == 400:
            raise RuntimeError(f"Workday 400 for {api}/jobs - payload rejected: {r.text[:200]}")
        if r.status_code == 422:
            raise RuntimeError(f"Workday 422 for {api}/jobs - invalid facet/site: {r.text[:200]}")
        r.raise_for_status()
        data = r.json()
        if total is None:          # Workday only reports `total` reliably on the first page
            total = data.get("total") or 0
        postings = data.get("jobPostings") or []
        yield from postings
        offset += WD_PAGE
        if not postings or offset >= total:
            break


def workday_detail(client: PoliteClient, tenant: str, host: str, site: str, path: str) -> dict:
    _, api = workday_urls(tenant, host, site)
    r = client.get(f"{api}{path}", headers={"Accept": "application/json"})
    r.raise_for_status()
    return r.json().get("jobPostingInfo", {})


def workday_sitemap(client: PoliteClient, tenant: str, host: str, site: str) -> Iterator[Posting]:
    """Fallback when the JSON API is blocked: robots.txt advertises {site}/siteMap.xml."""
    board, _ = workday_urls(tenant, host, site)
    r = client.get(f"{board}/siteMap.xml")
    r.raise_for_status()
    for loc in parse_sitemap_locs(r.content):
        parts = unquote(loc.split("/job/", 1)[-1]).strip("/").split("/")
        slug = parts[-1]
        location = parts[0].replace("---", "\0").replace("-", " ").replace("\0", " - ") if len(parts) > 1 else ""
        title, sep, req = slug.rpartition("_")
        if not sep:
            title, req = slug, ""
        # Workday slugs encode " – " as "---" and ", " / " (" as "--"; titles are approximate.
        title = title.replace("---", "\0").replace("--", ", ").replace("-", " ").replace("\0", " - ")
        yield Posting(company="", title=clean(title.replace(" ,", ",")),
                      location=clean(location), req_id=req, url=loc, source="workday-sitemap")


def scrape_workday(client: PoliteClient, company: str, cfg: dict, details: bool) -> list[Posting]:
    out: dict[str, Posting] = {}
    for tenant, host, site, *opt in cfg["boards"]:
        opts = opt[0] if opt else {}
        host = resolve_workday_host(client, tenant, host, site, cfg.get("alt_hosts", []))
        board, _ = workday_urls(tenant, host, site)
        everything = bool(opts.get("all"))     # a student-only board: take every posting on it
        try:
            for term in ([""] if everything else cfg.get("terms", WORKDAY_TERMS)):
                for jp in workday_search(client, tenant, host, site, term):
                    title, path = jp.get("title", ""), jp.get("externalPath", "")
                    if not path or path in out or not (everything or is_internship(title)):
                        continue
                    bullets = jp.get("bulletFields") or []
                    out[path] = Posting(
                        company=company, title=clean(title),
                        location=clean(jp.get("locationsText")),
                        posted=clean(jp.get("postedOn")),
                        req_id=bullets[0] if bullets else "",
                        url=f"{board}{path}", source=f"workday:{tenant}/{site}")
        except (BlockedError, requests.HTTPError) as e:
            log.warning("%s: JSON API failed (%s) - falling back to sitemap", company, e)
            for p in workday_sitemap(client, tenant, host, site):
                if is_internship(p.title) and p.url not in out:
                    p.company = company
                    out[p.url] = p
            continue
        if details:
            for path, p in out.items():
                if not p.source.startswith(f"workday:{tenant}/{site}"):
                    continue
                try:
                    info = workday_detail(client, tenant, host, site, path)
                    p.req_id = info.get("jobReqId", p.req_id)
                    p.location = info.get("location", p.location)
                    p.locations = [x for x in [info.get("location"), *(info.get("additionalLocations") or [])] if x]
                    p.start_date = info.get("startDate", "") or ""
                    if p.start_date:
                        p.posted = p.start_date[:10]
                    p.extra = {"startDate": p.start_date,
                               "timeType": info.get("timeType", ""),
                               "remoteType": info.get("remoteType", ""),
                               "country": (info.get("country") or {}).get("descriptor", "")}
                    apply_detail_text(p, html_to_text(info.get("jobDescription", "")))
                except (requests.RequestException, ValueError) as e:
                    log.debug("detail %s: %s", path, e)
    return list(out.values())


# --------------------------------------------------------------------------------------
# Greenhouse (public Job Board API, no key needed for GET)
# --------------------------------------------------------------------------------------
def scrape_greenhouse(client: PoliteClient, company: str, cfg: dict, details: bool) -> list[Posting]:
    url = f"https://boards-api.greenhouse.io/v1/boards/{cfg['token']}/jobs"
    r = client.get(url, params={"content": "true" if details else "false"},
                   headers={"Accept": "application/json"})
    r.raise_for_status()
    out = []
    for j in r.json().get("jobs", []):
        if not is_internship(j.get("title", "")):
            continue
        p = Posting(
            company=company, title=clean(j["title"]),
            location=clean((j.get("location") or {}).get("name")),
            posted=(j.get("first_published") or j.get("updated_at") or "")[:10],
            req_id=j.get("requisition_id") or str(j.get("id", "")),
            url=j.get("absolute_url", ""), source=f"greenhouse:{cfg['token']}")
        if details and j.get("content"):
            apply_detail_text(p, html_to_text(htmllib.unescape(j["content"])))
        out.append(p)
    return out


# --------------------------------------------------------------------------------------
# SAP SuccessFactors Career Site Builder (server-rendered /search/ pages)
# robots.txt disallows /services/ (incl. the RSS feed), so we use /search/ only.
# --------------------------------------------------------------------------------------
SF_PAGE = 25
SF_JOB_HREF = re.compile(r"/job/[^\"'?#]+/\d+/?$")


def _find_field(a, pattern: str):
    """Walk up from the title link until an element with a matching class appears."""
    node = a
    for _ in range(6):
        node = node.parent
        if node is None:
            return None
        el = node.find(class_=re.compile(pattern, re.I))
        if el is not None:
            return el
    return None


def parse_successfactors(html: str, base: str) -> tuple[list[dict], int | None]:
    soup = BeautifulSoup(html, "lxml")
    text = soup.get_text(" ", strip=True)
    # "Showing 1 to 25 of 425 Jobs" / "Results 1 – 25 of 425" / "1 - 25 von 425"
    m = re.search(r"\b\d+\s*(?:to|-|–|bis|à|a)\s*\d+\s*(?:of|von|de|di|sur)\s*([\d.,]+)",
                  text, re.IGNORECASE)
    total = int(re.sub(r"\D", "", m.group(1))) if m and re.sub(r"\D", "", m.group(1)) else None
    rows, seen = [], set()
    for a in soup.find_all("a", href=SF_JOB_HREF):
        href = urljoin(base, a["href"])
        title = clean(a.get_text(" "))
        if href in seen or not title:
            continue
        seen.add(href)
        loc_el, date_el = _find_field(a, r"location"), _find_field(a, r"date")
        loc = clean(loc_el.get_text(" ")) if loc_el else ""
        rows.append({"title": title,
                     "location": re.sub(r"^Location\s*:?\s*", "", loc, flags=re.I),
                     "posted": clean(date_el.get_text(" ")) if date_el else "",
                     "url": href,
                     "req_id": re.search(r"/(\d+)/?$", href).group(1)})
    return rows, total


def scrape_successfactors(client: PoliteClient, company: str, cfg: dict, details: bool,
                          max_pages: int = 30) -> list[Posting]:
    base, out = cfg["base"].rstrip("/"), {}
    for term in cfg.get("terms", ["intern"]):
        startrow = 0
        for _ in range(max_pages):
            qs = urlencode({"q": term, "locale": cfg.get("locale", "en_US"), "startrow": startrow})
            r = client.get(f"{base}/search/?{qs}", headers={"Accept": "text/html"})
            r.raise_for_status()
            rows, total = parse_successfactors(r.text, base)
            for row in rows:
                if row["url"] not in out and is_internship(row["title"]):
                    out[row["url"]] = Posting(company=company, source="successfactors", **row)
            startrow += SF_PAGE
            if not rows or (total is not None and startrow >= total):
                break
    if details:
        for p in out.values():
            enrich_from_page(client, p, (".jobdescription", "[itemprop=description]", ".job-description"))
    return list(out.values())


def enrich_from_page(client: PoliteClient, p: Posting, selectors: tuple[str, ...]) -> BeautifulSoup | None:
    """Fetch a posting's own page (allowed by robots.txt) for its description, pay and dates."""
    try:
        page = BeautifulSoup(client.get(p.url, headers={"Accept": "text/html"}).text, "lxml")
    except requests.RequestException as e:
        log.debug("detail %s: %s", p.url, e)
        return None
    jp = jsonld_jobposting(page)
    body = jp.get("description") or ""
    if not body:
        for sel in selectors:
            el = page.select_one(sel)
            if el:
                body = str(el)
                break
    p.pay = jsonld_pay(jp)
    apply_detail_text(p, html_to_text(body))
    if jp.get("validThrough"):
        p.deadline = str(jp["validThrough"])[:10]
    if jp.get("datePosted"):
        p.posted = str(jp["datePosted"])[:10]
    return page


# --------------------------------------------------------------------------------------
# AbbVie - vacancy sitemap (robots.txt disallows /jobs?* search URLs, allows /en/job/*)
# --------------------------------------------------------------------------------------
def parse_sitemap_locs(xml_bytes: bytes) -> list[str]:
    root = ET.fromstring(xml_bytes)
    return [el.text.strip() for el in root.iter() if el.tag.endswith("loc") and el.text]


def abbvie_slug_to_posting(url: str) -> Posting:
    slug = urlparse(url).path.rstrip("/").split("/job/")[-1]
    m = re.match(r"(.*?)-jid-(\d+)$", slug)
    body, jid = (m.group(1), m.group(2)) if m else (slug, "")
    title, _, loc = body.rpartition("-in-")
    if not title:                      # no "-in-" separator
        title, loc = body, ""
    def pretty(s: str) -> str:
        return " ".join(w.upper() if w in {"r", "d", "bts", "it", "hr", "us", "ai", "qa", "pds", "t"}
                        else w.capitalize() for w in s.replace("co-op", "co‑op").split("-")).replace("‑", "-")
    loc_words = pretty(loc).split()
    if loc_words and len(loc_words[-1]) == 2:          # "il" -> "IL", "ma" -> "MA"
        loc_words[-1] = loc_words[-1].upper()
    return Posting(company="AbbVie", title=pretty(title), location=" ".join(loc_words),
                   req_id=f"jid-{jid}" if jid else "", url=url, source="abbvie-sitemap")


def scrape_abbvie_sitemap(client: PoliteClient, company: str, cfg: dict, details: bool) -> list[Posting]:
    r = client.get(cfg["sitemap"])
    r.raise_for_status()
    locs = parse_sitemap_locs(r.content)
    vacancy_maps = [l for l in locs if "vacanc" in l.lower()] or [cfg["sitemap"]]
    job_urls: list[str] = []
    for sm in vacancy_maps:
        rr = r if sm == cfg["sitemap"] else client.get(sm)
        rr.raise_for_status()
        job_urls += [u for u in parse_sitemap_locs(rr.content) if "/job/" in u]
    out = []
    for u in dict.fromkeys(job_urls):
        p = abbvie_slug_to_posting(u)
        if not is_internship(p.title):
            continue
        if details:
            page = enrich_from_page(client, p, ("[itemprop=description]", ".job-description", ".vacancy-description", "article"))
            if page is not None:
                h1 = page.find("h1")
                og = page.find("meta", property="og:title")
                p.title = clean(h1.get_text(" ") if h1 else (og or {}).get("content", p.title))
                rid = re.search(r"\bR\d{6,}\b", page.get_text(" "))
                if rid:
                    p.req_id = rid.group(0)
        out.append(p)
    return out


SCRAPERS = {
    "workday": scrape_workday,
    "greenhouse": scrape_greenhouse,
    "successfactors": scrape_successfactors,
    "abbvie_sitemap": scrape_abbvie_sitemap,
}

US_RE = re.compile(r"\b(United States|USA|U\.S\.|US\b|Remote \(United States\))|, (?:A[KLRZ]|C[AOT]|D[CE]|FL|GA|"
                   r"HI|I[ADLN]|K[SY]|LA|M[ADEINOST]|N[CDEHJMVY]|O[HKR]|P[AR]|RI|S[CD]|T[NX]|UT|V[AT]|W[AIVY])\b")


def first_url(cfg: dict) -> str:
    if cfg["platform"] == "workday":
        t, h, s = cfg["boards"][0]
        return workday_urls(t, h, s)[0]
    return cfg.get("base") or cfg.get("sitemap") or f"https://boards.greenhouse.io/{cfg.get('token')}"


def cluster(cfg: dict) -> str:
    """Companies on the same Workday data centre share infrastructure (and probably rate limits)."""
    return cfg["boards"][0][1] if cfg["platform"] == "workday" else cfg["platform"] + ":" + cfg.get("token", cfg.get("base", ""))


CLUSTER_CAP = 2  # at most this many companies at once on one Workday data centre


def run(companies: list[str], details: bool, us_only: bool, client: PoliteClient,
        workers: int = 1) -> tuple[list[Posting], dict]:
    """Scrape each company. With workers > 1, companies run side by side, each with its own
    client, so every site still sees only one request at a time at the polite pace."""
    status: dict[str, str] = {}
    caps: dict[str, threading.Semaphore] = {}
    lock = threading.Lock()

    def one(name: str) -> list[Posting]:
        cfg = COMPANIES[name]
        with lock:
            cap = caps.setdefault(cluster(cfg), threading.Semaphore(CLUSTER_CAP))
        with cap:
            c = client if workers <= 1 else client.clone()
            log.info("== %s (%s)", name, cfg["platform"])
            try:
                found = SCRAPERS[cfg["platform"]](c, name, cfg, details)
                if us_only:
                    found = [p for p in found if US_RE.search(" | ".join([p.location, *p.locations]))]
                status[name] = f"ok ({len(found)})"
                log.info("   %s: %d internship postings", name, len(found))
                return found
            except BlockedError as e:
                status[name] = "BLOCKED - manual step needed"
                log.error("   %s: %s", name, e)
            except Exception as e:  # keep going with the other companies
                status[name] = f"error: {e}"
                log.exception("   %s failed", name)
            return []

    results: list[Posting] = []
    if workers <= 1:
        for name in companies:
            results += one(name)
    else:
        with ThreadPoolExecutor(max_workers=workers) as pool:
            futs = {pool.submit(one, n): n for n in companies}
            for f in as_completed(futs):
                results += f.result()
    return results, {n: status.get(n, "error: not run") for n in companies}


def write_outputs(postings: list[Posting], stem: str) -> None:
    with open(f"{stem}.json", "w", encoding="utf-8") as f:
        json.dump([{"key": posting_key(p), **asdict(p)} for p in postings], f, ensure_ascii=False, indent=2)
    cols = ["company", "title", "location", "posted", "deadline", "pay", "req_id", "url", "source"]
    with open(f"{stem}.csv", "w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=cols, extrasaction="ignore")
        w.writeheader()
        for p in postings:
            w.writerow(asdict(p))


def posting_key(p: Posting) -> str:
    """A short stable id for a posting, used to match Claude's extraction back to it."""
    import hashlib
    return hashlib.sha1((p.url or f"{p.company}|{p.title}").encode()).hexdigest()[:12]


# ---- the web app's import format (Admin > Import postings, or POST /api/ingest) ----
CATEGORY_RULES = [
    ("tech", r"data|machine learning|\bml\b|\bai\b|software|computational|bioinformatic|informatics|digital|"
             r"\bit\b|cheminformatic|automation|engineer(?!ing\s+(?:process|manufactur))|analytics|cyber"),
    ("development", r"clinical|regulatory|manufactur|process|quality|biostat|statistic|pharmacovigilance|safety|"
                    r"supply|cmc|operations|medical affairs|validation|packaging|msat|engineering"),
    ("discovery", r"research|discovery|biology|chemistry|chemist|pharmacolog|immunolog|oncolog|protein|structural|"
                  r"assay|in vivo|toxicolog|translational|genomic|neuroscience|scien"),
]


def guess_category(title: str, text: str = "") -> str:
    t = title.lower()
    for cat, rx in CATEGORY_RULES:
        if re.search(rx, t):
            return cat
    return "other"


def guess_term(title: str, text: str = "") -> str:
    for src in (title, text[:3000]):
        m = re.search(r"\b(spring|summer|fall|autumn|winter)\b[^\d\n]{0,15}(20\d\d)|(20\d\d)\b[^\d\n]{0,30}\b(spring|summer|fall|autumn|winter)\b", src, re.I)
        if m:
            season = (m.group(1) or m.group(4)).capitalize().replace("Autumn", "Fall")
            return f"{season} {m.group(2) or m.group(3)}" + (" co-op" if re.search(r"co[-\s]?op", title, re.I) else "")
    m = re.search(r"\b(spring|summer|fall)\b", title, re.I)
    return m.group(1).capitalize() if m else ""


def guess_mode(p: Posting) -> str:
    rt = (p.extra.get("remoteType") or "").lower() if isinstance(p.extra, dict) else ""
    loc = " ".join([p.location, *p.locations]).lower()
    if "hybrid" in rt or "hybrid" in loc:
        return "Hybrid"
    if "remote" in rt or "remote" in loc:
        return "Remote (US)" if US_RE.search(" ".join([p.location, *p.locations])) else "Remote"
    return "Onsite"


def first_sentences(text: str, n: int = 2, max_len: int = 400) -> str:
    body = " ".join(l for l in text.splitlines() if l and not l.startswith("•"))
    parts = re.split(r"(?<=[.!?])\s+", body)
    out = " ".join(parts[:n]).strip()
    return out[:max_len]


def to_import_record(p: Posting) -> dict:
    """One posting in the format lib/importer.ts reads. Claude's extraction (scraper/extract.py)
    can later replace summary, responsibilities, qualifications, category, term and mode."""
    sec = extract_sections(p.description)
    return {
        "key": posting_key(p),
        "title": p.title,
        "company": COMPANIES.get(p.company, {}).get("id", p.company),
        "locations": [x for x in dict.fromkeys(p.locations or [p.location]) if x],
        "category": guess_category(p.title, p.description),
        "deadline": p.deadline,
        "first_seen": posted_to_date(p.posted) or date.today().isoformat(),
        "term": guess_term(p.title, p.description),
        "mode": guess_mode(p),
        "pay": p.pay,
        "url": p.url,
        "description": first_sentences(p.description),
        "responsibilities": sec["resp"],
        "qualifications": sec["quals"],
    }


def write_import(postings: list[Posting], path: str) -> None:
    with open(path, "w", encoding="utf-8") as f:
        json.dump({"postings": [to_import_record(p) for p in postings]}, f, ensure_ascii=False, indent=2)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--companies", nargs="+", default=list(COMPANIES),
                    help="subset, e.g. --companies Pfizer Lilly Vertex (case-insensitive substring)")
    ap.add_argument("--details", action="store_true", help="fetch each posting's detail record (slower)")
    ap.add_argument("--us-only", action="store_true", help="keep US / US-remote locations only")
    ap.add_argument("--out", default="internships", help="output file stem (writes .csv and .json)")
    ap.add_argument("--workers", type=int, default=1,
                    help="companies to scrape at the same time (each site still gets one request at a time); try 5")
    ap.add_argument("--import-out", metavar="PATH",
                    help="also write the web app's import JSON here (use with --details)")
    ap.add_argument("--min-delay", type=float, default=1.5)
    ap.add_argument("--max-delay", type=float, default=3.0)
    ap.add_argument("--manual-session", nargs="*", metavar="COMPANY",
                    help="open these companies' sites in a real browser first so you can pass any "
                         "human check; their cookies are then reused (needs Playwright)")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s", datefmt="%H:%M:%S")

    def match(name: str) -> str:
        exact = [c for c in COMPANIES if c.lower() == name.lower()]
        hits = exact or [c for c in COMPANIES if name.lower() in c.lower()]
        if len(hits) != 1:
            ap.error(f"unknown or ambiguous company: {name!r}; choose from {list(COMPANIES)}")
        return hits[0]

    companies = [match(c) for c in args.companies]
    client = PoliteClient(args.min_delay, args.max_delay)
    for name in args.manual_session or []:
        client.import_browser_cookies(first_url(COMPANIES[match(name)]))

    postings, status = run(companies, args.details, args.us_only, client, workers=max(1, args.workers))
    postings.sort(key=lambda p: (p.company, p.title))
    write_outputs(postings, args.out)
    if args.import_out:
        write_import(postings, args.import_out)
        print(f"Import file for the app -> {args.import_out}")
    print("\nSummary")
    for name, s in status.items():
        print(f"  {name:<24} {s}")
    print(f"\n{len(postings)} postings -> {args.out}.csv / {args.out}.json")
    return 0 if not any(s.startswith(("BLOCKED", "error")) for s in status.values()) else 2


if __name__ == "__main__":
    sys.exit(main())
