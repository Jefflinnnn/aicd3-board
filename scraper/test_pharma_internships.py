"""Offline tests: fixtures mirror real responses captured from the sites in Oct 2026."""
import json
import unittest

import requests

import pharma_internships as pi


def make_resp(url, status=200, body="", ctype="application/json", method="GET"):
    r = requests.Response()
    r.status_code = status
    r.url = url
    r._content = body.encode() if isinstance(body, str) else body
    r.headers["Content-Type"] = ctype
    r.request = requests.Request(method, url).prepare()
    return r


class FakeClient(pi.PoliteClient):
    """Routes requests to handler(method, url, kwargs) -> Response; no network, no sleeping."""

    def __init__(self, handler):
        super().__init__(min_delay=0, max_delay=0)
        self.handler, self.calls = handler, []

    def _pace(self, url):
        pass

    def request(self, method, url, **kw):
        self.calls.append((method, url, kw))
        resp = self.handler(method, url, kw)
        self._check_block(resp)
        return resp

    def probe(self, url, **kw):
        return self.request("GET", url, **kw)


def wd_posting(title, path, loc="US - New York - New York City"):
    return {"title": title, "externalPath": path, "locationsText": loc,
            "postedOn": "Posted 3 Days Ago", "bulletFields": [path.rsplit("_", 1)[-1]]}


class TitleFilter(unittest.TestCase):
    def test_positive(self):
        for t in ["Undergrad Intern – Finance (Summer 2027)", "Spring Co-Op 2027, Process Development",
                  "2027 Packaging Co Op Jan June", "Finance & Controlling Internship",
                  "Praktikum / Werkstudent (all genders)", "MBA Intern – Commercial Leadership Program",
                  "Lilly Research Laboratories TDA - 2027 Summer Undergraduate Internship",
                  "Internship_核酸分析高感度分析法の構築", "Alternant(e) Technicien Contrôle Qualité"]:
            self.assertTrue(pi.is_internship(t), t)

    def test_negative(self):
        for t in ["International Mobility Expert", "Senior Internal Investigator",
                  "Manager / Consultant Internal Consulting", "Director, Internal Audit",
                  "Associate Director, International Marketing", "Clinical Trial Manager"]:
            self.assertFalse(pi.is_internship(t), t)


class BlockDetection(unittest.TestCase):
    def test_403(self):
        with self.assertRaises(pi.BlockedError):
            pi.PoliteClient._check_block(make_resp("https://x.test/a", 403, "<html>Access Denied</html>", "text/html"))

    def test_cloudflare_challenge_200(self):
        body = '<html><script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page"></script></html>'
        with self.assertRaises(pi.BlockedError):
            pi.PoliteClient._check_block(make_resp("https://x.test/a", 200, body, "text/html"))

    def test_normal_page_passes(self):
        pi.PoliteClient._check_block(make_resp("https://x.test/a", 200, "<html><h1>Jobs</h1></html>", "text/html"))
        pi.PoliteClient._check_block(make_resp("https://x.test/a", 200, '{"jobs": []}'))


