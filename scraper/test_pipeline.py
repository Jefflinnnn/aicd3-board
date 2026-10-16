"""Offline tests for classify.py and pipeline.py (no model download, no network)."""
import json
import os
import tempfile
import unittest
from unittest import mock

import classify as c
import pharma_internships as pi
import pipeline

# never report test runs to a real app (the PC running these tests may have the app up on :3000)
os.environ["AICD3_PROGRESS"] = "off"

# pipeline.main() writes a run log; keep the tests' logs out of the real scraper/out/logs/
os.environ["AICD3_LOG_FILE"] = os.path.join(tempfile.mkdtemp(prefix="aicd3-test-logs-"), "pipeline-test.log")


# Never reach Claude or a real d3 server from the tests, even on a machine whose .env.local has the settings
RealD3 = c.D3
_no_llm = mock.patch.object(c, "llm_configured", return_value=False)
_no_d3 = mock.patch.object(c, "D3", side_effect=ConnectionError("the d3 server at http://127.0.0.1:8765 isn't answering (test)"))


def setUpModule():
    _no_llm.start()
    _no_d3.start()


def tearDownModule():
    _no_llm.stop()
    _no_d3.stop()


class FakeBlock:
    def __init__(self, data):
        self.type, self.input = "tool_use", data


class FakeClaude:
    """Stands in for anthropic.AnthropicBedrock: records each call, answers with a tool_use block."""
    def __init__(self, answer=None, fail=None):
        self.answer, self.fail, self.calls = answer, fail, []
        self.messages = self

    def create(self, **kw):
        self.calls.append(kw)
        if self.fail:
            raise self.fail
        return mock.Mock(content=[FakeBlock(self.answer)])


PKPD_ANSWER = {"computational": 0.93, "category": "development", "category_confidence": 0.9,
               "reason": "Builds PK/PD models and automates simulation in Python.",
               "summary": "Build population PK/PD models for Phase 2 trials in the Clinical Pharmacology team.",
               "responsibilities": ["Build population PK/PD models in NONMEM", "Automate simulation workflows in Python"],
               "qualifications": ["Pursuing a PhD or PharmD", "Experience with R or Python"]}


