export type CatId = string
type SeedCat = "discovery" | "development" | "tech"
export type CoType = "Large pharma" | "Mid-size biotech" | "Startup"

export interface Company {
  id: string
  name: string
  type: CoType
  hq: string
  site: string
  focus: [number, number, number]
  w: number
}

export interface Job {
  id: string
  title: string
  company: string
  /** Primary location (kept for older saved data). Use jobLocations() to read every site. */
  location: string
  /** Every site the posting lists. */
  locations?: string[]
  category: CatId
  posted: string
  deadline: string
  term: string
  mode: string
  pay: string
  url: string
  summary: string
  resp: string[]
  quals: string[]
  sample?: boolean
  /** Set by an admin (or an import) when the posting has come down before its deadline. */
  closed?: boolean
  /** When an admin or import added it (ms). Sample postings only carry the first-seen date. */
  addedAt?: number
}

/** Why a posting is held back from students, and where it stands with staff. */
export interface ReviewInfo {
  flags: string[]
  /** where it came from: an import the checks flagged, or a staff member holding or pulling it back */
  source: "import" | "held" | "pulled"
  at: number
  status: "pending" | "rejected"
  decidedAt?: number
}
/** A posting waiting in the review queue. These live in a staff-only area and never reach students. */
export type StagedJob = Job & { review: ReviewInfo }

export interface CompanyRequest {
  id: string
  name: string
  site: string
  cat: string
  email: string
  why: string
  date: string
}

/* ---------- dates ---------- */
const DAY = 864e5
export const sod = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate())
export const TODAY = sod(new Date())
export const iso = (d: Date) =>
  d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0")
export const parse = (s: string) => {
  const [y, m, d] = s.split("-").map(Number)
  return new Date(y, m - 1, d)
}
export const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)
export const diffDays = (a: Date, b: Date) => Math.round((sod(a).getTime() - sod(b).getTime()) / DAY)
export const fmt = (s: string, o?: Intl.DateTimeFormatOptions) => {
  const d = parse(s)
  return d.toLocaleDateString(
    "en-US",
    o || { month: "short", day: "numeric", year: d.getFullYear() !== TODAY.getFullYear() ? "numeric" : undefined }
  )
}
/** Postings with no fixed deadline count as open for this many days after we first see them. */
export const ROLLING_DAYS = 90
export const isLive = (j: Job) =>
  !j.closed && (j.deadline ? parse(j.deadline) >= TODAY : diffDays(TODAY, parse(j.posted)) <= ROLLING_DAYS)
export const daysLeft = (j: Job) => (j.deadline ? diffDays(parse(j.deadline), TODAY) : null)
export const ageDays = (j: Job) => diffDays(TODAY, parse(j.posted))

/* ---------- reference data ---------- */
export interface Category { id: CatId; label: string; short: string; color: string; custom?: boolean }
const BASE_CATS: Category[] = [
  { id: "discovery", label: "Drug discovery", short: "Discovery", color: "--c1" },
  { id: "development", label: "Drug development", short: "Development", color: "--c2" },
  { id: "tech", label: "Tech & computational", short: "Tech", color: "--c3" },
  { id: "other", label: "Other", short: "Other", color: "--c-other" },
]
/** Colors for categories admins add, in a fixed order (validated categorical slots). */
export const CUSTOM_CAT_COLORS = ["--c5", "--c6", "--c7", "--c8"]
/**
 * The live category list. Admin-added categories are appended at runtime (see setCustomCategories),
 * so code reads this array at render time rather than caching it.
 */
export const CATS: Category[] = [...BASE_CATS]
export function setCustomCategories(custom: Category[]) {
  CATS.splice(0, CATS.length, ...BASE_CATS, ...custom.map((c) => ({ ...c, custom: true })))
}
export const catById = (id: string) => CATS.find((c) => c.id === id) || CATS.find((c) => c.id === "other") || CATS[0]
export const TYPES: CoType[] = ["Large pharma", "Mid-size biotech", "Startup"]