class Workday(unittest.TestCase):
    def test_paginates_filters_dedupes(self):
        pages = {
            0: {"total": 45, "jobPostings": [wd_posting("Undergrad Intern – Finance (Summer 2027)", "/job/A_R-1"),
                                             wd_posting("International Tax Manager", "/job/B_R-2")]},
            20: {"total": 0, "jobPostings": [wd_posting("Grad Intern – Data Scientist", "/job/C_R-3")]},
            40: {"total": 0, "jobPostings": [wd_posting("Spring Co-Op 2027, Biologics MSAT", "/job/D_R-4")]},
        }

        def handler(method, url, kw):
            if method == "GET":
                return make_resp(url, 200, "<html>board</html>", "text/html")
            body = kw["json"]
            self.assertLessEqual(body["limit"], 20)
            return make_resp(url, 200, json.dumps(pages.get(body["offset"], {"total": 0, "jobPostings": []})),
                             method="POST")

        client = FakeClient(handler)
        cfg = {"boards": [("amgen", "wd1", "Careers")]}
        got = pi.scrape_workday(client, "Amgen", cfg, details=False)
        self.assertEqual(sorted(p.title for p in got),
                         ["Grad Intern – Data Scientist", "Spring Co-Op 2027, Biologics MSAT",
                          "Undergrad Intern – Finance (Summer 2027)"])
        self.assertTrue(all(p.url.startswith("https://amgen.wd1.myworkdayjobs.com/Careers/job/") for p in got))
        posts = [c for c in client.calls if c[0] == "POST"]
        self.assertEqual(len(posts), 3 * len(pi.WORKDAY_TERMS))  # stops at total=45 for each term
        self.assertEqual(posts[0][1], "https://amgen.wd1.myworkdayjobs.com/wday/cxs/amgen/Careers/jobs")

    def test_host_migration_fallback(self):
        def handler(method, url, kw):
            if method == "GET":
                return make_resp(url, 500 if ".wd5." in url else 200, "<html></html>", "text/html")
            return make_resp(url, 200, json.dumps({"total": 1, "jobPostings": [
                wd_posting("Intern", "/job/Intern_R-105247", "Singapore")]}), method="POST")

        client = FakeClient(handler)
        got = pi.scrape_workday(client, "Eli Lilly",
                                {"boards": [("lilly", "wd5", "CMP")], "alt_hosts": ["wd115"]}, False)
        self.assertEqual(got[0].url, "https://lilly.wd115.myworkdayjobs.com/CMP/job/Intern_R-105247")

    def test_blocked_api_falls_back_to_sitemap(self):
        sitemap = """<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <url><loc>https://pfizer.wd1.myworkdayjobs.com/PfizerCareers/job/United-States---New-York---New-York-City/VP--Head-of-R-D-Clinical-Creation-Center_4964768-2</loc></url>
        <url><loc>https://pfizer.wd1.myworkdayjobs.com/PfizerCareers/job/United-States---Connecticut---Groton/Summer-2027-Intern--Medicinal-Chemistry_4970001</loc></url>
        <url><loc>https://pfizer.wd1.myworkdayjobs.com/PfizerCareers/job/Digital-Intern_4970002-1</loc></url>
        </urlset>"""

        def handler(method, url, kw):
            if method == "POST":
                return make_resp(url, 403, "<html>Access Denied</html>", "text/html", "POST")
            if url.endswith("siteMap.xml"):
                return make_resp(url, 200, sitemap, "application/xml")
            return make_resp(url, 200, "<html></html>", "text/html")

        got = pi.scrape_workday(FakeClient(handler), "Pfizer",
                                {"boards": [("pfizer", "wd1", "PfizerCareers")]}, False)
        by_title = {p.title: p for p in got}
        self.assertEqual(set(by_title), {"Summer 2027 Intern, Medicinal Chemistry", "Digital Intern"})
        p = by_title["Summer 2027 Intern, Medicinal Chemistry"]
        self.assertEqual((p.location, p.req_id), ("United States - Connecticut - Groton", "4970001"))
        self.assertEqual(by_title["Digital Intern"].location, "")

    def test_detail_enrichment(self):
        detail = {"jobPostingInfo": {"title": "Undergrad Intern – Finance (Summer 2027)",
                                     "location": "United States - Remote", "jobReqId": "R-254668",
                                     "startDate": "2026-09-01", "timeType": "Full time",
                                     "remoteType": "Remote",
                                     "country": {"descriptor": "United States of America"}}}

        def handler(method, url, kw):
            if method == "POST":
                return make_resp(url, 200, json.dumps({"total": 1, "jobPostings": [
                    wd_posting("Undergrad Intern – Finance (Summer 2027)",
                               "/job/United-States---Remote/Undergrad-Intern---Finance--Summer-2027-_R-254668")]}),
                                 method="POST")
            if "/wday/cxs/" in url:
                return make_resp(url, 200, json.dumps(detail))
            return make_resp(url, 200, "<html></html>", "text/html")

        got = pi.scrape_workday(FakeClient(handler), "Amgen", {"boards": [("amgen", "wd1", "Careers")]}, True)
        self.assertEqual(got[0].req_id, "R-254668")
        self.assertEqual(got[0].extra["country"], "United States of America")


