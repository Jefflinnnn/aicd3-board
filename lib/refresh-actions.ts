"use server"

/**
 * The Admin page's "Job data refresh" panel: run the scraper pipeline now, stop it, and turn the
 * automatic refresh on or off. Staff only; every change is in the audit log.
 */
import { z } from "zod"
import { db } from "@/lib/server/db"
import { audit, requireStaff } from "@/lib/server/access"
import { cancelRefresh, classifierInfo, d3Server, schemaProblem, nextScheduled, runnerProblem, startRefresh, sweepDeadRuns } from "@/lib/server/refresh"
import type { RefreshRun, RefreshStatus, RunProgress } from "@/lib/types"

function toRun(r: { id: string; trigger: string; status: string; startedAt: Date; finishedAt: Date | null; summary: unknown; log: string; requestedBy: string | null }, names: Record<string, string>): RefreshRun {
  return {
    id: r.id,
    trigger: r.trigger === "schedule" || r.trigger === "setup" ? r.trigger : "manual",
    status: r.status as RefreshRun["status"],
    startedAt: r.startedAt.getTime(),
    finishedAt: r.finishedAt?.getTime() ?? null,
    by: r.requestedBy ? names[r.requestedBy] || "Staff" : null,
    // while a run is going its summary only says which computer it's on; the counts arrive when it ends
    summary: r.summary && typeof r.summary === "object" && "scraped" in r.summary ? (r.summary as RefreshRun["summary"]) : null,
    log: r.log.split("\n").slice(-400).join("\n"),
    progress: progressOf(r.summary),
  }
}

function progressOf(summary: unknown): RunProgress | null {
  const p = (summary as { progress?: unknown } | null)?.progress as RunProgress | undefined
  return p && typeof p === "object" && Array.isArray(p.companies) ? p : null
}

export async function getRefreshStatus(): Promise<RefreshStatus> {
  await requireStaff()
  try {
    return await readStatus()
  } catch (e) {
    const problem = schemaProblem(e)
    if (problem) return { problem, autoRefresh: false, everyHours: 24, nextAt: null, runs: [], classifier: { ...classifierInfo(), server: await d3Server() }, schedulerHere: schedulerHere(), lastScheduled: null, queue: queueHere(), requested: null }
    throw e
  }
}

async function readStatus(): Promise<RefreshStatus> {
  await sweepDeadRuns()
  const [meta, runs, next, server, sched] = await Promise.all([
    db().siteMeta.findUnique({ where: { id: 1 } }),
    db().scrapeRun.findMany({ orderBy: { startedAt: "desc" }, take: 6 }),
    nextScheduled(),
    d3Server(),
    db().scrapeRun.findFirst({ where: { trigger: "schedule" }, orderBy: { startedAt: "desc" } }),
  ])
  const ids = [...new Set([...runs.map((r) => r.requestedBy), meta?.refreshRequestedBy].filter((x): x is string => !!x))]
  const people = ids.length ? await db().profile.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, email: true } }) : []
  const names = Object.fromEntries(people.map((p) => [p.id, p.name || p.email]))
  return {
    // where refreshes are handed to the GPU PC, not being able to run Python here isn't a problem
    problem: queueHere() ? null : runnerProblem(),
    autoRefresh: !!meta?.autoRefresh,
    everyHours: meta?.refreshHours ?? 24,
    nextAt: next?.getTime() ?? null,
    runs: runs.map((r) => toRun(r, names)),
    classifier: { ...classifierInfo(), server },
    schedulerHere: schedulerHere(),
    lastScheduled: sched ? { at: sched.startedAt.getTime(), status: sched.status as RefreshRun["status"], host: hostOf(sched.summary) } : null,
    queue: queueHere(),
    requested: meta?.refreshRequestedAt
      ? { at: meta.refreshRequestedAt.getTime(), by: meta.refreshRequestedBy ? names[meta.refreshRequestedBy] || "Staff" : null }
      : null,
  }
}

/** Vercel can't run the scraper: there, "Refresh now" leaves a request for the GPU PC instead. */
const queueHere = () => !!process.env.VERCEL

/** This server's own timer only runs where Python can (not on Vercel) and when it isn't switched off. */
const schedulerHere = () => !process.env.VERCEL && process.env.SCRAPER_SCHEDULER !== "off"
/** The computer a run happened on: in its summary while it runs, in its progress once it has finished. */
function hostOf(summary: unknown): string | null {
  const s = summary as { host?: unknown; progress?: { host?: unknown } } | null
  const h = s?.host ?? s?.progress?.host
  return typeof h === "string" ? h : null
}

export async function refreshNow(): Promise<{ started: boolean; queued?: boolean }> {
  const v = await requireStaff()
  if (queueHere()) {
    // leave a request for the GPU PC (scraper/refresh_requests.ps1 checks every few minutes); one at a time, and
    // none while a run is going: the running one already brings the board up to date
    const running = await db().scrapeRun.findFirst({ where: { status: "running" }, select: { id: true } })
    if (running) return { started: false }
    const meta = await db().siteMeta.findUnique({ where: { id: 1 }, select: { refreshRequestedAt: true } })
    if (!meta?.refreshRequestedAt) {
      const data = { refreshRequestedAt: new Date(), refreshRequestedBy: v.id }
      await db().siteMeta.upsert({ where: { id: 1 }, create: { id: 1, ...data }, update: data })
      await audit(v.id, "refresh.request", null)
    }
    return { started: false, queued: true }
  }
  const { run, started } = await startRefresh("manual", v.id).catch((e) => {
    const problem = schemaProblem(e)
    throw problem ? new Error(problem) : e
  })
  if (started) await audit(v.id, "refresh.start", run.id)
  return { started }
}

/** One-time setup of the d3 classifier and its model server (scraper/setup_d3.ps1 or .sh), run in the background like a refresh. */
export async function setupClassifier(): Promise<{ started: boolean }> {
  const v = await requireStaff()
  const { run, started } = await startRefresh("setup", v.id).catch((e) => {
    const problem = schemaProblem(e)
    throw problem ? new Error(problem) : e
  })
  if (started) await audit(v.id, "refresh.setup-d3", run.id)
  return { started }
}

export async function stopRefresh(): Promise<{ stopped: boolean }> {
  const v = await requireStaff()
  // a request the GPU PC hasn't picked up yet is simply withdrawn
  const withdrawn = await db().siteMeta.updateMany({ where: { id: 1, refreshRequestedAt: { not: null } }, data: { refreshRequestedAt: null, refreshRequestedBy: null } })
  if (withdrawn.count) await audit(v.id, "refresh.request-withdrawn", null)
  const stopped = (await cancelRefresh()) || withdrawn.count > 0
  if (stopped) await audit(v.id, "refresh.stop", null)
  return { stopped }
}

export async function setAutoRefresh(on: boolean, everyHours = 24): Promise<void> {
  const v = await requireStaff()
  const data = { autoRefresh: z.boolean().parse(on), refreshHours: z.number().int().min(6).max(24 * 14).parse(everyHours) }
  await db().siteMeta.upsert({ where: { id: 1 }, create: { id: 1, ...data }, update: data })
  await audit(v.id, "refresh.schedule", null, data)
}
