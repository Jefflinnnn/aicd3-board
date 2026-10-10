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
