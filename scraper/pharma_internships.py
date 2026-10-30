#!/usr/bin/env python3
"""
pharma_internships.py - collect internship / co-op postings from 61 pharma, biotech and AI drug
discovery career sites using the public JSON feeds and pages that power those sites.

Platforms covered (verified October 2026 unless marked otherwise in COMPANIES):
  * Workday "cxs" JSON API  - Pfizer, Merck/MSD, AstraZeneca, BMS, Sanofi, GSK, Vertex,
                              Regeneron, Genentech (Roche), Amgen, Eli Lilly, Takeda,
                              Gilead, Novartis, Biogen, NVIDIA, Johnson & Johnson, Moderna,
                              Eisai, CSL, Viatris, Denali, Cytokinetics, Thermo Fisher, Lonza,
                              Catalent, IQVIA, Labcorp, Abbott, Zoetis, BeiGene
  * Greenhouse Job Board API - Revolution Medicines, Recursion, Generate:Biomedicines, Nurix,
                              Septerna, Maze, BridgeBio, Biohub, Calico, Altos Labs, Profluent,
                              Noetik, Atomic AI, Freenome, Lila Sciences, Ginkgo Bioworks
  * Ashby posting API        - insitro, Genesis Molecular AI, Chai Discovery
  * Lever postings API       - Arsenal Bioscience, Tahoe Therapeutics, GRAIL
  * Eightfold job search API - Bayer
  * SAP SuccessFactors CSB   - Boehringer Ingelheim, Novo Nordisk, Astellas, Daiichi Sankyo
                              (server-rendered search pages)
  * Phenom career sites      - Merck KGaA (EMD Serono), UCB
  * AbbVie job search        - careers.abbvie.com (its vacancy sitemap with --respect-robots)
  * Backups when Workday is down: careers.gene.com (Phenom) for Genentech,
    careers.amgen.com (Radancy) for Amgen

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

robots.txt: by default the script also uses routes robots.txt disallows (today AbbVie's job
search, which has better data than its sitemap). Pass --respect-robots to use allowed routes only,
which still cover every company. The pace and the stop-on-block rule are the same either way.
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
from datetime import date, datetime, timedelta, timezone
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
                             "sitemap": "https://careers.abbvie.com/sitemap.xml",
                             # used by default (robots.txt disallows /jobs?*; --respect-robots skips it), which
                             # gives real titles, locations, pay, work type, R-numbers and expiry dates
                             "robots_disallowed": {"platform": "abbvie_search", "base": "https://careers.abbvie.com",
                                                   "path": "/en/jobs",
                                                   "terms": ["intern", "internship", "co-op", "praktikum", "werkstudent"]}},
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
    "Genentech":            {"id": "genentech", "platform": "workday", "boards": [("roche", "wd3", "ROG-A2O-GENE")],
                             # careers.gene.com (Phenom) lists the same jobs; used when Workday fails
                             "fallback": {"platform": "phenom", "base": "https://careers.gene.com", "path": "/us/en",
                                          "terms": ["intern", "internship", "co-op"]}},
    "Amgen":                {"id": "amgen", "platform": "workday", "boards": [("amgen", "wd1", "Careers")],
                             # careers.amgen.com (Radancy/TalentBrew) lists the same jobs; used when Workday fails
                             "fallback": {"platform": "radancy", "base": "https://careers.amgen.com", "path": "/en/search-jobs",
                                          "terms": ["intern", "internship", "co-op"]}},
    "Eli Lilly":            {"id": "lilly", "platform": "workday",
                             # CMP used to be student-only; since Oct 2026 it lists every kind of job, so filter it too
                             "boards": [("lilly", "wd115", "CMP"), ("lilly", "wd115", "LLY")],
                             "alt_hosts": ["wd5"],
                             # wd115 sits behind Cloudflare, which challenges Python's own TLS handshake (a real
                             # browser gets through with no check): talk to it the way Chrome does (curl_cffi)
                             "impersonate": True,
                             # if Workday still refuses: the same boards through headless Chromium (Playwright; the
                             # US internships are all on CMP), then careers.lilly.com (Phenom), which mirrors only
                             # the LLY board, with the same R-numbers
                             "fallback": [{"platform": "workday_browser", "label": "headless browser",
                                           "boards": [("lilly", "wd115", "CMP"), ("lilly", "wd115", "LLY")]},
                                          {"platform": "phenom", "base": "https://careers.lilly.com", "path": "/us/en",
                                           "terms": ["intern", "internship", "co-op"]}]},
    "Revolution Medicines": {"id": "revmed", "platform": "greenhouse", "token": "revolutionmedicines"},
    "Gilead Sciences":      {"id": "gilead", "platform": "workday", "boards": [("gilead", "wd1", "gileadcareers")]},
    "Novartis":             {"id": "novartis", "platform": "workday", "boards": [("novartis", "wd3", "Novartis_Careers")]},
    "Biogen":               {"id": "biogen", "platform": "workday", "boards": [("biibhr", "wd3", "external")]},
    "Recursion":            {"id": "recursion", "platform": "greenhouse", "token": "recursionpharmaceuticals"},
    "Generate:Biomedicines": {"id": "generate", "platform": "greenhouse", "token": "generatebiomedicines"},
    "insitro":              {"id": "insitro", "platform": "ashby", "org": "insitro"},
    "Takeda":               {"id": "takeda", "platform": "workday", "boards": [("takeda", "wd502", "External")],
                             "alt_hosts": ["wd3"]},
    # A tech company with hundreds of internships a year, most of them chips, graphics and systems:
    # only keep the ones that mention healthcare or the life sciences ("require", on title + description).
    "NVIDIA":               {"id": "nvidia", "platform": "workday", "boards": [("nvidia", "wd5", "NVIDIAExternalCareerSite")],
                             "require": r"(?<![A-Za-z])(health\s?care|life sciences?|biolog\w*|bioinformatic\w*|biotech\w*|"
                                        r"pharma\w*|drug|molecul\w*|protein\w*|genom\w*|chemistry|cheminformatic\w*|"
                                        r"medical|medicine|clinical|biomedical|BioNeMo|Clara|MONAI|Parabricks)(?![A-Za-z])"},

    # Added October 2026. Boards found from their live postings; platforms marked "unverified" weren't reachable
    # for a test fetch and are worth watching on the first refresh.
    # Large pharma
    "Johnson & Johnson":    {"id": "jnj", "platform": "workday", "boards": [("jj", "wd5", "JJ")]},
    "Novo Nordisk":         {"id": "novonordisk", "platform": "successfactors", "base": "https://careers.novonordisk.com",
                             "terms": ["intern", "internship", "co-op", "student"]},
    # Eightfold; also lists Crop Science and Consumer Health jobs, which aren't drug R&D
    "Bayer":                {"id": "bayer", "platform": "eightfold", "base": "https://talent.bayer.com", "domain": "bayer.com",
                             "terms": ["intern", "co-op"], "skip_business_units": ["Crop Science", "Consumer Health"]},
    "Astellas":             {"id": "astellas", "platform": "successfactors", "base": "https://careers.astellas.com"},
    "Daiichi Sankyo":       {"id": "daiichisankyo", "platform": "successfactors", "base": "https://careers.daiichisankyo.com"},   # unverified
    "Moderna":              {"id": "moderna", "platform": "workday", "boards": [("modernatx", "wd1", "M_tx")]},
    "Merck KGaA":           {"id": "merck-kgaa", "platform": "phenom", "base": "https://careers.emdgroup.com", "path": "/us/en",   # unverified
                             "terms": ["intern", "internship", "co-op"]},
    "Eisai":                {"id": "eisai", "platform": "workday", "boards": [("eisai", "wd5", "eisai")]},
    "UCB":                  {"id": "ucb", "platform": "phenom", "base": "https://careers.ucb.com", "path": "/us/en",   # unverified
                             "terms": ["intern", "internship", "co-op"]},
    "CSL":                  {"id": "csl", "platform": "workday", "boards": [("csl", "wd1", "CSL_External")]},
    "Viatris":              {"id": "viatris", "platform": "workday", "boards": [("viatris", "wd5", "External")]},
    # Bay Area biotech
    "Denali Therapeutics":  {"id": "denali", "platform": "workday",
                             "boards": [("dnli", "wd1", "Internships", {"all": True}), ("dnli", "wd1", "Discovery"),
                                        ("dnli", "wd1", "Development")]},
    "Cytokinetics":         {"id": "cytokinetics", "platform": "workday", "boards": [("cytokinetics", "wd1", "Cytokinetics")]},
    "Nurix Therapeutics":   {"id": "nurix", "platform": "greenhouse", "token": "nurix"},
    "Septerna":             {"id": "septerna", "platform": "greenhouse", "token": "septerna"},
    "Maze Therapeutics":    {"id": "maze", "platform": "greenhouse", "token": "mazetherapeutics"},
    "Arsenal Bioscience":   {"id": "arsenalbio", "platform": "lever", "site": "arsenalbio"},
    "BridgeBio":            {"id": "bridgebio", "platform": "greenhouse", "token": "bridgebio"},
    # Research institutes
    "Chan Zuckerberg Biohub": {"id": "czbiohub", "platform": "greenhouse", "token": "biohub"},
    "Calico Life Sciences": {"id": "calico", "platform": "greenhouse", "token": "calicolabs"},
    "Altos Labs":           {"id": "altos", "platform": "greenhouse", "token": "altoslabs"},
    # AI drug discovery
    "Genesis Molecular AI": {"id": "genesis", "platform": "ashby", "org": "genesis-molecular-ai"},
    "Chai Discovery":       {"id": "chai", "platform": "ashby", "org": "chaidiscovery"},
    "Profluent":            {"id": "profluent", "platform": "greenhouse", "token": "profluent"},
    "Noetik":               {"id": "noetik", "platform": "greenhouse", "token": "noetik"},
    "Tahoe Therapeutics":   {"id": "tahoe", "platform": "lever", "site": "tahoebio-ai"},
    "Atomic AI":            {"id": "atomicai", "platform": "greenhouse", "token": "atomai"},
    # Genomics
    "GRAIL":                {"id": "grail", "platform": "lever", "site": "grailbio"},
    "Freenome":             {"id": "freenome", "platform": "greenhouse", "token": "freenome"},

    # Added October 2026 after probing the public job feeds of life-science employers for internship-titled
    # postings (boards and tenants below returned live internships on 2026-10-30).
    # Life-science tools, CDMOs and CROs
    "Thermo Fisher Scientific": {"id": "thermofisher", "platform": "workday",
                                 "boards": [("thermofisher", "wd5", "ThermoFisherCareers")]},
    "Lonza":                {"id": "lonza", "platform": "workday", "boards": [("lonza", "wd3", "Lonza_Careers")]},
    "Catalent":             {"id": "catalent", "platform": "workday", "boards": [("catalent", "wd1", "External")]},
    "IQVIA":                {"id": "iqvia", "platform": "workday", "boards": [("iqvia", "wd1", "IQVIA")]},
    "Labcorp":              {"id": "labcorp", "platform": "workday", "boards": [("labcorp", "wd1", "External")]},
    # Healthcare, animal health and biotech
    "Abbott":               {"id": "abbott", "platform": "workday", "boards": [("abbott", "wd5", "abbottcareers")]},
    "Zoetis":               {"id": "zoetis", "platform": "workday", "boards": [("zoetis", "wd5", "zoetis")]},
    "BeiGene":              {"id": "beigene", "platform": "workday", "boards": [("beigene", "wd5", "BeiGene")]},
    # AI / synthetic biology
    "Lila Sciences":        {"id": "lila", "platform": "greenhouse", "token": "lilasciences"},
    "Ginkgo Bioworks":      {"id": "ginkgo", "platform": "greenhouse", "token": "ginkgobioworks"},
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
NOT_INTERN_RE = re.compile(r"(?<![A-Za-z])(early|late|mid)[-\s]stage(?![A-Za-z])|"
                           # talent-pool postings ("Interested in an internship?"), not openings
                           r"^\s*(?:interested in|don'?t see|general (?:application|interest)|join our talent)", re.IGNORECASE)
WORKDAY_TERMS = ["intern", "internship", "co-op"]

# --------------------------------------------------------------------------------------
# Full-time roles mode (set_mode("job")): the same companies and careers-site adapters, searched for junior to
# mid-level (0-5 years) AI and computational drug R&D roles instead of internships. They go to the private
# Full-time roles tab (pipeline.py --kind job), never to the student board.
MODE = "internship"
JOB_TERMS = ["data scientist", "machine learning", "computational", "bioinformatics", "cheminformatics",
             "pharmacometrics", "artificial intelligence", "biostatistics", "statistical programmer"]
# titles of computational roles
JOB_TITLE_RE = re.compile(
    r"data scien|machine learning|\bml\b|\bai\b|artificial intelligence|gen(?:erative)?\s*ai|deep learning|"
    r"computational|bioinformatic|cheminformatic|informatics|pharmacometric|quantitative (?:systems|pharmacolog|scien)|"
    r"\bqsp\b|modell?ing (?:and|&) simulation|biostatistic|statistician|statistical programm|data engineer|"
    r"ml engineer|mlops|research engineer|scientific (?:software|programm)|software engineer[^,]{0,40}(?:scien|research|discovery|r&d)|"
    r"structural biolog|protein design|molecular (?:modell?ing|design)|\bomics\b|genomics data|real[- ]world (?:data|evidence)",
    re.I)
# titles above 0-5 years. "Postdoctoral Fellow" is an early-career role, so only other fellows count.
SENIOR_TITLE_RE = re.compile(
    r"(?<![A-Za-z])(senior|sr|principal|lead|staff|manager|director|head|vp|vice president|chief|"
    r"distinguished|executive|fellow|iv|v|vi|level\s*[4-9])(?![A-Za-z])", re.I)
SENIOR_OK_RE = re.compile(r"post-?doc", re.I)


JOB_SEARCH = list(JOB_TERMS)     # what full-time roles mode searches for (a candidate profile can replace it)
EXTRA_TITLE_RE: re.Pattern | None = None   # extra titles a candidate profile adds


def set_mode(mode: str) -> None:
    """"internship" (the student board) or "job" (full-time roles). Set before run()."""
    global MODE
    if mode not in ("internship", "job"):
        raise ValueError(mode)
    MODE = mode


def set_job_search(terms: list[str] | None = None, title_words: list[str] | None = None) -> None:
    """Tailor full-time roles mode to a candidate (scraper/roles_profile.py): its search terms replace the defaults,
    and its title words count as computational titles too. No arguments: back to the defaults."""
    global JOB_SEARCH, EXTRA_TITLE_RE
    JOB_SEARCH = list(terms) if terms else list(JOB_TERMS)
    words = [w for w in (title_words or []) if w.strip()]
    EXTRA_TITLE_RE = re.compile("|".join(re.escape(w) for w in words), re.I) if words else None


def is_target_role(title: str) -> bool:
    """A junior to mid-level computational role: not an internship, not senior, and a computational title."""
    t = title or ""
    if is_internship(t) or not (JOB_TITLE_RE.search(t) or (EXTRA_TITLE_RE and EXTRA_TITLE_RE.search(t))):
        return False
    senior = {m.group(1).lower() for m in SENIOR_TITLE_RE.finditer(t)}
    return not senior or (senior == {"fellow"} and bool(SENIOR_OK_RE.search(t)))


def wanted(title: str) -> bool:
    """The title test the adapters apply: an internship, or in full-time roles mode a target role."""
    return is_target_role(title) if MODE == "job" else is_internship(title)


def search_terms(cfg: dict, default: list[str]) -> list[str]:
    """What to type into a careers site's search box. A company's own "terms" are internship words."""
    return JOB_SEARCH if MODE == "job" else cfg.get("terms", default)


YEARS_RE = re.compile(
    r"(?<![\d.])(\d{1,2})\s*(?:\+|or more)?\s*(?:(?:-|–|—|to)\s*\d{1,2}\s*\+?\s*)?years?['’]?\s*(?:of\s+)?"
    r"(?:[\w/&,-]+\s+){0,6}?(?:experience|work)", re.I)


def min_years(text: str) -> int | None:
    """The fewest years of experience a posting asks for on any route ("PhD with 0-2 years, or MS with 5+ years"
    is 0), or None when it doesn't say."""
    found = [int(m.group(1)) for m in YEARS_RE.finditer(text or "") if int(m.group(1)) <= 30]
    return min(found) if found else None

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