class Claude(unittest.TestCase):
    def test_one_call_gives_decision_reason_and_sections(self):
        fake = FakeClaude(PKPD_ANSWER)
        clf = c.Classifier("llm", cache_path=None, llm_client=fake)
        v = clf.classify("2027 Summer Intern - Clinical Pharmacology Modeling", "Genentech", "Build PK/PD models...")
        self.assertEqual((clf.name, v.backend, v.decision, v.category), ("llm", "llm", "publish", "development"))
        self.assertEqual(v.resp[0], "Build population PK/PD models in NONMEM")
        self.assertTrue(v.summary.startswith("Build population PK/PD models"))
        call = fake.calls[0]
        self.assertEqual(call["tool_choice"], {"type": "tool", "name": "record_assessment"})
        self.assertIn("<posting>", call["messages"][0]["content"])   # the posting goes in as data
        self.assertIn("claude-sonnet", call["model"])

    def test_model_is_sonnet_5_or_claude_codes_sonnet_setting(self):
        clean = {k: "" for k in ("AICD3_LLM_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL")}
        with mock.patch.dict(os.environ, clean), mock.patch.object(c, "env", side_effect=lambda n: os.environ.get(n, "")):
            self.assertEqual(c.LLM(client=FakeClaude(PKPD_ANSWER)).model, "us.anthropic.claude-sonnet-5")
            with mock.patch.dict(os.environ, {"ANTHROPIC_DEFAULT_SONNET_MODEL": "us.anthropic.claude-sonnet-test"}):
                self.assertEqual(c.LLM(client=FakeClaude(PKPD_ANSWER)).model, "us.anthropic.claude-sonnet-test")
            with mock.patch.dict(os.environ, {"AICD3_LLM_MODEL": "us.anthropic.claude-opus-test", "ANTHROPIC_DEFAULT_SONNET_MODEL": "x"}):
                self.assertEqual(c.LLM(client=FakeClaude(PKPD_ANSWER)).model, "us.anthropic.claude-opus-test")

    def ucsf_llm(self):
        env = {"AWS_ACCESS_KEY_ID": "id", "AWS_SECRET_ACCESS_KEY": "secret", "AWS_REGION": "us-west-2",
               "ANTHROPIC_BEDROCK_BASE_URL": "https://unified-api.ucsf.edu/general/awsai"}
        fake_sdk = mock.Mock()
        with mock.patch.dict(os.environ, env), mock.patch.dict("sys.modules", {"anthropic": fake_sdk}):
            return c.LLM()

    def test_off_the_vpn_says_so_and_uses_rules(self):
        import requests
        with mock.patch("requests.get", side_effect=requests.exceptions.ConnectionError("Name or service not known")):
            ok, why = self.ucsf_llm().reachable()
        self.assertFalse(ok)
        self.assertIn("unified-api.ucsf.edu", why)
        self.assertIn("UCSF VPN", why)
        with mock.patch("requests.get", side_effect=requests.exceptions.ConnectTimeout("timed out")):
            self.assertIn("UCSF VPN", self.ucsf_llm().reachable()[1])
        llm = mock.Mock(model="m", needs_vpn=True, reachable=mock.Mock(return_value=(False, "couldn't connect. " + c.VPN_HINT)))
        with mock.patch.object(c, "LLM", return_value=llm), self.assertRaises(ConnectionError):
            c.Classifier("llm", cache_path=None)   # asked for Claude explicitly: fail loudly

    def test_on_the_vpn_any_http_answer_counts(self):
        with mock.patch("requests.get", return_value=mock.Mock(status_code=403)):
            self.assertEqual(self.ucsf_llm().reachable(), (True, ""))

    def test_connection_errors_mid_run_mention_the_vpn(self):
        class APIConnectionError(Exception):
            pass
        clf = c.Classifier("llm", cache_path=None, llm_client=FakeClaude(fail=APIConnectionError("Connection error.")))
        clf.llm.base_url = "https://unified-api.ucsf.edu/general/awsai"
        with self.assertLogs("classify", "WARNING") as logs:
            clf.classify("Data Science Intern", "Amgen", "Python")
        self.assertIn("UCSF VPN", logs.output[0])

    @unittest.skipUnless(__import__("importlib").util.find_spec("anthropic"), "anthropic isn't installed")
    def test_bedrock_gateway_settings_reach_the_client(self):
        env = {"AWS_ACCESS_KEY_ID": "id", "AWS_SECRET_ACCESS_KEY": "secret", "AWS_REGION": "us-west-2",
               "ANTHROPIC_BEDROCK_BASE_URL": "https://gateway.example.edu/general/awsai"}
        with mock.patch.dict(os.environ, env), mock.patch("anthropic.AnthropicBedrock") as bedrock:
            m = c.LLM()
        kw = bedrock.call_args.kwargs
        self.assertEqual((kw["aws_access_key"], kw["aws_secret_key"], kw["aws_region"], kw["base_url"]),
                         ("id", "secret", "us-west-2", "https://gateway.example.edu/general/awsai"))
        self.assertIn("gateway.example.edu", m.via)

    def test_odd_answers_are_clamped(self):
        v = c.Classifier("llm", cache_path=None, llm_client=FakeClaude(
            {**PKPD_ANSWER, "computational": 1.7, "category": "marketing", "responsibilities": ["", "a"] + ["b"] * 12})
        ).classify("t", "c", "d")
        self.assertEqual((v.computational, v.category, len(v.resp)), (1.0, "other", 8))

    def test_failures_fall_back_to_rules_and_stop_trying_after_five(self):
        fake = FakeClaude(fail=RuntimeError("403 from gateway"))
        clf = c.Classifier("llm", cache_path=None, llm_client=fake)
        got = [clf.classify(f"Data Science Intern {i}", "Amgen", "Python and SQL").backend for i in range(8)]
        self.assertEqual(set(got), {"rules"})
        self.assertEqual(len(fake.calls), 5)   # no more calls once it's clearly not working

    def test_warm_classifies_in_parallel_and_caches(self):
        fake = FakeClaude(PKPD_ANSWER)
        clf = c.Classifier("llm", cache_path=None, llm_client=fake)
        items = [(f"Intern {i}", "Genentech", f"text {i}") for i in range(10)]
        clf.warm(items + items[:3])   # duplicates asked once
        self.assertEqual(len(fake.calls), 10)
        clf.classify(*items[0])
        self.assertEqual(len(fake.calls), 10)   # answered from the cache

    def test_pipeline_uses_claudes_sections_and_reason(self):
        fake = FakeClaude({**PKPD_ANSWER, "computational": 0.5, "category": "discovery", "reason": "Mostly bench work with some modeling."})
        clf = c.Classifier("llm", cache_path=None, llm_client=fake)
        p = pi.Posting(company="Gilead Sciences", title="Intern - Translational Research Modeling", location="US, CA, Foster City",
                       url="https://gilead.wd1.myworkdayjobs.com/x/job/y", description="What we need to see:\n• ...")
        recs, report = pipeline.build_records([p], clf)
        self.assertEqual(report[0]["decision"], "review")
        self.assertEqual(recs[0]["qualifications"], PKPD_ANSWER["qualifications"])
        self.assertEqual(recs[0]["description"], PKPD_ANSWER["summary"])
        self.assertIn("Claude: Mostly bench work", recs[0]["review_reason"])

    def test_auto_never_uses_claude(self):
        # d3 replaced Claude/Versa: auto is d3, else keyword rules, even with Claude's settings present
        with mock.patch.object(c, "llm_configured", return_value=True), mock.patch.object(c, "LLM") as llm:
            self.assertEqual(c.Classifier("auto", cache_path=None).name, "rules")
        llm.assert_not_called()


