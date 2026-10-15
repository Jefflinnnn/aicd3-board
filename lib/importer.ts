/**
 * Turns scraper output (JSON or CSV) into postings and works out what changes against what's already listed.
 */
import { CATS, COMPANIES, TODAY, coById, iso, jobLocations, type Job, type StagedJob } from "./data"
import { reviewFlags, stage as toStage } from "./review"
import { normalizeUrl } from "./validate"
import { normalizeLocation } from "./locations"

export const CSV_TEMPLATE =
  "title,company,locations,category,deadline,first_seen,term,mode,pay,url,req_id,description,responsibilities,qualifications,start_from,start_to\n" +
  '"Machine Learning Intern",Genentech,"South San Francisco, CA; Remote (US)",Tech,2026-11-15,2026-10-01,Summer 2027,Hybrid,$48–$56/hr,https://careers.gene.com/job/123,R-123456,"Build models…","Train models | Write pipelines","Python | ML coursework",May,July'

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
  /** with closeMissing: import-flagged postings still waiting for review that this import no longer
   *  contains (gone from the site, or no longer a fit); taken out of the queue */
  dropStale: StagedJob[]
  /** published postings the scraper now marks as not a fit (fit: "no"): moved to the bin, not closed */
  unlist: Job[]
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
  JSON.stringify([a.title, a.company, jobLocations(a), a.category, a.deadline, a.term, a.mode, a.pay, a.url, a.reqId || "", a.summary, a.resp, a.quals, !!a.closed, a.startFrom ?? 0, a.startTo ?? 0]) ===
  JSON.stringify([b.title, b.company, jobLocations(b), b.category, b.deadline, b.term, b.mode, b.pay, b.url, b.reqId || "", b.summary, b.resp, b.quals, !!b.closed, b.startFrom ?? 0, b.startTo ?? 0])

const MONTHS3 = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]
/** a month 1-12 from 5, "5", "May" or "may"; undefined when blank or unreadable */
function month(v: unknown): number | undefined {
  const s = str(v)
  if (!s) return undefined
  const n = /^\d{1,2}$/.test(s) ? Number(s) : MONTHS3.indexOf(s.slice(0, 3).toLowerCase()) + 1
  return n >= 1 && n <= 12 ? n : undefined
}

/** A link without tracking parameters, fragment or trailing slash, so the same page always compares equal. */
function canonUrl(u: string): string {
  try {
    const x = new URL(u)
    x.hash = ""
    for (const k of [...x.searchParams.keys()]) if (/^(utm_|gclid|fbclid|source$|src$|ref$)/i.test(k)) x.searchParams.delete(k)
    return (x.origin.toLowerCase() + x.pathname.replace(/\/+$/, "") + (x.search || "")).toLowerCase()
  } catch {
    return u.trim().toLowerCase()
  }
}

/**
 * Finds the existing posting an incoming row refers to: by company + job ID first, then by the
 * posting's own link, and by title + company only when the row has neither (a company-site link
 * doesn't identify a posting).
 */
function matcher<T extends Job>(list: T[]) {
  const byReq = new Map<string, T>()
  const byUrl = new Map<string, T>()
  const byTitle = new Map<string, T>()
  const reqKey = (j: Job) => (j.reqId ? `${j.company}:${j.reqId.trim().toLowerCase()}` : "")
  const urlKey = (j: Job) => (j.url && j.url !== coById(j.company).site ? canonUrl(j.url) : "")
  const titleKey = (j: Job) => `${j.company}:${j.title.trim().toLowerCase()}`
  for (const j of list) {
    if (reqKey(j)) byReq.set(reqKey(j), j)
    if (urlKey(j)) byUrl.set(urlKey(j), j)
    byTitle.set(titleKey(j), j)
  }
  return {
    find(n: Job): T | undefined {
      const r = reqKey(n) && byReq.get(reqKey(n))
      if (r) return r
      const u = urlKey(n) && byUrl.get(urlKey(n))
      // same link but a different job ID: a different posting
      if (u && !(n.reqId && u.reqId && u.reqId.trim().toLowerCase() !== n.reqId.trim().toLowerCase())) return u
      if (!n.reqId && !urlKey(n)) return byTitle.get(titleKey(n))
      return undefined
    },
    /** one key per posting, for spotting duplicate rows within an import */
    primary: (j: Job) => reqKey(j) ? "r:" + reqKey(j) : urlKey(j) ? "u:" + urlKey(j) : "t:" + titleKey(j),
  }
}