class UnavailableError(RuntimeError):
    """Raised when a site is down for maintenance (e.g. Workday's weekend maintenance page)."""


MAINTENANCE_MARKERS = ("maintenance-page", "currently unavailable", "service interruption", "scheduled maintenance")


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
        """Turn WAF / bot-challenge answers into a clear BlockedError (or UnavailableError for maintenance)."""
        ctype = resp.headers.get("Content-Type", "")
        # Pages that don't name a charset are UTF-8 in practice; older `requests` versions assume
        # ISO-8859-1 for text/*, which garbles "–", "é" and the like.
        if "charset" not in ctype.lower() and ("html" in ctype or "json" in ctype or "xml" in ctype):
            resp.encoding = "utf-8"
        head = resp.text[:20000].lower() if "html" in ctype else ""
        if any(m in head or m in (resp.url or "").lower() for m in MAINTENANCE_MARKERS):
            raise UnavailableError(f"{resp.request.method} {resp.url} -> the site is down for maintenance; try again later.")
        # A real challenge page: Cloudflare's "Just a moment..." interstitial (it loads
        # /cdn-cgi/challenge-platform/.../orchestrate/... and sets cf-mitigated), PerimeterX or Incapsula block
        # pages. Cloudflare also adds a background script (/cdn-cgi/challenge-platform/scripts/jsd/main.js) to
        # ordinary pages that loaded fine, e.g. Eli Lilly's Workday: on a 200 answer that is not a block.
        status = resp.status_code
        interstitial = next((m for m in ("<title>just a moment", "_cf_chl_opt", "challenge-platform/h/",
                                         "/orchestrate/", "cf-browser-verification",
                                         "px-captcha", "_incapsula_resource") if m in head), None)
        if resp.headers.get("cf-mitigated", "").lower() == "challenge":
            interstitial = "cf-mitigated: challenge"
        widget = next((m for m in ("cf-chl", "challenge-platform", "g-recaptcha", "hcaptcha") if m in head), None)
        soft_marker = next((m for m in BLOCK_MARKERS if m in head), None)
        why = ("HTTP %d" % status if status in (401, 403) else interstitial
               or (widget if status != 200 else None) or (soft_marker if status in (429, 503) else None))
        if why:
            server = resp.headers.get("Server", "?")
            raise BlockedError(
                f"{resp.request.method} {resp.url} -> HTTP {status} (server: {server}; {why}). "
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


    def impersonating(self) -> "PoliteClient":
        """A client that connects the way Chrome does (TLS and HTTP/2 fingerprint, via curl_cffi), for sites
        behind Cloudflare-style bot checks that refuse Python's own handshake even when a real browser gets
        straight through. Same pacing, cookies and block detection. Without curl_cffi installed, returns
        this client unchanged and says so."""
        try:
            from curl_cffi import requests as creq
        except ImportError:
            log.warning("curl_cffi isn't installed, so this site gets Python's own handshake and may refuse it: "
                        "pip install -r scraper/requirements.txt")
            return self
        c = ImpersonatingClient(self.min_delay, self.max_delay, timeout=self.timeout)
        c.csession = creq.Session(impersonate="chrome")
        c.csession.cookies.update(self.session.cookies.get_dict())
        return c


class ImpersonatingClient(PoliteClient):
    """PoliteClient over curl_cffi (Chrome's handshake). Responses come back as ordinary
    requests.Response objects and errors as requests exceptions, so every scraper works unchanged."""
    csession = None
    RETRY_STATUS = (429, 500, 502, 503, 504)

    def _send(self, method: str, url: str, **kw) -> requests.Response:
        from curl_cffi.requests.exceptions import RequestException as CurlError
        kw.setdefault("timeout", self.timeout)
        kw.pop("allow_redirects", None)
        # Chrome sends its own User-Agent and Accept-Language; keep the caller's Accept/JSON headers
        headers = {k: v for k, v in (kw.pop("headers", None) or {}).items() if k.lower() != "user-agent"}
        for attempt in range(4):
            try:
                cr = self.csession.request(method, url, headers=headers, **kw)
            except CurlError as e:
                if attempt == 3:
                    raise requests.ConnectionError(f"{method} {url}: {e}") from e
                time.sleep(2 ** attempt + random.random())
                continue
            if cr.status_code in self.RETRY_STATUS and attempt < 3:
                time.sleep(float(cr.headers.get("Retry-After") or 2 ** (attempt + 1)) + random.random())
                continue
            return self._to_requests(method, cr)
        raise requests.ConnectionError(f"{method} {url}: no answer")   # pragma: no cover

    @staticmethod
    def _to_requests(method: str, cr) -> requests.Response:
        r = requests.Response()
        r.status_code = cr.status_code
        r._content = cr.content
        r.headers = requests.structures.CaseInsensitiveDict(dict(cr.headers))
        r.url = str(cr.url)
        r.encoding = None
        r.request = requests.Request(method, str(cr.url)).prepare()
        r.reason = getattr(cr, "reason", "") or ""
        return r

    def request(self, method: str, url: str, **kw) -> requests.Response:
        self._pace(url)
        resp = self._send(method, url, **kw)
        self._check_block(resp)
        return resp

    def probe(self, url: str, **kw) -> requests.Response:
        self._pace(url)
        resp = self._send("GET", url, **kw)
        self._check_block(resp)
        return resp

    def clone(self) -> "PoliteClient":
        return self


# --------------------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------------------
def is_internship(title: str) -> bool:
    return bool(INTERN_RE.search(title or "")) and not NOT_INTERN_RE.search(title or "")


# The board serves UCSF graduate and professional students, so postings only undergraduates (or high
# schoolers) can take are left out. Co-ops in the US are undergraduate programmes unless they say otherwise.
UNDERGRAD_TITLE_RE = re.compile(r"(?<![A-Za-z])(co[-\s]?op|undergrad(?:uate)?s?|bachelor'?s?|high[-\s]school)(?![A-Za-z])", re.I)
UNDERGRAD_TEXT_RE = re.compile(
    r"(?<![A-Za-z])(undergrad(?:uate)?s?|bachelor'?s?\s+(?:degree\s+)?(?:program|programme|student|candidate)|"
    r"(?:pursuing|enrolled in|working toward)\s+(?:a\s+|an\s+|your\s+)?(?:b\.?s\.?|b\.?a\.?|bachelor'?s?)|"
    r"rising\s+(?:sophomore|junior|senior)s?|sophomores?|freshm[ae]n|high[-\s]school\s+students?)(?![A-Za-z])", re.I)
GRAD_RE = re.compile(
    r"(?<![A-Za-z])((?<!under)graduate\s+(?:student|program|programme|degree|school|level|studies|candidate)s?|"
    r"grad\s+students?|master'?s|masters|m\.s\.|ms\s+(?:student|degree|program|candidate)s?|ph\.?\s?d\.?s?|"
    r"doctora(?:l|te)|pharm\.?\s?d\.?|m\.?d\.?/ph\.?d|mba|m\.?p\.?h\.?|professional\s+(?:school|degree)\s+students?|"
    r"advanced\s+degree|post-?doc\w*)(?![A-Za-z])", re.I)


def undergrad_only(title: str, description: str = "") -> bool:
    """True for a posting only undergraduates (or high schoolers) can take: an undergraduate or co-op title,
    or a description that asks for undergraduates, with no mention of graduate, PhD, PharmD, MD or MBA students."""
    title, description = title or "", description or ""
    if GRAD_RE.search(title) or GRAD_RE.search(description):
        return False
    return bool(UNDERGRAD_TITLE_RE.search(title) or UNDERGRAD_TEXT_RE.search(description))


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
    lines = [re.sub(r"^[·●▪◦*–-]\s+", "• ", l) for l in lines]   # bullets typed as paragraphs
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


# "The hourly rate for our interns is 38 USD - 94 USD." (NVIDIA): currency after the number
TRAILING_USD_RE = re.compile(r"(\d[\d,]*(?:\.\d+)?)\s?USD\s*(?:-|–|—|to)\s*(\d[\d,]*(?:\.\d+)?)\s?USD", re.I)


def extract_pay(text: str) -> str:
    """The first pay figure or range in a description, e.g. "$28.87 per hour" or "$45 - $55/hr"."""
    m = TRAILING_USD_RE.search(text or "")
    if m:
        around = (text or "")[max(0, m.start() - 120):m.end() + 40].lower()
        unit = "/hr" if "hour" in around else "/yr" if re.search(r"annual|year|salary", around) else ""
        return f"${m.group(1)} - ${m.group(2)}{unit}"
    for m in SALARY_RE.finditer(text or ""):
        val = clean(m.group(0))
        if re.search(r"\d{2}", val):          # skip "$1" style noise
            return val
    return ""


SECTION_HEADS = {
    "resp": re.compile(r"^(?:key\s+|your\s+|main\s+|primary\s+|position\s+|examples of key\s+)?(?:responsibilit|duties|"
                       r"what you(?:'|’)?ll do|what you will do|what will you do|what you will achieve|"
                       r"what you(?:'|’)?ll be doing|"
                       r"the role|role overview|key activities|day to day|day-to-day|in this role|job description|"
                       r"your mission|tasks|what you will be doing|your impact|the opportunity|projects may include|"
                       r"during your internship|key deliverables|deliverables)", re.I),
    "quals": re.compile(r"^(?:basic |minimum |preferred |required |desired |position |additional )?(?:qualifications?|requirements?|"
                        r"what you(?:'|’)?ll bring|what you bring|who you are|eligibility|program eligibility|"
                        r"skills|experience|education|about you|your profile|we(?:'|’)?re looking for|"
                        r"must[- ]haves?|nice[- ]to[- ]haves?|what we expect of you|what are we looking for|"
                        r"what you will need|let(?:'|’)?s find out if|you(?:'|’)?re basic requirements|your basic requirements|"
                        r"additional (?:skills|preferences)|preferences|ideal candidate|"
                        r"what we need to see|ways to stand out|what you need|what you(?:'|’)?ll need)", re.I),
}
# Headings after which bullets are not responsibilities or qualifications (pay, benefits, about us...).
SECTION_STOP = re.compile(r"^(?:compensation|salary|pay\b|benefits?|what (?:do )?we offer|what you can expect|why |about |"
                          r"program (?:highlights|details)|additional information|flex|disclosure|eeo|equal opportunity|"
                          r"how we work|our ways|\w+ offers?\b|company overview|organization overview|who we are|"
                          r"supporting people|candidate rights|data protection|us and puerto rico|current employees|#)", re.I)


def extract_sections(text: str, limit: int = 8) -> dict[str, list[str]]:
    """Bullet points under "Responsibilities"/"Qualifications"-style headings (best effort)."""
    out: dict[str, list[str]] = {"resp": [], "quals": []}
    current = None
    for line in (text or "").splitlines():
        bare = line.strip().rstrip(":").strip()
        if not bare:
            continue
        is_head = len(bare) < 80 and not bare.startswith("•")
        if is_head and SECTION_STOP.search(bare):
            current = None
            continue
        hit = next((k for k, rx in SECTION_HEADS.items() if is_head and rx.search(bare)), None)
        if hit:
            current = hit
            continue
        # a different heading ("Program Highlights", "What do we offer you?") ends the section; a lead-in
        # line ("Key responsibilities include:") or an ordinary sentence doesn't
        if is_head and len(bare) < 60 and not line.strip().endswith((":", ".", ",", ";")) and not current is None \
                and re.match(r"^[A-Z][\w’'&/(),-]*(?:\s+[\w’'&/(),-]+){0,7}\??$", bare):
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


_STATES = {
    "alabama": "AL", "alaska": "AK", "arizona": "AZ", "arkansas": "AR", "california": "CA", "colorado": "CO",
    "connecticut": "CT", "delaware": "DE", "district of columbia": "DC", "florida": "FL", "georgia": "GA",
    "hawaii": "HI", "idaho": "ID", "illinois": "IL", "indiana": "IN", "iowa": "IA", "kansas": "KS", "kentucky": "KY",
    "louisiana": "LA", "maine": "ME", "maryland": "MD", "massachusetts": "MA", "michigan": "MI", "minnesota": "MN",
    "mississippi": "MS", "missouri": "MO", "montana": "MT", "nebraska": "NE", "nevada": "NV", "new hampshire": "NH",
    "new jersey": "NJ", "new mexico": "NM", "new york": "NY", "north carolina": "NC", "north dakota": "ND",
    "ohio": "OH", "oklahoma": "OK", "oregon": "OR", "pennsylvania": "PA", "puerto rico": "PR", "rhode island": "RI",
    "south carolina": "SC", "south dakota": "SD", "tennessee": "TN", "texas": "TX", "utah": "UT", "vermont": "VT",
    "virginia": "VA", "washington": "WA", "west virginia": "WV", "wisconsin": "WI", "wyoming": "WY",
}
_CODES = set(_STATES.values())
_US = re.compile(r"^(us|usa|u\.s\.a?\.?|united states( of america)?)$", re.I)


def _state(s: str) -> str | None:
    t = s.strip()
    if len(t) == 2 and t.upper() in _CODES:
        return t.upper()
    return _STATES.get(t.lower())


# US sites career sites list without a state (Workday "South San Francisco", "SLEEPY HOLLOW"). Only used
# when the site says the job is in the US, since "Cambridge" or "Athens" alone could be anywhere.
CITY_STATE = {
    "south san francisco": "CA", "san francisco": "CA", "thousand oaks": "CA", "oceanside": "CA", "vacaville": "CA",
    "redwood city": "CA", "san diego": "CA", "irvine": "CA", "foster city": "CA", "hillsboro": "OR",
    "sleepy hollow": "NY", "tarrytown": "NY", "armonk": "NY", "rensselaer": "NY", "new york city": "NY",
    "warren": "NJ", "rahway": "NJ", "princeton": "NJ", "lawrenceville": "NJ", "new brunswick": "NJ", "summit": "NJ",
    "bridgewater": "NJ", "morristown": "NJ", "cambridge": "MA", "boston": "MA", "lexington": "MA", "devens": "MA",
    "waltham": "MA", "seattle": "WA", "bothell": "WA", "indianapolis": "IN", "north chicago": "IL", "mettawa": "IL",
    "lake county": "IL", "ridgefield": "CT", "west greenwich": "RI", "durham": "NC", "zebulon": "NC",
    "research triangle park": "NC", "rockville": "MD", "gaithersburg": "MD", "frederick": "MD", "wilmington": "DE",
    "upper merion": "PA", "upper providence": "PA", "collegeville": "PA", "west point": "PA", "philadelphia": "PA",
    "swiftwater": "PA", "columbus": "OH", "athens": "GA", "johns creek": "GA", "saint joseph": "MO",
    "st. joseph": "MO", "holly springs": "NC", "new albany": "OH", "lebanon": "IN", "kenilworth": "NJ",
}


def _city(s: str) -> str:
    """'SLEEPY HOLLOW' -> 'Sleepy Hollow' (leave mixed-case names alone)."""
    return s.title() if s.isupper() and len(s) > 3 else s


def normalize_location(raw: str, us: bool = False) -> str:
    """Career-site location formats -> the board's "City, ST" form (same rules as lib/locations.ts):
    "US - New Jersey - Rahway" -> "Rahway, NJ"; "US - Frederick - MD" -> "Frederick, MD";
    "Princeton - NJ - US" -> "Princeton, NJ"; "US, Indianapolis IN" -> "Indianapolis, IN";
    "Redwood City, California, United States" -> "Redwood City, CA"; "Columbus, United States, Ohio" -> "Columbus, OH";
    "US, CA, Santa Clara" -> "Santa Clara, CA";
    "North Chicago IL" -> "North Chicago, IL"; with us=True (the site says the job is in the US),
    "SLEEPY HOLLOW" -> "Sleepy Hollow, NY" for known US sites;
    "United States - Remote" -> "Remote (US)"; "Germany - Ingelheim" -> "Ingelheim, Germany". Else unchanged."""
    loc = clean(raw)
    if not loc:
        return loc
    if re.search(r"\bremote\b", loc, re.I) and (re.search(r"\b(us|usa|united states)\b", loc, re.I) or loc.lower() == "remote"):
        return "Remote (US)"
    m = re.match(r"^(?:US|USA|United States(?: of America)?)\s*[,:]\s*(.+)$", loc, re.I)
    if m:                                                          # "US, Indianapolis IN" / "US: South San Francisco"
        return normalize_location(m.group(1), True)
    dashed = [clean(x) for x in re.split(r"\s+-\s+|\s*–\s*", loc) if clean(x)]
    parts = dashed if len(dashed) >= 2 else ([clean(x) for x in loc.split("-")] if re.match(r"^(US|USA)-[A-Za-z]{2}-", loc) else dashed)
    if len(parts) >= 3 and _US.match(parts[0]) and _state(parts[1]):
        return f"{_city(parts[2])}, {_state(parts[1])}"
    if len(parts) == 3 and _US.match(parts[0]) and _state(parts[2]):     # "US - Frederick - MD"
        return f"{_city(parts[1])}, {_state(parts[2])}"
    if len(parts) == 3 and _US.match(parts[2]) and _state(parts[1]):     # "Princeton - NJ - US"
        return f"{_city(parts[0])}, {_state(parts[1])}"
    if len(parts) == 2 and _US.match(parts[0]):
        return normalize_location(parts[1], True) if not _state(parts[1]) else parts[1]
    if len(parts) >= 2 and not _US.match(parts[0]) and "," not in loc and re.fullmatch(r"[A-Za-z .'()]+", parts[0]):
        return f"{parts[-1]}, {parts[0]}"
    c = [clean(x) for x in loc.split(",") if clean(x)]
    if len(c) >= 2:
        if _state(c[1]) and (len(c) == 2 or _US.match(c[2])):
            return f"{_city(c[0])}, {_state(c[1])}"
        if len(c) == 3 and _US.match(c[1]) and _state(c[2]):
            return f"{_city(c[0])}, {_state(c[2])}"
        if len(c) == 2 and _US.match(c[1]):
            return normalize_location(c[0], True)
        if len(c) == 2 and _state(c[0]) and not _state(c[1]):          # "CA, Santa Clara" (NVIDIA: "US, CA, Santa Clara")
            return f"{_city(c[1])}, {_state(c[0])}"
        return loc
    m = re.match(r"^(.+?)\s+([A-Za-z]{2})$", loc)
    if m and m.group(2).upper() in _CODES and re.search(r"[a-z]", m.group(1)):
        return f"{m.group(1)}, {m.group(2).upper()}"
    st = CITY_STATE.get(loc.lower()) if us else None
    return f"{_city(loc)}, {st}" if st else loc


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


def sane_deadline(value: str, today: date | None = None) -> str:
    """A YYYY-MM-DD closing date, or "" for placeholders (AbbVie lists validThrough 100 years out)."""
    d = str(value or "")[:10]
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", d):
        return ""
    today = today or date.today()
    try:
        when = date.fromisoformat(d)
    except ValueError:
        return ""
    return d if today - timedelta(days=365) <= when <= today + timedelta(days=2 * 365) else ""


_MONTH_NAMES = ["january", "february", "march", "april", "may", "june", "july", "august", "september",
                "october", "november", "december"]
DEADLINE_RE = re.compile(
    r"(?:application deadline|deadline to apply|apply by|closing date|applications? (?:will )?(?:close|are due|due)|"
    r"accepting applications (?:through|until))\W{0,10}(?:on\s+|is\s+)?(?:[A-Za-z]+day,?\s+)?"
    r"(?P<mon>jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(?P<day>\d{1,2})(?:st|nd|rd|th)?"
    r"(?:,?\s+(?P<year>20\d\d))?", re.I)


def extract_deadline(text: str, today: date | None = None) -> str:
    """'Applications will close on November 22nd at 11:59pm' -> the next such date, as YYYY-MM-DD."""
    m = DEADLINE_RE.search(text or "")
    if not m:
        return ""
    today = today or date.today()
    month = [n[:3] for n in _MONTH_NAMES].index(m.group("mon").lower()[:3]) + 1
    year = int(m.group("year")) if m.group("year") else today.year
    try:
        when = date(year, month, int(m.group("day")))
    except ValueError:
        return ""
    if not m.group("year") and when < today - timedelta(days=30):
        when = when.replace(year=year + 1)
    return sane_deadline(when.isoformat(), today)


def apply_detail_text(p: Posting, text: str) -> None:
    p.description = text[:20000]
    if not p.pay:
        p.pay = extract_pay(text)
    if not p.deadline:
        p.deadline = extract_deadline(text)


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
        if everything and MODE == "job":
            continue                           # nothing but internships there
        log.info("   %s: searching %s", company, board)
        try:
            for term in ([""] if everything else search_terms(cfg, WORKDAY_TERMS)):
                before = len(out)
                for jp in workday_search(client, tenant, host, site, term):
                    title, path = jp.get("title", ""), jp.get("externalPath", "")
                    if not path or path in out or not (everything or wanted(title)):
                        continue
                    out[path] = workday_listing(company, board, tenant, site, jp)
                log.info("   %s: %s %r: %d new internship listings", company, site, term or "(everything)", len(out) - before)
        except UnavailableError:
            raise
        except (BlockedError, requests.HTTPError) as e:
            log.warning("%s: JSON API failed (%s) - falling back to sitemap", company, e)
            for p in workday_sitemap(client, tenant, host, site):
                if wanted(p.title) and p.url not in out:
                    p.company = company
                    out[p.url] = p
            continue
        if details:
            mine = [(path, p) for path, p in out.items() if p.source.startswith(f"workday:{tenant}/{site}")]
            for k, (path, p) in enumerate(mine, 1):
                if k == 1 or k % 10 == 0 or k == len(mine):
                    log.info("   %s: %s details %d/%d", company, site, k, len(mine))
                try:
                    apply_workday_detail(p, workday_detail(client, tenant, host, site, path))
                except (requests.RequestException, ValueError) as e:
                    log.debug("detail %s: %s", path, e)
    return list(out.values())


def workday_listing(company: str, board: str, tenant: str, site: str, jp: dict) -> Posting:
    """One row of a Workday search result as a Posting."""
    bullets = jp.get("bulletFields") or []
    return Posting(company=company, title=clean(jp.get("title", "")), location=clean(jp.get("locationsText")),
                   posted=clean(jp.get("postedOn")), req_id=bullets[0] if bullets else "",
                   url=f"{board}{jp.get('externalPath', '')}", source=f"workday:{tenant}/{site}")


def apply_workday_detail(p: Posting, info: dict) -> None:
    """Fill a Posting from a Workday job's detail record (jobPostingInfo)."""
    p.req_id = info.get("jobReqId", p.req_id)
    p.location = info.get("location", p.location)
    p.locations = [x for x in [info.get("location"), *(info.get("additionalLocations") or [])] if x]
    p.start_date = info.get("startDate", "") or ""
    if p.start_date:
        p.posted = p.start_date[:10]
    p.deadline = sane_deadline(info.get("endDate") or "")   # "Posting end date" when the tenant sets one
    p.extra = {"startDate": p.start_date,
               "timeType": info.get("timeType", ""),
               "remoteType": info.get("remoteType", ""),
               "country": (info.get("country") or {}).get("descriptor", "")}
    apply_detail_text(p, html_to_text(info.get("jobDescription", "")))


# --------------------------------------------------------------------------------------
# Workday through a headless browser: for tenants behind a bot check that refuses scripted HTTP
# even with Chrome's handshake. Opens the board page in Chromium (Playwright) and calls the same
# JSON API from inside it, exactly as the page itself does. Needs: pip install playwright &&
# playwright install chromium
# --------------------------------------------------------------------------------------
_BROWSER_FETCH = """async ([url, body]) => {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 30000);   // never wait forever on one call
  try {
    const r = await fetch(url, { signal: ctl.signal, ...(body
      ? { method: 'POST', body, headers: { 'Content-Type': 'application/json', Accept: 'application/json' } }
      : { headers: { Accept: 'application/json' } }) });
    return { status: r.status, text: await r.text() };
  } catch (e) {
    return { status: 0, text: String(e) };
  } finally { clearTimeout(t); }
}"""


def scrape_workday_browser(client: PoliteClient, company: str, cfg: dict, details: bool) -> list[Posting]:
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        raise RuntimeError("the headless-browser route needs Playwright: pip install playwright && playwright install chromium")
    out: dict[str, Posting] = {}

    def call(page, url: str, payload: dict | None = None) -> dict:
        time.sleep(random.uniform(client.min_delay, client.max_delay))   # same polite pace as plain HTTP
        r = page.evaluate(_BROWSER_FETCH, [url, json.dumps(payload) if payload is not None else None])
        if r["status"] == 0:
            raise RuntimeError(f"{url} -> no answer within 30 s from inside the browser ({r['text'][:120]})")
        if r["status"] in (401, 403) or "_cf_chl_opt" in r["text"][:5000]:
            raise BlockedError(f"{url} -> HTTP {r['status']} even from a real browser")
        if r["status"] != 200:
            raise RuntimeError(f"{url} -> HTTP {r['status']}: {r['text'][:200]}")
        return json.loads(r["text"])

    log.info("   %s: starting headless Chromium", company)
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True, timeout=60_000)
        try:
            ctx = browser.new_context(user_agent=DEFAULT_UA, locale="en-US")
            page = ctx.new_page()
            page.set_default_timeout(45_000)
            for tenant, host, site, *opt in cfg["boards"]:
                opts = opt[0] if opt else {}
                everything = bool(opts.get("all"))
                if everything and MODE == "job":
                    continue
                board, api = workday_urls(tenant, host, site)
                log.info("   %s: opening %s in the browser", company, board)
                resp = page.goto(board, wait_until="domcontentloaded", timeout=45_000)
                log.info("   %s: page loaded (HTTP %s, title %r)", company, resp.status if resp else "?", page.title()[:60])
                api_path = urlparse(api).path   # same-origin call from the board page
                found: list[Posting] = []
                for term in ([""] if everything else search_terms(cfg, WORKDAY_TERMS)):
                    total, offset = None, 0
                    while True:
                        data = call(page, f"{api_path}/jobs", {"appliedFacets": {}, "limit": WD_PAGE, "offset": offset, "searchText": term})
                        total = data.get("total") or 0 if total is None else total
                        rows = data.get("jobPostings") or []
                        for jp in rows:
                            path = jp.get("externalPath", "")
                            if path and f"{board}{path}" not in out and (everything or wanted(jp.get("title", ""))):
                                p = workday_listing(company, board, tenant, site, jp)
                                out[p.url] = p
                                found.append(p)
                        offset += WD_PAGE
                        if not rows or offset >= total or offset >= WD_PAGE * 50:
                            break
                    log.info("   %s: %s %r: %d jobs searched, %d internships so far", company, site, term or "(everything)", total, len(found))
                if details:
                    for k, p in enumerate(found, 1):
                        if k == 1 or k % 10 == 0 or k == len(found):
                            log.info("   %s: %s details %d/%d (browser)", company, site, k, len(found))
                        try:
                            apply_workday_detail(p, call(page, api_path + p.url[len(board):]).get("jobPostingInfo", {}))
                        except (RuntimeError, ValueError) as e:
                            log.debug("detail %s: %s", p.url, e)
        finally:
            browser.close()
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
        if not wanted(j.get("title", "")):
            continue
        locs = [clean(x) for x in re.split(r"\s*;\s*", (j.get("location") or {}).get("name") or "") if clean(x)]
        p = Posting(
            company=company, title=clean(j["title"]), locations=locs,
            location=locs[0] if locs else "",
            posted=(j.get("first_published") or j.get("updated_at") or "")[:10],
            req_id=j.get("requisition_id") or str(j.get("id", "")),
            url=j.get("absolute_url", ""), source=f"greenhouse:{cfg['token']}",
            deadline=(j.get("application_deadline") or "")[:10])
        if details and j.get("content"):
            apply_detail_text(p, html_to_text(htmllib.unescape(j["content"])))
        out.append(p)
    return out