class AnswerShapes(unittest.TestCase):
    """d3-flash's card doesn't pin down the answer format, so accept the plausible ones."""

    def test_yes_no(self):
        for ans in ({"probabilities": {"yes": 0.8, "no": 0.2}}, {"yes": 0.8, "no": 0.2}, {"Yes": 0.8},
                    {"no": 0.2}, [{"label": "yes", "probability": 0.8}, {"label": "no", "probability": 0.2}],
                    {"answer": "yes", "probabilities": {"true": 0.8, "false": 0.2}}):
            self.assertAlmostEqual(c.p_yes(ans), 0.8, msg=repr(ans))
        with self.assertRaises(ValueError):
            c.p_yes({"maybe": 1.0})

    def test_d3_noul_answer(self):
        # what d3-flash actually returned for the "noul" (yes/no likelihood) question on 12 Oct 2026
        self.assertAlmostEqual(c.p_yes({"type": "noul", "noul": 0.9906622951973657}), 0.9906622951973657)

    def test_choice(self):
        ans = {"scores": {"discovery": 0.1, "development": 0.7, "tech": 0.15, "other": 0.05}}
        self.assertEqual(c.best_choice(ans, c.CATEGORIES), ("development", 0.7))
        self.assertEqual(c.best_choice({"answer": "tech"}, c.CATEGORIES), ("tech", 1.0))


class FakeD3:
    model = "vllm-sr/d3@abc"

    def __init__(self, answers):
        self.answers, self.calls = answers, 0

    def classify(self, title, company, description, location=""):
        self.calls += 1
        ans = self.answers
        cat, cp = c.best_choice(ans["category"], c.CATEGORIES)
        return c.Verdict(round(c.p_yes(ans["computational"]), 3), cat, round(cp, 3), "d3")


