/**
 * Checks that decide whether a scraped posting goes straight to students or waits for staff review.
 * They look for the usual signs that a scrape picked up something other than an internship:
 * a title that isn't an internship, senior or full-time wording, experience requirements,
 * and descriptions too thin to judge.
 */
import type { Job, StagedJob } from "./data"

const INTERNISH = /\b(intern(ship)?s?|co-?op|summer (student|associate|scholar|program)|trainee|apprentice(ship)?|fellow(ship)?)\b/i
const SENIOR = /\b(senior|sr\.?|principal|staff|lead|manager|director|head of|vp|vice president|full[- ]?time|permanent|post-?doc(toral)?)\b/i
const YEARS = /(\d+)\s*\+?\s*(?:or more\s+)?years?(?:['’]s?)?\s+(?:of\s+)?(?:industry\s+|relevant\s+|professional\s+|post-?doctoral\s+|related\s+)?(?:work\s+)?experience/i

export function reviewFlags(j: Job, opts: { catUnmatched?: boolean } = {}): string[] {
  const flags: string[] = []
  if (!INTERNISH.test(j.title)) flags.push("Title doesn't say internship or co-op")
  if (SENIOR.test(j.title)) flags.push("Title reads like a senior or full-time role")
  const text = [j.summary, ...j.quals, ...j.resp].join(" ")
  const yrs = YEARS.exec(text)
  if (yrs && +yrs[1] >= 2) flags.push(`Asks for ${yrs[1]}+ years of experience`)
  if (/\b(ph\.?d\.?|doctorate)\b[^.]{0,30}\brequired\b/i.test(text)) flags.push("Requires a completed PhD")
  const len = j.summary.trim().length
  if (len < 80) flags.push(len ? "Description is very short" : "No description")
  if (!j.resp.length && !j.quals.length) flags.push("No responsibilities or qualifications listed")
  if (opts.catUnmatched) flags.push("Category couldn't be matched, filed under Other")
  return flags
}

export const stage = (j: Job, flags: string[], source: StagedJob["review"]["source"]): StagedJob => ({
  ...j,
  review: { flags, source, at: Date.now(), status: "pending" },
})

/** The posting as students will see it once approved. */
export const unstage = (s: StagedJob): Job => {
  const { review: _r, ...job } = s // eslint-disable-line @typescript-eslint/no-unused-vars
  return { ...job, addedAt: Date.now() }
}

/** Sample queue for preview copies, so the review area has something to show. */
export function seedStaged(): StagedJob[] {
  const now = Date.now()
  const base = { term: "Summer 2027", mode: "Onsite", pay: "", sample: true, posted: new Date(now - 2 * 864e5).toISOString().slice(0, 10) }
  const list: Job[] = [
    { ...base, id: "s-amgen-sci", title: "Scientist I, Protein Sciences", company: "amgen", location: "Thousand Oaks, CA", locations: ["Thousand Oaks, CA"], category: "discovery", deadline: "", url: "https://careers.amgen.com", summary: "Join the Protein Sciences team to design and characterize biologics for early discovery programs across therapeutic areas.", resp: ["Run protein expression and purification", "Present results to project teams"], quals: ["PhD in biochemistry or related field", "3+ years of industry experience"], addedAt: now - 2 * 864e5 },
    { ...base, id: "s-vertex-summer", title: "Summer Opportunity", company: "vertex", location: "Boston, MA", locations: ["Boston, MA"], category: "other", deadline: "", url: "https://www.vrtx.com/careers", summary: "Join our team this summer.", resp: [], quals: [], addedAt: now - 864e5 },
    { ...base, id: "s-pfizer-mgr", title: "Manager, University Relations Intern Program", company: "pfizer", location: "New York, NY", locations: ["New York, NY"], category: "other", deadline: "2026-11-30", url: "https://www.pfizer.com/about/careers", summary: "Lead the planning and delivery of Pfizer's summer intern program, from recruiting through end-of-summer presentations.", resp: ["Own intern recruiting calendar", "Manage program vendors"], quals: ["5+ years of experience in early-career recruiting"], addedAt: now - 864e5 },
    { ...base, id: "s-insitro-data", title: "Data Intern", company: "insitro", location: "South San Francisco, CA", locations: ["South San Francisco, CA"], category: "other", deadline: "2026-12-15", url: "https://www.insitro.com/careers", summary: "Work with data.", resp: ["Clean datasets"], quals: [], addedAt: now - 3 * 36e5 },
  ]
  return [
    stage(list[0], reviewFlags(list[0]), "import"),
    stage(list[1], reviewFlags(list[1], { catUnmatched: true }), "import"),
    stage(list[2], reviewFlags(list[2], { catUnmatched: true }), "import"),
    stage(list[3], reviewFlags(list[3], { catUnmatched: true }), "import"),
  ]
}