# --------------------------------------------------------------------------------------
# Ashby (public posting API, the same one the company's own careers page calls)
# --------------------------------------------------------------------------------------
def scrape_ashby(client: PoliteClient, company: str, cfg: dict, details: bool) -> list[Posting]:
    r = client.get(f"https://api.ashbyhq.com/posting-api/job-board/{cfg['org']}",
                   params={"includeCompensation": "true"}, headers={"Accept": "application/json"})
    r.raise_for_status()
    out = []
    for j in r.json().get("jobs", []):
        title = clean(j.get("title"))
        if not (wanted(title) or (MODE == "internship" and j.get("employmentType") == "Intern" and not NOT_INTERN_RE.search(title))):
            continue
        if j.get("isListed") is False:
            continue
        locs = [clean(x) for x in [j.get("location"), *[(l or {}).get("location") for l in j.get("secondaryLocations") or []]] if clean(x)]
        wp = (j.get("workplaceType") or "").lower()
        p = Posting(company=company, title=title, location=locs[0] if locs else "", locations=locs,
                    posted=(j.get("publishedAt") or "")[:10], url=j.get("jobUrl") or "", source=f"ashby:{cfg['org']}",
                    pay=clean(((j.get("compensation") or {}).get("compensationTierSummary")) or ""),
                    extra={"remoteType": "Hybrid" if wp == "hybrid" else "Remote" if wp == "remote" or j.get("isRemote") else ""})
        if details and j.get("descriptionHtml"):
            apply_detail_text(p, html_to_text(j["descriptionHtml"]))
        out.append(p)
    return out


