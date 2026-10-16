"""
The candidate profile that tailors the full-time roles search (pipeline.py --kind job) to one person's background.

It lives only on the computer that runs the search, never in the repository: scraper/private/roles_profile.json
(git-ignored), or the file named by ROLES_PROFILE. Without it, the search uses the general AICD3-graduate fit test.
Copy scraper/roles_profile.example.json to start one. Fields:

  summary      a few sentences on the candidate's skills and experience, written for d3's fit question. Leave out
               names, contact details, links and anything else that identifies the person: d3 runs on this computer,
               but answers are cached and runs are logged, so keep it to skills.
  terms        what to type into each careers site's search box (replaces the default list)
  title_words  extra words or phrases that make a job title worth a look, beyond the built-in computational titles
               (for example "applied scientist", "admet")

The run log only says that a profile was used and how many terms it has; the summary itself is never printed or sent
to the job board.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
from dataclasses import dataclass, field

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_PATH = os.path.join(ROOT, "scraper", "private", "roles_profile.json")
MAX_SUMMARY = 2000
MAX_TERMS = 30
# things a summary shouldn't carry (it's only ever read by d3 on this computer, but it's cached and could be shared)
IDENTIFYING = re.compile(r"[\w.+-]+@[\w-]+\.[\w.]+|https?://|www\.|linkedin|github\.com|\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}", re.I)


@dataclass
class Profile:
    summary: str
    terms: list = field(default_factory=list)
    title_words: list = field(default_factory=list)
    path: str = ""

    @property
    def version(self) -> str:
        """Changes whenever the profile does, so d3's cached answers from an older profile aren't reused."""
        return hashlib.sha256(json.dumps([self.summary, self.terms, self.title_words]).encode()).hexdigest()[:10]


def path() -> str:
    return os.environ.get("ROLES_PROFILE") or DEFAULT_PATH


def load(file: str | None = None) -> Profile | None:
    """The profile, or None when there isn't one. Raises ValueError for a file that's there but unusable."""
    file = file or path()
    if not os.path.exists(file):
        return None
    with open(file, encoding="utf-8-sig") as f:
        try:
            data = json.load(f)
        except ValueError as e:
            raise ValueError(f"{file} isn't valid JSON: {e}") from None
    summary = " ".join(str(data.get("summary") or "").split())
    if not summary:
        raise ValueError(f"{file} has no summary")
    if len(summary) > MAX_SUMMARY:
        raise ValueError(f"{file}: keep the summary under {MAX_SUMMARY} characters (it's {len(summary)})")
    if IDENTIFYING.search(summary):
        raise ValueError(f"{file}: the summary looks like it has contact details or links; keep it to skills and experience")
    clean = lambda xs: [" ".join(str(x).split()).lower() for x in (xs or []) if str(x).strip()][:MAX_TERMS]
    return Profile(summary, clean(data.get("terms")), clean(data.get("title_words")), file)