class Greenhouse(unittest.TestCase):
    def test_filters(self):
        body = {"jobs": [
            {"absolute_url": "https://www.revmed.com/careers-list/?gh_jid=1", "id": 1,
             "location": {"name": "Redwood City, California, United States"},
             "requisition_id": "P3051", "title": "Application Administrator II",
             "first_published": "2026-08-11T21:13:08-04:00"},
            {"absolute_url": "https://www.revmed.com/careers-list/?gh_jid=2", "id": 2,
             "location": {"name": "Redwood City, California, United States"},
             "requisition_id": "P4000", "title": "Summer Intern, Medicinal Chemistry",
             "first_published": "2026-10-01T10:00:00-04:00"}]}
        client = FakeClient(lambda m, u, k: make_resp(u, 200, json.dumps(body)))
        got = pi.scrape_greenhouse(client, "Revolution Medicines", {"token": "revolutionmedicines"}, False)
        self.assertEqual([(p.title, p.req_id, p.posted) for p in got],
                         [("Summer Intern, Medicinal Chemistry", "P4000", "2026-10-01")])
        self.assertIn("boards-api.greenhouse.io/v1/boards/revolutionmedicines/jobs", client.calls[0][1])


SF_HTML_TILES = """<html><body>
<div class="pagination-label">Showing 1 to 25 of 26 Jobs</div>
<ul id="job-tile-list">
 <li class="job-tile"><div class="tile-title"><a class="jobTitle-link"
     href="/job/Wroc%C5%82aw-International-Mobility-Expert-Pola/1444650133/">International Mobility Expert</a></div>
   <div id="job-1-desktop-section-location-value" class="section-value location">Location Wrocław, Poland, Dolnoslaskie</div></li>
 <li class="job-tile"><div class="tile-title"><a class="jobTitle-link"
     href="/job/Columbus-Intern-Supply-Chain-Management-Unit/1438182733/">Intern - Supply Chain Management</a>
     <a class="jobTitle-link" href="/job/Columbus-Intern-Supply-Chain-Management-Unit/1438182733/">Intern - Supply Chain Management</a></div>
   <div class="section-value location">Location Columbus, United States, Ohio</div></li>
</ul></body></html>"""

SF_HTML_TABLE = """<html><body><span class="paginationLabel">Results <b>26 – 26</b> of <b>26</b></span>
<table id="searchresults"><tr class="data-row">
<td class="colTitle"><span class="jobTitle hidden-phone"><a href="/job/Ingelheim-Praktikum-Biotech-Germ/1444000001/" class="jobTitle-link">Praktikum Biotech (m/w/d)</a></span></td>
<td class="colLocation hidden-phone"><span class="jobLocation">Ingelheim, DE</span></td>
<td class="colDate hidden-phone"><span class="jobDate">Oct 2, 2026</span></td></tr></table></body></html>"""


class SuccessFactors(unittest.TestCase):
    def test_parse_tile_layout(self):
        rows, total = pi.parse_successfactors(SF_HTML_TILES, "https://jobs.boehringer-ingelheim.com")
        self.assertEqual(total, 26)
        self.assertEqual(len(rows), 2)  # duplicate link collapsed
        self.assertEqual(rows[1]["location"], "Columbus, United States, Ohio")
        self.assertEqual(rows[1]["req_id"], "1438182733")

    def test_parse_table_layout(self):
        rows, total = pi.parse_successfactors(SF_HTML_TABLE, "https://jobs.boehringer-ingelheim.com")
        self.assertEqual(total, 26)
        self.assertEqual(rows[0]["location"], "Ingelheim, DE")
        self.assertEqual(rows[0]["posted"], "Oct 2, 2026")

    def test_scrape_paginates(self):
        def handler(method, url, kw):
            return make_resp(url, 200, SF_HTML_TILES if "startrow=0" in url else SF_HTML_TABLE, "text/html")

        client = FakeClient(handler)
        cfg = {"base": "https://jobs.boehringer-ingelheim.com", "terms": ["intern"]}
        got = pi.scrape_successfactors(client, "Boehringer Ingelheim", cfg, False)
        self.assertEqual(sorted(p.title for p in got),
                         ["Intern - Supply Chain Management", "Praktikum Biotech (m/w/d)"])
        self.assertEqual(len(client.calls), 2)
        self.assertTrue(all("/services/" not in c[1] for c in client.calls))  # robots.txt


