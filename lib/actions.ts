"use server"

/**
 * Server actions: the only way the browser reads or changes app data.
 * Each one checks who is calling (lib/server/access.ts) before it touches the database,
 * validates its input, and only ever reads or writes the caller's own personal data.
 */
import { z } from "zod"
import { authConfigured } from "@/lib/auth/server"
import { db, dbConfigured } from "@/lib/server/db"
import { getViewer, isStaff, requireActive, requireStaff } from "@/lib/server/access"
import {
  categorySchema, idSchema, idsSchema, jobSchema, loadCategories, purgeOldBin, reviewSchema, runImport, stagedSchema,
  toJob, toStaged, touchMeta, upsertLive, upsertStaged, type ImportSummary,
} from "@/lib/server/postings"
import { unstage } from "@/lib/review"
import { Prisma } from "@/lib/generated/prisma/client"
import type { Category, CompanyRequest, IssueReport, Job, StagedJob } from "@/lib/data"
import type { DashLayout, LoadResult, Me, Meta, MyStatus } from "@/lib/types"

const ms = (d: Date | null | undefined) => (d ? d.getTime() : undefined)

/* ---------------------------------------------------------------- load */

/** Everything for the signed-in person. `refresh` skips stamping this as a new visit. */
export async function loadState(opts: { refresh?: boolean } = {}): Promise<LoadResult> {
  if (!authConfigured() || !dbConfigured()) return { mode: process.env.NODE_ENV === "production" ? "unavailable" : "preview" }
  const v = await getViewer()
  if (!v) return { mode: "signedout" }
  const me: Me = { id: v.id, canEdit: v.status === "active" && isStaff(v.role), role: v.role, name: v.name, email: v.email }
  if (v.status !== "active") return { mode: v.status === "blocked" ? "blocked" : "pending", me }

  const prisma = db()
  const staff = isStaff(v.role)
  if (staff && !opts.refresh) await purgeOldBin()
  const [meta, postings, statuses, notes, myReq, myRep] = await Promise.all([
    loadCategories(),
    prisma.posting.findMany({ where: staff ? {} : { state: "live" }, orderBy: { posted: "desc" } }),
    prisma.jobStatus.findMany({ where: { userId: v.id } }),
    prisma.jobNote.findMany({ where: { userId: v.id } }),
    prisma.companyRequest.findMany({ where: { userId: v.id, resolvedAt: null }, orderBy: { createdAt: "desc" } }),
    prisma.issueReport.findMany({ where: { userId: v.id, resolvedAt: null }, orderBy: { createdAt: "desc" } }),
  ])
  const prevVisit = ms(v.lastVisit) ?? null
  if (!opts.refresh) await prisma.profile.update({ where: { id: v.id }, data: { lastVisit: new Date() } })

  const result: LoadResult = {
    mode: "cloud",
    me,
    jobs: postings.filter((p) => p.state === "live").map(toJob),
    meta: {
      customCats: (meta?.customCats as unknown as Category[]) || [],
      lastUpdated: ms(meta?.lastUpdated),
      lastImport: (meta?.lastImport as unknown as Meta["lastImport"]) || undefined,
    },
    mine: {
      status: Object.fromEntries(statuses.map((s) => [s.postingId, s.status as MyStatus])),
      notes: Object.fromEntries(notes.map((n) => [n.postingId, n.text])),
      lastVisit: Date.now(),
      ...(v.layout ? { layout: v.layout as DashLayout } : {}),
    },
    prevVisit,
    myInbox: { requests: myReq.map(reqOut), reports: myRep.map(repOut) },
  }
  if (staff) {
    const [reqs, reps] = await Promise.all([
      prisma.companyRequest.findMany({ where: { resolvedAt: null }, orderBy: { createdAt: "desc" }, include: { user: { select: { name: true, email: true } } } }),
      prisma.issueReport.findMany({ where: { resolvedAt: null }, orderBy: { createdAt: "desc" }, include: { user: { select: { name: true, email: true } } } }),
    ])
    const byUser = new Map<string, { requests: CompanyRequest[]; reports: IssueReport[] }>()
    const names: Record<string, string> = {}
    const slot = (uid: string) => byUser.get(uid) ?? byUser.set(uid, { requests: [], reports: [] }).get(uid)!
    reqs.forEach((r) => { slot(r.userId).requests.push(reqOut(r)); names[r.userId] = r.user.name || r.user.email })
    reps.forEach((r) => { slot(r.userId).reports.push(repOut(r)); names[r.userId] = r.user.name || r.user.email })
    result.staff = {
      bin: postings.filter((p) => p.state === "bin").map((p) => ({ job: toJob(p), deletedAt: ms(p.deletedAt) ?? Date.now() })).sort((a, b) => b.deletedAt - a.deletedAt),
      staged: postings.filter((p) => p.state === "review" || p.state === "rejected").map(toStaged),
      inbox: [...byUser].map(([uid, d]) => ({ uid, ...d })),
      names,
    }
  }
  return result
}

