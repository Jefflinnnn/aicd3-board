"""Offline tests for classify.py and pipeline.py (no model download, no network)."""
import json
import os
import tempfile
import unittest
from unittest import mock

import classify as c
import pharma_internships as pi
import pipeline


class AnswerShapes(unittest.TestCase):
    """d3-flash's card doesn't pin down the answer format, so accept the plausible ones."""

    def test_yes_no(self):
        for ans in ({"probabilities": {"yes": 0.8, "no": 0.2}}, {"yes": 0.8, "no": 0.2}, {"Yes": 0.8},
                    {"no": 0.2}, [{"label": "yes", "probability": 0.8}, {"label": "no", "probability": 0.2}],
                    {"answer": "yes", "probabilities": {"true": 0.8, "false": 0.2}}):
            self.assertAlmostEqual(c.p_yes(ans), 0.8, msg=repr(ans))
        with self.assertRaises(ValueError):
            c.p_yes({"maybe": 1.0})

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