class Decisions(unittest.TestCase):
    def test_thresholds(self):
        self.assertEqual([c.Verdict(p, "discovery", 1, "d3").decision for p in (0.9, 0.6, 0.5, 0.45, 0.3)],
                         ["publish", "publish", "review", "review", "skip"])
        # outside the drug pipeline: tech ML roles publish (students add Tech themselves), borderline ones don't go to review
        self.assertEqual([c.Verdict(p, "tech", 1, "d3").decision for p in (0.9, 0.5)], ["publish", "skip"])
        self.assertEqual([c.Verdict(p, "other", 1, "d3").decision for p in (0.9, 0.5)], ["review", "skip"])

    def test_rules(self):
        cases = [("2027 Summer Intern - Clinical Pharmacology Modeling",
                  "Build population PK/PD models in R and NONMEM and automate simulation workflows in Python.", "publish", "development"),
                 ("Intern - PDM - Process Chemistry", "Run reactions at bench scale, purification, HPLC.", "skip", "development"),
                 ("2027 Summer Intern - Computational Biology", "Analyze single-cell genomic data with machine learning to find targets.", "publish", "discovery"),
                 ("Intern - CFO - IT", "Develop software tools in Python and SQL; cloud data engineering.", "skip", "tech"),
                 ("Undergrad Intern – Finance (Summer 2027)", "Support budgeting and forecasting in Excel.", "skip", "other"),
                 ("Intern - Development - Biostatistics", "Statistical analysis of clinical trial data using SAS and R programming.", "skip", "development"),
                 ("Intern - Research - Pathobiology - AI", "Build deep learning models that quantify tissue changes in whole-slide "
                  "images from preclinical studies; automate image analysis pipelines.", "publish", "discovery"),
                 ("Co-op, Cell Models and Molecular Biology", "Culture iPSC lines, run assays, analyze data in Excel.", "skip", "discovery")]
        for title, desc, decision, cat in cases:
            v = c.rules_classify(title, "X", desc)
            self.assertEqual((v.decision, v.category), (decision, cat), title)

    def test_cache_and_fallback(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "cache.json")
            clf = c.Classifier("rules", cache_path=path)
            fake = FakeD3({"computational": {"yes": 0.9, "no": 0.1}, "category": {"discovery": 0.6, "tech": 0.4}})
            clf.d3 = fake
            v1 = clf.classify("Intern", "Amgen", "text")
            v2 = clf.classify("Intern", "Amgen", "text")
            self.assertEqual((v1.backend, v1.category, fake.calls), ("d3", "discovery", 1))   # second answer from the cache
            self.assertEqual(v1, v2)
            clf.save()
            with open(path) as f:
                self.assertEqual(len(json.load(f)), 1)
            broken = c.Classifier("rules", cache_path=None)
            broken.d3 = mock.Mock(classify=mock.Mock(side_effect=RuntimeError("out of memory")))
            self.assertEqual(broken.classify("Data Science Intern", "Amgen", "Python and SQL").backend, "rules")

    def test_pipeline_title_beats_tech(self):
        # Gilead R0055519 / R0055526: AI-heavy roles inside a research team were filed under tech
        clf = c.Classifier("rules", cache_path=None)
        clf.d3 = FakeD3({"computational": {"yes": 0.9, "no": 0.1}, "category": {"tech": 0.7, "discovery": 0.3}})
        for title, cat in [("Intern - Research - Drug Metabolism - AI", "discovery"),
                           ("Intern - Research - Clinical Virology - AI", "development"),
                           ("AI Research Intern", "tech"), ("Software Engineering Intern", "tech")]:
            self.assertEqual(clf.classify(title, "Gilead", "Build AI agents and LLM workflows.").category, cat, title)
        for title, cat in [("Intern - Research - Drug Metabolism - AI", "discovery"),
                           ("Intern - Research - Clinical Virology - AI", "development")]:
            self.assertEqual(c.rules_classify(title, "Gilead", "Implement AI tools, models and agents.").category, cat, title)

    def test_unreachable_server_warns_and_uses_rules(self):
        for backend in ("auto", "d3"):
            with self.assertLogs("classify", "WARNING") as logs:
                clf = c.Classifier(backend, cache_path=None)
            self.assertEqual(clf.name, "rules")
            self.assertIn("isn't answering", logs.output[0])
            self.assertIn("d3 not used", clf.fallback_reason)