const reqOut = (r: { id: string; name: string; site: string; cat: string; email: string; why: string; date: string }): CompanyRequest =>
  ({ id: r.id, name: r.name, site: r.site, cat: r.cat, email: r.email, why: r.why, date: r.date })
const repOut = (r: { id: string; kind: string; jobId: string; details: string; email: string; date: string }): IssueReport =>
  ({ id: r.id, kind: r.kind, jobId: r.jobId, details: r.details, email: r.email, date: r.date })

/* ---------------------------------------------------------------- postings (staff) */

export async function saveJobs(list: Job[]) {
  await requireStaff()
  const jobs = z.array(jobSchema).max(5000).parse(list) as Job[]
  await db().$transaction(async (tx) => {
    await upsertLive(tx, jobs)
    await touchMeta(tx)
  }, { timeout: 60_000 })
}

export async function moveToBin(ids: string[]) {
  await requireStaff()
  const list = idsSchema.parse(ids)
  await db().posting.updateMany({ where: { id: { in: list }, state: "live" }, data: { state: "bin", deletedAt: new Date() } })
  await touchMeta()
}

export async function restore(ids: string[]) {
  await requireStaff()
  const list = idsSchema.parse(ids)
  const r = await db().posting.updateMany({ where: { id: { in: list }, state: "bin" }, data: { state: "live", deletedAt: null } })
  await touchMeta()
  return r.count
}

export async function deleteForever(ids: string[]) {
  const v = await requireStaff()
  const list = idsSchema.parse(ids)
  await db().posting.deleteMany({ where: { id: { in: list }, state: "bin" } })
  await db().auditLog.create({ data: { actorId: v.id, action: "postings.delete-forever", detail: { ids: list } } })
}

export async function saveStaged(list: StagedJob[]) {
  await requireStaff()
  const items = z.array(stagedSchema).max(5000).parse(list) as StagedJob[]
  await db().$transaction((tx) => upsertStaged(tx, items), { timeout: 60_000 })
}

export async function dropStaged(ids: string[]) {
  await requireStaff()
  await db().posting.deleteMany({ where: { id: { in: idsSchema.parse(ids) }, state: { in: ["review", "rejected"] } } })
}

/** Approve: publish to the job board and clear from the queue. */
export async function approve(ids: string[]) {
  await requireStaff()
  const rows = await db().posting.findMany({ where: { id: { in: idsSchema.parse(ids) }, state: { in: ["review", "rejected"] } } })
  await db().$transaction(async (tx) => {
    await upsertLive(tx, rows.map((r) => unstage(toStaged(r))), ["review", "rejected"])
    await touchMeta(tx)
  })
}

/** Take published postings off the job board and back into the review queue. */
export async function pullToReview(ids: string[], reason: string) {
  await requireStaff()
  const why = z.string().max(300).parse(reason)
  const rows = await db().posting.findMany({ where: { id: { in: idsSchema.parse(ids) }, state: "live" } })
  const now = Date.now()
  await db().$transaction(async (tx) => {
    await upsertStaged(tx, rows.map((r) => ({ ...toJob(r), review: { flags: [why], source: "pulled" as const, at: now, status: "pending" as const } })), ["live"])
    await touchMeta(tx)
  })
}

export async function setReviewStatus(ids: string[], status: "pending" | "rejected") {
  await requireStaff()
  const st = reviewSchema.shape.status.parse(status)
  const rows = await db().posting.findMany({ where: { id: { in: idsSchema.parse(ids) }, state: { in: ["review", "rejected"] } } })
  await db().$transaction((tx) =>
    upsertStaged(tx, rows.map((r) => {
      const s = toStaged(r)
      return { ...s, review: { ...s.review, status: st, decidedAt: st === "rejected" ? Date.now() : undefined } }
    }))
  )
}

