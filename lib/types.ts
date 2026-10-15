import type { BinItem, Category, CompanyRequest, IssueReport, Job, StagedJob } from "./data"

export type Mode = "loading" | "cloud" | "preview" | "signedout" | "pending" | "blocked" | "outside" | "unavailable"
export type MyStatus = "saved" | "applied"
export type Role = "student" | "staff" | "admin"
export interface DashLayout { order: string[]; hidden: string[] }
export interface Mine {
  status: Record<string, MyStatus>
  notes: Record<string, string>
  lastVisit?: number
  /** this person's dashboard arrangement: section order and the ones they hid */
  layout?: DashLayout
}
export interface Meta {
  customCats: Category[]
  lastUpdated?: number
  lastImport?: { at: number; added: number; updated: number; closed: number }
}
export interface InboxDoc {
  uid: string
  requests: CompanyRequest[]
  reports: IssueReport[]
}
export interface Me {
  id: string | null
  canEdit: boolean
  role: Role
  name: string | null
  email: string | null
}

/** Everything the app needs on load, scoped to what this person may see. */
export type LoadResult =
  | { mode: "preview"; demo?: boolean }
  | { mode: "signedout" | "unavailable" }
  | { mode: "pending" | "blocked" | "outside"; me: Me }
  | {
      mode: "cloud"
      me: Me
      jobs: Job[]
      meta: Meta
      mine: Mine
      prevVisit: number | null
      myInbox: { requests: CompanyRequest[]; reports: IssueReport[] }
      /** staff only */
      staff?: { bin: BinItem[]; staged: StagedJob[]; inbox: InboxDoc[]; names: Record<string, string> }
    }

export interface Person {
  id: string
  email: string
  emailVerified: boolean
  name: string | null
  role: Role
  status: "pending" | "active" | "blocked"
  createdAt: number
}
export interface Invite { email: string; role: Role; createdAt: number }

/** Live progress the pipeline reports while it runs (scraper/progress.py), drawn as the refresh Sankey. */
export interface RunProgress {
  /** when the pipeline last reported (ms) */
  at: number
  host: string
  dryRun?: boolean
  step: "scrape" | "classify" | "import" | "check" | "done"
  classifier: string
  companies: { name: string; state: "waiting" | "running" | "done" | "failed"; found: number | null; note: string }[]
  classify: { done: number; total: number }
  outcome: { publish: number; review: number; skip: number; undergrad: number; not_us: number } | null
  /** live while classifying: where postings have gone so far, how many the model hasn't answered, the last one it did */
  routing?: RoutingTally | null
  checked: { open: number; closed: number; unknown: number } | null
}
export type RouteTo = "publish" | "review" | "skip" | "undergrad" | "not_us"
export interface RoutingTally {
  publish: number; review: number; skip: number; undergrad: number; not_us: number
  pending: number
  last: { title: string; company: string; to: RouteTo } | null
}

/** One run of the scraper pipeline (Admin: Job data refresh). */
export interface RefreshRun {
  id: string
  trigger: "manual" | "schedule" | "setup"
  status: "running" | "succeeded" | "partial" | "failed" | "cancelled"
  startedAt: number
  finishedAt: number | null
  by: string | null
  summary: {
    classifier: string
    scraped: number
    publish: number
    review: number
    skip: number
    /** undergraduate-only roles and co-ops left out (runs before this was tracked lack it) */
    undergrad?: number
    /** left out by d3 as outside the US */
    not_us?: number
    /** a dry run: the counts are what would have changed */
    dryRun?: boolean
    database: { added: number; staged: number; updated: number; closed: number; unchanged: number; rejected: number; dropped?: number; unlisted?: number }
    errors: number
    checked: { open: number; closed: number; unknown: number } | null
    /** why the model classifier wasn't used for (some of) this run: the d3 server not answering, failed requests... */
    classifierNote?: string
    /** why re-checking open postings stopped, when it did (the import before it was still saved) */
    checkError?: string | null
    companies: Record<string, string>
    failed: string[]
  } | null
  /** the last lines the pipeline printed */
  log: string
  /** what the pipeline reported as it went (runs before this was added, and setup runs, have none) */
  progress: RunProgress | null
}
export interface RefreshStatus {
  /** why this server can't run the scraper, or null */
  problem: string | null
  autoRefresh: boolean
  everyHours: number
  nextAt: number | null
  runs: RefreshRun[]
  /**
   * Which classifier refreshes use. d3: set up on this server; server: whether its model server answers
   * (up) and what it runs, or the address it was looked for at; canSetup: why this server can't set up d3, or null.
   */
  classifier: { d3: boolean; revision: string; server: { up: boolean; detail: string }; canSetup: string | null }
  /** whether this server's own timer runs automatic refreshes (never on Vercel: the GPU PC's scheduled task does) */
  schedulerHere: boolean
  /** the latest scheduled run, wherever it ran (the GPU PC's task or this server's timer) */
  lastScheduled: { at: number; status: RefreshRun["status"]; host: string | null } | null
  /** true where "Refresh now" asks the GPU PC instead of running here (the live site on Vercel) */
  queue: boolean
  /** a "Refresh now" waiting for the GPU PC to pick it up */
  requested: { at: number; by: string | null } | null
  /** when the GPU PC last checked for requests (scraper/refresh_requests.ps1, every 5 minutes), and its name */
  requestCheck: { at: number; host: string | null } | null
}
