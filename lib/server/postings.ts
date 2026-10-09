import "server-only"
import { z } from "zod"
import { db } from "@/lib/server/db"
import { BIN_DAYS, setCustomCategories, type Category, type Job, type ReviewInfo, type StagedJob } from "@/lib/data"
import { Prisma, type Posting, type PostingState } from "@/lib/generated/prisma/client"
import { planImport, type ImportPlan } from "@/lib/importer"

/* ---------- validation: everything that arrives from a browser or the scraper ---------- */
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const text = (max: number) => z.string().max(max)
export const idSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)
export const idsSchema = z.array(idSchema).max(5000)
const httpUrl = z.string().max(2048).refine((u) => {
  try {
    const p = new URL(u).protocol
    return p === "https:" || p === "http:"
  } catch {
    return false
  }
}, "Not a web address")

export const jobSchema = z.object({
  id: idSchema,
  title: text(300).min(1),
  company: text(64).min(1),
  location: text(200),
  locations: z.array(text(200)).max(50).optional(),
  category: text(64),
  posted: day,
  deadline: z.union([day, z.literal("")]),
  term: text(100),
  mode: text(60),
  pay: text(200),
  url: httpUrl,
  summary: text(20000),
  resp: z.array(text(2000)).max(60),
  quals: z.array(text(2000)).max(60),
  sample: z.boolean().optional(),
  closed: z.boolean().optional(),
  addedAt: z.number().int().nonnegative().optional(),
})
export const reviewSchema = z.object({
  flags: z.array(text(300)).max(30),
  source: z.enum(["import", "held", "pulled"]),
  at: z.number().int().nonnegative(),
  status: z.enum(["pending", "rejected"]),
  decidedAt: z.number().int().nonnegative().optional(),
})
export const stagedSchema = jobSchema.extend({ review: reviewSchema })
export const categorySchema = z.object({
  id: text(64).min(1), label: text(60).min(1), short: text(30).min(1), color: text(30), custom: z.boolean().optional(),
})

/* ---------- row <-> app shape ---------- */
const toDay = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : "")
const fromDay = (s: string) => new Date(s + "T00:00:00.000Z")

export function toJob(r: Posting): Job {
  return {
    id: r.id, title: r.title, company: r.company, location: r.location, locations: r.locations,
    category: r.category, posted: toDay(r.posted), deadline: toDay(r.deadline), term: r.term, mode: r.mode,
    pay: r.pay, url: r.url, summary: r.summary, resp: r.resp, quals: r.quals,
    ...(r.sample ? { sample: true } : {}),
    ...(r.closed ? { closed: true } : {}),
    ...(r.addedAt ? { addedAt: r.addedAt.getTime() } : {}),
  }
}
export const toStaged = (r: Posting): StagedJob => ({ ...toJob(r), review: r.review as unknown as ReviewInfo })

function fields(j: Job) {
  return {
    title: j.title, company: j.company, location: j.location || j.locations?.[0] || "",
    locations: j.locations?.length ? j.locations : [j.location].filter(Boolean),
    category: j.category, posted: fromDay(j.posted), deadline: j.deadline ? fromDay(j.deadline) : null,
    term: j.term, mode: j.mode, pay: j.pay, url: j.url, summary: j.summary, resp: j.resp, quals: j.quals,
    closed: !!j.closed, sample: !!j.sample, addedAt: j.addedAt ? new Date(j.addedAt) : null,
  }
}

/* ---------- writes (callers check the role first) ---------- */
type Tx = Prisma.TransactionClient

export async function touchMeta(tx: Tx | ReturnType<typeof db> = db(), patch: { customCats?: Category[]; lastImport?: unknown } = {}) {
  const data = {
    lastUpdated: new Date(),
    ...(patch.customCats ? { customCats: JSON.parse(JSON.stringify(patch.customCats)) } : {}),
    ...(patch.lastImport ? { lastImport: JSON.parse(JSON.stringify(patch.lastImport)) } : {}),
  }
  await tx.siteMeta.upsert({ where: { id: 1 }, create: { id: 1, ...data }, update: data })
}

/**
 * Write a posting only if it is new or currently in one of `from` states. A posting someone else
 * has since binned or pulled into review is left alone, so an edit made on a stale screen can't
 * put it back in front of students.
 */
async function writeIf(tx: Tx, id: string, from: PostingState[], data: Omit<Prisma.PostingUncheckedCreateInput, "id">) {
  const r = await tx.posting.updateMany({ where: { id, state: { in: from } }, data })
  if (r.count) return true
  const exists = await tx.posting.findUnique({ where: { id }, select: { id: true } })
  if (exists) return false
  await tx.posting.create({ data: { id, ...data } })
  return true
}

/** Publish new postings or update ones on the job board. `from` also lets approve() publish queued ones. */
export async function upsertLive(tx: Tx, list: Job[], from: PostingState[] = ["live"]) {
  let n = 0
  for (const j of list) {
    if (await writeIf(tx, j.id, from, { state: "live", review: Prisma.DbNull, deletedAt: null, ...fields(j) })) n++
  }
  return n
}

/** Put postings in the staff-only review queue (or update ones already there). */
export async function upsertStaged(tx: Tx, list: StagedJob[], from: PostingState[] = ["review", "rejected"]) {
  let n = 0
  for (const s of list) {
    const review = JSON.parse(JSON.stringify(s.review))
    const state = s.review.status === "rejected" ? "rejected" : "review"
    if (await writeIf(tx, s.id, from, { state, review, deletedAt: null, ...fields(s) })) n++
  }
  return n
}

export async function purgeOldBin() {
  const cutoff = new Date(Date.now() - BIN_DAYS * 864e5)
  await db().posting.deleteMany({ where: { state: "bin", deletedAt: { lte: cutoff } } })
}

/* ---------- reads ---------- */
export async function loadCategories() {
  const meta = await db().siteMeta.findUnique({ where: { id: 1 } })
  const cats = (meta?.customCats as unknown as Category[]) || []
  setCustomCategories(cats)
  return meta
}

/* ---------- bulk import (Admin import dialog and the scraper's /api/ingest) ---------- */
export interface ImportSummary {
  added: number; updated: number; closed: number; staged: number; restaged: number
  rejected: number; unchanged: number; errors: ImportPlan["errors"]; companies: string[]
}

export async function runImport(text: string, opts: { closeMissing: boolean; reviewAll: boolean; dryRun?: boolean }): Promise<ImportSummary> {
  await loadCategories()
  const rows = await db().posting.findMany({ where: { state: { in: ["live", "review", "rejected"] } } })
  const live = rows.filter((r) => r.state === "live").map(toJob)
  const staged = rows.filter((r) => r.state !== "live").map(toStaged)
  const plan = planImport(text, live, opts.closeMissing, staged, opts.reviewAll)
  const summary: ImportSummary = {
    added: plan.add.length, updated: plan.update.length, closed: plan.close.length, staged: plan.stage.length,
    restaged: plan.restage.length, rejected: plan.rejected, unchanged: plan.unchanged,
    errors: plan.errors.slice(0, 100), companies: plan.companies,
  }
  if (opts.dryRun) return summary
  await db().$transaction(async (tx) => {
    await upsertStaged(tx, [...plan.stage, ...plan.restage])
    await upsertLive(tx, [...plan.add, ...plan.update, ...plan.close])
    await touchMeta(tx, { lastImport: { at: Date.now(), added: plan.add.length, updated: plan.update.length, closed: plan.close.length } })
  }, { timeout: 120_000, maxWait: 20_000 })
  return summary
}