# --------------------------------------------------------------------------------------
# Lever (public postings API, the same one jobs.lever.co pages call). One request lists every
# posting with its full description, so --details costs nothing extra.
# --------------------------------------------------------------------------------------
def _remote_type(workplace: str | None) -> str:
    wp = (workplace or "").lower()
    return "Hybrid" if wp == "hybrid" else "Remote" if wp == "remote" else ""


def scrape_lever(client: PoliteClient, company: str, cfg: dict, details: bool) -> list[Posting]:
    site = cfg["site"]
    r = client.get(f"https://api.lever.co/v0/postings/{site}", params={"mode": "json"},
                   headers={"Accept": "application/json"})
    r.raise_for_status()
    out = []
    for j in r.json() or []:
        title = clean(j.get("text"))
        cats = j.get("categories") or {}
        # "Intern" as the commitment counts like an internship title (as Ashby's employmentType does)
        intern_commitment = bool(re.search(r"(?<![A-Za-z])intern", cats.get("commitment") or "", re.I))
        if not (wanted(title) or (MODE == "internship" and intern_commitment and not NOT_INTERN_RE.search(title))):
            continue
        locs = [clean(x) for x in (cats.get("allLocations") or [cats.get("location")]) if clean(x)]
        created = j.get("createdAt")
        posted = (datetime.fromtimestamp(created / 1000, tz=timezone.utc).date().isoformat()
                  if isinstance(created, (int, float)) else "")
        extra = {"remoteType": _remote_type(j.get("workplaceType"))}
        if j.get("country"):
            extra["country"] = j["country"]   # ISO code ("US"), which is_us reads
        p = Posting(company=company, title=title, location=locs[0] if locs else "", locations=locs, posted=posted,
                    req_id=str(j.get("id", "")), url=j.get("hostedUrl") or "", source=f"lever:{site}", extra=extra)
        if details:
            lists = "".join(f"<h3>{htmllib.escape(l.get('text') or '')}</h3><ul>{l.get('content') or ''}</ul>"
                            for l in j.get("lists") or [])
            body = (j.get("description") or "") + lists + (j.get("additional") or "")
            if body.strip():
                apply_detail_text(p, html_to_text(body))
        out.append(p)
    return out