class Pipeline(unittest.TestCase):
    def postings(self):
        mk = lambda t, d: pi.Posting(company="Gilead Sciences", title=t, location="United States - California - Foster City",
                                     url="https://gilead.wd1.myworkdayjobs.com/gileadcareers/job/x/" + t.replace(" ", "_"),
                                     posted="2026-09-08", req_id="R1", description=d,
                                     extra={"country": "United States of America"})
        return [mk("Intern - Development - Pharmacometrics", "Build population PK/PD models in NONMEM and automate simulation workflows in Python."),
                mk("Intern - Translational Research Modeling", "Support modeling of preclinical data for target selection."),
                mk("Intern - PDM - Process Chemistry", "Bench-scale reactions and purification.")]

    def test_build_records(self):
        clf = c.Classifier("rules", cache_path=None)
        recs, report = pipeline.build_records(self.postings(), clf)
        self.assertEqual([r["decision"] for r in report], ["publish", "review", "skip"])
        self.assertEqual([r["title"] for r in recs if r.get("fit") != "no"], ["Intern - Development - Pharmacometrics", "Intern - Translational Research Modeling"])
        self.assertEqual([r["title"] for r in recs if r.get("fit") == "no"], ["Intern - PDM - Process Chemistry"])  # sent so the app can unlist it
        self.assertEqual(recs[0]["category"], "development")
        self.assertNotIn("review_reason", recs[0])
        self.assertIn("Unsure ML or computational automation is central", recs[1]["review_reason"])
        self.assertEqual(recs[0]["locations"], ["Foster City, CA"])
        self.assertEqual(recs[0]["company"], "gilead")

    def test_undergrad_only_left_out(self):
        mk = lambda t, d: pi.Posting(company="Gilead Sciences", title=t, url="https://x/" + t.replace(" ", "_"), description=d)
        ps = [mk("Co-op - Machine Learning, Drug Discovery", "Build ML models for target discovery. Open to undergraduates."),
              mk("Intern - Pharmacometrics", "Automate PK/PD modeling in Python. Currently pursuing a Bachelor's degree in data science."),
              mk("Intern - Pharmacometrics ML", "Automate PK/PD modeling in Python. Currently enrolled in a PhD or PharmD program.")]
        recs, report = pipeline.build_records(ps, c.Classifier("rules", cache_path=None))
        self.assertEqual([r["decision"] for r in report][:2], ["undergrad", "undergrad"])
        self.assertNotEqual(report[2]["decision"], "undergrad")
        self.assertEqual([r.get("fit") for r in recs][:2], ["no", "no"])   # so the app bins any already listed

    def test_token_from_env_file(self):
        with tempfile.TemporaryDirectory() as d:
            with open(os.path.join(d, ".env.local"), "w") as f:
                f.write('DATABASE_URL=postgres://x\nexport SCRAPER_INGEST_TOKEN="abc123"\n')
            with mock.patch.object(pipeline, "ROOT", d), mock.patch.dict(os.environ, {}, clear=True):
                self.assertEqual(pipeline.read_env(("AICD3_INGEST_TOKEN", "SCRAPER_INGEST_TOKEN")), "abc123")
            with mock.patch.object(pipeline, "ROOT", d), mock.patch.dict(os.environ, {"AICD3_INGEST_TOKEN": "env"}):
                self.assertEqual(pipeline.read_env(("AICD3_INGEST_TOKEN", "SCRAPER_INGEST_TOKEN")), "env")

    def test_end_to_end_with_a_fake_app(self):
        sent = {}

        def fake_post(url, data=None, headers=None, timeout=None):
            sent.update(url=url, body=json.loads(data), auth=headers["Authorization"])
            return mock.Mock(status_code=200, json=lambda: {"added": 1, "staged": 1, "updated": 0, "closed": 0,
                                                            "unchanged": 0, "rejected": 0, "errors": []})
        with tempfile.TemporaryDirectory() as d, \
                mock.patch.object(pi, "run", return_value=(self.postings(), {"Gilead Sciences": "ok (3)"})), \
                mock.patch.object(pipeline.requests, "post", side_effect=fake_post), \
                mock.patch.dict(os.environ, {"AICD3_INGEST_TOKEN": "t0k"}):
            code = pipeline.main(["--companies", "Gilead", "--classifier", "rules", "--no-check", "--out", d,
                                  "--url", "http://localhost:3000"])
            self.assertEqual(code, 0)
            self.assertEqual(sent["url"], "http://localhost:3000/api/ingest?dryRun=0&closeMissing=1&reviewAll=0")
            self.assertEqual(sent["auth"], "Bearer t0k")
            self.assertEqual(len(sent["body"]["postings"]), 3)
            self.assertEqual(sum(1 for r in sent["body"]["postings"] if r.get("fit") == "no"), 1)
            self.assertTrue(os.path.exists(os.path.join(d, "fit.csv")))


    def test_full_time_roles_end_to_end(self):
        sent = {}

        def fake_post(url, data=None, headers=None, timeout=None):
            if "kind=check" in url:   # the pipeline first checks the app keeps roles apart
                return mock.Mock(status_code=400, json=lambda: {"error": 'kind must be "internship" or "job"'})
            sent.update(url=url, body=json.loads(data))
            return mock.Mock(status_code=200, json=lambda: {"added": 1, "staged": 0, "updated": 0, "closed": 0,
                                                            "unchanged": 0, "rejected": 0, "errors": []})
        mk = lambda t, d: pi.Posting(company="Gilead Sciences", title=t, location="Foster City, CA", url="https://x/" + t[:12],
                                     description=d)
        roles = [mk("Data Scientist, Pharmacometrics", "Build population PK/PD models in Python. 3+ years of experience in modeling."),
                 mk("Scientist, Machine Learning", "Requires 8+ years of industry experience building ML models in Python.")]
        try:
            with tempfile.TemporaryDirectory() as d, \
                    mock.patch.object(pi, "run", return_value=(roles, {"Gilead Sciences": "ok (2)"})), \
                    mock.patch.object(pipeline.requests, "post", side_effect=fake_post), \
                    mock.patch.object(c.Classifier, "save"), \
                    mock.patch.dict(os.environ, {"AICD3_INGEST_TOKEN": "t0k", "ROLES_PROFILE": os.path.join(d, "none.json")}):
                code = pipeline.main(["--kind", "job", "--companies", "Gilead", "--classifier", "rules", "--out", d,
                                      "--url", "http://localhost:3000"])
                self.assertEqual(pi.MODE, "job")
        finally:
            pi.set_mode("internship")
            pi.set_job_search()
        self.assertEqual(code, 0)
        self.assertEqual(sent["url"], "http://localhost:3000/api/ingest?dryRun=0&closeMissing=1&reviewAll=0&kind=job")
        self.assertEqual([r["title"] for r in sent["body"]["postings"]], ["Data Scientist, Pharmacometrics"])  # 8+ years left out
        self.assertEqual((sent["body"]["postings"][0]["level"], sent["body"]["postings"][0]["term"]), ("mid", "Full-time"))
        self.assertIsInstance(sent["body"]["postings"][0]["score"], int)

    def test_full_time_roles_with_a_candidate_profile(self):
        import roles_profile
        sent = {}

        def fake_post(url, data=None, headers=None, timeout=None):
            if "kind=check" in url:
                return mock.Mock(status_code=400, json=lambda: {"error": 'kind must be "internship" or "job"'})
            sent.update(body=json.loads(data))
            return mock.Mock(status_code=200, json=lambda: {"added": 1, "staged": 0, "updated": 0, "closed": 0,
                                                            "unchanged": 0, "rejected": 0, "errors": []})
        roles = [pi.Posting(company="Gilead Sciences", title="Scientist, ADMET Modeling", location="Foster City, CA",
                            url="https://x/admet", description="Build GNN models for ADME endpoints in PyTorch.")]
        made = {}
        real = c.Classifier

        def spy(*a, **k):
            made["clf"] = real(*a, **k)
            return made["clf"]
        try:
            with tempfile.TemporaryDirectory() as d:
                prof = os.path.join(d, "p.json")
                with open(prof, "w") as f:
                    json.dump({"summary": "Builds graph neural networks for ADMET prediction.", "terms": ["ADMET"],
                               "title_words": ["admet"]}, f)
                with mock.patch.object(pi, "run", return_value=(roles, {"Gilead Sciences": "ok (1)"})), \
                        mock.patch.object(pipeline.requests, "post", side_effect=fake_post), \
                        mock.patch.object(pipeline, "Classifier", side_effect=spy), \
                        mock.patch.object(c.Classifier, "save"), \
                        mock.patch.dict(os.environ, {"AICD3_INGEST_TOKEN": "t0k", "ROLES_PROFILE": prof}):
                    code = pipeline.main(["--kind", "job", "--companies", "Gilead", "--classifier", "rules", "--out", d,
                                          "--url", "http://localhost:3000"])
                self.assertEqual(code, 0)
                self.assertEqual(pi.JOB_SEARCH, ["admet"])          # the profile's search terms replace the defaults
                self.assertTrue(pi.is_target_role("Associate Scientist, ADMET"))
                self.assertEqual(made["clf"].profile.terms, ["admet"])
                # a bad profile stops the run before scraping, without printing its contents
                with open(prof, "w") as f:
                    json.dump({"summary": "Reach me at someone@example.com"}, f)
                with mock.patch.dict(os.environ, {"AICD3_INGEST_TOKEN": "t0k", "ROLES_PROFILE": prof}):
                    self.assertEqual(pipeline.main(["--kind", "job", "--classifier", "rules", "--out", d, "--url", "http://x"]), 1)
        finally:
            pi.set_mode("internship")
            pi.set_job_search()


    def test_full_time_roles_never_run_against_an_app_without_them(self):
        posted = []
        old_app = lambda url, data=None, headers=None, timeout=None: posted.append(url) or mock.Mock(
            status_code=200, json=lambda: {"added": 0, "staged": 0, "updated": 0, "closed": 0, "unchanged": 0, "rejected": 0, "errors": []})
        scraped = mock.Mock(return_value=([], {}))
        try:
            with tempfile.TemporaryDirectory() as d, mock.patch.object(pi, "run", scraped), \
                    mock.patch.object(pipeline.requests, "post", side_effect=old_app), \
                    mock.patch.dict(os.environ, {"AICD3_INGEST_TOKEN": "t0k", "ROLES_PROFILE": os.path.join(d, "none.json")}):
                code = pipeline.main(["--kind", "job", "--classifier", "rules", "--out", d, "--url", "http://old.app"])
        finally:
            pi.set_mode("internship")
            pi.set_job_search()
        self.assertEqual(code, 1)
        self.assertFalse(scraped.called)                       # stopped before scraping
        self.assertEqual(len(posted), 1)                       # only the check; nothing imported
        self.assertIn("kind=check", posted[0])