export const COMPANIES: Company[] = [
  { id: "genentech", name: "Genentech", type: "Large pharma", hq: "South San Francisco, CA", site: "https://www.gene.com", focus: [0.4, 0.35, 0.25], w: 5 },
  { id: "amgen", name: "Amgen", type: "Large pharma", hq: "Thousand Oaks, CA", site: "https://www.amgen.com", focus: [0.35, 0.45, 0.2], w: 4 },
  { id: "gilead", name: "Gilead Sciences", type: "Large pharma", hq: "Foster City, CA", site: "https://www.gilead.com", focus: [0.3, 0.55, 0.15], w: 4 },
  { id: "pfizer", name: "Pfizer", type: "Large pharma", hq: "New York, NY", site: "https://www.pfizer.com", focus: [0.3, 0.5, 0.2], w: 5 },
  { id: "merck", name: "Merck", type: "Large pharma", hq: "Rahway, NJ", site: "https://www.merck.com", focus: [0.35, 0.45, 0.2], w: 4 },
  { id: "lilly", name: "Eli Lilly", type: "Large pharma", hq: "Indianapolis, IN", site: "https://www.lilly.com", focus: [0.35, 0.4, 0.25], w: 4 },
  { id: "novartis", name: "Novartis", type: "Large pharma", hq: "Cambridge, MA", site: "https://www.novartis.com", focus: [0.35, 0.4, 0.25], w: 4 },
  { id: "vertex", name: "Vertex", type: "Mid-size biotech", hq: "Boston, MA", site: "https://www.vrtx.com", focus: [0.45, 0.4, 0.15], w: 3 },
  { id: "regeneron", name: "Regeneron", type: "Mid-size biotech", hq: "Tarrytown, NY", site: "https://www.regeneron.com", focus: [0.5, 0.35, 0.15], w: 3 },
  { id: "biogen", name: "Biogen", type: "Mid-size biotech", hq: "Cambridge, MA", site: "https://www.biogen.com", focus: [0.4, 0.45, 0.15], w: 2 },
  { id: "alnylam", name: "Alnylam", type: "Mid-size biotech", hq: "Cambridge, MA", site: "https://www.alnylam.com", focus: [0.45, 0.4, 0.15], w: 2 },
  { id: "biomarin", name: "BioMarin", type: "Mid-size biotech", hq: "San Rafael, CA", site: "https://www.biomarin.com", focus: [0.3, 0.6, 0.1], w: 2 },
  { id: "exelixis", name: "Exelixis", type: "Mid-size biotech", hq: "Alameda, CA", site: "https://www.exelixis.com", focus: [0.4, 0.5, 0.1], w: 1 },
  { id: "arcus", name: "Arcus Biosciences", type: "Mid-size biotech", hq: "Hayward, CA", site: "https://www.arcusbio.com", focus: [0.5, 0.4, 0.1], w: 1 },
  { id: "insitro", name: "insitro", type: "Startup", hq: "South San Francisco, CA", site: "https://www.insitro.com", focus: [0.3, 0, 0.7], w: 2 },
  { id: "recursion", name: "Recursion", type: "Startup", hq: "Salt Lake City, UT", site: "https://www.recursion.com", focus: [0.35, 0.1, 0.55], w: 2 },
  { id: "generate", name: "Generate:Biomedicines", type: "Startup", hq: "Somerville, MA", site: "https://www.generatebiomedicines.com", focus: [0.5, 0.05, 0.45], w: 2 },
  { id: "dyno", name: "Dyno Therapeutics", type: "Startup", hq: "Watertown, MA", site: "https://www.dynotx.com", focus: [0.55, 0.05, 0.4], w: 1 },
  // companies the scraper covers (scraper/pharma_internships.py); w: 0 keeps them out of the sample data
  { id: "abbvie", name: "AbbVie", type: "Large pharma", hq: "North Chicago, IL", site: "https://www.abbvie.com", focus: [0.3, 0.5, 0.2], w: 0 },
  { id: "astrazeneca", name: "AstraZeneca", type: "Large pharma", hq: "Cambridge, UK", site: "https://www.astrazeneca.com", focus: [0.35, 0.45, 0.2], w: 0 },
  { id: "bms", name: "Bristol Myers Squibb", type: "Large pharma", hq: "Princeton, NJ", site: "https://www.bms.com", focus: [0.3, 0.5, 0.2], w: 0 },
  { id: "sanofi", name: "Sanofi", type: "Large pharma", hq: "Paris, France", site: "https://www.sanofi.com", focus: [0.3, 0.5, 0.2], w: 0 },
  { id: "gsk", name: "GSK", type: "Large pharma", hq: "London, UK", site: "https://www.gsk.com", focus: [0.3, 0.5, 0.2], w: 0 },
  { id: "boehringer", name: "Boehringer Ingelheim", type: "Large pharma", hq: "Ingelheim, Germany", site: "https://www.boehringer-ingelheim.com", focus: [0.3, 0.5, 0.2], w: 0 },
  { id: "takeda", name: "Takeda", type: "Large pharma", hq: "Tokyo, Japan", site: "https://www.takeda.com", focus: [0.3, 0.5, 0.2], w: 0 },
  { id: "revmed", name: "Revolution Medicines", type: "Mid-size biotech", hq: "Redwood City, CA", site: "https://www.revmed.com", focus: [0.5, 0.4, 0.1], w: 0 },
]
export const coById = (id: string): Company =>
  COMPANIES.find((c) => c.id === id) || { id, name: id, type: "Startup", hq: "", site: "#", focus: [1, 0, 0], w: 0 }

