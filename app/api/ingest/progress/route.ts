import { z } from "zod"
import { audit } from "@/lib/server/access"
import { refuseIngest } from "@/lib/server/ingest-auth"
import { db } from "@/lib/server/db"
import { sweepDeadRuns } from "@/lib/server/refresh"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const MAX_BYTES = 300_000

const count = z.number().int().min(0).max(1_000_000)
const progressSchema = z.object({
  v: z.number().int(),
  at: z.number().int().nonnegative(),
  host: z.string().max(100),
  dryRun: z.boolean().optional(),
  step: z.enum(["scrape", "classify", "import", "check", "done"]),
  classifier: z.string().max(20),
  companies: z.array(z.object({
    name: z.string().max(80),
    state: z.enum(["waiting", "running", "done", "failed"]),
    found: count.nullable(),
    note: z.string().max(200),
  })).max(100),
  classify: z.object({ done: count, total: count }),
  outcome: z.object({ publish: count, review: count, skip: count, undergrad: count, not_us: count }).nullable(),
  routing: z.object({
    publish: count, review: count, skip: count, undergrad: count, not_us: count, pending: count,
    last: z.object({ title: z.string().max(200), company: z.string().max(80), to: z.enum(["publish", "review", "skip", "undergrad", "not_us"]) }).nullable(),
  }).nullable().optional(),
  checked: z.object({ open: count, closed: count, unknown: count }).nullable(),
})

const bodySchema = z.object({
  event: z.enum(["start", "update", "finish"]),
  runId: z.string().max(40).nullable().optional(),
  trigger: z.enum(["manual", "schedule"]).optional(),
  progress: progressSchema,
  status: z.enum(["succeeded", "partial", "failed", "cancelled"]).optional(),
  summary: z.record(z.string(), z.unknown()).nullable().optional(),
  log: z.string().max(60_000).optional(),
})

/**
 * Live progress of a scraper pipeline run (scraper/progress.py), for the Admin page's refresh Sankey.
 *
 *   POST /api/ingest/progress   {"event": "start" | "update" | "finish", "runId"?, "progress": {...}, ...}
 *   Authorization: Bearer $SCRAPER_INGEST_TOKEN
 *
 * start   joins the run the Admin page started (runId), or opens a new one for a run started elsewhere
 *         (the daily scheduled task on the GPU PC). Answers 409 if another refresh is already running.
 * update  the latest progress; at least every 45 s while the run is going (a heartbeat).
 * finish  how a run started elsewhere ended: its status, counts and the end of its log.
 * Every answer says whether the run is still meant to be running, so the pipeline stops after its current
 * step when staff press Stop.
 */
export async function POST(req: Request) {
  const refused = refuseIngest(req)
  if (refused) return refused
  if (Number(req.headers.get("content-length") || 0) > MAX_BYTES) return Response.json({ error: "Too large" }, { status: 413 })
  const text = await req.text()
  if (text.length > MAX_BYTES) return Response.json({ error: "Too large" }, { status: 413 })
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return Response.json({ error: "Send JSON" }, { status: 400 })
  }
  const parsed = bodySchema.safeParse(raw)
  if (!parsed.success) return Response.json({ error: "That isn't a progress report: " + parsed.error.issues[0]?.message }, { status: 400 })
  const { event, runId, trigger, progress, status, summary, log } = parsed.data
  const running = { host: progress.host, progress }

  if (event === "start" && !runId) {
    await sweepDeadRuns()
    const opened = await db().$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(7242001)`
      const current = await tx.scrapeRun.findFirst({ where: { status: "running" }, orderBy: { startedAt: "desc" } })
      if (current) return { current }
      return { run: await tx.scrapeRun.create({ data: { trigger: trigger ?? "schedule", requestedBy: null, summary: running } }) }
    })
    if ("current" in opened && opened.current) {
      const at = opened.current.startedAt.toLocaleString("en-US", { timeZone: "America/Los_Angeles", dateStyle: "short", timeStyle: "short" })
      return Response.json({ error: `another refresh is already running (started ${at} Pacific)` }, { status: 409 })
    }
    const run = opened.run!
    await audit(null, "refresh.start-external", run.id, { host: progress.host, trigger: run.trigger, dryRun: !!progress.dryRun })
    return Response.json({ ok: true, runId: run.id, running: true })
  }

  if (!runId) return Response.json({ error: "runId is required" }, { status: 400 })
  const run = await db().scrapeRun.findUnique({ where: { id: runId } })
  if (!run) return Response.json({ ok: false, running: false })

  if (event === "finish") {
    await db().scrapeRun.update({
      where: { id: run.id },
      data: {
        // a run staff stopped stays "cancelled"
        ...(run.status === "running" ? { status: status ?? "failed", finishedAt: new Date(), pid: null } : {}),
        summary: JSON.parse(JSON.stringify({ ...(summary ?? {}), ...running })),
        ...(log !== undefined ? { log } : {}),
      },
    })
    return Response.json({ ok: true, running: false })
  }

  // start (joining the Admin page's run) or update
  if (run.status !== "running") return Response.json({ ok: true, runId: run.id, running: false })
  await db().scrapeRun.update({ where: { id: run.id }, data: { summary: JSON.parse(JSON.stringify(running)) } })
  return Response.json({ ok: true, runId: run.id, running: true })
}
