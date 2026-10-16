"""Offline tests for the d3 server and classifying through it (a stand-in model, no GPU, no download)."""
import json
import os
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from unittest import mock

import requests

import classify as c
import d3_server
import pharma_internships as pi
import pipeline

# never report test runs to a real app (the PC running these tests may have the app up on :3000)
os.environ["AICD3_PROGRESS"] = "off"

os.environ.setdefault("AICD3_LOG_FILE", os.path.join(tempfile.mkdtemp(prefix="aicd3-test-logs-"), "pipeline-test.log"))


def answers(fit=0.9, cat=None, undergrad=0.05, us=0.97):
    """Answers in the shape the d3 family returns: named after the question type."""
    cat = cat or {"discovery": 0.7, "development": 0.2, "tech": 0.05, "other": 0.05}
    return {"computational": {"type": "noul", "noul": fit},
            "category": {"type": "choice", "choice": cat},
            "level": {"type": "choice", "choice": {"graduate": 1 - undergrad, "undergrad_only": undergrad}},
            "us": {"type": "noul", "noul": us}}


class FakeModel:
    """Stands in for d3_server.Model: answers by keyword in the posting text, records what it was asked."""
    name, revision, device, gpu, loaded_at = "vllm-sr/d3", "0123456789abcdef", "cuda", "NVIDIA RTX PRO 6000", "now"

    def __init__(self):
        self.asked = []

    def ask(self, state, questions):
        self.asked.append((state, questions))
        if "BOOM" in state:
            raise RuntimeError("CUDA out of memory")
        if "seniority" in questions:   # full-time roles
            a = {k: v for k, v in answers().items() if k != "level"}
            seniority = ({"entry": 0.05, "mid": 0.05, "senior": 0.9} if "decade" in state else
                         {"entry": 0.2, "mid": 0.3, "senior": 0.5} if "maybe senior" in state else
                         {"entry": 0.2, "mid": 0.7, "senior": 0.1} if "a few years" in state else
                         {"entry": 0.8, "mid": 0.15, "senior": 0.05})
            a["seniority"] = {"type": "choice", "choice": seniority}
            if "bench" in state:
                a["computational"] = {"type": "noul", "noul": 0.2}
            return a
        if "Undergraduates" in state:
            return answers(undergrad=0.9)
        if "Basel" in state:
            return answers(us=0.05)
        if "maybe US" in state:
            return answers(us=0.45)
        if "bench" in state:
            return answers(fit=0.2)
        return answers()


class Server:
    """The real d3_server HTTP handler around FakeModel, on a free localhost port."""

    def __init__(self, token=""):
        self.token = token

    def __enter__(self):
        self.model = FakeModel()
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), d3_server.make_handler(self.model, self.token))
        self.url = f"http://127.0.0.1:{self.httpd.server_address[1]}"
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        return self

    def __exit__(self, *exc):
        self.httpd.shutdown()
        self.httpd.server_close()