type Role = [string, string, string, string[]]
const ROLES: Record<SeedCat, Role[]> = {
  discovery: [
    ["Medicinal Chemistry Intern", "Medicinal Chemistry", "the design and synthesis of small-molecule lead series", ["Plan and run multistep syntheses of analogs for active SAR campaigns", "Purify and characterize compounds by HPLC, LC-MS and NMR", "Register compounds and record results in the electronic lab notebook", "Present SAR findings at weekly project team meetings"]],
    ["Discovery Biology Intern", "Discovery Biology", "target validation and cell-based assays", ["Run cell-based assays to measure compound potency and selectivity", "Maintain mammalian cell lines and prepare reagents", "Fit dose-response curves and report IC50 values", "Support target validation experiments using CRISPR knockouts"]],
    ["Protein Engineering Intern", "Protein Sciences", "engineering and expressing therapeutic protein variants", ["Design and clone protein variants for expression", "Express and purify proteins from mammalian and bacterial systems", "Measure binding kinetics by SPR or BLI", "Document protocols and results for the team"]],
    ["Structural Biology Intern", "Structural Biology", "structures of drug targets bound to ligands", ["Prepare protein samples for crystallography or cryo-EM", "Set up and optimize crystallization screens", "Process and interpret structural datasets", "Share structure-based insights with chemistry teams"]],
    ["In Vivo Pharmacology Intern", "In Vivo Pharmacology", "efficacy studies in preclinical disease models", ["Help plan and run preclinical efficacy studies", "Process tissue and blood samples for biomarker readouts", "Analyze study data and prepare summary figures", "Follow IACUC and animal welfare procedures"]],
    ["Assay Development Intern", "Lead Discovery", "high-throughput screening assays", ["Develop and miniaturize biochemical assays for 384-well screening", "Optimize assay conditions and calculate Z-prime", "Run pilot screens on automated liquid handlers", "Write assay protocols for transfer to the screening group"]],
  ],
  development: [
    ["Clinical Operations Intern", "Clinical Operations", "running Phase 1–3 clinical trials", ["Track study start-up activities across trial sites", "Maintain trial master file documents", "Prepare materials for investigator meetings", "Support enrollment tracking and reporting"]],
    ["Regulatory Affairs Intern", "Regulatory Affairs", "submissions to the FDA and other health authorities", ["Compile and format sections of IND and NDA/BLA submissions", "Research regulatory precedents and guidance documents", "Track health authority commitments and timelines", "Help prepare briefing packages for agency meetings"]],
    ["Process Development Intern", "Process Development", "scaling up manufacturing processes for clinical supply", ["Run bench-scale experiments to optimize process parameters", "Support scale-up and tech transfer to manufacturing", "Analyze process data to identify critical parameters", "Write development reports"]],
    ["Biostatistics Intern", "Biostatistics", "statistical design and analysis of clinical studies", ["Program analyses of clinical trial datasets in R or SAS", "Support sample size and power calculations", "Create tables, listings and figures for study reports", "Review statistical analysis plans"]],
    ["Clinical Pharmacology Intern", "Clinical Pharmacology", "pharmacokinetic and dose-selection analyses", ["Perform noncompartmental PK analyses", "Build simple population PK models", "Summarize exposure-response findings", "Support dose-selection discussions for upcoming studies"]],
    ["Drug Safety & Pharmacovigilance Intern", "Drug Safety", "monitoring the safety profile of investigational and marketed products", ["Review and code adverse event case reports", "Support signal detection and aggregate safety reports", "Help maintain the safety database", "Search the literature for safety-relevant findings"]],
  ],
  tech: [
    ["Machine Learning Intern", "Machine Learning", "models that predict molecular properties and activity", ["Train and evaluate models on internal assay and structure data", "Build data pipelines for model training", "Benchmark against published methods", "Present results to scientists and engineers"]],
    ["Computational Biology Intern", "Computational Biology", "large-scale genomics and screening data", ["Analyze single-cell and bulk RNA-seq datasets", "Develop reproducible analysis workflows", "Work with wet-lab scientists on experiment design", "Visualize and communicate findings"]],
    ["Data Engineering Intern", "Research Data Platform", "the infrastructure that moves lab data to scientists", ["Build and maintain ETL pipelines for instrument data", "Add data quality checks and monitoring", "Model data for analytics in the warehouse", "Write documentation and tests"]],
    ["Bioinformatics Intern", "Bioinformatics", "sequence analysis and genomic data pipelines", ["Develop pipelines for NGS data processing", "Annotate variants and genomic features", "Maintain reference databases", "Support target discovery with genomic evidence"]],
    ["Software Engineering Intern, Lab Automation", "Lab Automation", "software that drives robotic lab workflows", ["Write software to schedule and control lab robots", "Build interfaces scientists use to queue experiments", "Integrate instruments with the data platform", "Test and harden automation workflows"]],
    ["Cheminformatics Intern", "Cheminformatics", "tools for searching and analyzing chemical space", ["Develop tools for compound library analysis", "Compute molecular descriptors and similarity metrics", "Support virtual screening campaigns", "Build dashboards for medicinal chemists"]],
  ],
}
const QUALS: Record<SeedCat, string[]> = {
  discovery: ["Pursuing a BS, MS or PhD in biology, chemistry or a related field", "Prior hands-on research lab experience", "Clear written and verbal communication"],
  development: ["Pursuing a degree in life sciences, pharmacy, statistics or a related field", "Strong organization and attention to detail", "Interest in how medicines move through clinical development"],
  tech: ["Pursuing a degree in computer science, computational biology or a related field", "Proficiency in Python", "Experience with data analysis or ML libraries"],
}

