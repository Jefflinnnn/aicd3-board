"""Offline tests: fixtures mirror real responses captured from the sites in Oct 2026."""
import re
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

    def test_cloudflare_background_script_on_a_normal_page_passes(self):
        # Eli Lilly's Workday (12 Oct 2026): a 200 page that only loads Cloudflare's JS-detection script
        body = ("<html><title></title><script>window.__CF$cv$params={r:'a49c'};var a=document.createElement('script');"
                "a.src='/cdn-cgi/challenge-platform/scripts/jsd/main.js';</script></html>")
        pi.PoliteClient._check_block(make_resp("https://lilly.wd115.myworkdayjobs.com/CMP", 200, body, "text/html"))

    def test_cloudflare_interstitial_403_names_the_reason(self):
        body = "<html><title>Just a moment...</title><script>window._cf_chl_opt={}</script></html>"
        with self.assertRaises(pi.BlockedError) as e:
            pi.PoliteClient._check_block(make_resp("https://x.test/a", 403, body, "text/html"))
        self.assertIn("HTTP 403", str(e.exception))

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


def phenom_page(ddo):
    return ('<html><head><script>var phApp = phApp || {};\nphApp.ddo = ' + json.dumps(ddo) +
            '; phApp.experimentData = {};</script></head><body></body></html>')


GENE_SEARCH = phenom_page({"siteConfig": {"note": "braces { in } strings and \\\"quotes\\\""},
                           "eagerLoadRefineSearch": {"totalHits": 3, "data": {"jobs": [
    {"jobId": "202610-125229", "reqId": "202610-125229", "title": "2027 Spring Intern - GenAI Applications",
     "jobUrl": "https://careers.gene.com/us/en/job/202610-125229/2027-Spring-Intern-GenAI-Applications",
     "postedDate": "2026-10-05T00:00:00.000+0000", "multi_location": ["South San Francisco, California, United States of America"]},
    {"jobId": "202609-123586", "title": "Measurement Analytics & Insights Senior Manager",
     "jobUrl": "https://careers.gene.com/us/en/job/202609-123586/x", "postedDate": "2026-10-02T00:00:00.000+0000"},
    {"jobId": "202609-124239", "title": "2027 Summer Intern - Quality Control",
     "jobUrl": "https://careers.gene.com/us/en/job/202609-124239/2027-Summer-Intern-Quality-Control",
     "postedDate": "2026-10-05T00:00:00.000+0000", "multi_location": [{"location": "Hillsboro, Oregon, United States of America"}]}]}}})
GENE_JOB = phenom_page({"jobDetail": {"data": {"job": {
    "description": "<p>The Position</p><ul><li>Build agents</li></ul><p>The expected salary range is $52.00 per hour.</p>",
    "multi_location": [{"location": "South San Francisco, California, United States of America"}]}}}})
WORKDAY_DOWN = "<html><title>Workday is currently unavailable.</title><body>We are experiencing a service interruption.</body></html>"


class Phenom(unittest.TestCase):
    def test_parse_ddo_handles_braces_and_quotes_in_strings(self):
        ddo = pi.parse_phenom_ddo(GENE_SEARCH)
        self.assertEqual(ddo["eagerLoadRefineSearch"]["totalHits"], 3)
        self.assertIn("{ in }", ddo["siteConfig"]["note"])

    def test_scrape_with_details(self):
        def handler(method, url, kw):
            return make_resp(url, 200, GENE_SEARCH if "search-results" in url else GENE_JOB, "text/html")
        cfg = {"base": "https://careers.gene.com", "path": "/us/en", "terms": ["intern"]}
        got = pi.scrape_phenom(FakeClient(handler), "Genentech", cfg, True)
        self.assertEqual(sorted(p.req_id for p in got), ["202609-124239", "202610-125229"])  # manager role filtered out
        genai = next(p for p in got if p.req_id == "202610-125229")
        self.assertEqual((genai.posted, genai.pay), ("2026-10-05", "$52.00 per hour"))
        self.assertIn("• Build agents", genai.description)
        self.assertEqual(pi.to_import_record(genai)["locations"], ["South San Francisco, CA"])


