"""Offline tests for classify.py and pipeline.py (no model download, no network)."""
import json
import os
import tempfile
import unittest
from unittest import mock

import classify as c
import pharma_internships as pi
import pipeline

# pipeline.main() writes a run log; keep the tests' logs out of the real scraper/out/logs/
os.environ["AICD3_LOG_FILE"] = os.path.join(tempfile.mkdtemp(prefix="aicd3-test-logs-"), "pipeline-test.log")


# Never reach Claude from the tests, even on a machine whose .env.local has the settings
_no_llm = mock.patch.object(c, "llm_configured", return_value=False)


def setUpModule():
    _no_llm.start()


def tearDownModule():
    _no_llm.stop()


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
        # auto: one clear warning, then keyword rules for the run (no per-posting failures)
        llm = mock.Mock(model="m", needs_vpn=True, reachable=mock.Mock(return_value=(False, "couldn't connect. " + c.VPN_HINT)))
        with mock.patch.object(c, "llm_configured", return_value=True), mock.patch.object(c, "LLM", return_value=llm), \
                self.assertLogs("classify", "WARNING") as logs:
            clf = c.Classifier("auto", cache_path=None)
        self.assertEqual(clf.name, "rules")
        self.assertTrue(any("UCSF VPN" in m for m in logs.output))
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

    def test_auto_uses_claude_when_configured(self):
        with mock.patch.object(c, "llm_configured", return_value=True), mock.patch.object(c, "LLM") as llm:
            llm.return_value.model = "m"
            llm.return_value.reachable.return_value = (True, "")
            self.assertEqual(c.Classifier("auto", cache_path=None).name, "llm")


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
    def __init__(self, answers):
        self.answers, self.calls = answers, 0

    def classify(self, title, company, description):
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

    def test_auto_falls_back_when_the_model_cant_load(self):
        with mock.patch.object(c, "D3", side_effect=ImportError("No module named 'torch'")):
            self.assertEqual(c.Classifier("auto", cache_path=None).name, "rules")
            with self.assertRaises(ImportError):
                c.Classifier("d3", cache_path=None)


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


if __name__ == "__main__":
    unittest.main()