export function seedJobs(): Job[] {
  let seed = 20261005
  const R = () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  function pickW<T>(arr: T[], wf: (a: T) => number): T {
    const tot = arr.reduce((s, a) => s + wf(a), 0)
    let r = R() * tot
    for (const a of arr) {
      r -= wf(a)
      if (r <= 0) return a
    }
    return arr[arr.length - 1]
  }
  const out: Job[] = []
  const yr = TODAY.getFullYear()
  for (let i = 0; i < 112; i++) {
    const co = pickW(COMPANIES, (c) => c.w)
    const ci = pickW([0, 1, 2], (k) => co.focus[k])
    const cat = (["discovery", "development", "tech"] as SeedCat[])[ci]
    const role = ROLES[cat][Math.floor(R() * ROLES[cat].length)]
    const posted = addDays(TODAY, -Math.floor(Math.pow(R(), 1.6) * 330))
    const rolling = R() < 0.1
    const deadline = rolling ? null : addDays(posted, 21 + Math.floor(R() * 50))
    const liveish = rolling ? diffDays(TODAY, posted) <= 90 : (deadline as Date) >= TODAY
    const term = liveish ? (R() < 0.8 ? "Summer " + (yr + 1) : "Spring " + (yr + 1) + " co-op") : R() < 0.75 ? "Summer " + yr : "Fall " + yr + " co-op"
    const mode = cat === "tech" ? ["Hybrid", "Remote (US)", "Onsite", "Hybrid"][Math.floor(R() * 4)] : cat === "development" && R() < 0.4 ? "Hybrid" : "Onsite"
    const base = co.type === "Large pharma" ? 44 : co.type === "Startup" ? 36 : 40
    const lo = base + Math.floor(R() * 6)
    out.push({
      id: "j" + (1000 + i),
      title: role[0],
      company: co.id,
      location: mode === "Remote (US)" ? "Remote (US)" : co.hq,
      category: cat,
      posted: iso(posted),
      deadline: deadline ? iso(deadline) : "",
      term,
      mode,
      pay: "$" + lo + "–$" + (lo + 8 + Math.floor(R() * 6)) + "/hr",
      url: co.site,
      summary: `${co.name} is hiring a ${term} intern for its ${role[1]} team. You will work alongside scientists and engineers on ${role[2]}, with a mentor and a final presentation to leadership.`,
      resp: role[3].slice(),
      quals: QUALS[cat].slice(),
      sample: true,
    })
  }
  // Some postings list several sites. A separate seeded pass keeps the rest of the sample data stable.
  let seed2 = 7319
  const R2 = () => {
    seed2 = (seed2 * 16807) % 2147483647
    return (seed2 - 1) / 2147483646
  }
  for (const j of out) {
    const sites = SITES[j.company]
    if (!sites || j.location === "Remote (US)" || R2() > 0.45) {
      j.locations = [j.location]
      continue
    }
    const extra = sites.filter((x) => x !== j.location && R2() < 0.6)
    j.locations = [j.location, ...extra]
    if (j.mode !== "Onsite" && R2() < 0.25) j.locations.push("Remote (US)")
  }
  return out
}