class Maintenance(unittest.TestCase):
    def test_workday_down_falls_back_to_careers_site(self):
        def handler(method, url, kw):
            if "myworkdayjobs.com" in url:
                return make_resp("https://static.community.workday.com/maintenance-page.html", 403, WORKDAY_DOWN, "text/html", method)
            return make_resp(url, 200, GENE_SEARCH if "search-results" in url else GENE_JOB, "text/html")
        got, status = pi.run(["Genentech"], False, False, FakeClient(handler))
        self.assertEqual(status["Genentech"], "ok (2) via phenom")
        self.assertEqual(len(got), 2)

    def test_maintenance_without_fallback_is_reported_as_unavailable(self):
        def handler(method, url, kw):
            return make_resp("https://static.community.workday.com/maintenance-page.html", 403, WORKDAY_DOWN, "text/html", method)
        _, status = pi.run(["Regeneron"], False, False, FakeClient(handler))
        self.assertTrue(status["Regeneron"].startswith("UNAVAILABLE"), status)

    def test_amgen_falls_back_to_its_radancy_site(self):
        def handler(method, url, kw):
            if "myworkdayjobs.com" in url:
                return make_resp("https://static.community.workday.com/maintenance-page.html", 403, WORKDAY_DOWN, "text/html", method)
            return make_resp(url, 200, AMGEN_SEARCH, "text/html")
        got, status = pi.run(["Amgen"], False, False, FakeClient(handler))
        self.assertEqual(status["Amgen"], "ok (2) via radancy")
        self.assertEqual(len(got), 2)


def amgen_item(jid, title, loc, posted):
    return (f'<li><a href="/en/job/thousand-oaks/x/87/{jid}" data-job-id="{jid}">'
            f'<span class="job-date-posted">{posted}</span><h3>{title}</h3>'
            f'<span class="job-location">{loc}</span></a></li>')


AMGEN_SEARCH = ('<html><body><section id="search-results" data-total-job-results="3" data-total-pages="1" '
                'data-records-per-page="12" data-current-page="1"><ul id="search-results-list">'
                + amgen_item("1001", "Amgen Scholars Intern - Process Development", "US - California - Thousand Oaks / and 3 other locations", "Aug. 31, 2026")
                + amgen_item("1002", "Senior Manager, Regulatory Affairs", "US - Massachusetts - Cambridge", "Sep. 2, 2026")
                + amgen_item("1003", "2027 Summer Intern - Data Science", "US - New Jersey - Rahway", "October 1, 2026")
                + '</ul></section></body></html>')
AMGEN_JOB = ('<html><body><main><div class="ats-description"><p>Join us.</p><ul><li>Analyze data</li></ul></div>'
             '<span class="job-id">Job ID R-254668</span></main></body></html>')


class Radancy(unittest.TestCase):
    def test_dates_and_locations(self):
        self.assertEqual(pi.radancy_date("Aug. 31, 2026"), "2026-08-31")
        self.assertEqual(pi.radancy_date("September 3, 2026"), "2026-09-03")
        self.assertEqual(pi.radancy_date("10/01/2026"), "2026-10-01")
        self.assertEqual(pi.radancy_date("soon"), "")
        self.assertEqual(pi._radancy_locations("US - California - Thousand Oaks / and 3 other locations"),
                         ["US - California - Thousand Oaks"])

    def test_scrape_stops_at_the_terms_result_count(self):
        urls = []

        def handler(method, url, kw):
            urls.append(url)
            return make_resp(url, 200, AMGEN_JOB if "/job/" in url else AMGEN_SEARCH, "text/html")
        cfg = {"base": "https://careers.amgen.com", "path": "/en/search-jobs", "terms": ["intern"]}
        got = pi.scrape_radancy(FakeClient(handler), "Amgen", cfg, True)
        self.assertEqual([u for u in urls if "search-jobs" in u], ["https://careers.amgen.com/en/search-jobs/intern"])
        self.assertEqual(sorted(p.title for p in got), ["2027 Summer Intern - Data Science",
                                                        "Amgen Scholars Intern - Process Development"])
        p = next(p for p in got if "Scholars" in p.title)
        self.assertEqual((p.posted, p.req_id), ("2026-08-31", "R-254668"))
        self.assertIn("• Analyze data", p.description)
        self.assertEqual(pi.to_import_record(p)["locations"], ["Thousand Oaks, CA"])