class AbbVie(unittest.TestCase):
    def test_sitemap_index(self):
        index = """<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
          <sitemap><loc>https://careers.abbvie.com/en/vacanciessitemap.xml</loc></sitemap>
          <sitemap><loc>https://careers.abbvie.com/en/contentsitemap.xml</loc></sitemap></sitemapindex>"""
        vac = """<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
          <url><loc>https://careers.abbvie.com/en/job/veteran-skillbridge-program-intern-in-north-chicago-il-jid-2680</loc></url>
          <url><loc>https://careers.abbvie.com/en/job/director-clinical-pharmacology-in-north-chicago-il-jid-19320</loc></url>
          <url><loc>https://careers.abbvie.com/en/job/2027-packaging-co-op-jan-june-in-north-chicago-il-jid-30760</loc></url>
          <url><loc>https://careers.abbvie.com/en/job/werkstudent-all-genders-im-bereich-procurement-in-ludwigshafen-rp-jid-30480</loc></url>
          <url><loc>https://careers.abbvie.com/en/job/2027-business-technology-solutions-intern-data-and-software-engineering-undergraduate-in-north-chicago-il-jid-31287</loc></url>
          <url><loc>https://careers.abbvie.com/en/job/senior-auditor-compliance-internal-audit-in-north-chicago-il-jid-25053</loc></url>
        </urlset>"""

        def handler(method, url, kw):
            self.assertNotIn("/jobs?", url)  # disallowed by robots.txt
            return make_resp(url, 200, index if url.endswith("/sitemap.xml") else vac, "text/xml")

        client = FakeClient(handler)
        got = pi.scrape_abbvie_sitemap(client, "AbbVie", {"sitemap": "https://careers.abbvie.com/sitemap.xml"}, False)
        titles = {p.title: p for p in got}
        self.assertEqual(len(got), 4)
        self.assertIn("Veteran Skillbridge Program Intern", titles)
        self.assertEqual(titles["Veteran Skillbridge Program Intern"].location, "North Chicago IL")
        self.assertEqual(titles["Veteran Skillbridge Program Intern"].req_id, "jid-2680")
        self.assertIn("2027 Packaging Co-op Jan June", titles)
        self.assertFalse(any("contentsitemap" in c[1] for c in client.calls))


class EndToEnd(unittest.TestCase):
    def test_run_reports_blocked_and_continues(self):
        def handler(method, url, kw):
            if "greenhouse" in url:
                return make_resp(url, 200, json.dumps({"jobs": [{"title": "Summer Intern", "id": 9,
                                                                 "absolute_url": "https://x/9",
                                                                 "location": {"name": "Remote (United States)"}}]}))
            return make_resp(url, 403, "<html>Access Denied</html>", "text/html", method)

        postings, status = pi.run(["Pfizer", "Revolution Medicines"], False, True, FakeClient(handler))
        self.assertTrue(status["Pfizer"].startswith("BLOCKED"))
        self.assertEqual(status["Revolution Medicines"], "ok (1)")
        self.assertEqual(postings[0].title, "Summer Intern")

    def test_us_filter(self):
        for loc in ["US - California - Thousand Oaks", "United States - Remote", "North Chicago, IL",
                    "Remote (United States)", "USA - Massachusetts - Lexington"]:
            self.assertTrue(pi.US_RE.search(loc), loc)
        for loc in ["Wrocław, Poland, Dolnoslaskie", "Singapore", "Basel, Switzerland"]:
            self.assertFalse(pi.US_RE.search(loc), loc)