class RequireD3(unittest.TestCase):
    """The GPU PC's scheduled refresh (--require-d3): only d3 decides."""
    postings = Pipeline.postings

    def run_main(self, d3=None, fail_d3=False):
        posted = []
        fake_post = lambda url, data=None, headers=None, timeout=None: posted.append(url) or mock.Mock(
            status_code=200, json=lambda: {"added": 0, "staged": 0, "updated": 0, "closed": 0, "unchanged": 0, "rejected": 0, "errors": []})
        scraped = mock.Mock(return_value=(self.postings(), {"Gilead Sciences": "ok (3)"}))
        patches = [mock.patch.object(pi, "run", scraped), mock.patch.object(pipeline.requests, "post", side_effect=fake_post),
                   mock.patch.dict(os.environ, {"AICD3_INGEST_TOKEN": "t0k"})]
        if d3 is not None:
            patches.append(mock.patch.object(c, "D3", return_value=d3))
        with tempfile.TemporaryDirectory() as out:
            for p in patches:
                p.start()
            try:
                with mock.patch.object(c, "CACHE_PATH", None), mock.patch.object(c.Classifier, "save"):
                    code = pipeline.main(["--require-d3", "--no-check", "--out", out, "--url", "http://localhost:3000"])
            finally:
                for p in reversed(patches):
                    p.stop()
        return code, scraped.called, posted

    def test_d3_down_stops_before_scraping_and_changes_nothing(self):
        code, scraped, posted = self.run_main()   # module-level patch: d3 unreachable
        self.assertEqual((code, scraped, posted), (1, False, []))

    def test_d3_failing_partway_imports_nothing(self):
        d3 = mock.Mock(model="vllm-sr/d3@abc", classify=mock.Mock(side_effect=RuntimeError("CUDA out of memory")))
        with mock.patch.object(pipeline, "build_records", wraps=pipeline.build_records):
            clf_failures = 5
            with mock.patch.object(c.Classifier, "classify", autospec=True,
                                   side_effect=lambda self, *a: setattr(self, "d3_failures", clf_failures) or c.rules_classify(*a[:3])):
                code, scraped, posted = self.run_main(d3=d3)
        self.assertEqual((code, scraped, posted), (1, True, []))

    def test_postings_d3_could_not_answer_go_to_review(self):
        clf = c.Classifier("rules", cache_path=None)
        clf.d3 = FakeD3({"computational": {"yes": 0.9, "no": 0.1}, "category": {"discovery": 0.9, "tech": 0.1}})
        real = clf.d3.classify
        clf.d3.classify = lambda t, *a: (_ for _ in ()).throw(RuntimeError("timeout")) if "Process" in t else real(t, *a)
        recs, report = pipeline.build_records(self.postings(), clf, require_d3=True)
        by = {r["title"]: r for r in recs}
        held = by["Intern - PDM - Process Chemistry"]   # rules alone would have said skip (fit: no -> bin)
        self.assertEqual(held.get("review_reason"), pipeline.D3_HELD)
        self.assertNotIn("fit", held)
        self.assertNotIn("review_reason", by["Intern - Development - Pharmacometrics"])   # d3 answered: published as usual
        self.assertEqual([r["decision"] for r in report], ["publish", "publish", "review"])