def abbvie_tile(jid, title, loc, pay, mode, jobtype, rid, expiry="01/01/0001"):
    item = lambda cls, label, value: (f'<div class="attrax-vacancy-tile__{cls} attrax-vacancy-tile__item">'
                                      f'<p class="attrax-vacancy-tile__item-label"> {label} </p>'
                                      f'<p class="attrax-vacancy-tile__item-value"> {value} </p></div>')
    return (f'<div class="attrax-vacancy-tile attrax-vacancy-tile--intern" data-jobid="{jid}">'
            f'<a class="attrax-vacancy-tile__title attrax-vacancy-tile__item attrax-button" href="/en/job/x-jid-{jid}">{title}</a>'
            f'<div class="attrax-vacancy-tile__salary attrax-vacancy-tile__item"><p class="attrax-vacancy-tile__salary-label attrax-vacancy-tile__item-label"> Salary </p>'
            f'<p class="attrax-vacancy-tile__salary-value attrax-vacancy-tile__item-value">{pay}</p></div>'
            + item("location-freetext", "Location", loc)
            + f'<div class="attrax-vacancy-tile__option-work-location-type attrax-vacancy-tile__item"><p class="attrax-vacancy-tile__item-label"> Work location type </p><div class="attrax-vacancy-tile__item-valueset"><p class="attrax-vacancy-tile__item-value"> {mode} </p></div></div>'
            + f'<div class="attrax-vacancy-tile__option-job-type attrax-vacancy-tile__item"><p class="attrax-vacancy-tile__item-label"> Job Type </p><div class="attrax-vacancy-tile__item-valueset"><p class="attrax-vacancy-tile__item-value"> {jobtype} </p></div></div>'
            + item("reference", "Job ID", "3526b173-a7a5-4a8c-a530-9f5299b90abe")
            + item("externalreference", "Job ID", rid)
            + item("expiry", "Expiry Date", expiry)
            + '</div>')


ABBVIE_PAGE1 = ('<html><body><span class="attrax-pagination__total-results"> 12 result(s) </span>'
                + abbvie_tile(33570, "2027 Global Supply Chain Intern (Undergraduate)", "North Chicago, IL", "$21 - $37.8", "Hybrid", "Intern", "R00151172", "12/15/2026")
                + abbvie_tile(34139, "Front Desk Specialist (Maternity Backfill)", "Dubai, Dubai", "", "Hybrid", "Full time", "R00150000")
                + '</body></html>')
ABBVIE_PAGE2 = ('<html><body><span class="attrax-pagination__total-results"> 12 result(s) </span>'
                + abbvie_tile(33457, "Discover Accounting and Finance at AbbVie 2027", "North Chicago, IL", "$0 - $0", "On-Site", "Intern", "R00151999")
                + '</body></html>')