class ServerEndpoints(unittest.TestCase):
    def test_health_and_answers(self):
        with Server() as s:
            h = requests.get(s.url + "/health", timeout=5).json()
            self.assertEqual((h["ok"], h["model"], h["device"]), (True, "vllm-sr/d3", "cuda"))
            r = requests.post(s.url + "/v1/systemone", timeout=5, json={
                "state": "Intern", "questions": {"fit": {"type": "noul", "instructions": "Fit?"}}})
            self.assertEqual(r.status_code, 200)
            self.assertEqual(r.json()["answers"]["computational"]["noul"], 0.9)

    def test_bad_requests_are_refused_and_errors_reported(self):
        with Server() as s:
            post = lambda body: requests.post(s.url + "/v1/systemone", json=body, timeout=5)
            q = {"fit": {"type": "noul", "instructions": "Fit?"}}
            self.assertEqual(post({"state": "", "questions": q}).status_code, 400)
            self.assertEqual(post({"state": "x", "questions": {}}).status_code, 400)
            self.assertEqual(post({"state": "x", "questions": {"a": {"type": "essay", "instructions": "?"}}}).status_code, 400)
            r = post({"state": "x", "questions": q, "images": ["http://169.254.169.254/"]})
            self.assertEqual(r.status_code, 400)   # text only: the server never fetches URLs
            self.assertIn("no images", r.json()["error"])
            r = post({"state": "BOOM", "questions": q})
            self.assertEqual(r.status_code, 500)
            self.assertIn("out of memory", r.json()["error"])
            self.assertEqual(requests.get(s.url + "/v1/systemone", timeout=5).status_code, 404)
            self.assertEqual(requests.post(s.url + "/v1/systemone", data="x" * 10, timeout=5).status_code, 400)

    def test_jsonable(self):
        class Scalar:
            def item(self):
                return 0.25
        self.assertEqual(d3_server.jsonable({"a": (Scalar(), 1), 2: None}), {"a": [0.25, 1], "2": None})

    def test_only_localhost_without_allow_remote(self):
        with mock.patch.object(d3_server, "setting", side_effect=lambda n, d="": d), self.assertRaises(SystemExit):
            d3_server.main(["--host", "0.0.0.0"])

    def test_short_token_refused(self):
        with mock.patch.object(d3_server, "setting", side_effect=lambda n, d="": "short" if n == "D3_TOKEN" else d), \
                self.assertRaises(SystemExit):
            d3_server.main(["--host", "0.0.0.0"])

    def test_other_computers_need_the_token(self):
        token = "k" * 40
        q = {"fit": {"type": "noul", "instructions": "Fit?"}}
        with Server(token) as s, mock.patch.object(d3_server, "LOOPBACK", ()):   # treat this test as another computer
            self.assertEqual(requests.get(s.url + "/health", timeout=5).status_code, 401)
            self.assertEqual(requests.post(s.url + "/v1/systemone", json={"state": "x", "questions": q}, timeout=5).status_code, 401)
            bad = {"Authorization": "Bearer " + "x" * 40}
            self.assertEqual(requests.get(s.url + "/health", headers=bad, timeout=5).status_code, 401)
            ok = {"Authorization": "Bearer " + token}
            self.assertEqual(requests.get(s.url + "/health", headers=ok, timeout=5).status_code, 200)
            # the classifier sends D3_TOKEN from .env.local
            with mock.patch.object(c, "env", side_effect=lambda n: {"D3_URL": s.url, "D3_TOKEN": token}.get(n, "")):
                self.assertEqual(c.Classifier("auto", cache_path=None).name, "d3")
            with mock.patch.object(c, "env", side_effect=lambda n: {"D3_URL": s.url, "D3_TOKEN": "nope"}.get(n, "")):
                with self.assertRaisesRegex(ConnectionError, "D3_TOKEN"):
                    c.D3()
        with Server(token) as s:   # this computer itself needs no token
            self.assertEqual(requests.get(s.url + "/health", timeout=5).status_code, 200)

    def test_unreachable_remote_d3_says_what_to_check(self):
        with mock.patch.object(c, "env", side_effect=lambda n: {"D3_URL": "http://192.0.2.1:9"}.get(n, "")), \
                mock.patch("requests.Session.get", side_effect=requests.exceptions.ConnectTimeout("t")):
            with self.assertRaisesRegex(ConnectionError, "GPU PC on and awake"):
                c.D3()


class ClassifyThroughServer(unittest.TestCase):
    def classifier(self, s):
        with mock.patch.object(c, "env", side_effect=lambda n: s.url if n == "D3_URL" else ""):
            return c.Classifier("auto", cache_path=None)

    def test_classifier_uses_the_server(self):
        with Server() as s:
            clf = self.classifier(s)
            self.assertEqual(clf.name, "d3")
            self.assertEqual(clf.d3.model, "vllm-sr/d3@0123456789ab")
            v = clf.classify("ML Intern", "Genentech", "Build models", "South San Francisco, CA")
            self.assertEqual((v.backend, v.category, v.decision, v.us, v.undergrad), ("d3", "discovery", "publish", 0.97, 0.05))
            state, questions = s.model.asked[-1]
            self.assertIn("Location: South San Francisco, CA", state)
            self.assertEqual(set(questions), {"computational", "category", "level", "us"})
            self.assertIn("AICD3", questions["computational"]["instructions"])
            self.assertEqual(set(questions["level"]["criteria"]), {"graduate", "undergrad_only"})
            clf.classify("ML Intern", "Genentech", "Build models", "South San Francisco, CA")
            self.assertEqual(len(s.model.asked), 1)   # answered from the cache

    def test_server_stopping_mid_run_falls_back_to_rules(self):
        with Server() as s:
            clf = self.classifier(s)
        # the server is gone now
        with self.assertLogs("classify", "WARNING"):
            got = [clf.classify(f"Data Science Intern {i}", "Amgen", "Python and SQL").backend for i in range(7)]
        self.assertEqual(set(got), {"rules"})
        self.assertEqual(clf.d3_failures, 5)   # stops asking after five failures
        self.assertIn("5 d3 requests failed", clf.fallback_reason)

    def test_pipeline_eligibility_and_reasons(self):
        mk = lambda t, d, loc="Foster City, CA": pi.Posting(company="Gilead Sciences", title=t, location=loc,
                                                           url="https://x/" + t.replace(" ", "_"), description=d)
        ps = [mk("Intern - Pharmacometrics ML", "Automate PK/PD modeling in Python. PhD students welcome."),
              mk("Intern - Computational Biology", "Undergraduates in their junior year build models."),
              mk("Intern - ML for Chemistry", "Build GNNs for molecules.", loc="Basel, Switzerland"),
              mk("Intern - Data Science", "Build models; maybe US or Canada."),
              mk("Intern - Process Chemistry", "bench work only")]
        with Server() as s:
            clf = self.classifier(s)
            recs, report = pipeline.build_records(ps, clf)
        self.assertEqual([r["decision"] for r in report], ["publish", "undergrad", "not_us", "review", "skip"])
        self.assertEqual([r.get("fit") for r in recs], [None, "no", "no", None, "no"])
        self.assertIn("Unsure it's in the US (45% by d3)", recs[3]["review_reason"])
        self.assertEqual(report[0]["us_p"], 0.97)


