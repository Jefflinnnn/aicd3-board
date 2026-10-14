"""Offline tests for live run progress (scraper/progress.py) and how the pipeline reports it."""
import json
import os
import tempfile
import unittest
from unittest import mock

import classify as c
import pharma_internships as pi
import pipeline
import progress as live

os.environ.setdefault("AICD3_LOG_FILE", os.path.join(tempfile.mkdtemp(prefix="aicd3-test-logs-"), "pipeline-test.log"))


class FakeApp:
    """Stands in for the app's /api/ingest/progress: records every call, answers like the real route."""

    def __init__(self, start_status=200, running=True, missing=False):
        self.calls, self.start_status, self.running, self.missing = [], start_status, running, missing

    def post(self, url, json=None, timeout=None, headers=None):
        self.calls.append({"url": url, "body": json, "auth": headers["Authorization"]})
        if self.missing:
            return mock.Mock(status_code=404, json=lambda: {})
        if json["event"] == "start" and self.start_status == 409:
            return mock.Mock(status_code=409, json=lambda: {"error": "A refresh is already running (started 4:02 PM)"})
        return mock.Mock(status_code=200, json=lambda: {"ok": True, "runId": json.get("runId") or "run1", "running": self.running})

    def events(self):
        return [x["body"]["event"] for x in self.calls]


class Reporter(unittest.TestCase):
    def make(self, app, **kw):
        return live.Progress("http://app.test/", "tok", ["Gilead Sciences", "Amgen"], session=app, **kw)

    def test_start_update_finish(self):
        app = FakeApp()
        p = self.make(app, trigger="schedule")
        p.start()
        self.assertEqual(p.run_id, "run1")
        p.company("Amgen", "running")
        p.company("Amgen", "done", 7, "via careers site")
        p._post("update")
        p.finish("succeeded", {"scraped": 7}, "log line\n")
        self.assertEqual(app.events(), ["start", "update", "finish"])
        first, last = app.calls[0], app.calls[-1]
        self.assertEqual((first["url"], first["auth"], first["body"]["trigger"]), ("http://app.test/api/ingest/progress", "Bearer tok", "schedule"))
        amgen = next(x for x in last["body"]["progress"]["companies"] if x["name"] == "Amgen")
        self.assertEqual((amgen["state"], amgen["found"]), ("done", 7))
        self.assertEqual((last["body"]["status"], last["body"]["summary"], last["body"]["runId"]), ("succeeded", {"scraped": 7}, "run1"))
        self.assertEqual(last["body"]["progress"]["step"], "done")

    def test_another_refresh_running_refuses_to_start(self):
        with self.assertRaises(live.AlreadyRunning) as e:
            self.make(FakeApp(start_status=409)).start()
        self.assertIn("already running", str(e.exception))

    def test_older_app_without_the_endpoint_is_ignored(self):
        app = FakeApp(missing=True)
        p = self.make(app)
        with self.assertLogs("progress", "WARNING"):
            p.start()
        p._post("update")
        p.finish("succeeded")
        self.assertEqual(len(app.calls), 1)   # stopped trying after the 404

    def test_stop_from_the_admin_page(self):
        app = FakeApp(running=False)
        p = self.make(app, run_id="abc")
        with self.assertLogs("progress", "WARNING"):
            p.start()
        self.assertTrue(p.stop_requested)

    def test_runs_started_by_the_app_only_update(self):
        app = FakeApp()
        p = self.make(app, run_id="abc")
        p.start()
        p.finish("succeeded", {"scraped": 1})
        self.assertEqual(app.events(), ["start", "update"])   # the app records how its own run ended
        self.assertTrue(all(x["body"]["runId"] == "abc" for x in app.calls))

    def test_unreachable_app_never_breaks_the_run(self):
        import requests
        s = mock.Mock(post=mock.Mock(side_effect=requests.ConnectionError("refused")))
        p = live.Progress("http://app.test", "tok", ["Amgen"], session=s)
        with self.assertLogs("progress", "WARNING"):
            p.start()
        p.finish("failed")