class Details(unittest.TestCase):
    DESC = ("<p><b>Program Overview</b></p><p>Join Amgen's summer 2027 internship. You will work on real projects.</p>"
            "<p><b>What You Will Do</b></p><ul><li>Build data pipelines</li><li>Present results to leadership</li></ul>"
            "<p><b>Program Eligibility Requirements:</b></p><ul><li>Enrolled in a BS program</li></ul>"
            "<p>The base pay range for this opportunity is $28.87 per hour.</p>")

    def test_html_to_text_and_sections(self):
        text = pi.html_to_text(self.DESC)
        self.assertIn("• Build data pipelines", text)
        sec = pi.extract_sections(text)
        self.assertEqual(sec["resp"], ["Build data pipelines", "Present results to leadership"])
        self.assertEqual(sec["quals"], ["Enrolled in a BS program"])

    def test_pay(self):
        self.assertEqual(pi.extract_pay("base pay range is $28.87 per hour."), "$28.87 per hour")
        self.assertEqual(pi.extract_pay("Pay: $45 - $55/hr plus housing"), "$45 - $55/hr")
        self.assertEqual(pi.extract_pay("salary range of $60,000 to $75,000 USD per year"), "$60,000 to $75,000 USD per year")
        self.assertEqual(pi.extract_pay("no pay listed, see $1 coffee"), "")

    def test_posted(self):
        from datetime import date
        d = date(2026, 10, 8)
        self.assertEqual(pi.posted_to_date("Posted Today", d), "2026-10-08")
        self.assertEqual(pi.posted_to_date("Posted 3 Days Ago", d), "2026-10-05")
        self.assertEqual(pi.posted_to_date("Posted 30+ Days Ago", d), "2026-09-08")
        self.assertEqual(pi.posted_to_date("2026-09-01T00:00:00", d), "2026-09-01")

    def test_stage_wording(self):
        self.assertFalse(pi.is_internship("Director, Late-Stage Oncology"))
        self.assertTrue(pi.is_internship("Stage 6 mois - Data Science (F/H)"))
        self.assertTrue(pi.is_internship("Pflichtpraktikant (m/w/d) Qualitätskontrolle"))

    def test_workday_details_and_student_board(self):
        detail = {"jobPostingInfo": {"title": "Research Associate", "location": "US - Indianapolis",
                                     "additionalLocations": ["US - Boston"], "jobReqId": "R-1",
                                     "startDate": "2026-10-01", "remoteType": "Hybrid",
                                     "jobDescription": self.DESC}}

        def handler(method, url, kw):
            if method == "POST":
                self.assertEqual(kw["json"]["searchText"], "")   # student board: list everything
                return make_resp(url, 200, json.dumps({"total": 1, "jobPostings": [
                    wd_posting("Research Associate", "/job/x/Research-Associate_R-1")]}), method="POST")
            if "/wday/cxs/" in url:
                return make_resp(url, 200, json.dumps(detail))
            return make_resp(url, 200, "<html></html>", "text/html")

        got = pi.scrape_workday(FakeClient(handler), "Eli Lilly",
                                {"boards": [("lilly", "wd115", "CMP", {"all": True})]}, True)
        p = got[0]
        self.assertEqual(p.title, "Research Associate")       # kept although the title lacks "intern"
        self.assertEqual(p.locations, ["US - Indianapolis", "US - Boston"])
        self.assertEqual(p.pay, "$28.87 per hour")
        self.assertEqual(p.posted, "2026-10-01")
        rec = pi.to_import_record(p)
        self.assertEqual(rec["company"], "lilly")
        self.assertEqual(rec["mode"], "Hybrid")
        self.assertEqual(rec["first_seen"], "2026-10-01")
        self.assertEqual(rec["responsibilities"], ["Build data pipelines", "Present results to leadership"])
        self.assertIn("summer 2027", rec["description"].lower())

    def test_jsonld_page(self):
        page = """<html><head><script type="application/ld+json">{"@context":"https://schema.org","@type":"JobPosting",
          "title":"Intern","datePosted":"2026-09-30","validThrough":"2026-11-15T00:00:00",
          "description":"&lt;p&gt;Great internship.&lt;/p&gt;",
          "baseSalary":{"@type":"MonetaryAmount","currency":"USD","value":{"@type":"QuantitativeValue","minValue":30,"maxValue":40,"unitText":"HOUR"}}}
          </script></head><body><h1>Intern</h1></body></html>"""
        client = FakeClient(lambda m, u, k: make_resp(u, 200, page, "text/html"))
        p = pi.Posting(company="Boehringer Ingelheim", title="Intern", url="https://jobs.example.com/job/1/")
        pi.enrich_from_page(client, p, (".jobdescription",))
        self.assertEqual((p.deadline, p.posted, p.pay), ("2026-11-15", "2026-09-30", "$30 - $40 per hour"))
        self.assertEqual(p.description, "Great internship.")


class Parallel(unittest.TestCase):
    def test_workers_run_companies_side_by_side(self):
        import threading
        seen = set()

        class Clonable(FakeClient):
            def clone(self):
                seen.add(threading.get_ident())
                return self

        def handler(method, url, kw):
            return make_resp(url, 200, json.dumps({"jobs": [{"title": "Summer Intern", "id": 1, "absolute_url": url,
                                                             "location": {"name": "Boston, MA"}}]}))
        orig = dict(pi.COMPANIES)
        try:
            pi.COMPANIES.update({f"G{i}": {"id": f"g{i}", "platform": "greenhouse", "token": f"t{i}"} for i in range(4)})
            got, status = pi.run([f"G{i}" for i in range(4)], False, False, Clonable(handler), workers=4)
        finally:
            pi.COMPANIES.clear()
            pi.COMPANIES.update(orig)
        self.assertEqual(len(got), 4)
        self.assertTrue(all(v == "ok (1)" for v in status.values()))


if __name__ == "__main__":
    unittest.main()