# --------------------------------------------------------------------------------------
# Eightfold career sites (talent.bayer.com): the search page calls /api/apply/v2/jobs, which takes the
# site's domain and pages through results 10 at a time; each job's description is a second call.
# --------------------------------------------------------------------------------------
EIGHTFOLD_PAGE = 10


def scrape_eightfold(client: PoliteClient, company: str, cfg: dict, details: bool, max_pages: int = 20) -> list[Posting]:
    base, domain = cfg["base"].rstrip("/"), cfg["domain"]
    skip_units = {u.lower() for u in cfg.get("skip_business_units", [])}
    out: dict[str, Posting] = {}
    ids: dict[str, str] = {}
    for term in search_terms(cfg, ["intern"]):
        for page in range(max_pages):
            r = client.get(f"{base}/api/apply/v2/jobs",
                           params={"domain": domain, "query": term, "start": page * EIGHTFOLD_PAGE, "num": EIGHTFOLD_PAGE},
                           headers={"Accept": "application/json"})
            r.raise_for_status()
            data = r.json() or {}
            jobs = data.get("positions") or []
            for j in jobs:
                title = clean(j.get("posting_name") or j.get("name"))
                url = j.get("canonicalPositionUrl") or f"{base}/careers/job/{j.get('id')}"
                if url in out or not wanted(title):
                    continue
                if clean(j.get("business_unit")).lower() in skip_units:
                    continue
                # "Chesterfield,Missouri,United States"
                locs = [", ".join(s.strip() for s in str(x).split(",") if s.strip())
                        for x in (j.get("locations") or [j.get("location")]) if x]
                created = j.get("t_create")
                out[url] = Posting(
                    company=company, title=title, location=locs[0] if locs else "", locations=locs,
                    posted=(datetime.fromtimestamp(created, tz=timezone.utc).date().isoformat()
                            if isinstance(created, (int, float)) else ""),
                    req_id=str(j.get("display_job_id") or j.get("ats_job_id") or j.get("id") or ""),
                    url=url, source=f"eightfold:{base}",
                    extra={"remoteType": _remote_type(j.get("work_location_option"))})
                ids[url] = str(j.get("id") or "")
            if not jobs or (page + 1) * EIGHTFOLD_PAGE >= (data.get("count") or 0):
                break
    if details:
        for url, p in out.items():
            if not ids.get(url):
                continue
            try:
                job = client.get(f"{base}/api/apply/v2/jobs/{ids[url]}", params={"domain": domain},
                                 headers={"Accept": "application/json"}).json() or {}
            except (requests.RequestException, ValueError) as e:
                log.debug("eightfold detail %s: %s", url, e)
                continue
            if job.get("job_description"):
                apply_detail_text(p, html_to_text(job["job_description"]))
    return list(out.values())


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
    for term in search_terms(cfg, ["intern"]):
        startrow = 0
        for _ in range(max_pages):
            qs = urlencode({"q": term, "locale": cfg.get("locale", "en_US"), "startrow": startrow})
            r = client.get(f"{base}/search/?{qs}", headers={"Accept": "text/html"})
            r.raise_for_status()
            rows, total = parse_successfactors(r.text, base)
            for row in rows:
                if row["url"] not in out and wanted(row["title"]):
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
    def meta(prop: str) -> str:
        el = page.find("meta", attrs={"itemprop": prop})
        return el.get("content", "") if el else ""
    valid = sane_deadline(jp.get("validThrough") or "") or sane_deadline(any_date(meta("validThrough")))
    if valid:
        p.deadline = valid
    posted = str(jp.get("datePosted") or "")[:10] or any_date(meta("datePosted"))   # SuccessFactors: microdata only
    if posted:
        p.posted = posted
    ident = jp.get("identifier")
    ident = ident.get("value") if isinstance(ident, dict) else ident
    if not p.req_id and isinstance(ident, str) and re.fullmatch(r"[A-Z]{0,5}-?\d{4,}(?:-\d+)?", ident.strip()):
        p.req_id = ident.strip()   # Radancy: {"name": "Job ID", "value": "R-254668"}; AbbVie's is a GUID, skipped
    apply_detail_text(p, html_to_text(body))
    return page