class FullTimeRoles(unittest.TestCase):
    def classifier(self, s):
        with mock.patch.object(c, "env", side_effect=lambda n: s.url if n == "D3_URL" else ""):
            return c.Classifier("auto", cache_path=None, job=True)

    def test_job_questions_and_levels(self):
        mk = lambda t, d: pi.Posting(company="Genentech", title=t, location="South San Francisco, CA",
                                     url="https://x/" + t.replace(" ", "_"), description=d)
        ps = [mk("Data Scientist, Pharmacometrics", "New grads welcome. Build PK/PD models."),
              mk("Scientist II, Computational Biology", "a few years of omics work"),
              mk("Scientist, Machine Learning", "a decade leading ML teams"),
              mk("Statistician", "maybe senior"),
              mk("Scientist, Process Chemistry", "bench work only")]
        with Server() as s:
            clf = self.classifier(s)
            recs, report = pipeline.build_records(ps, clf, job=True)
            state, questions = s.model.asked[0]
        self.assertTrue(state.startswith("Role title: Data Scientist"))
        self.assertEqual(set(questions), {"computational", "category", "seniority", "us"})
        self.assertIn("recent graduate", questions["computational"]["instructions"])
        self.assertEqual([r["decision"] for r in report], ["publish", "publish", "skip", "review", "skip"])
        self.assertEqual([r.get("level") for r in recs[:2]], ["entry", "mid"])
        self.assertEqual(recs[0]["term"], "Full-time")
        self.assertEqual(recs[2]["fit"], "no")
        self.assertIn("May need more than 5 years (50% by d3)", recs[3]["review_reason"])

    def test_job_answers_are_cached_apart_from_internship_ones(self):
        with Server() as s:
            with mock.patch.object(c, "env", side_effect=lambda n: s.url if n == "D3_URL" else ""):
                intern, job = c.Classifier("auto", cache_path=None), c.Classifier("auto", cache_path=None, job=True)
            self.assertNotEqual(intern._key("ML", "Amgen", "x", "CA"), job._key("ML", "Amgen", "x", "CA"))

    def test_llm_is_refused_for_jobs(self):
        with self.assertRaises(ValueError):
            c.Classifier("llm", cache_path=None, job=True)

    def test_rules_fallback_levels(self):
        clf = c.Classifier("rules", cache_path=None, job=True)
        self.assertEqual(clf.classify("Data Scientist", "Amgen", "Requires 3+ years of experience in Python").level, "mid")
        self.assertEqual(clf.classify("Data Scientist", "Amgen", "PhD with 0-2 years of experience").level, "entry")


class EligibilityDecisions(unittest.TestCase):
    def v(self, **kw):
        return c.Verdict(**{"computational": 0.9, "category": "discovery", "category_p": 0.8, "backend": "d3", **kw})

    def test_undergrad_and_us(self):
        self.assertEqual([self.v(undergrad=p).decision for p in (0.1, 0.39, 0.4, 0.59, 0.6, 0.95)],
                         ["publish", "publish", "review", "review", "skip", "skip"])
        self.assertEqual([self.v(us=p).decision for p in (0.95, 0.6, 0.59, 0.3, 0.29, 0.0)],
                         ["publish", "publish", "review", "review", "skip", "skip"])
        self.assertEqual(self.v(us=0.1).skip_reason, "not in the US")
        self.assertEqual(self.v(undergrad=0.9).skip_reason, "undergraduate only")

    def test_not_asked_means_no_eligibility_effect(self):
        # rules and Claude don't answer these (-1); the scraper's keyword checks still apply to them
        self.assertEqual(self.v(backend="rules").decision, "publish")

    def test_unclear_eligibility_never_rescues_a_poor_fit(self):
        self.assertEqual(self.v(computational=0.2, us=0.5).decision, "skip")

    def test_review_reason_lists_every_doubt(self):
        r = self.v(computational=0.5, undergrad=0.45, us=0.5).review_reason()
        self.assertIn("Unsure graduate students can apply (45% undergraduate-only by d3)", r)
        self.assertIn("Unsure it's in the US (50% by d3)", r)
        self.assertIn("Unsure ML or computational automation is central (50% by d3; 60% needed to publish)", r)

    def test_old_cache_entries_still_load(self):
        old = {"computational": 0.7, "category": "tech", "category_p": 0.6, "backend": "rules", "note": "",
               "summary": "", "resp": [], "quals": []}
        self.assertEqual(c.Verdict(**old).decision, "publish")


if __name__ == "__main__":
    unittest.main()