class AbbVieSearch(unittest.TestCase):
    def test_parse_tiles(self):
        rows, total = pi.parse_abbvie_search(ABBVIE_PAGE1, "https://careers.abbvie.com")
        self.assertEqual(total, 12)
        r = rows[0]
        self.assertEqual((r["title"], r["location"], r["pay"], r["mode"], r["req_id"], r["deadline"]),
                         ("2027 Global Supply Chain Intern (Undergraduate)", "North Chicago, IL", "$21 - $37.8", "Hybrid", "R00151172", "2026-12-15"))
        self.assertEqual(r["url"], "https://careers.abbvie.com/en/job/x-jid-33570")

    def test_only_with_ignore_robots(self):
        calls = []

        def handler(method, url, kw):
            calls.append(url)
            if "/en/jobs?" in url:
                return make_resp(url, 200, ABBVIE_PAGE1 if "page=1" in url else ABBVIE_PAGE2, "text/html")
            return make_resp(url, 200, "<urlset xmlns='http://www.sitemaps.org/schemas/sitemap/0.9'></urlset>", "text/xml")
        got, status = pi.run(["AbbVie"], False, False, FakeClient(handler))
        self.assertFalse(any("/en/jobs?" in u for u in calls))  # default: robots.txt respected
        calls.clear()
        cfg = dict(pi.COMPANIES["AbbVie"])
        cfg["robots_disallowed"] = {**cfg["robots_disallowed"], "terms": ["intern"]}
        orig = pi.COMPANIES["AbbVie"]
        pi.COMPANIES["AbbVie"] = cfg
        try:
            got, status = pi.run(["AbbVie"], False, False, FakeClient(handler), ignore_robots=True)
        finally:
            pi.COMPANIES["AbbVie"] = orig
        self.assertEqual(status["AbbVie"], "ok (2) via abbvie_search (robots.txt ignored)")
        by = {p.req_id: p for p in got}
        self.assertEqual(set(by), {"R00151172", "R00151999"})  # the front-desk job is filtered out
        self.assertEqual(by["R00151999"].pay, "")             # "$0 - $0" means not listed
        self.assertEqual(pi.to_import_record(by["R00151172"])["mode"], "Hybrid")
        self.assertEqual(sum("/en/jobs?" in u for u in calls), 2)  # stops at 12 results = 2 pages


class GreenhouseDeadline(unittest.TestCase):
    def test_application_deadline(self):
        body = {"jobs": [{"title": "Summer Intern, Biology", "id": 7, "absolute_url": "https://x/7", "requisition_id": "P7",
                          "location": {"name": "Redwood City, California, United States"}, "application_deadline": "2026-12-01T00:00:00Z"}]}
        got = pi.scrape_greenhouse(FakeClient(lambda m, u, k: make_resp(u, 200, json.dumps(body))), "Revolution Medicines",
                                   {"token": "revolutionmedicines"}, False)
        self.assertEqual(got[0].deadline, "2026-12-01")


if __name__ == "__main__":
    unittest.main()