/* ---------- locations ---------- */
const SITES: Record<string, string[]> = {
  genentech: ["South San Francisco, CA", "Oceanside, CA", "Vacaville, CA"],
  amgen: ["Thousand Oaks, CA", "South San Francisco, CA", "Cambridge, MA"],
  gilead: ["Foster City, CA", "Oceanside, CA", "Santa Monica, CA"],
  pfizer: ["New York, NY", "South San Francisco, CA", "Groton, CT", "Cambridge, MA", "San Diego, CA"],
  merck: ["Rahway, NJ", "South San Francisco, CA", "Boston, MA", "West Point, PA"],
  lilly: ["Indianapolis, IN", "San Diego, CA", "Boston, MA", "South San Francisco, CA"],
  novartis: ["Cambridge, MA", "San Diego, CA", "East Hanover, NJ"],
  vertex: ["Boston, MA", "San Diego, CA"],
  regeneron: ["Tarrytown, NY", "Rensselaer, NY"],
  biogen: ["Cambridge, MA", "Research Triangle Park, NC"],
  alnylam: ["Cambridge, MA", "Norton, MA"],
  biomarin: ["San Rafael, CA", "Novato, CA"],
}
const COORDS: Record<string, [number, number]> = {
  "South San Francisco, CA": [37.65, -122.41], "Oceanside, CA": [33.2, -117.38], "Vacaville, CA": [38.36, -121.99],
  "Thousand Oaks, CA": [34.17, -118.84], "Cambridge, MA": [42.37, -71.11], "Foster City, CA": [37.56, -122.27],
  "Santa Monica, CA": [34.02, -118.49], "New York, NY": [40.71, -74.01], "Groton, CT": [41.35, -72.08],
  "San Diego, CA": [32.72, -117.16], "Rahway, NJ": [40.61, -74.28], "Boston, MA": [42.36, -71.06],
  "West Point, PA": [40.21, -75.3], "Indianapolis, IN": [39.77, -86.16], "East Hanover, NJ": [40.82, -74.36],
  "Tarrytown, NY": [41.08, -73.86], "Rensselaer, NY": [42.64, -73.74], "Research Triangle Park, NC": [35.9, -78.86],
  "Norton, MA": [41.97, -71.19], "San Rafael, CA": [37.97, -122.53], "Novato, CA": [38.11, -122.57],
  "Alameda, CA": [37.77, -122.24], "Hayward, CA": [37.67, -122.08], "Salt Lake City, UT": [40.76, -111.89],
  "Somerville, MA": [42.39, -71.1], "Watertown, MA": [42.37, -71.18],
}
/** Cities a student can pick as "My location" (Settings). */
export const HOME_CITIES = [
  "San Francisco, CA", "San Diego, CA", "Los Angeles, CA", "Boston, MA", "New York, NY", "Seattle, WA", "Chicago, IL",
  "Philadelphia, PA", "Research Triangle Park, NC", "Indianapolis, IN", "Salt Lake City, UT", "Austin, TX",
]
Object.assign(COORDS, {
  "San Francisco, CA": [37.77, -122.42], "Los Angeles, CA": [34.05, -118.24], "Seattle, WA": [47.61, -122.33],
  "Chicago, IL": [41.88, -87.63], "Philadelphia, PA": [39.95, -75.17], "Austin, TX": [30.27, -97.74],
})
/** [latitude, longitude] for a known site, or undefined. */
export const cityCoord = (loc: string): [number, number] | undefined => COORDS[loc]
let HOME: string = "San Francisco, CA"
/** The viewer's own city, or "" for no preference (sites then sort alphabetically). */
export function setHomeLocation(city: string) {
  HOME = city
}
/** Miles from the viewer's city; unknown places sort after known ones and remote sorts last. */
export function milesFromHome(loc: string): number {
  if (/remote/i.test(loc)) return 1e7
  const c = COORDS[loc]
  const h = COORDS[HOME]
  if (!c || !h) return 1e6
  const r = (d: number) => (d * Math.PI) / 180
  const dLat = r(c[0] - h[0]), dLon = r(c[1] - h[1])
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(r(h[0])) * Math.cos(r(c[0])) * Math.sin(dLon / 2) ** 2
  return 3959 * 2 * Math.asin(Math.sqrt(a))
}
/** All of a posting's sites, closest to the viewer's city first. */
export const jobLocations = (j: Job): string[] =>
  [...new Set(j.locations && j.locations.length ? j.locations : [j.location])].sort((a, b) => milesFromHome(a) - milesFromHome(b) || a.localeCompare(b))