export function planImport(text: string, existing: Job[], closeMissing: boolean, staged: StagedJob[] = [], reviewAll = false): ImportPlan {
  const recs = readRecords(text)
  const errors: ImportRowError[] = []
  const now = Date.now()
  const incoming: Job[] = []
  const catMiss = new Set<number>()
  const unfit = new Set<number>() // rows marked fit: "no" by the scraper's classifier
  const asked = new Map<number, string[]>() // rows the scraper itself sends for review (e.g. unsure it's computational)
  recs.forEach((r, i) => {
    const row = i + 1
    const title = str(pick(r, "title", "job title", "role"))
    const coRaw = str(pick(r, "company", "company name", "employer"))
    if (!title) return errors.push({ row, reason: "Missing a title." })
    const co = COMPANIES.find((c) => c.id === coRaw.toLowerCase() || c.name.toLowerCase() === coRaw.toLowerCase())
    if (!co) return errors.push({ row, reason: coRaw ? `${coRaw} isn't one of the tracked companies.` : "Missing a company." })
    const locs = [...new Set(list(pick(r, "locations", "location", "city"), /;|\|/).map(normalizeLocation).filter(Boolean))]
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
    const reqId = str(pick(r, "req_id", "reqid", "job id", "jobid", "requisition", "requisition id")).slice(0, 64)
    const startFrom = month(pick(r, "start_from", "start_earliest", "earliest start"))
    const startTo = startFrom && (month(pick(r, "start_to", "start_latest", "latest start")) || startFrom)
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
      ...(reqId ? { reqId } : {}),
      summary: str(pick(r, "description", "summary", "about")),
      resp: list(pick(r, "responsibilities"), /\||\n/),
      quals: list(pick(r, "qualifications", "requirements"), /\||\n/),
      closed: ["true", "yes", "1"].includes(closedRaw) || undefined,
      addedAt: now,
      // always set, so a posting that stops naming a start month loses the old one on update
      startFrom: startFrom || undefined,
      startTo: startTo || undefined,
    })
    if (!catHit) catMiss.add(incoming.length - 1)
    const why = list(pick(r, "review_reason", "review", "flags"), /\|/).map((x) => x.slice(0, 300)).slice(0, 5)
    if (why.length) asked.set(incoming.length - 1, why)
    if (/^(no|false|0)$/i.test(str(pick(r, "fit")))) unfit.add(incoming.length - 1)
  })

  const live = matcher(existing)
  const held_ = matcher(staged)
  const heldSeen = new Set<string>()
  const matched = new Set<string>() // existing postings this import saw
  const add: Job[] = []
  const update: Job[] = []
  const stage: StagedJob[] = []
  const restage: StagedJob[] = []
  let rejected = 0
  let unchanged = 0
  const unlist: Job[] = []
  const seenKeys = new Set<string>()
  incoming.forEach((n, i) => {
    const k = live.primary(n)
    if (seenKeys.has(k)) return errors.push({ row: i + 1, reason: "Duplicate of an earlier row in this import." })
    seenKeys.add(k)
    const old = live.find(n)
    if (unfit.has(i)) {
      // not a fit any more: take a published one off the board; one waiting in review is cleared below
      if (old && !matched.has(old.id)) {
        matched.add(old.id)
        if (!old.sample) unlist.push(old)
      }
      return
    }
    if (old) {
      if (matched.has(old.id)) return errors.push({ row: i + 1, reason: "Matches the same posting as an earlier row in this import." })
      matched.add(old.id)
    }
    const held = !old && held_.find(n)
    if (held) heldSeen.add(held.id)
    if (held) {
      // already in the review queue: keep it there (or keep it rejected), refreshing its details
      if (held.review.status === "rejected") return void rejected++
      const merged: StagedJob = { ...held, ...n, id: held.id, posted: held.posted, addedAt: held.addedAt, sample: false, review: { ...held.review, flags: [...reviewFlags(n, { catUnmatched: catMiss.has(i) }), ...(asked.get(i) || [])] } }
      if (sameish(held, merged)) unchanged++
      else restage.push(merged)
      return
    }
    if (!old) {
      const fresh = { ...n, id: "j" + now.toString(36) + i.toString(36) }
      const flags = [...reviewFlags(fresh, { catUnmatched: catMiss.has(i) }), ...(asked.get(i) || [])]
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
    ? existing.filter((j) => companies.includes(j.company) && !j.closed && !matched.has(j.id) && (j.deadline ? j.deadline > iso(TODAY) : true)).map((j) => ({ ...j, closed: true }))
    : []
  const dropStale = closeMissing
    ? staged.filter((s) => s.review.source === "import" && s.review.status === "pending" && companies.includes(s.company) && !heldSeen.has(s.id))
    : []
  return { add, update, unchanged, close, stage, restage, rejected, errors, companies, dropStale, unlist }
}