class LiveFormats(unittest.TestCase):
    """Formats seen on the live career sites on 12 Oct 2026."""

    def test_us_locations_in_every_site_format(self):
        cases = {"US - Frederick - MD": "Frederick, MD",                 # AstraZeneca
                 "Princeton - NJ - US": "Princeton, NJ",                 # Bristol Myers Squibb
                 "US, Indianapolis IN": "Indianapolis, IN",              # Lilly
                 "US: South San Francisco": "South San Francisco, CA",   # Lilly
                 "USA - Pennsylvania - West Point": "West Point, PA",    # Merck
                 "Ridgefield, CT, United States, Connecticut": "Ridgefield, CT",  # Boehringer
                 "US, CA, Santa Clara": "Santa Clara, CA",               # NVIDIA
                 "US, WA, Redmond": "Redmond, WA",                       # NVIDIA
                 "Washington, DC": "Washington, DC",                     # state name first, but a state code second
                 "China, Shanghai": "China, Shanghai",                   # not the US: unchanged
                 "Cambridge": "Cambridge"}                               # could be anywhere without a country
        for raw, want in cases.items():
            self.assertEqual(pi.normalize_location(raw), want, raw)

    def test_bare_us_cities_get_a_state(self):
        p = pi.Posting(company="Regeneron", title="2027 Co-op Supply Chain", locations=["Warren", "SLEEPY HOLLOW", "Gotham"],
                       extra={"country": "United States of America"},
                       description="When & where:\nLocation: Warren, NJ and Tarrytown / Sleepy Hollow, NY\nGotham, NY office")
        self.assertEqual(pi.us_locations(p), ["Warren, NJ", "Sleepy Hollow, NY", "Gotham, NY"])

    def test_us_only_uses_the_sites_country(self):
        us = pi.Posting(company="Genentech", title="Intern", location="South San Francisco", extra={"country": "United States of America"})
        ie = pi.Posting(company="BMS", title="Intern", location="Cruiserath - IE", extra={"country": "Ireland"})
        unknown = pi.Posting(company="Merck", title="Intern", location="4 Locations")
        self.assertEqual([pi.is_us(x) for x in (us, ie, unknown)], [True, False, True])

    def test_sections_with_each_companys_headings(self):
        text = pi.html_to_text(
            "<p>What You Will Achieve</p><ul><li>Own a launch plan</li></ul>"            # Pfizer
            "<p>Program Highlights</p><ul><li>Networking events</li></ul>"              # Genentech: not a duty
            "<p>Position Requirements:</p><ul><li>Enrolled in a BS program</li></ul>"  # AstraZeneca
            "<p>Must-Have</p><ul><li>Python</li></ul>"                                   # Pfizer
            "<p>What do we offer you?</p><ul><li>Housing stipend</li></ul>"             # GSK: not a qualification
            "<p>Let’s find out if we’re a fit:</p><ul><li>Rising senior</li></ul>")    # Regeneron
        sec = pi.extract_sections(text)
        self.assertEqual(sec, {"resp": ["Own a launch plan"], "quals": ["Enrolled in a BS program", "Python", "Rising senior"]})

    def test_paragraph_bullets(self):  # Lilly writes bullets as "· text" paragraphs
        text = pi.html_to_text("<p>Basic Qualifications</p><p>· Enrolled in an MBA program</p><p>- Graduating by 2028</p>")
        self.assertEqual(pi.extract_sections(text)["quals"], ["Enrolled in an MBA program", "Graduating by 2028"])

    def test_deadlines(self):
        from datetime import date
        today = date(2026, 10, 12)
        self.assertEqual(pi.extract_deadline("*Applications will close on November 22nd at 11:59pm EST", today), "2026-11-22")
        self.assertEqual(pi.extract_deadline("Application deadline: January 5, 2027", today), "2027-01-05")
        self.assertEqual(pi.extract_deadline("We review applications on a rolling basis.", today), "")
        self.assertEqual(pi.sane_deadline("2126-09-24T12:30:22+00:00", today), "")   # AbbVie placeholder
        self.assertEqual(pi.sane_deadline("2026-12-01", today), "2026-12-01")
        self.assertEqual(pi.any_date("Thu Sep 17 00:00:00 UTC 2026"), "2026-09-17")

    def test_workday_end_date_is_the_deadline(self):
        detail = {"jobPostingInfo": {"title": "2027 Summer Intern - Quality Control", "location": "Hillsboro", "jobReqId": "202609-124239",
                                     "startDate": "2026-10-05", "endDate": "2026-10-20", "country": {"descriptor": "United States of America"},
                                     "jobDescription": "<p>The Opportunity</p><ul><li>Run QC assays</li></ul><p>$25.00-$52.00 per hour</p>"}}

        def handler(method, url, kw):
            if method == "POST":
                return make_resp(url, 200, json.dumps({"total": 1, "jobPostings": [
                    wd_posting("2027 Summer Intern - Quality Control", "/job/Hillsboro/QC_202609-124239")]}), method="POST")
            if "/wday/cxs/" in url:
                return make_resp(url, 200, json.dumps(detail))
            return make_resp(url, 200, "<html></html>", "text/html")
        p = pi.scrape_workday(FakeClient(handler), "Genentech", {"boards": [("roche", "wd3", "ROG-A2O-GENE")]}, True)[0]
        rec = pi.to_import_record(p)
        self.assertEqual((rec["deadline"], rec["first_seen"], rec["pay"], rec["req_id"]), ("2026-10-20", "2026-10-05", "$25.00-$52.00 per hour", "202609-124239"))
        self.assertEqual(rec["locations"], ["Hillsboro, OR"])
        self.assertEqual(rec["responsibilities"], ["Run QC assays"])

    def test_page_microdata_and_job_id(self):
        bi = ('<html><body><span itemprop="jobLocation"></span><meta itemprop="datePosted" content="Thu Sep 17 00:00:00 UTC 2026">'
              '<div class="jobdescription"><p>Duties &amp; Responsibilities</p><ul><li>Plan supply</li></ul><p>$24 to $33 per hour</p></div></body></html>')
        p = pi.Posting(company="Boehringer Ingelheim", title="Intern", url="https://jobs.boehringer-ingelheim.com/job/x/1438182733/")
        pi.enrich_from_page(FakeClient(lambda m, u, k: make_resp(u, 200, bi, "text/html")), p, (".jobdescription",))
        self.assertEqual((p.posted, p.pay), ("2026-09-17", "$24 to $33 per hour"))
        amgen = ('<html><head><script type="application/ld+json">{"@type": "JobPosting", "datePosted": "2026-09-01", '
                 '"identifier": {"@type": "PropertyValue", "name": "Job ID", "value": "R-254668"}, "description": "<p>Join us.</p>", '
                 '"baseSalary": {"@type": "MonetaryAmount", "currency": "", "value": {"@type": "QuantitativeValue", "unitText": ""}}}'
                 '</script></head><body></body></html>')
        q = pi.Posting(company="Amgen", title="Undergrad Intern", url="https://careers.amgen.com/en/job/x/87/1")
        pi.enrich_from_page(FakeClient(lambda m, u, k: make_resp(u, 200, amgen, "text/html")), q, ("main",))
        self.assertEqual((q.req_id, q.posted, q.pay), ("R-254668", "2026-09-01", ""))

    def test_lilly_cmp_is_filtered_now(self):
        self.assertEqual(pi.COMPANIES["Eli Lilly"]["boards"], [("lilly", "wd115", "CMP"), ("lilly", "wd115", "LLY")])