export async function setCustomCats(cats: Category[]) {
  await requireStaff()
  await touchMeta(db(), { customCats: z.array(categorySchema).max(20).parse(cats) as Category[] })
}

export async function bumpMeta(patch: { lastImport?: Meta["lastImport"] } = {}) {
  await requireStaff()
  const lastImport = z.object({ at: z.number(), added: z.number(), updated: z.number(), closed: z.number() }).optional().parse(patch.lastImport)
  await touchMeta(db(), lastImport ? { lastImport } : {})
}

/** The Admin page's import dialog, run on the server so it sees the full queue. */
export async function importPostings(text: string, opts: { closeMissing: boolean; reviewAll: boolean; dryRun: boolean }): Promise<ImportSummary> {
  const v = await requireStaff()
  const body = z.string().max(10_000_000).parse(text)
  const o = z.object({ closeMissing: z.boolean(), reviewAll: z.boolean(), dryRun: z.boolean() }).parse(opts)
  const summary = await runImport(body, o)
  if (!o.dryRun) await db().auditLog.create({ data: { actorId: v.id, action: "postings.import", detail: JSON.parse(JSON.stringify({ ...summary, errors: summary.errors.length })) } })
  return summary
}

/* ---------------------------------------------------------------- my own data */

export async function setStatus(ids: string[], s: MyStatus | null) {
  const v = await requireActive()
  const list = idsSchema.max(500).parse(ids)
  const status = z.enum(["saved", "applied"]).nullable().parse(s)
  const prisma = db()
  if (!status) {
    await prisma.jobStatus.deleteMany({ where: { userId: v.id, postingId: { in: list } } })
    return
  }
  // only postings this person can see
  const visible = await prisma.posting.findMany({ where: { id: { in: list }, ...(isStaff(v.role) ? {} : { state: "live" }) }, select: { id: true } })
  await prisma.$transaction(visible.map((p) =>
    prisma.jobStatus.upsert({
      where: { userId_postingId: { userId: v.id, postingId: p.id } },
      create: { userId: v.id, postingId: p.id, status },
      update: { status },
    })
  ))
}

export async function setNote(id: string, text: string) {
  const v = await requireActive()
  const postingId = idSchema.parse(id)
  const body = z.string().max(5000).parse(text)
  const prisma = db()
  if (!body.trim()) {
    await prisma.jobNote.deleteMany({ where: { userId: v.id, postingId } })
    return
  }
  const ok = await prisma.posting.count({ where: { id: postingId, ...(isStaff(v.role) ? {} : { state: "live" }) } })
  if (!ok) return
  await prisma.jobNote.upsert({
    where: { userId_postingId: { userId: v.id, postingId } },
    create: { userId: v.id, postingId, text: body },
    update: { text: body },
  })
}

export async function setLayout(layout: DashLayout | null) {
  const v = await requireActive()
  const l = z.object({ order: z.array(z.string().max(40)).max(40), hidden: z.array(z.string().max(40)).max(40) }).nullable().parse(layout)
  await db().profile.update({ where: { id: v.id }, data: { layout: l ?? Prisma.DbNull } })
}

const requestSchema = z.object({
  id: idSchema, name: z.string().min(1).max(200), site: z.string().max(500), cat: z.string().max(100),
  email: z.string().max(320), why: z.string().max(4000), date: z.string().max(40),
})
const reportSchema = z.object({
  id: idSchema, kind: z.string().min(1).max(200), jobId: z.string().max(64), details: z.string().max(4000),
  email: z.string().max(320), date: z.string().max(40),
})

export async function addRequest(r: CompanyRequest) {
  const v = await requireActive()
  const d = requestSchema.parse(r)
  await db().companyRequest.create({ data: { ...d, userId: v.id } })
}

export async function addReport(r: IssueReport) {
  const v = await requireActive()
  const d = reportSchema.parse(r)
  await db().issueReport.create({ data: { ...d, userId: v.id } })
}

export async function resolveInbox(uid: string, kind: "requests" | "reports", itemId: string) {
  const v = await requireStaff()
  const where = { id: idSchema.parse(itemId), userId: z.string().max(128).parse(uid) }
  const data = { resolvedAt: new Date(), resolvedBy: v.id }
  if (z.enum(["requests", "reports"]).parse(kind) === "requests") await db().companyRequest.updateMany({ where, data })
  else await db().issueReport.updateMany({ where, data })
}
