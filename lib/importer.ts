/**
 * Turns scraper output (JSON or CSV) into postings and works out what changes against what's already listed.
 */
import { CATS, COMPANIES, TODAY, coById, iso, jobLocations, type Job, type StagedJob } from "./data"
import { reviewFlags, stage as toStage } from "./review"
import { normalizeUrl } from "./validate"

export const CSV_TEMPLATE =
  "title,company,locations,category,deadline,first_seen,term,mode,pay,url,description,responsibilities,qualifications\n" +
  '"Machine Learning Intern",Genentech,"South San Francisco, CA; Remote (US)",Tech,2026-11-15,2026-10-01,Summer 2027,Hybrid,$48–$56/hr,https://careers.gene.com/job/123,"Build models…","Train models | Write pipelines","Python | ML coursework"'

export interface ImportRowError { row: number; reason: string }
export interface ImportPlan {
  add: Job[]
  update: Job[]
  unchanged: number
  close: Job[]
  /** new postings held for staff review, with the reasons */
  stage: StagedJob[]
  /** postings already waiting for review that this import changed */
  restage: StagedJob[]
  /** rows matching postings staff already rejected; left alone */
  rejected: number
  errors: ImportRowError[]
  companies: string[]
}

/** Minimal RFC 4180 CSV reader: quoted fields, doubled quotes, commas and newlines inside quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ""
  let q = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (q) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ } else q = false
      } else field += ch
    } else if (ch === '"') q = true
    else if (ch === ",") { row.push(field); field = "" }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++
      row.push(field); field = ""
      if (row.some((c) => c.trim() !== "")) rows.push(row)
      row = []
    } else field += ch
  }
  row.push(field)
  if (row.some((c) => c.trim() !== "")) rows.push(row)
  return rows
}

type Raw = Record<string, unknown>

export function readRecords(text: string): Raw[] {
  const t = text.trim()
  if (!t) throw new Error("Paste the scraper output or choose a file first.")
  if (t.startsWith("[") || t.startsWith("{")) {
    let data: unknown
    try {
      data = JSON.parse(t)
    } catch {
      throw new Error("That looks like JSON but couldn't be read. Check for a missing comma or bracket.")
    }
    const arr = Array.isArray(data) ? data : (data as { postings?: unknown; jobs?: unknown }).postings || (data as { jobs?: unknown }).jobs
    if (!Array.isArray(arr)) throw new Error('JSON needs to be a list of postings, or an object with a "postings" list.')
    return arr as Raw[]
  }
  const rows = parseCsv(t)
  if (rows.length < 2) throw new Error("The CSV needs a header row and at least one posting.")
  const head = rows[0].map((h) => h.trim())
  return rows.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ""])))
}

const key = (k: string) => k.toLowerCase().replace(/[^a-z]/g, "")
function pick(r: Raw, ...names: string[]): unknown {
  const want = names.map(key)
  for (const [k, v] of Object.entries(r)) if (want.includes(key(k))) return v
  return undefined
}
const str = (v: unknown) => (v == null ? "" : String(v)).trim()
const list = (v: unknown, sep: RegExp) => (Array.isArray(v) ? v.map(str) : str(v).split(sep).map((x) => x.trim())).filter(Boolean)
function day(v: unknown): string | null {
  const s = str(v)
  if (!s) return ""
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (m) {
    const d = new Date(+m[1], +m[2] - 1, +m[3])
    return d.getFullYear() === +m[1] && d.getMonth() === +m[2] - 1 && d.getDate() === +m[3] ? s : null
  }
  const d = new Date(s)
  return isNaN(d.getTime()) ? null : iso(d)
}

const sameish = (a: Job, b: Job) =>
  JSON.stringify([a.title, a.company, jobLocations(a), a.category, a.deadline, a.term, a.mode, a.pay, a.url, a.summary, a.resp, a.quals, !!a.closed]) ===
  JSON.stringify([b.title, b.company, jobLocations(b), b.category, b.deadline, b.term, b.mode, b.pay, b.url, b.summary, b.resp, b.quals, !!b.closed])

export function planImport(text: string, existing: Job[], closeMissing: boolean, staged: StagedJob[] = [], reviewAll = false): ImportPlan {
  const recs = readRecords(text)
  const errors: ImportRowError[] = []
  const now = Date.now()
  const incoming: Job[] = []
  const catMiss = new Set<number>()
  recs.forEach((r, i) => {
    const row = i + 1
    const title = str(pick(r, "title", "job title", "role"))
    const coRaw = str(pick(r, "company", "company name", "employer"))
    if (!title) return errors.push({ row, reason: "Missing a title." })
    const co = COMPANIES.find((c) => c.id === coRaw.toLowerCase() || c.name.toLowerCase() === coRaw.toLowerCase())
    if (!co) return errors.push({ row, reason: coRaw ? `${coRaw} isn't one of the tracked companies.` : "Missing a company." })
    const locs = list(pick(r, "locations", "location", "city"), /;|\|/)
    const catRaw = str(pick(r, "category", "area")).toLowerCase()
    const catHit = CATS.find((c) => [c.id, c.label.toLowerCase(), c.short.toLowerCase()].includes(catRaw))?.id
    const cat = catHit || "other"
    const deadline = day(pick(r, "deadline", "closes", "apply by"))
    if (deadline === null) return errors.push({ row, reason: `Deadline "${str(pick(r, "deadline", "closes", "apply by"))}" isn't a date. Use YYYY-MM-DD, or leave it blank for rolling.` })
    const seen = day(pick(r, "first_seen", "firstseen", "posted", "date posted"))
    if (seen === null) return errors.push({ row, reason: "First-seen date isn't a date. Use YYYY-MM-DD." })
    const urlRaw = str(pick(r, "url", "link", "posting url"))
    const url = urlRaw ? normalizeUrl(urlRaw) : co.site
    if (!url) return errors.push({ row, reason: `Link "${urlRaw}" isn't a valid web address.` })
    const closedRaw = str(pick(r, "closed", "taken down")).toLowerCase()
    incoming.push({
      id: "",
      title,
      company: co.id,
      location: locs[0] || co.hq,
      locations: locs.length ? locs : [co.hq],
      category: cat,
      posted: seen || iso(TODAY),
      deadline,
      term: str(pick(r, "term", "season")),
      mode: str(pick(r, "mode", "work mode", "workmode")) || "Onsite",
      pay: str(pick(r, "pay", "salary", "compensation")),
      url,
      summary: str(pick(r, "description", "summary", "about")),
      resp: list(pick(r, "responsibilities"), /\||\n/),
      quals: list(pick(r, "qualifications", "requirements"), /\||\n/),
      closed: ["true", "yes", "1"].includes(closedRaw) || undefined,
      addedAt: now,
    })
    if (!catHit) catMiss.add(incoming.length - 1)
  })

  // match on the posting link when it's specific, otherwise on title + company
  const sig = (j: Job) => (j.url && j.url !== coById(j.company).site ? "u:" + j.url : `t:${j.company}:${j.title.toLowerCase()}`)
  const byKey = new Map(existing.map((j) => [sig(j), j]))
  const stagedByKey = new Map(staged.map((j) => [sig(j), j]))
  const add: Job[] = []
  const update: Job[] = []
  const stage: StagedJob[] = []
  const restage: StagedJob[] = []
  let rejected = 0
  let unchanged = 0
  const seenKeys = new Set<string>()
  incoming.forEach((n, i) => {
    const k = sig(n)
    if (seenKeys.has(k)) return errors.push({ row: i + 1, reason: "Duplicate of an earlier row in this import." })
    seenKeys.add(k)
    const old = byKey.get(k)
    const held = !old && stagedByKey.get(k)
    if (held) {
      // already in the review queue: keep it there (or keep it rejected), refreshing its details
      if (held.review.status === "rejected") return void rejected++
      const merged: StagedJob = { ...held, ...n, id: held.id, posted: held.posted, addedAt: held.addedAt, sample: false, review: { ...held.review, flags: reviewFlags(n, { catUnmatched: catMiss.has(i) }) } }
      if (sameish(held, merged)) unchanged++
      else restage.push(merged)
      return
    }
    if (!old) {
      const fresh = { ...n, id: "j" + now.toString(36) + i.toString(36) }
      const flags = reviewFlags(fresh, { catUnmatched: catMiss.has(i) })
      if (flags.length || reviewAll) stage.push(toStage(fresh, flags.length ? flags : ["Every new posting in this import was sent for review"], "import"))
      else add.push(fresh)
    } else {
      const merged: Job = { ...old, ...n, id: old.id, posted: old.posted, addedAt: old.addedAt, sample: false }
      if (sameish(old, merged)) unchanged++
      else update.push(merged)
    }
  })
  const companies = [...new Set(incoming.map((j) => j.company))]
  const close = closeMissing
    ? existing.filter((j) => companies.includes(j.company) && !j.closed && !seenKeys.has(sig(j)) && (j.deadline ? j.deadline >= iso(TODAY) : true)).map((j) => ({ ...j, closed: true }))
    : []
  return { add, update, unchanged, close, stage, restage, rejected, errors, companies }
}