class ScrapeCallback(unittest.TestCase):
    def test_each_company_reports_running_then_done_or_failed(self):
        heard = []
        ok = lambda client, name, cfg, details: [pi.Posting(company=name, title="Data Science Intern", location="Boston, MA",
                                                            url="https://x/1", extra={"country": "United States"})]
        def boom(client, name, cfg, details):
            raise RuntimeError("site changed")
        companies = {"Good Co": {"id": "good", "platform": "fake_ok"}, "Bad Co": {"id": "bad", "platform": "fake_boom"}}
        with mock.patch.dict(pi.COMPANIES, companies), mock.patch.dict(pi.SCRAPERS, {"fake_ok": ok, "fake_boom": boom}), \
                self.assertLogs("pharma_internships", "ERROR"):
            found, status = pi.run(["Good Co", "Bad Co"], details=True, us_only=True, client=pi.PoliteClient(),
                                   on_company=lambda *a: heard.append(a))
        self.assertEqual(len(found), 1)
        self.assertEqual([h[:3] for h in heard], [("Good Co", "running", None), ("Good Co", "done", 1),
                                                  ("Bad Co", "running", None), ("Bad Co", "failed", 0)])
        self.assertIn("site changed", heard[-1][3])

    def test_a_broken_callback_doesnt_stop_scraping(self):
        def bad(*a):
            raise ValueError("oops")
        with mock.patch.dict(pi.COMPANIES, {"Good Co": {"id": "good", "platform": "fake_ok"}}), \
                mock.patch.dict(pi.SCRAPERS, {"fake_ok": lambda *a: []}):
            found, status = pi.run(["Good Co"], details=True, us_only=True, client=pi.PoliteClient(), on_company=bad)
        self.assertTrue(status["Good Co"].startswith("ok"))


class PipelineReports(unittest.TestCase):
    def postings(self):
        mk = lambda t, d: pi.Posting(company="Gilead Sciences", title=t, location="Foster City, CA",
                                     url="https://x/" + t.replace(" ", "_"), description=d, extra={"country": "United States of America"})
        return [mk("Intern - Pharmacometrics", "Build population PK/PD models in NONMEM and automate simulation workflows in Python."),
                mk("Intern - Process Chemistry", "Bench-scale reactions and purification.")]

    def run_pipeline(self, app, extra=()):
        def fake_scrape(names, details, us_only, client, workers, ignore_robots, on_company):
            on_company("Gilead Sciences", "running", None, "")
            on_company("Gilead Sciences", "done", 2, "")
            return self.postings(), {"Gilead Sciences": "ok (2)"}
        ingested = mock.Mock(status_code=200, json=lambda: {"added": 1, "staged": 0, "updated": 0, "closed": 0,
                                                              "unchanged": 0, "rejected": 0, "errors": []})
        env = {k: v for k, v in os.environ.items() if k not in ("AICD3_PROGRESS", "AICD3_RUN_ID")}
        with tempfile.TemporaryDirectory() as d, mock.patch.dict(os.environ, {**env, "AICD3_INGEST_TOKEN": "t0k"}, clear=True), \
                mock.patch.object(pi, "run", side_effect=fake_scrape), \
                mock.patch.object(pipeline.requests, "post", return_value=ingested) as post, \
                mock.patch.object(pipeline.live, "from_env", side_effect=lambda url, token, names, trigger, dry_run:
                                  live.Progress(url, token, names, trigger=trigger, dry_run=dry_run, session=app)), \
                mock.patch.object(c, "D3", side_effect=ConnectionError("no d3 here")):
            code = pipeline.main(["--companies", "Gilead", "--classifier", "rules", "--no-check", "--out", d,
                                  "--url", "http://localhost:3000", "--trigger", "schedule", *extra])
        return code, post

    def test_a_scheduled_run_opens_reports_and_closes_its_row(self):
        app = FakeApp()
        code, _ = self.run_pipeline(app)
        self.assertEqual(code, 0)
        self.assertEqual(app.events()[0], "start")
        self.assertEqual(app.events()[-1], "finish")
        end = app.calls[-1]["body"]
        self.assertEqual((end["status"], end["trigger"]), ("succeeded", "schedule"))
        self.assertEqual(end["summary"]["companies"], {"Gilead Sciences": "ok (2)"})
        prog = end["progress"]
        self.assertEqual(prog["companies"][0]["state"], "done")
        self.assertEqual(prog["classify"], {"done": 2, "total": 2})
        self.assertEqual(prog["outcome"]["publish"] + prog["outcome"]["skip"], 2)
        self.assertIn("[run] finished", end["log"])

    def test_never_runs_beside_another_refresh(self):
        code, post = self.run_pipeline(FakeApp(start_status=409))
        self.assertEqual(code, 3)
        post.assert_not_called()   # nothing scraped, nothing imported

    def test_stopped_from_the_admin_page_before_import(self):
        app = FakeApp(running=False)
        code, post = self.run_pipeline(app)
        self.assertEqual(code, pipeline.STOPPED)
        post.assert_not_called()   # stopped before anything reached the database
        self.assertEqual(app.calls[-1]["body"]["status"], "cancelled")


if __name__ == "__main__":
    unittest.main()
