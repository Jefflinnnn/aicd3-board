"""
Live progress of a pipeline run, sent to the app so its Admin page can draw it (the refresh Sankey).

The pipeline tells this which company it's scraping, which finished (and how many postings each found), and
how far classifying, importing and re-checking have got. A background thread sends the latest state to
POST /api/ingest/progress (same bearer token as /api/ingest) when something changed, at most every couple of
seconds, and at least every 45 seconds as a heartbeat, so the app can tell a run that's still going from one
that died. Reporting never breaks a run: if the app can't be reached, or is an older version without the
endpoint, it says so once and carries on quietly.

A run started from the Admin page already has a row in the app; it passes its id as AICD3_RUN_ID and the
pipeline updates that row (the app records how it ended). A run started anywhere else (the daily scheduled
task, a terminal) asks the app to open a row, and closes it when it finishes. If another refresh is already
running, the app says so and this run stops before scraping, so two refreshes never overlap.
"""
from __future__ import annotations

import logging
import os
import socket
import threading
import time

import requests

log = logging.getLogger("progress")

MIN_GAP = 2.0       # seconds between sends while things are changing
HEARTBEAT = 45.0    # at least this often while the run is going


class AlreadyRunning(Exception):
    pass


def _now_ms() -> int:
    return int(time.time() * 1000)


class Progress:
    def __init__(self, url: str, token: str, companies: list[str], *, trigger: str = "manual",
                 run_id: str | None = None, dry_run: bool = False, session=None, enabled: bool = True):
        self.endpoint = url.rstrip("/") + "/api/ingest/progress"
        self.token, self.trigger, self.run_id = token, trigger, run_id or None
        self.attached = bool(run_id)          # the app started this run and records how it ends
        self.http = session or requests.Session()
        self.enabled = enabled
        self.stop_requested = False           # staff pressed Stop on the Admin page
        self._lock = threading.Lock()
        self._dirty = False
        self._last_sent = 0.0
        self._thread: threading.Thread | None = None
        self._halt = threading.Event()
        self.state: dict = {
            "v": 1, "at": _now_ms(), "host": socket.gethostname(), "dryRun": dry_run,
            "step": "scrape", "classifier": "",
            "companies": [{"name": n, "state": "waiting", "found": None, "note": ""} for n in companies],
            "classify": {"done": 0, "total": 0},
            "outcome": None,      # {"publish", "review", "skip", "undergrad", "not_us"} once classified
            # live while classifying: where postings have gone so far, how many d3 hasn't answered yet, and the
            # last one it answered {"title", "company", "to"}
            "routing": None,
            "checked": None,      # {"open", "closed", "unknown"} once open postings are re-checked
        }

    # ---------------------------------------------------------------- sending
    def _post(self, event: str, extra: dict | None = None, timeout: float = 15.0) -> dict | None:
        if not self.enabled:
            return None
        with self._lock:
            self.state["at"] = _now_ms()
            body = {"event": event, "runId": self.run_id, "trigger": self.trigger, "progress": self.state, **(extra or {})}
            self._dirty = False
        self._last_sent = time.monotonic()
        try:
            r = self.http.post(self.endpoint, json=body, timeout=timeout,
                               headers={"Authorization": f"Bearer {self.token}"})
        except requests.RequestException as e:
            log.warning("progress: couldn't reach %s (%s); the Admin page won't show this run live", self.endpoint, type(e).__name__)
            return None
        if r.status_code == 404:
            self.enabled = False
            log.warning("progress: %s doesn't take progress yet (an older version of the app); the run goes on without "
                        "showing live on the Admin page", self.endpoint)
            return None
        try:
            data = r.json()
        except ValueError:
            data = {}
        if r.status_code == 409 and event == "start":
            raise AlreadyRunning(data.get("error") or "another refresh is already running")
        if r.status_code >= 400:
            log.warning("progress: the app answered HTTP %d (%s)", r.status_code, str(data.get("error", ""))[:200])
            return None
        if data.get("running") is False and event != "finish":
            if not self.stop_requested:
                log.warning("progress: this run was stopped from the Admin page; stopping after the current step")
            self.stop_requested = True
        return data

    def _loop(self) -> None:
        while not self._halt.wait(1.0):
            since = time.monotonic() - self._last_sent
            if (self._dirty and since >= MIN_GAP) or since >= HEARTBEAT:
                self._post("update")

    def _changed(self) -> None:
        self._dirty = True

    # ---------------------------------------------------------------- lifecycle
    def start(self) -> None:
        """Open (or join) the run's row in the app. Raises AlreadyRunning if another refresh is going."""
        data = self._post("start")
        if data and data.get("runId"):
            self.run_id = data["runId"]
        self._thread = threading.Thread(target=self._loop, name="progress", daemon=True)
        self._thread.start()

    def finish(self, status: str, summary: dict | None = None, log_tail: str = "") -> None:
        self._halt.set()
        with self._lock:
            self.state["step"] = "done"
        if self.attached:
            self._post("update")   # the app records how its own run ended
        else:
            self._post("finish", {"status": status, "summary": summary, "log": log_tail[-60000:]}, timeout=30.0)

    # ---------------------------------------------------------------- what the pipeline reports
    def step(self, name: str) -> None:
        with self._lock:
            self.state["step"] = name
        self._changed()

    def company(self, name: str, state: str, found: int | None = None, note: str = "") -> None:
        with self._lock:
            for c in self.state["companies"]:
                if c["name"] == name:
                    c.update(state=state, found=found if found is not None else c["found"], note=note[:200])
        self._changed()

    def classifier(self, name: str) -> None:
        with self._lock:
            self.state["classifier"] = name
        self._changed()

    def classify(self, done: int, total: int) -> None:
        with self._lock:
            self.state["classify"] = {"done": done, "total": total}
        self._changed()

    def routing(self, counts: dict, pending: int, last: dict | None = None) -> None:
        with self._lock:
            self.state["routing"] = {**{k: int(counts.get(k, 0)) for k in ("publish", "review", "skip", "undergrad", "not_us")},
                                     "pending": max(0, int(pending)), "last": last}
        self._changed()

    def outcome(self, counts: dict) -> None:
        with self._lock:
            self.state["outcome"] = {k: int(counts.get(k, 0)) for k in ("publish", "review", "skip", "undergrad", "not_us")}
        self._changed()

    def checked(self, counts: dict | None) -> None:
        with self._lock:
            self.state["checked"] = counts
        self._changed()


def from_env(url: str, token: str, companies: list[str], *, trigger: str, dry_run: bool) -> Progress:
    """The reporter for this run: joins the Admin page's run when AICD3_RUN_ID is set; AICD3_PROGRESS=off turns it off."""
    return Progress(url, token, companies, trigger=trigger, run_id=os.environ.get("AICD3_RUN_ID") or None,
                    dry_run=dry_run, enabled=os.environ.get("AICD3_PROGRESS", "").lower() != "off")
