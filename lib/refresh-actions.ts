"use server"

/**
 * The Admin page's "Job data refresh" panel: run the scraper pipeline now, stop it, and turn the
 * automatic refresh on or off. Staff only; every change is in the audit log.
 */
import { z } from "zod"
import { db } from "@/lib/server/db"
import { audit, requireStaff } from "@/lib/server/access"
import { cancelRefresh, classifierInfo, schemaProblem, nextScheduled, runnerProblem, startRefresh, sweepDeadRuns } from "@/lib/server/refresh"
import type { RefreshRun, RefreshStatus } from "@/lib/types"

function toRun(r: { id: string; trigger: string; status: string; startedAt: Date; finishedAt: Date | null; summary: unknown; log: string; requestedBy: string | null }, names: Record<string, string>): RefreshRun {
  return {
    id: r.id,
    trigger: r.trigger === "schedule" || r.trigger === "setup" ? r.trigger : "manual",
    status: r.status as RefreshRun["status"],
    startedAt: r.startedAt.getTime(),
    finishedAt: r.finishedAt?.getTime() ?? null,
    by: r.requestedBy ? names[r.requestedBy] || "Staff" : null,
    summary: (r.summary as RefreshRun["summary"]) ?? null,
    log: r.log.split("\n").slice(-12).join("\n"),
  }
}

export async function getRefreshStatus(): Promise<RefreshStatus> {
  await requireStaff()
  try {
    return await readStatus()
  } catch (e) {
    const problem = schemaProblem(e)
    if (problem) return { problem, autoRefresh: false, everyHours: 48, nextAt: null, runs: [], classifier: classifierInfo() }
    throw e
  }
}

async function readStatus(): Promise<RefreshStatus> {
  await sweepDeadRuns()
  const [meta, runs, next] = await Promise.all([
    db().siteMeta.findUnique({ where: { id: 1 } }),
    db().scrapeRun.findMany({ orderBy: { startedAt: "desc" }, take: 6 }),
    nextScheduled(),
  ])
  const ids = [...new Set(runs.map((r) => r.requestedBy).filter((x): x is string => !!x))]
  const people = ids.length ? await db().profile.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, email: true } }) : []
  const names = Object.fromEntries(people.map((p) => [p.id, p.name || p.email]))
  return {
    problem: runnerProblem(),
    autoRefresh: !!meta?.autoRefresh,
    everyHours: meta?.refreshHours ?? 48,
    nextAt: next?.getTime() ?? null,
    runs: runs.map((r) => toRun(r, names)),
    classifier: classifierInfo(),
  }
}

export async function refreshNow(): Promise<{ started: boolean }> {
  const v = await requireStaff()
  const { run, started } = await startRefresh("manual", v.id).catch((e) => {
    const problem = schemaProblem(e)
    throw problem ? new Error(problem) : e
  })
  if (started) await audit(v.id, "refresh.start", run.id)
  return { started }
}

/** One-time setup of the d3-flash classifier (scraper/setup_d3.sh), run in the background like a refresh. */
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
  const stopped = await cancelRefresh()
  if (stopped) await audit(v.id, "refresh.stop", null)
  return { stopped }
}

export async function setAutoRefresh(on: boolean, everyHours = 48): Promise<void> {
  const v = await requireStaff()
  const data = { autoRefresh: z.boolean().parse(on), refreshHours: z.number().int().min(6).max(24 * 14).parse(everyHours) }
  await db().siteMeta.upsert({ where: { id: 1 }, create: { id: 1, ...data }, update: data })
  await audit(v.id, "refresh.schedule", null, data)
}