class NewCompanies(unittest.TestCase):
    """Gilead, Novartis, Biogen (Workday), Recursion, Generate (Greenhouse), insitro (Ashby), checked live 12 Oct 2026."""

    def test_config(self):
        want = {"Gilead Sciences": ("workday", "gilead"), "Novartis": ("workday", "novartis"), "Biogen": ("workday", "biogen"),
                "Recursion": ("greenhouse", "recursion"), "Generate:Biomedicines": ("greenhouse", "generate"), "insitro": ("ashby", "insitro")}
        for name, (platform, cid) in want.items():
            self.assertEqual((pi.COMPANIES[name]["platform"], pi.COMPANIES[name]["id"]), (platform, cid), name)
        for gone in ("Alnylam", "BioMarin", "Exelixis", "Arcus Biosciences", "Dyno Therapeutics"):
            self.assertNotIn(gone, pi.COMPANIES)

    def test_nvidia_keeps_only_life_science_postings(self):
        cfg = pi.COMPANIES["NVIDIA"]
        self.assertEqual((cfg["platform"], cfg["id"], cfg["boards"][0][:3]), ("workday", "nvidia", ("nvidia", "wd5", "NVIDIAExternalCareerSite")))
        req = re.compile(cfg["require"], re.I)
        self.assertTrue(req.search("Deep Learning Intern, BioNeMo"))
        self.assertTrue(req.search("Research Intern\nModels for drug discovery and protein design"))
        self.assertTrue(req.search("Healthcare AI Intern"))
        self.assertFalse(req.search("ASIC Verification Intern\nWrite testbenches for GPU memory controllers"))

    def test_lilly_tries_chrome_handshake_then_browser_then_phenom(self):
        cfg = pi.COMPANIES["Eli Lilly"]
        self.assertTrue(cfg["impersonate"])
        self.assertEqual([f["platform"] for f in cfg["fallback"]], ["workday_browser", "phenom"])
        self.assertIn(("lilly", "wd115", "CMP"), cfg["fallback"][0]["boards"])   # the US internships are on CMP

    def test_fallback_chain_moves_on_when_a_source_is_blocked(self):
        calls = []
        def blocked(client, company, cfg, details):
            calls.append(cfg["platform"]); raise pi.BlockedError("cf challenge")
        def browser(client, company, cfg, details):
            calls.append(cfg["platform"])
            return [pi.Posting(company=company, title="AI PhD ML Engineering Intern", location="US, Indianapolis IN",
                               url="https://lilly.wd115.myworkdayjobs.com/CMP/job/x_R-1")]
        saved = dict(pi.SCRAPERS)
        try:
            pi.SCRAPERS.update(workday=blocked, workday_browser=browser, phenom=blocked)
            got, status = pi.run(["Eli Lilly"], details=False, us_only=True, client=pi.PoliteClient(0, 0))
        finally:
            pi.SCRAPERS.clear(); pi.SCRAPERS.update(saved)
        self.assertEqual(calls, ["workday", "workday_browser"])   # Phenom not needed once the browser route worked
        self.assertEqual([p.title for p in got], ["AI PhD ML Engineering Intern"])
        self.assertIn("via headless browser", status["Eli Lilly"])

    def test_impersonated_responses_look_like_requests(self):
        class Fake:
            status_code, content, url, reason = 403, b"<html>cf-chl challenge</html>", "https://x.test/a", "Forbidden"
            headers = {"Content-Type": "text/html", "Server": "cloudflare"}
        r = pi.ImpersonatingClient._to_requests("GET", Fake())
        self.assertIsInstance(r, requests.Response)
        self.assertEqual((r.status_code, r.request.method, r.headers["server"]), (403, "GET", "cloudflare"))
        with self.assertRaises(pi.BlockedError):
            pi.PoliteClient._check_block(r)

    def test_talent_pool_postings_are_not_internships(self):
        self.assertFalse(pi.is_internship("Interested in an internship?"))   # Recursion's standing post
        self.assertTrue(pi.is_internship("Co-op, Cell Models and Molecular Biology"))

    def test_greenhouse_several_locations(self):
        body = json.dumps({"jobs": [{"title": "Summer Intern, Computational Biology", "id": 7, "requisition_id": "P3100",
                                     "absolute_url": "https://job-boards.greenhouse.io/recursionpharmaceuticals/jobs/7",
                                     "location": {"name": "New York, New York; Salt Lake City, Utah"},
                                     "first_published": "2026-10-01T00:00:00-04:00", "content": "&lt;p&gt;$30 - $40 per hour&lt;/p&gt;"}]})
        p = pi.scrape_greenhouse(FakeClient(lambda m, u, k: make_resp(u, 200, body)), "Recursion", {"token": "recursionpharmaceuticals"}, True)[0]
        self.assertEqual(pi.to_import_record(p)["locations"], ["New York, NY", "Salt Lake City, UT"])
        self.assertEqual((p.req_id, p.pay), ("P3100", "$30 - $40 per hour"))

    def test_ashby(self):
        body = json.dumps({"jobs": [
            {"id": "0bff19c6-e165-4be7-a32a-6beeffb51ffa", "title": "Machine Learning Intern (Summer 2027)", "employmentType": "Intern",
             "location": "South San Francisco, CA", "secondaryLocations": [{"location": "Remote (US)"}], "isListed": True,
             "publishedAt": "2026-09-21T23:40:31.103+00:00", "workplaceType": "Hybrid",
             "jobUrl": "https://jobs.ashbyhq.com/insitro/0bff19c6-e165-4be7-a32a-6beeffb51ffa",
             "descriptionHtml": "<p>What you'll do</p><ul><li>Train models</li></ul>",
             "compensation": {"compensationTierSummary": "$45 – $55 per hour"}},
            {"id": "1", "title": "Research Associate", "employmentType": "Intern", "isListed": True, "location": "Boston, MA", "jobUrl": "u1"},
            {"id": "2", "title": "Full Stack Software Engineer", "employmentType": "FullTime", "isListed": True, "location": "x", "jobUrl": "u2"}]})
        got = pi.scrape_ashby(FakeClient(lambda m, u, k: make_resp(u, 200, body)), "insitro", {"org": "insitro"}, True)
        self.assertEqual(sorted(p.title for p in got), ["Machine Learning Intern (Summer 2027)", "Research Associate"])  # Ashby says Intern
        rec = pi.to_import_record(next(p for p in got if "Machine" in p.title))
        self.assertEqual((rec["first_seen"], rec["pay"], rec["mode"]), ("2026-09-21", "$45 – $55 per hour", "Hybrid"))
        self.assertEqual(rec["responsibilities"], ["Train models"])

    def test_biogen_headings(self):
        text = pi.html_to_text("<p>Key Deliverables and Responsibilities:</p><ul><li>Culture iPSC lines</li></ul>"
                               "<p>Ideal Candidate:</p><ul><li>Rising senior in biology</li></ul>"
                               "<p>The base compensation range for this role is: $29.00-$33.00</p>")
        self.assertEqual(pi.extract_sections(text), {"resp": ["Culture iPSC lines"], "quals": ["Rising senior in biology"]})
        self.assertEqual(pi.extract_pay(text), "$29.00-$33.00")