def any_date(text: str) -> str:
    """'2026-09-17T…' / 'Thu Sep 17 00:00:00 UTC 2026' / 'Sep 17, 2026' -> '2026-09-17' ('' if none)."""
    t = clean(text)
    if re.match(r"\d{4}-\d{2}-\d{2}", t):
        return t[:10]
    m = re.search(r"\b([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})\b.*?\b(20\d\d)\b", t)
    if m and m.group(1).lower() in [n[:3] for n in _MONTH_NAMES]:
        return f"{m.group(3)}-{[n[:3] for n in _MONTH_NAMES].index(m.group(1).lower()) + 1:02d}-{int(m.group(2)):02d}"
    return ""


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
        if not wanted(p.title):
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


# --------------------------------------------------------------------------------------
# Phenom career sites (careers.gene.com): the search and job pages embed their data as
# `phApp.ddo = {...}`. robots.txt allows /search-results and /job/ pages (it blocks /apply etc.).
# --------------------------------------------------------------------------------------
PHENOM_PAGE = 10


def parse_phenom_ddo(html: str) -> dict:
    """The JSON object assigned to phApp.ddo in a Phenom page."""
    i = html.find("phApp.ddo = ")
    if i < 0:
        return {}
    start = i + len("phApp.ddo = ")
    depth, in_str, esc = 0, False, False
    for j in range(start, len(html)):
        ch = html[j]
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                try:
                    return json.loads(html[start:j + 1])
                except ValueError:
                    return {}
    return {}


def _phenom_locations(job: dict) -> list[str]:
    locs = []
    for l in job.get("multi_location") or []:
        locs.append(l.get("location") if isinstance(l, dict) else l)
    return [clean(x) for x in locs if x] or ([clean(job["location"])] if job.get("location") else [])


def scrape_phenom(client: PoliteClient, company: str, cfg: dict, details: bool, max_pages: int = 20) -> list[Posting]:
    base, path = cfg["base"].rstrip("/"), cfg.get("path", "/us/en")
    out: dict[str, Posting] = {}
    for term in search_terms(cfg, ["intern"]):
        for page in range(max_pages):
            r = client.get(f"{base}{path}/search-results?" + urlencode({"keywords": term, "from": page * PHENOM_PAGE, "s": 1}),
                           headers={"Accept": "text/html"})
            r.raise_for_status()
            found = (parse_phenom_ddo(r.text).get("eagerLoadRefineSearch") or {})
            jobs = ((found.get("data") or {}).get("jobs")) or []
            for j in jobs:
                title, url = clean(j.get("title")), j.get("jobUrl") or ""
                if not url or url in out or not wanted(title):
                    continue
                locs = _phenom_locations(j)
                out[url] = Posting(company=company, title=title, location=locs[0] if locs else "", locations=locs,
                                   posted=(j.get("postedDate") or j.get("dateCreated") or "")[:10],
                                   req_id=j.get("reqId") or j.get("jobId") or "", url=url, source=f"phenom:{base}")
            total = found.get("totalHits") or 0
            if not jobs or (page + 1) * PHENOM_PAGE >= total:
                break
    if details:
        for p in out.values():
            try:
                job = ((parse_phenom_ddo(client.get(p.url, headers={"Accept": "text/html"}).text).get("jobDetail") or {})
                       .get("data") or {}).get("job") or {}
                if job.get("description"):
                    apply_detail_text(p, html_to_text(job["description"]))
                p.locations = _phenom_locations(job) or p.locations
            except requests.RequestException as e:
                log.debug("phenom detail %s: %s", p.url, e)
    return list(out.values())


# --------------------------------------------------------------------------------------
# AbbVie job search (Attrax): /en/jobs?q=intern&page=N, 10 tiles per page.
# Used by default; skipped with --respect-robots, because robots.txt disallows /jobs?*.
# --------------------------------------------------------------------------------------
ABBVIE_PAGE = 10


def parse_abbvie_search(html: str, base: str) -> tuple[list[dict], int | None]:
    soup = BeautifulSoup(html, "lxml")
    m = re.search(r"([\d,]+)\s*result", (soup.select_one(".attrax-pagination__total-results") or soup).get_text(" "), re.I)
    total = int(m.group(1).replace(",", "")) if m else None

    def val(tile, cls: str) -> str:
        el = tile.select_one(f".{cls} .attrax-vacancy-tile__item-value") or tile.select_one(f".{cls}")
        if el is None:
            return ""
        txt = clean(el.get_text(" "))
        label = tile.select_one(f".{cls} .attrax-vacancy-tile__item-label")
        if label is not None and el is not label and txt.startswith(clean(label.get_text(" "))):
            txt = clean(txt[len(clean(label.get_text(" "))):])
        return re.sub(r"^(Job ID|Expiry Date|Salary|Location)\s*", "", txt, flags=re.I)

    rows = []
    for t in soup.select(".attrax-vacancy-tile"):
        a = t.select_one("a.attrax-vacancy-tile__title")
        if a is None or not a.get("href"):
            continue
        pay = val(t, "attrax-vacancy-tile__salary-value") or val(t, "attrax-vacancy-tile__salary")
        expiry = val(t, "attrax-vacancy-tile__expiry")
        deadline = ""
        em = re.match(r"(\d{1,2})/(\d{1,2})/(\d{4})", expiry)
        if em and int(em.group(3)) > 2000:
            deadline = f"{em.group(3)}-{int(em.group(1)):02d}-{int(em.group(2)):02d}"  # /en/ pages use MM/DD/YYYY
        rows.append({
            "title": clean(a.get_text(" ")),
            "url": urljoin(base, a["href"]),
            "location": val(t, "attrax-vacancy-tile__location-freetext"),
            "pay": "" if re.fullmatch(r"\$?0(\.0+)?\s*-\s*\$?0(\.0+)?", pay or "") else pay,
            "mode": val(t, "attrax-vacancy-tile__option-work-location-type"),
            "job_type": val(t, "attrax-vacancy-tile__option-job-type"),
            "req_id": val(t, "attrax-vacancy-tile__externalreference"),
            "deadline": deadline,
        })
    return rows, total


def scrape_abbvie_search(client: PoliteClient, company: str, cfg: dict, details: bool, max_pages: int = 30) -> list[Posting]:
    base, path = cfg["base"].rstrip("/"), cfg.get("path", "/en/jobs")
    out: dict[str, Posting] = {}
    for term in search_terms(cfg, ["intern"]):
        for page in range(1, max_pages + 1):
            r = client.get(f"{base}{path}?" + urlencode({"q": term, "page": page}), headers={"Accept": "text/html"})
            r.raise_for_status()
            rows, total = parse_abbvie_search(r.text, base)
            for row in rows:
                if row["url"] in out or not (wanted(row["title"]) or (MODE == "internship" and re.search(r"intern", row["job_type"], re.I))):
                    continue
                mode = row["mode"].lower()
                out[row["url"]] = Posting(
                    company=company, title=row["title"], location=row["location"], locations=[row["location"]] if row["location"] else [],
                    req_id=row["req_id"], url=row["url"], source="abbvie-search", pay=row["pay"], deadline=row["deadline"],
                    extra={"remoteType": "Hybrid" if "hybrid" in mode else "Remote" if "remote" in mode else ""})
            if not rows or (total is not None and page * ABBVIE_PAGE >= total):
                break
    if details:
        for p in out.values():
            pay, deadline = p.pay, p.deadline
            enrich_from_page(client, p, ("[itemprop=description]", ".job-description", ".vacancy-description", "article"))
            p.pay, p.deadline = p.pay or pay, p.deadline or deadline
    return list(out.values())


# --------------------------------------------------------------------------------------
# Radancy / TalentBrew career sites (careers.amgen.com): /en/search-jobs/<term>?p=N.
# The first page says how many jobs match the term (data-total-job-results); pages past
# that drift into unrelated jobs, so paging stops there.
# --------------------------------------------------------------------------------------
_MONTHS = {m: i for i, m in enumerate(["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"], 1)}


def radancy_date(text: str) -> str:
    """'Aug. 31, 2026' / 'August 31, 2026' / '08/31/2026' -> '2026-08-31' ('' if unreadable)."""
    t = clean(text)
    m = re.search(r"([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})", t)
    if m and m.group(1).lower() in _MONTHS:
        return f"{m.group(3)}-{_MONTHS[m.group(1).lower()]:02d}-{int(m.group(2)):02d}"
    m = re.search(r"(\d{1,2})/(\d{1,2})/(\d{4})", t)
    return f"{m.group(3)}-{int(m.group(1)):02d}-{int(m.group(2)):02d}" if m else ""


def _radancy_locations(text: str) -> list[str]:
    """'US - California - Thousand Oaks / and 3 other locations' -> ['US - California - Thousand Oaks']."""
    t = re.sub(r"(/\s*)?\band \d+ other locations?\b.*$", "", clean(text), flags=re.I).strip(" /")
    return [x.strip() for x in re.split(r"\s*/\s*|\s*;\s*", t) if x.strip()]