class LiveRouting(unittest.TestCase):
    """While d3 answers, the Admin page sees where postings have gone so far (progress.routing)."""

    def test_counts_cached_answers_first_then_each_new_one(self):
        clf = c.Classifier("rules", cache_path=None)
        clf.d3 = FakeD3({"computational": {"yes": 0.9, "no": 0.1}, "category": {"discovery": 0.9, "tech": 0.1}})
        ps = Pipeline.postings(None)
        clf.classify(ps[0].title, ps[0].company, ps[0].description, pipeline.where(ps[0]))   # answered on an earlier run
        undergrad = pi.Posting(company="Gilead Sciences", title="Undergraduate Co-op - Data Science", url="https://x/u",
                               description="Open to undergraduates only.")
        seen = []
        pipeline.build_records(ps + [undergrad], clf, on_routing=lambda t, pending, last: seen.append((t, pending, last)))
        first, final = seen[0], seen[-1]
        self.assertEqual((first[0]["publish"], first[0]["undergrad"], first[1], first[2]), (1, 1, 2, None))
        self.assertEqual(final[1], 0)
        self.assertEqual(final[0]["publish"], 3)
        self.assertEqual(final[2]["to"], "publish")
        self.assertEqual(len(seen), 3)   # the first report, then one per new answer

    def test_route_of(self):
        self.assertEqual(pipeline.route_of(c.Verdict(0.9, "tech", 1, "d3")), "publish")
        self.assertEqual(pipeline.route_of(c.Verdict(0.9, "discovery", 1, "d3", undergrad=0.8)), "undergrad")
        self.assertEqual(pipeline.route_of(c.Verdict(0.9, "discovery", 1, "d3", us=0.1)), "not_us")
        self.assertEqual(pipeline.route_of(c.Verdict(0.1, "other", 1, "d3")), "skip")
        self.assertEqual(pipeline.route_of(c.Verdict(0.1, "other", 1, "rules"), require_d3=True), "review")



class AdminDialogInStep(unittest.TestCase):
    def test_thresholds_match_lib_d3_routing(self):
        # the Admin page's "How d3 routes" dialog shows these numbers (lib/d3-routing.ts)
        import re
        ts = open(os.path.join(os.path.dirname(__file__), "..", "lib", "d3-routing.ts"), encoding="utf-8").read()
        for name in ("FIT_MIN", "REVIEW_MIN", "UNDERGRAD_SKIP", "UNDERGRAD_REVIEW", "US_SKIP", "US_REVIEW", "QUESTIONS_V"):
            m = re.search(rf"\b{name}: ([0-9.]+)", ts)
            self.assertIsNotNone(m, name)
            self.assertEqual(float(m.group(1)), float(getattr(c, name)), f"{name} differs between classify.py and lib/d3-routing.ts")



if __name__ == "__main__":
    unittest.main()
