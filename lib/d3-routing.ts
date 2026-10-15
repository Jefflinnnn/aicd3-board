/**
 * How the scraper's classifier decides, for the Admin page's "How d3 routes" dialog. These mirror the thresholds
 * in scraper/classify.py; scraper/test_pipeline.py fails if the two drift apart.
 */
export const D3_RULES = {
  FIT_MIN: 0.6,
  REVIEW_MIN: 0.45,
  UNDERGRAD_SKIP: 0.6,
  UNDERGRAD_REVIEW: 0.4,
  US_SKIP: 0.3,
  US_REVIEW: 0.6,
  QUESTIONS_V: 4,
} as const

/** The four questions d3 answers about every posting (scraper/classify.py: COMPUTATIONAL_Q, CATEGORY_Q, LEVEL_Q, US_Q). */
export const D3_QUESTIONS: { key: string; name: string; asks: string; answers: string }[] = [
  {
    key: "computational", name: "AICD3 fit",
    asks: "Is this internship a good fit for a student in UCSF's AICD3 master's program, because machine learning, AI or computational work is central to it (building or applying models, computational chemistry or biology, bioinformatics, modeling and simulation such as PK/PD, clinical or real-world data science, software that automates scientific work)? No when the computational part is only spreadsheets, dashboards, reporting or IT support, or the role is mainly bench work, manufacturing, operations, sales or business.",
    answers: "Probability of yes",
  },
  {
    key: "category", name: "Pipeline area",
    asks: "Which part of the pharmaceutical pipeline does it belong to? Discovery (before clinical trials), development (during clinical trials), tech (not tied to a drug stage) or other. AI and ML applied inside a research or clinical team counts as discovery or development, not tech.",
    answers: "A probability for each area",
  },
  {
    key: "level", name: "Who can apply",
    asks: "Can graduate or professional students apply (master's, PhD, PharmD, MD, any university student, or no limit), or only undergraduate, community-college or high-school students?",
    answers: "A probability for each",
  },
  {
    key: "us", name: "In the US",
    asks: "Is it based in the United States, or remote from within the US? Yes when at least one location is in the US.",
    answers: "Probability of yes",
  },
]
