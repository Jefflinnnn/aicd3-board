"""Offline tests for check_open.py: how each kind of answer from a career site is read."""
import json
import unittest

import check_open as co
from test_pharma_internships import FakeClient, make_resp


def posting(url, company="amgen", pid="j1"):
    return {"id": pid, "company": company, "title": "Summer Intern", "url": url, "reqId": ""}


class Urls(unittest.TestCase):
    def test_workday_detail_url(self):
        self.assertEqual(
            co.workday_detail_url("https://amgen.wd1.myworkdayjobs.com/en-US/Careers/job/US-California-Thousand-Oaks/Intern_R-1"),
            "https://amgen.wd1.myworkdayjobs.com/wday/cxs/amgen/Careers/job/US-California-Thousand-Oaks/Intern_R-1")
        self.assertEqual(co.workday_detail_url("https://lilly.wd115.myworkdayjobs.com/CMP/job/Intern_R-9"),
                         "https://lilly.wd115.myworkdayjobs.com/wday/cxs/lilly/CMP/job/Intern_R-9")
        self.assertIsNone(co.workday_detail_url("https://jobs.boehringer-ingelheim.com/job/x/123/"))

    def test_greenhouse_api_url(self):
        self.assertEqual(co.greenhouse_api_url("https://www.revmed.com/careers-list/?gh_jid=4000", "revmed"),
                         "https://boards-api.greenhouse.io/v1/boards/revolutionmedicines/jobs/4000")


class Checks(unittest.TestCase):
    def run_one(self, p, handler):
        return co.check(FakeClient(handler), p)

    def test_workday(self):
        url = "https://amgen.wd1.myworkdayjobs.com/Careers/job/X/Intern_R-1"
        self.assertEqual(self.run_one(posting(url), lambda m, u, k: make_resp(u, 404, "{}")).status, "closed")
        self.assertEqual(self.run_one(posting(url), lambda m, u, k: make_resp(u, 200, json.dumps({"jobPostingInfo": {"title": "x"}}))).status, "open")
        self.assertEqual(self.run_one(posting(url), lambda m, u, k: make_resp(u, 200, json.dumps({"jobPostingInfo": {"canApply": False}}))).status, "closed")
        self.assertEqual(self.run_one(posting(url), lambda m, u, k: make_resp(u, 503, "{}")).status, "unknown")

    def test_greenhouse(self):
        p = posting("https://www.revmed.com/careers-list/?gh_jid=4000", "revmed")
        self.assertEqual(self.run_one(p, lambda m, u, k: make_resp(u, 404, "{}")).status, "closed")
        self.assertEqual(self.run_one(p, lambda m, u, k: make_resp(u, 200, "{}")).status, "open")

    def test_other_sites(self):
        url = "https://jobs.boehringer-ingelheim.com/job/Columbus-Intern/1438182733/"
        moved = make_resp("https://jobs.boehringer-ingelheim.com/search/?q=", 200, "<html>Search jobs</html>", "text/html")
        self.assertEqual(self.run_one(posting(url, "boehringer"), lambda m, u, k: moved).status, "closed")
        gone = make_resp(url, 200, "<html><h1>Sorry, this job is no longer available.</h1></html>", "text/html")
        self.assertEqual(self.run_one(posting(url, "boehringer"), lambda m, u, k: gone).status, "closed")
        live = make_resp(url, 200, "<html><h1>Intern</h1><a>Apply now</a></html>", "text/html")
        self.assertEqual(self.run_one(posting(url, "boehringer"), lambda m, u, k: live).status, "open")
        self.assertEqual(self.run_one(posting(url, "boehringer"), lambda m, u, k: make_resp(u, 410, "", "text/html")).status, "closed")

    def test_never_closes_on_doubt(self):
        url = "https://careers.abbvie.com/en/job/intern-in-north-chicago-il-jid-2680"
        blocked = make_resp(url, 403, "<html>Access Denied</html>", "text/html")
        self.assertEqual(self.run_one(posting(url, "abbvie"), lambda m, u, k: blocked).status, "unknown")
        self.assertEqual(self.run_one(posting("https://www.amgen.com"), lambda m, u, k: make_resp(u, 404, "")).status, "unknown")

    def test_check_all_groups_by_site(self):
        ps = [posting("https://amgen.wd1.myworkdayjobs.com/Careers/job/X/A_R-1", pid="a"),
              posting("https://www.revmed.com/careers-list/?gh_jid=5", "revmed", pid="b")]
        got = co.check_all(ps, FakeClient(lambda m, u, k: make_resp(u, 404, "{}")), workers=1)
        self.assertEqual(sorted((r.id, r.status) for r in got), [("a", "closed"), ("b", "closed")])