/* ---------- local persistence (per browser) ---------- */
export const store = {
  get<T>(k: string, d: T): T {
    try {
      const v = localStorage.getItem("ip3:" + k)
      return v ? (JSON.parse(v) as T) : d
    } catch {
      return d
    }
  },
  set(k: string, v: unknown) {
    try {
      localStorage.setItem("ip3:" + k, JSON.stringify(v))
    } catch {
      /* storage unavailable */
    }
  },
  del(k: string) {
    try {
      localStorage.removeItem("ip3:" + k)
    } catch {
      /* storage unavailable */
    }
  },
}

/* ---------- months ---------- */
export const monthStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), 1)
export const addMonths = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth() + n, 1)
export const monthEnd = (d: Date) => new Date(d.getFullYear(), d.getMonth() + 1, 0)
export const monthLabel = (d: Date, long = true) =>
  d.toLocaleDateString("en-US", { month: long ? "long" : "short", year: "numeric" })
export const inMonth = (s: string, m: Date) => {
  const d = parse(s)
  return d.getFullYear() === m.getFullYear() && d.getMonth() === m.getMonth()
}
export const THIS_MONTH = monthStart(TODAY)

/** When the scraper last ran (sample: 6:00 AM local each day). */
export const LAST_UPDATED = (() => {
  const t = new Date(TODAY.getFullYear(), TODAY.getMonth(), TODAY.getDate(), 6, 0)
  return t.getTime() > Date.now() ? new Date(t.getTime() - 864e5) : t
})()

/** A deleted posting waiting in the admin bin. It is removed for good after BIN_DAYS. */
export interface BinItem {
  job: Job
  deletedAt: number
}
export const BIN_DAYS = 30

/** A problem a student flagged from the job board. */
export interface IssueReport {
  id: string
  kind: string
  jobId: string
  details: string
  email: string
  date: string
}
export const ISSUE_KINDS = [
  "Link is broken or goes to the wrong page",
  "Posting has closed",
  "Details are wrong (deadline, location, pay)",
  "Duplicate posting",
  "Something else on the site",
]