def parse_radancy_search(html: str, base: str) -> tuple[list[dict], dict]:
    soup = BeautifulSoup(html, "lxml")
    sec = soup.select_one("section#search-results") or soup.select_one("[data-total-job-results]")

    def num(attr: str) -> int | None:
        v = sec.get(attr) if sec is not None else None
        return int(v) if v and str(v).isdigit() else None

    meta = {"total": num("data-total-job-results"), "pages": num("data-total-pages"), "per_page": num("data-records-per-page")}
    rows = []
    for a in soup.select("#search-results-list li a[href*='/job/']"):
        h = a.select_one("h2, h3")
        locs: list[str] = []
        for el in a.select(".job-location"):
            locs += [l for l in _radancy_locations(el.get_text(" ")) if l not in locs]
        rid = a.select_one(".job-id, .job-reqid")
        posted = a.select_one(".job-date-posted")
        rows.append({
            "title": clean((h or a).get_text(" ")),
            "url": urljoin(base, a["href"]),
            "locations": locs,
            "posted": radancy_date(posted.get_text(" ")) if posted else "",
            "req_id": re.sub(r"^(Job\s*ID|Req(uisition)?\s*(ID|#)?)\s*:?\s*", "", clean(rid.get_text(" ")), flags=re.I) if rid else "",
        })
    return rows, meta


REQ_ID_RE = re.compile(r"\b(?:Job|Req(?:uisition)?)\s*(?:ID|#|Number)\s*:?\s*([A-Z]{1,4}-?\d{4,})", re.I)