class ManualReview(unittest.TestCase):
    def test_maintenance_page_is_unknown_not_a_crash(self):
        url = "https://amgen.wd1.myworkdayjobs.com/Careers/job/X/Intern_R-1"
        down = make_resp("https://static.community.workday.com/maintenance-page.html", 403,
                         "<html>Workday is currently unavailable.</html>", "text/html")
        r = co.check(FakeClient(lambda m, u, k: down), posting(url))
        self.assertEqual(r.status, "unknown")

    def run_main(self, postings, handler, *flags):
        calls = []

        def fake_app(method, path, url, token, body=None):
            calls.append((path, body))
            if path == "/api/ingest/open":
                return {"postings": postings}
            return {"closed": len(body["ids"])} if path.endswith("close") else {"flagged": len(body["ids"])}
        import os, tempfile
        orig_app, orig_client = co.app_call, co.pi.PoliteClient
        co.app_call = fake_app
        co.pi.PoliteClient = lambda *a, **k: FakeClient(handler)
        os.environ["AICD3_INGEST_TOKEN"] = "t"
        try:
            with tempfile.TemporaryDirectory() as d:
                co.main(["--workers", "1", "--report", d + "/r.json", *flags])
        finally:
            co.app_call, co.pi.PoliteClient = orig_app, orig_client
        return {path: body for path, body in calls if path != "/api/ingest/open"}

    def test_apply_closes_the_closed_and_flags_the_unconfirmed(self):
        ps = [posting("https://jobs.boehringer-ingelheim.com/job/A/1438182733/", "boehringer", "gone"),
              posting("https://jobs.boehringer-ingelheim.com/job/B/1438182734/", "boehringer", "err"),
              posting("https://jobs.boehringer-ingelheim.com/job/C/1438182735/", "boehringer", "live")]

        def handler(m, u, k):
            if "1438182733" in u:
                return make_resp(u, 404, "", "text/html")
            if "1438182734" in u:
                return make_resp(u, 500, "", "text/html")
            return make_resp(u, 200, "<html>Apply now</html>", "text/html")
        sent = self.run_main(ps, handler, "--apply")
        self.assertEqual(sent["/api/ingest/close"]["ids"], ["gone"])
        self.assertEqual(sent["/api/ingest/flag"]["ids"], ["err"])
        self.assertIn("500", sent["/api/ingest/flag"]["reasons"]["err"])
        self.assertEqual(self.run_main(ps, handler), {})  # report only without --apply

    def test_a_whole_site_down_is_reported_not_flagged(self):
        ps = [posting(f"https://amgen.wd1.myworkdayjobs.com/Careers/job/X/I_R-{i}", pid=f"a{i}") for i in range(3)]
        ps.append(posting("https://jobs.boehringer-ingelheim.com/job/B/1438182734/", "boehringer", "b"))

        def handler(m, u, k):
            return make_resp(u, 503, "{}") if "workday" in u else make_resp(u, 500, "", "text/html")
        sent = self.run_main(ps, handler, "--apply")
        self.assertEqual(sent["/api/ingest/flag"]["ids"], ["b"])  # single posting on its site: still flagged
        sent = self.run_main(ps, handler, "--apply", "--flag-site-outages")
        self.assertEqual(sorted(sent["/api/ingest/flag"]["ids"]), ["a0", "a1", "a2", "b"])


class Ashby(unittest.TestCase):
    def test_board_membership_decides(self):
        co._ashby_boards.clear()
        board = json.dumps({"jobs": [{"id": "0bff19c6-e165-4be7-a32a-6beeffb51ffa"}]})
        client = FakeClient(lambda m, u, k: make_resp(u, 200, board))
        live = posting("https://jobs.ashbyhq.com/insitro/0bff19c6-e165-4be7-a32a-6beeffb51ffa", "insitro")
        gone = posting("https://jobs.ashbyhq.com/insitro/11111111-2222-3333-4444-555555555555", "insitro", "j2")
        self.assertEqual((co.check(client, live).status, co.check(client, gone).status), ("open", "closed"))
        co._ashby_boards.clear()
        self.assertEqual(co.check(FakeClient(lambda m, u, k: make_resp(u, 500, "{}")), live).status, "unknown")
        co._ashby_boards.clear()


class Locations(unittest.TestCase):
    def test_normalize(self):
        import pharma_internships as pi
        for raw, want in {"US - New Jersey - Rahway": "Rahway, NJ", "USA - California - South San Francisco": "South San Francisco, CA",
                          "Redwood City, California, United States": "Redwood City, CA", "Columbus, United States, Ohio": "Columbus, OH",
                          "North Chicago IL": "North Chicago, IL", "United States - Remote": "Remote (US)",
                          "Germany - Ingelheim": "Ingelheim, Germany", "3 Locations": "3 Locations"}.items():
            self.assertEqual(pi.normalize_location(raw), want, raw)


if __name__ == "__main__":
    unittest.main()


class LeverAndEightfold(unittest.TestCase):
    LEVER = "https://jobs.lever.co/tahoebio-ai/8fe3e406-050f-498c-8f75-3cb780dec092"
    EIGHTFOLD = "https://talent.bayer.com/careers/job/562949978740495"

    def test_urls(self):
        self.assertEqual(co.lever_api_url(self.LEVER),
                         "https://api.lever.co/v0/postings/tahoebio-ai/8fe3e406-050f-498c-8f75-3cb780dec092")
        self.assertEqual(co.eightfold_api_url(self.EIGHTFOLD),
                         "https://talent.bayer.com/api/apply/v2/jobs/562949978740495?domain=bayer.com")
        self.assertIsNone(co.eightfold_api_url("https://example.com/careers/job/1"))   # not a configured Eightfold site

    def test_checks(self):
        run = lambda url, status, body="{}": co.check(FakeClient(lambda m, u, k: make_resp(u, status, body)), posting(url, "x")).status
        self.assertEqual((run(self.LEVER, 200), run(self.LEVER, 404), run(self.LEVER, 503)), ("open", "closed", "unknown"))
        self.assertEqual(run(self.EIGHTFOLD, 200, json.dumps({"id": 562949978740495})), "open")
        self.assertEqual((run(self.EIGHTFOLD, 404), run(self.EIGHTFOLD, 200, "{}"), run(self.EIGHTFOLD, 500)), ("closed", "unknown", "unknown"))