class Summaries(unittest.TestCase):
    """The job details pop-up shows the start of the job description, not the company's 'About us'."""

    def test_skips_company_blurb(self):
        text = ("Job Description\nAt Gilead, we’re creating a healthier world for all people. For more than 35 years, we’ve "
                "tackled diseases such as HIV.\nEvery member of Gilead’s team plays a critical role in discovery.\n"
                "Intern - Research - Pathobiology - AI\nAs an intern on the Pathobiology team, you will build deep learning "
                "models for whole-slide images. You will automate image analysis pipelines.\nRequired Qualifications:\n• Python")
        self.assertEqual(pi.job_summary(text, "Gilead Sciences", "Intern - Research - Pathobiology - AI"),
                         "As an intern on the Pathobiology team, you will build deep learning models for whole-slide images. "
                         "You will automate image analysis pipelines.")

    def test_skips_about_sections_and_slogans(self):
        text = ("Join Amgen’s Mission of Serving Patients\nAt Amgen, if you feel like you’re part of something bigger, it’s because "
                "you are.\nWhat You Will Do\nLet’s do this. Let’s change the world. In this vital role you will support financial "
                "planning for Operations.\nWhat You Can Expect of Us\nWe offer competitive benefits.")
        self.assertEqual(pi.job_summary(text, "Amgen", ""), "In this vital role you will support financial planning for Operations.")

    def test_bullets_only(self):
        self.assertEqual(pi.job_summary("The Opportunity\n• Run assays\n• Analyze data", "Genentech", ""), "Run assays. Analyze data.")

    def test_import_record_uses_it(self):
        p = pi.Posting(company="Amgen", title="Intern", description="About Amgen\nAmgen is a pioneer in biotech.\nThe Role\nYou will build ML models.")
        self.assertEqual(pi.to_import_record(p)["description"], "You will build ML models.")