def scrape_radancy(client: PoliteClient, company: str, cfg: dict, details: bool, max_pages: int = 20) -> list[Posting]:
    base, path = cfg["base"].rstrip("/"), cfg.get("path", "/en/search-jobs")
    out: dict[str, Posting] = {}
    for term in search_terms(cfg, ["intern"]):
        last = max_pages
        for page in range(1, max_pages + 1):
            r = client.get(f"{base}{path}/{term}" + (f"?p={page}" if page > 1 else ""), headers={"Accept": "text/html"})
            r.raise_for_status()
            rows, meta = parse_radancy_search(r.text, base)
            if page == 1 and meta["total"] is not None:
                per = meta["per_page"] or len(rows) or 1
                last = min(max_pages, max(1, -(-meta["total"] // per)))
            for row in rows:
                if row["url"] in out or not wanted(row["title"]):
                    continue
                locs = row["locations"]
                out[row["url"]] = Posting(company=company, title=row["title"], location=locs[0] if locs else "",
                                          locations=locs, posted=row["posted"], req_id=row["req_id"], url=row["url"],
                                          source=f"radancy:{base}")
            if not rows or page >= last:
                break
    if details:
        for p in out.values():
            posted = p.posted
            page = enrich_from_page(client, p, (".ats-description", ".job-description", "#anchor-overview",
                                                "[itemprop=description]", "main"))
            p.posted = p.posted or posted
            if page is not None and not p.req_id:
                m = REQ_ID_RE.search(page.get_text(" "))
                if m:
                    p.req_id = m.group(1).upper()
    return list(out.values())


SCRAPERS = {
    "abbvie_search": scrape_abbvie_search,
    "phenom": scrape_phenom,
    "workday_browser": scrape_workday_browser,
    "radancy": scrape_radancy,
    "ashby": scrape_ashby,
    "lever": scrape_lever,
    "eightfold": scrape_eightfold,
    "workday": scrape_workday,
    "greenhouse": scrape_greenhouse,
    "successfactors": scrape_successfactors,
    "abbvie_sitemap": scrape_abbvie_sitemap,
}

US_RE = re.compile(r"\b(United States|USA|U\.S\.|US\b|Remote \(United States\))|, (?:A[KLRZ]|C[AOT]|D[CE]|FL|GA|"
                   r"HI|I[ADLN]|K[SY]|LA|M[ADEINOST]|N[CDEHJMVY]|O[HKR]|P[AR]|RI|S[CD]|T[NX]|UT|V[AT]|W[AIVY])\b")


def is_us(p: Posting) -> bool:
    """In the US: the site says so (Workday country), a location names a US place, or (without
    --details) a "3 Locations" listing that can't be judged yet."""
    country = (p.extra.get("country") or "") if isinstance(p.extra, dict) else ""
    if country:
        return bool(re.search(r"united states|^usa?$", country, re.I))
    locs = " | ".join([p.location, *p.locations])
    return bool(US_RE.search(locs)) or bool(re.fullmatch(r"\d+ Locations?", clean(p.location)) and not p.locations)


def first_url(cfg: dict) -> str:
    if cfg["platform"] == "workday":
        t, h, s = cfg["boards"][0][:3]
        return workday_urls(t, h, s)[0]
    if cfg["platform"] == "ashby":
        return f"https://jobs.ashbyhq.com/{cfg['org']}"
    if cfg["platform"] == "lever":
        return f"https://jobs.lever.co/{cfg['site']}"
    return cfg.get("base") or cfg.get("sitemap") or f"https://boards.greenhouse.io/{cfg.get('token')}"


def cluster(cfg: dict) -> str:
    """Companies on the same Workday data centre share infrastructure (and probably rate limits)."""
    return cfg["boards"][0][1] if cfg["platform"] == "workday" else cfg["platform"] + ":" + cfg.get("token", cfg.get("org", cfg.get("site", cfg.get("base", ""))))


CLUSTER_CAP = 2  # at most this many companies at once on one Workday data centre


def run(companies: list[str], details: bool, us_only: bool, client: PoliteClient,
        workers: int = 1, ignore_robots: bool = False, on_company=None) -> tuple[list[Posting], dict]:
    """Scrape each company. With workers > 1, companies run side by side, each with its own
    client, so every site still sees only one request at a time at the polite pace.
    With ignore_robots, a company's `robots_disallowed` route (if any) is tried first.
    on_company(name, state, found, note), if given, hears "running" when a company starts and "done"
    (with the number of postings) or "failed" (with why) when it ends; its errors never stop the scrape."""
    status: dict[str, str] = {}

    def tell(name: str, state: str, found: int | None = None, note: str = "") -> None:
        if on_company:
            try:
                on_company(name, state, found, note)
            except Exception as e:  # reporting progress must never break scraping
                log.debug("progress callback failed: %s", e)
    caps: dict[str, threading.Semaphore] = {}
    lock = threading.Lock()

    def one(name: str) -> list[Posting]:
        cfg = COMPANIES[name]
        with lock:
            cap = caps.setdefault(cluster(cfg), threading.Semaphore(CLUSTER_CAP))
        with cap:
            c = client if workers <= 1 else client.clone()
            if cfg.get("impersonate"):
                c = c.impersonating()
            log.info("== %s (%s)", name, cfg["platform"])
            tell(name, "running")
            fallbacks = cfg.get("fallback") or []
            fallbacks = [fallbacks] if isinstance(fallbacks, dict) else fallbacks   # one source, or several in order
            attempts = [(cfg, "")] + [({**fb, "id": cfg.get("id")}, " via " + fb.get("label", fb["platform"])) for fb in fallbacks]
            if ignore_robots and cfg.get("robots_disallowed"):
                rd = cfg["robots_disallowed"]
                attempts.insert(0, ({**rd, "id": cfg.get("id")}, " via " + rd["platform"] + " (robots.txt ignored)"))
            problems = []
            for acfg, via in attempts:
                try:
                    found = SCRAPERS[acfg["platform"]](c, name, acfg, details)
                    if us_only:
                        found = [p for p in found if is_us(p)]
                    if cfg.get("require"):   # a company outside pharma: only postings on topic
                        req = re.compile(cfg["require"], re.I)
                        found = [p for p in found if req.search(f"{p.title}\n{p.description}")]
                    status[name] = f"ok ({len(found)}){via}"
                    log.info("   %s: %d internship postings%s", name, len(found), via)
                    tell(name, "done", len(found), via.strip())
                    return found
                except UnavailableError as e:
                    problems.append("UNAVAILABLE - down for maintenance, try later")
                    log.warning("   %s: %s", name, e)
                except BlockedError as e:
                    problems.append("BLOCKED - manual step needed")
                    log.error("   %s: %s", name, e)
                except Exception as e:  # keep going with the other companies
                    problems.append(f"error: {e}")
                    log.exception("   %s failed", name)
                if acfg is not attempts[-1][0]:
                    log.warning("   %s: trying the next source", name)
            status[name] = problems[0] if problems else "error"
            tell(name, "failed", 0, status[name])
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
    # a drug-pipeline area in the title comes first, so "Intern - Research - Drug Metabolism - AI" is discovery,
    # not tech (the classifier in scraper/classify.py uses the same check)
    from classify import stage_from_title
    stage = stage_from_title(title)
    if stage:
        return stage
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


# Headings that start the part of a posting about the job itself.
ROLE_HEAD = re.compile(
    r"^(?:the\s+|your\s+|about\s+the\s+|position\s+|role\s+|job\s+|internship\s+|program\s+)?"
    r"(?:job description|description|role|position|opportunity|job|internship|summary|overview|overview of (?:the )?role|"
    r"role overview|position summary|job summary|about the role|what you(?:'|’)ll do|what you will do|in this role|"
    r"department summary|team overview|the team|project description)\s*:?$", re.I)
# Headings of sections about the company, benefits or legal text: skipped until the next role heading.
COMPANY_HEAD = re.compile(
    r"^(?:about (?:us|the company|[A-Z][\w&.’' -]{1,40})|who we are|company (?:overview|description)|our (?:company|mission|story|culture)|"
    r"why (?:join|work)|join [A-Z][\w’']+(?:’s|'s)? mission|life at|our commitment|equal opportunity|eeo|benefits|"
    r"what we offer|what you can expect of us|compensation|pay range|salary|additional information|#)", re.I)
ROLE_WORDS = re.compile(r"\b(intern(?:ship)?s?|co-?op|you will|you['’]ll|this (?:role|position|internship|project)|the (?:intern|candidate|student)|"
                        r"responsib|project)\b", re.I)
SLOGAN = re.compile(r"^(?:let['’]s (?:do this|change the world)|join us|apply (?:now|today)|are you ready|ready to make)[.!]?$", re.I)
WE_WORDS = re.compile(r"\b(we|we['’]re|we['’]ve|our|us)\b", re.I)


def _company_words(company: str) -> list[str]:
    name = company or ""
    words = [w for w in re.split(r"[\s:,]+", name) if len(w) > 2 and w.lower() not in ("the", "and", "inc", "sciences", "pharmaceuticals", "therapeutics")]
    extra = {"Genentech": ["Roche"], "Merck": ["MSD"], "Bristol Myers Squibb": ["BMS"], "Eli Lilly": ["Lilly"]}.get(name, [])
    return words + extra


# Application small print, never a job summary even when it says "internship" (NVIDIA opens with this)
BOILERPLATE = re.compile(r"^by submitting your (?:resume|application)|applicant privacy policy|terms of service|"
                         r"posting is for an existing vacancy|uses ai tools in its recruiting|"
                         r"applications are accepted on an ongoing basis", re.I)


PAY_TALK = re.compile(r"\b(?:hourly rates?|pay range|base pay|salary range|compensation range|rate for our interns|"
                      r"eligible for (?:intern |our )?benefits)\b", re.I)


def is_company_blurb(par: str, company: str) -> bool:
    """'At Gilead, we're creating a healthier world...' - about the company, not the job."""
    if BOILERPLATE.search(par):
        return True
    if ROLE_WORDS.search(par):
        return False
    names = _company_words(company)
    mentions = any(re.search(rf"\b{re.escape(w)}\b", par, re.I) for w in names)
    return mentions or bool(re.search(
        r"for (?:more than|over) \d+ years|our mission|we['’]re (?:creating|committed|on a mission)|patients (?:around|across) the (?:world|globe)|"
        r"equal (?:employment )?opportunity|committed to (?:diversity|an inclusive)", par, re.I))


def job_summary(text: str, company: str = "", title: str = "", n: int = 3, max_len: int = 600) -> str:
    """The opening of the job description itself: skips company blurbs, benefits and legal text, and
    starts after a heading like "Job Description" or "The Opportunity" when there is one."""
    lines = [l.strip() for l in (text or "").splitlines() if l.strip()]
    def is_head(l: str) -> bool:
        return len(l) < 70 and not l.startswith("•") and not re.search(r"[.!?]$", l)
    paras, skipping = [], False
    for l in lines:
        if is_head(l):
            bare = l.rstrip(":").strip()
            if COMPANY_HEAD.search(bare):
                skipping = True
            elif ROLE_HEAD.search(bare) or SECTION_HEADS["resp"].search(bare):
                skipping = False
            continue
        if skipping or l.startswith("•") or (title and l.strip().lower() == title.strip().lower()):
            continue
        # a lead-in to a list ("...in at least one of the following areas:") or a sentence about pay
        if l.endswith(":") or PAY_TALK.search(l):
            continue
        if is_company_blurb(l, company):
            continue
        paras.append(l)
        if sum(len(x) for x in paras) > max_len * 1.5:
            break
    body = " ".join(paras)
    if not body:   # nothing but bullets: use the first few
        bullets = [l.lstrip("• ").strip() for l in lines if l.startswith("•")][:3]
        body = " ".join(b if re.search(r"[.!?]$", b) else b + "." for b in bullets)
    parts = [x for x in re.split(r"(?<=[.!?])\s+", body.strip()) if x and not SLOGAN.match(x) and not is_company_blurb(x, company)]
    out = ""
    for part in parts[:n]:
        if out and len(out) + len(part) + 1 > max_len:
            break
        out = (out + " " + part).strip()
    return out[:max_len]


def first_sentences(text: str, n: int = 2, max_len: int = 400) -> str:
    body = " ".join(l for l in text.splitlines() if l and not l.startswith("•"))
    parts = re.split(r"(?<=[.!?])\s+", body)
    out = " ".join(parts[:n]).strip()
    return out[:max_len]


def us_locations(p: Posting) -> list[str]:
    """Normalized locations. For US jobs listed by city alone ("SLEEPY HOLLOW", "Warren"), the state
    comes from the description ("Location: Warren, NJ") or the table of known US sites."""
    country = (p.extra.get("country") or "") if isinstance(p.extra, dict) else ""
    us = bool(re.search(r"united states", country, re.I))
    out = []
    for raw in p.locations or [p.location]:
        loc = normalize_location(raw, us)
        if us and "," not in loc and loc and not re.search(r"remote|\d+ locations?", loc, re.I):
            m = re.search(rf"\b({re.escape(loc)}),?\s+([A-Z]{{2}})\b", p.description or "", re.I)
            if m and m.group(2).upper() in _CODES:
                loc = f"{_city(raw.strip()) if raw.strip().isupper() else m.group(1)}, {m.group(2).upper()}"
        if loc and loc not in out:
            out.append(loc)
    return out


# ---- internship start window ----
_MONTHS = {m: i + 1 for i, m in enumerate(["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"])}
_MON = r"(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\b\.?"


def _m(name: str) -> str:
    """one month mention, its month captured as `name`: "late May", "Monday, June 1, 2027", "June of 2027"."""
    return (rf"(?:(?i:early|mid|late)[- ]?)?(?:(?:Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day,?\s+)?(?P<{name}>{_MON})"
            rf"(?:\s+\d{{1,2}}(?:st|nd|rd|th)?)?(?:,?\s*(?i:of\s+)?(?:20\d\d))?")


_TO = r"\s*(?:[–—-]|(?i:to|through|thru|until)\b)\s*"
# "10-12 weeks between May and August": the internship sits somewhere inside, so it can start as late as July
_WINDOW = re.compile(rf"(?i:\bbetween|\bduring(?: the months of)?)\s+{_m('a')}\s*(?:(?i:and\b)|{_TO})\s*{_m('b')}")
# "beginning in May or June", "starting May 26, 2027", "start date: June 1"
_START = re.compile(rf"(?i:\bbegin\w*|\bstart\w*|\bcommenc\w*)(?:\s+(?i:in|on|around|date:?|dates:?|of))*\s+{_m('a')}"
                    rf"(?:\s*(?:(?i:or\b)|/)\s*{_m('b')})?")
# a fixed term: "Program Dates: Monday June 1 - Friday, August 14", co-ops "from January-August, May/June-December"
_TERM = re.compile(rf"{_m('a')}(?:\s*/\s*{_m('c')})?{_TO}{_m('b')}")
_TERM_CONTEXT = re.compile(r"intern|co-?op|program|weeks|months?\b|role|term\b|take place|hours per week|position|summer|full[- ]time", re.I)
_NOT_WORK = re.compile(r"graduat|degree|enrol|semester|academic|appl(?:y|ications?) (?:by|before|deadline|window|period|clos)|"
                       r"deadline|review|r[eé]sum[eé]|interview|post(?:ed|ing)", re.I)


def _month(s: str | None) -> int | None:
    return _MONTHS.get(s[:3].lower()) if s else None


def start_window(text: str) -> tuple[int | None, int | None]:
    """The earliest and latest month (1-12) the internship can start, from what the posting says; (None, None)
    when it doesn't say. "between May and August" gives (5, 7): a 10-12 week internship inside that window starts
    by July at the latest. Graduation and application dates are ignored."""
    text = re.sub(r"\s+", " ", text or "")
    starts: list[int] = []
    ends: list[int] = []
    taken: list[tuple[int, int]] = []

    def free(m) -> bool:
        return not any(a < m.end() and m.start() < b for a, b in taken) and not _NOT_WORK.search(text[max(0, m.start() - 60):m.start()])

    for m in _WINDOW.finditer(text):
        a, b = _month(m.group("a")), _month(m.group("b"))
        if a and b and free(m):
            taken.append(m.span())
            starts.append(a)
            ends.append(max(a, b - 1) if b >= a else a)
    for m in _START.finditer(text):
        a, b = _month(m.group("a")), _month(m.group("b"))
        if a and free(m):
            taken.append(m.span())
            starts.append(a)
            ends.append(b or a)
    for m in _TERM.finditer(text):
        a, c = _month(m.group("a")), _month(m.group("c"))
        if a and free(m) and _TERM_CONTEXT.search(text[max(0, m.start() - 100):m.end() + 40]):
            taken.append(m.span())
            starts.append(a)
            ends.append(c or a)
    if not starts:
        return None, None
    return min(starts), max(ends)


def to_import_record(p: Posting) -> dict:
    """One posting in the format lib/importer.ts reads. Claude's extraction (scraper/extract.py)
    can later replace summary, responsibilities, qualifications, category, term and mode."""
    sec = extract_sections(p.description)
    start_from, start_to = start_window(p.description)
    return {
        "key": posting_key(p),
        "title": p.title,
        "company": COMPANIES.get(p.company, {}).get("id", p.company),
        "locations": us_locations(p),
        "category": guess_category(p.title, p.description),
        "deadline": p.deadline,
        "first_seen": posted_to_date(p.posted) or date.today().isoformat(),
        "term": guess_term(p.title, p.description),
        "mode": guess_mode(p),
        "pay": p.pay,
        "url": p.url,
        "req_id": p.req_id,
        "description": job_summary(p.description, p.company, p.title),
        "responsibilities": sec["resp"],
        "qualifications": sec["quals"],
        # earliest and latest month (1-12) the internship can start; null when the posting doesn't say
        "start_from": start_from,
        "start_to": start_to,
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
    ap.add_argument("--respect-robots", action="store_true",
                    help="only use routes each site's robots.txt allows (by default the script also uses "
                         "disallowed ones, today AbbVie's job search)")
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

    ignore_robots = not args.respect_robots
    if ignore_robots:
        log.info("Ignoring robots.txt (default); pass --respect-robots to follow it")
    postings, status = run(companies, args.details, args.us_only, client, workers=max(1, args.workers),
                           ignore_robots=ignore_robots)
    postings.sort(key=lambda p: (p.company, p.title))
    write_outputs(postings, args.out)
    if args.import_out:
        write_import(postings, args.import_out)
        print(f"Import file for the app -> {args.import_out}")
    print("\nSummary")
    for name, s in status.items():
        print(f"  {name:<24} {s}")
    print(f"\n{len(postings)} postings -> {args.out}.csv / {args.out}.json")
    return 0 if not any(s.startswith(("BLOCKED", "UNAVAILABLE", "error")) for s in status.values()) else 2


if __name__ == "__main__":
    sys.exit(main())
