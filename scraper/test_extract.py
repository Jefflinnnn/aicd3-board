"""Offline tests for the split -> Claude -> merge steps."""
import json
import os
import tempfile
import unittest

import extract
import pharma_internships as pi


class SplitMerge(unittest.TestCase):
    def test_round_trip_and_validation(self):
        posts = [
            pi.Posting(company="Amgen", title="Summer 2027 Intern - Data Science", location="US - California - Thousand Oaks",
                       url="https://amgen.wd1.myworkdayjobs.com/Careers/job/A_R-1", posted="Posted 2 Days Ago",
                       description="Join us.\n\nWhat You Will Do\n• Build models\n\nPay is $40 per hour.", pay="$40 per hour"),
            pi.Posting(company="Pfizer", title="Director, Intern Programs", location="US - New York",
                       url="https://pfizer.wd1.myworkdayjobs.com/PfizerCareers/job/B_1", description="Lead the programme."),
            pi.Posting(company="Merck", title="Co-op, Process Development", location="Rahway, NJ",
                       url="https://msd.wd5.myworkdayjobs.com/SearchJobs/job/C_1", description="Spring co-op."),
        ]
        with tempfile.TemporaryDirectory() as d:
            stem = os.path.join(d, "raw")
            pi.write_outputs(posts, stem)
            pi.write_import(posts, os.path.join(d, "base.json"))
            bdir = os.path.join(d, "batches")
            extract.split(stem + ".json", bdir, 2)
            self.assertEqual(sorted(os.listdir(bdir)), ["batch_01.json", "batch_02.json"])
            b1 = json.load(open(os.path.join(bdir, "batch_01.json")))
            k0, k1 = b1[0]["key"], b1[1]["key"]
            with open(os.path.join(bdir, "batch_01.out.jsonl"), "w") as f:
                f.write(json.dumps({"key": k0, "is_internship": True, "category": "tech", "summary": "Build ML models.",
                                    "responsibilities": ["Train models"], "qualifications": ["Python"],
                                    "term": "Summer 2027", "mode": "Onsite", "pay": "$40 per hour",
                                    "deadline": "not a date", "extra": "ignored"}) + "\n")
                f.write("this line is broken\n")
                f.write(json.dumps({"key": k1, "is_internship": False, "category": "made-up"}) + "\n")
            out = os.path.join(d, "import.json")
            extract.merge(os.path.join(d, "base.json"), bdir, out, keep_non_interns=False)
            got = json.load(open(out))["postings"]
            self.assertEqual(len(got), 2)                       # the Director role was left out
            amgen = next(p for p in got if p["company"] == "amgen")
            self.assertEqual(amgen["category"], "tech")
            self.assertEqual(amgen["description"], "Build ML models.")
            self.assertEqual(amgen["deadline"], "")             # invalid date ignored
            self.assertNotIn("key", amgen)
            merck = next(p for p in got if p["company"] == "merck")
            self.assertEqual(merck["category"], "development")  # no extraction: scraper's own guess
            self.assertIn("Director, Intern Programs", open(os.path.join(d, "import.report.txt")).read())


if __name__ == "__main__":
    unittest.main()