class UndergradOnly(unittest.TestCase):
    def test_left_out(self):
        for t, d in [("Co-op, Cell Models and Molecular Biology", "Six-month co-op."),
                     ("2027 Undergraduate Summer Intern - Data Science", ""),
                     ("Intern - Computational Biology", "Requirements: currently pursuing a B.S. in computer science."),
                     ("Intern - Data Science", "Open to rising juniors and seniors."),
                     ("Summer Intern - Bioinformatics", "Must be enrolled in an undergraduate program in biology."),
                     ("High School Summer Intern", "")]:
            self.assertTrue(pi.undergrad_only(t, d), t)

    def test_kept(self):
        for t, d in [("Co-op - ML Engineering", "Open to undergraduate and graduate students."),
                     ("Intern - Computational Biology", "Currently pursuing a Bachelor's, Master's or Ph.D. in biology."),
                     ("PhD Intern - Machine Learning", ""),
                     ("Intern - Pharmacometrics", "PharmD candidates or graduate students in pharmaceutical sciences."),
                     ("Intern - Data Science", "Build models of clinical trial data."),          # says nothing about level
                     ("Intern - Clinical Data", "Bachelor's degree required; MS degree preferred."),
                     ("International Cooperation Intern", "Recent graduates welcome.")]:
            self.assertFalse(pi.undergrad_only(t, d), t)
