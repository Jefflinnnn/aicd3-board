import "server-only"
import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { db } from "@/lib/server/db"
import type { ScrapeRun } from "@/lib/generated/prisma/client"

/**
 * Runs the scraper pipeline (scraper/pipeline.py: scrape -> classify -> import -> re-check) as a
 * background process of this server, for the Admin page's Refresh button and the automatic
 * refresh. Each run is a ScrapeRun row; only one runs at a time.
 *
 * Needs a server that can run Python: `pnpm dev` / `pnpm start` on a Mac or Linux box with
 * `pip install -r scraper/requirements.txt`. Serverless hosts (Vercel) can't, and say so.
 *
 * The same runner also does the one-time d3 setup (scraper/setup_d3.ps1 or setup_d3.sh) from the Admin page,
 * which also starts the d3 model server (scraper/d3_server.py) that refreshes classify with.
 */

const ROOT = /*turbopackIgnore: true*/ process.cwd()
const SCRIPT = path.join(/*turbopackIgnore: true*/ ROOT, "scraper", "pipeline.py")
const WIN = process.platform === "win32"
const SETUP = path.join(/*turbopackIgnore: true*/ ROOT, "scraper", WIN ? "setup_d3.ps1" : "setup_d3.sh")
const VENV_PY = WIN ? path.join(/*turbopackIgnore: true*/ ROOT, ".venv-d3", "Scripts", "python.exe") : path.join(/*turbopackIgnore: true*/ ROOT, ".venv-d3", "bin", "python")
const VENV_REV = path.join(/*turbopackIgnore: true*/ ROOT, ".venv-d3", "D3_REVISION")
const D3_OK = path.join(/*turbopackIgnore: true*/ ROOT, ".venv-d3", "D3_OK")
/** SCRAPER_PYTHON if set, else the d3 environment once setup has finished, else python3 */
const python = () => process.env.SCRAPER_PYTHON || (fs.existsSync(D3_OK) && fs.existsSync(VENV_PY) ? VENV_PY : WIN ? "python" : "python3")
const d3Revision = () => {
  try { return process.env.D3_REVISION || fs.readFileSync(VENV_REV, "utf8").trim() } catch { return process.env.D3_REVISION || "" }
}
/** a run still "running" after this long is treated as dead */
const STALE_MS = 6 * 3600_000
/** lines of each run's output kept in the database (the full log is in scraper/out/logs/) */
const LOG_LINES = 400
const CHECK_EVERY_MS = 15 * 60_000

type Live = { child: ChildProcess; lines: string[]; flushed: number; stopping?: boolean }
const g = globalThis as unknown as { __scrapeLive?: Map<string, Live>; __scrapeTimer?: NodeJS.Timeout; __pyCheck?: { at: number; problem: string | null } }
const live = (g.__scrapeLive ??= new Map())

const STALE_CLIENT = "This server is running an old Prisma client that doesn't know the refresh history table. Stop the app, run `pnpm prisma generate`, then start it again (`pnpm dev` now does this on its own)."
const NO_TABLE = "The database doesn't have the refresh history table yet. Run `pnpm prisma migrate dev`, then restart the app."

/** Why the refresh tables can't be used, or null when the error is something else. */
export function schemaProblem(e?: unknown): string | null {
  if (!("scrapeRun" in db())) return STALE_CLIENT
  const code = (e as { code?: string })?.code
  if (code === "P2021" || code === "P2022") return NO_TABLE
  return null
}

/** Why this server can't run the scraper, or null if it can. */
export function runnerProblem(): string | null {
  if (process.env.VERCEL) return "This copy of the site runs on Vercel, which can't run the Python scraper. Run refreshes from a copy of the app on a computer with Python (pnpm dev or pnpm start)."
  if (!process.env.SCRAPER_INGEST_TOKEN) return "SCRAPER_INGEST_TOKEN isn't set for this server, so the scraper can't send it postings. Add it to .env.local and restart."
  if (!fs.existsSync(SCRIPT)) return "scraper/pipeline.py is missing from this server."
  const now = Date.now()
  if (!g.__pyCheck || now - g.__pyCheck.at > 5 * 60_000) {
    const PYTHON = python()
    const r = spawnSync(PYTHON, ["-c", "import requests, bs4, lxml"], { cwd: ROOT, timeout: 20_000, encoding: "utf8" })
    g.__pyCheck = {
      at: now,
      problem: r.error
        ? `Python (${PYTHON}) isn't installed or isn't on this server's PATH. Set SCRAPER_PYTHON to its full path.`
        : r.status !== 0
          ? "The scraper's Python packages are missing. Run: pip install -r scraper/requirements.txt"
          : null,
    }
  }
  return g.__pyCheck.problem
}

/** Whether d3 is set up for refreshes, and whether this server can set it up. */
export function classifierInfo(): { d3: boolean; revision: string; canSetup: string | null } {
  const d3 = fs.existsSync(D3_OK) && fs.existsSync(VENV_PY)
  const canSetup = process.env.VERCEL
    ? "Set up d3 from a copy of the app running on a PC with a large NVIDIA GPU (64 GB or more, e.g. an RTX PRO 6000)."
    : !(WIN || process.platform === "linux")
      ? "d3 needs a Windows or Linux PC with an NVIDIA GPU with 64 GB or more of memory (e.g. an RTX PRO 6000)."
      : !fs.existsSync(SETUP) ? `scraper/${path.basename(SETUP)} is missing from this server.` : null
  return { d3, revision: d3 ? d3Revision() : "", canSetup }
}

/** Whether the d3 model server (scraper/d3_server.py) answers on this computer. */
export async function d3Server(): Promise<{ up: boolean; detail: string }> {
  const url = (process.env.D3_URL || `http://127.0.0.1:${process.env.D3_PORT || 8765}`).replace(/\/$/, "")
  if (process.env.VERCEL) return { up: false, detail: url }
  try {
    const r = await fetch(url + "/health", { signal: AbortSignal.timeout(2000), cache: "no-store" })
    const h = (await r.json()) as { ok?: boolean; model?: string; gpu?: string }
    if (r.ok && h?.ok) return { up: true, detail: [h.model, h.gpu].filter(Boolean).join(" on ") }
  } catch {}
  return { up: false, detail: url }
}

function alive(pid: number | null): boolean {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM"
  }
}

/** The computer a run was started on (kept in its summary until the run's own summary replaces it). */
const runHost = (r: { summary: unknown }) => {
  const s = r.summary as { host?: unknown } | null
  return s && typeof s.host === "string" ? s.host : null
}
/** The run's live progress (scraper/progress.py), kept in its summary next to the final counts. */
const runProgress = (r: { summary: unknown }) => {
  const p = (r.summary as { progress?: { at?: unknown } } | null)?.progress
  return p && typeof p === "object" ? p : null
}
/** a run reporting its own progress is presumed dead once it has been silent this long (it sends at least every 45 s) */
const SILENT_MS = 10 * 60_000

/**
 * Mark runs whose process is gone (server restarted, crash) as failed. A server only judges runs it can
 * see the process of: runs started on another computer sharing this database (the GPU PC, while the live
 * site's Admin page is open on Vercel) are left alone until they're older than 6 hours.
 */
export async function sweepDeadRuns() {
  const running = await db().scrapeRun.findMany({ where: { status: "running" } })
  const here = os.hostname()
  for (const r of running) {
    if (live.has(r.id)) continue
    if (!r.pid) {
      // started outside the app (the daily scheduled task on the GPU PC): there's no process to look at, but it
      // reports progress at least every 45 s, so it's alive while that keeps coming (any server can judge this)
      const at = runProgress(r)?.at
      const beat = typeof at === "number" ? at : r.startedAt.getTime()
      if (Date.now() - beat > SILENT_MS) {
        console.warn(`[refresh] run ${r.id} marked failed: no progress for ${Math.round((Date.now() - beat) / 60_000)} minutes`)
        await db().scrapeRun.update({
          where: { id: r.id },
          data: { status: "failed", finishedAt: new Date(), log: (r.log + `\n[server] stopped: the run stopped reporting progress (the PC running it was turned off, restarted or lost its connection, or the run crashed) (noticed ${new Date().toLocaleString()})`).slice(-60000) },
        })
      }
      continue
    }
    const old = Date.now() - r.startedAt.getTime() > STALE_MS
    const host = runHost(r)
    const elsewhere = !!process.env.VERCEL || (host !== null && host !== here)   // Vercel never runs the scraper
    if (elsewhere && !old) continue
    if (old || !alive(r.pid)) {
      if (old && !elsewhere) killGroup(r.pid)
      console.warn(`[refresh] run ${r.id} marked failed: ${old ? "took longer than 6 hours" : "its process is gone (the app restarted?)"}`)
      await db().scrapeRun.update({
        where: { id: r.id },
        data: { status: "failed", finishedAt: new Date(), log: (r.log + `\n[server] ${old ? "stopped: the run took longer than 6 hours" : "stopped: the app restarted or was closed while this run was going, which ends the run"} (noticed ${new Date().toLocaleString()})`).slice(-60000) },
      })
    }
  }
}

function killGroup(pid: number | null) {
  if (!pid || !alive(pid)) return
  if (WIN) {   // no process groups: end the process and everything it started
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true })
    return
  }
  try {
    process.kill(-pid, "SIGTERM")
  } catch {
    try { process.kill(pid, "SIGTERM") } catch {}
  }
}

function selfUrl() {
  return (process.env.SCRAPER_APP_URL || `http://127.0.0.1:${process.env.PORT || 3000}`).replace(/\/$/, "")
}

/**
 * Start a run unless one is already going. Returns the run and whether this call started it.
 * Two clicks (or a click and the schedule) at the same moment start only one run.
 */
export async function startRefresh(trigger: "manual" | "schedule" | "setup", requestedBy: string | null): Promise<{ run: ScrapeRun; started: boolean }> {
  const problem = trigger === "setup" ? classifierInfo().canSetup : runnerProblem()
  if (problem) throw new Error(problem)
  await sweepDeadRuns()
  const { run, started } = await db().$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(7242001)`
    const current = await tx.scrapeRun.findFirst({ where: { status: "running" }, orderBy: { startedAt: "desc" } })
    if (current) return { run: current, started: false }
    return { run: await tx.scrapeRun.create({ data: { trigger, requestedBy, summary: { host: os.hostname() } } }), started: true }
  })
  if (!started) return { run, started }

  const summaryPath = path.join(os.tmpdir(), `aicd3-run-${run.id}.json`)
  const [cmd, args] = trigger === "setup"
    ? WIN ? ["powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", SETUP]] : ["bash", [SETUP]]
    : [python(), [SCRIPT, "--url", selfUrl(), "--summary-json", summaryPath]]
  const rev = d3Revision()
  const child = spawn(cmd, args, {
    cwd: ROOT,
    // UTF-8 output: on Windows, Python would otherwise print through the console code page and fail on
    // non-Latin job titles
    // AICD3_RUN_ID: the pipeline reports its live progress to this run (scraper/progress.py)
    env: { ...process.env, AICD3_INGEST_TOKEN: process.env.SCRAPER_INGEST_TOKEN, ...(trigger === "setup" ? {} : { AICD3_RUN_ID: run.id }), PYTHONUNBUFFERED: "1", PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1", ...(rev ? { D3_REVISION: rev } : {}) },
    stdio: ["ignore", "pipe", "pipe"],
    detached: !WIN, // its own process group, so Stop ends the scraper and anything it started (Windows: taskkill /T)
    windowsHide: true,
  })
  const t0 = Date.now()
  const entry: Live = { child, lines: [`[server] ${new Date(t0).toLocaleString()}: ${trigger} run started: ${cmd} ${args.map((a) => (a.startsWith(ROOT + path.sep) ? path.relative(ROOT, a) : a)).join(" ")}`], flushed: 0 }
  console.log(`[refresh] run ${run.id} started (${trigger}): ${cmd}`)
  live.set(run.id, entry)
  const take = (buf: Buffer) => {
    for (const l of buf.toString("utf8").split(/\r?\n/)) if (l.trim()) entry.lines.push(l.slice(0, 1000))
    if (entry.lines.length > LOG_LINES * 2) entry.lines.splice(1, entry.lines.length - LOG_LINES)   // keep the "[server] started" line
    if (Date.now() - entry.flushed > 10_000) {
      entry.flushed = Date.now()
      db().scrapeRun.update({ where: { id: run.id }, data: { log: entry.lines.slice(-LOG_LINES).join("\n") } }).catch(() => {})
    }
  }
  child.stdout?.on("data", take)
  child.stderr?.on("data", take)
  child.on("error", (e) => {
    entry.lines.push(`[server] could not start ${cmd}: ${e.message}`)
    console.error(`[refresh] run ${run.id} could not start ${cmd}: ${e.message}`)
  })
  child.on("close", async (code, signal) => {
    live.delete(run.id)
    let summary: unknown = null
    try {
      summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"))
      fs.unlinkSync(summaryPath)
    } catch {}
    if (trigger === "setup") g.__pyCheck = undefined // the next refresh re-checks which Python to use
    const cancelled = entry.stopping || signal === "SIGTERM" || signal === "SIGKILL"
    const status = cancelled ? "cancelled" : code === 0 ? "succeeded" : code === 2 && summary ? "partial" : "failed"
    const secs = Math.round((Date.now() - t0) / 1000)
    const how = signal ? `was stopped by ${signal}` : `exited with code ${code}`
    // keep the live progress the pipeline reported next to its final counts (the Admin page draws the run from it)
    const progress = await db().scrapeRun.findUnique({ where: { id: run.id }, select: { summary: true } }).then((r) => (r ? runProgress(r) : null), () => null)
    if (summary && progress) summary = { ...(summary as object), progress }
    entry.lines.push(`[server] ${new Date().toLocaleString()}: the ${trigger === "setup" ? "setup" : "pipeline"} ${how} after ${Math.floor(secs / 60)}m ${secs % 60}s: ${status}`)
    ;(status === "failed" ? console.error : console.log)(`[refresh] run ${run.id} ${status} (${how}, ${Math.floor(secs / 60)}m ${secs % 60}s)${status === "failed" ? `. Last lines:\n  ${entry.lines.slice(-8).join("\n  ")}` : ""}`)
    await db().scrapeRun.update({
      where: { id: run.id },
      data: { status, finishedAt: new Date(), pid: null, summary: summary ? JSON.parse(JSON.stringify(summary)) : undefined, log: entry.lines.slice(-LOG_LINES).join("\n") },
    }).catch(() => {})
  })
  if (child.pid) await db().scrapeRun.update({ where: { id: run.id }, data: { pid: child.pid } })
  return { run: { ...run, pid: child.pid ?? null }, started: true }
}

export async function cancelRefresh(): Promise<boolean> {
  const run = await db().scrapeRun.findFirst({ where: { status: "running" }, orderBy: { startedAt: "desc" } })
  if (!run) return false
  const entry = live.get(run.id)
  if (entry) {
    entry.stopping = true
    killGroup(entry.child.pid ?? null)
    return true
  }
  killGroup(run.pid)
  await db().scrapeRun.update({ where: { id: run.id }, data: { status: "cancelled", finishedAt: new Date(), pid: null } })
  return true
}

/** When the next automatic run is due (null when automatic refresh is off). */
export async function nextScheduled(): Promise<Date | null> {
  const meta = await db().siteMeta.findUnique({ where: { id: 1 } })
  if (!meta?.autoRefresh) return null
  const last = await db().scrapeRun.findFirst({ where: { trigger: { in: ["manual", "schedule"] }, status: { in: ["succeeded", "partial", "running"] } }, orderBy: { startedAt: "desc" } })
  return last ? new Date(last.startedAt.getTime() + meta.refreshHours * 3600_000) : new Date(0) // never ran: due now
}

export async function runIfDue(now = new Date()): Promise<boolean> {
  if (runnerProblem()) return false
  await sweepDeadRuns()
  const due = await nextScheduled()
  if (!due || due > now) return false
  // a failed run is retried at the next check, but not more than every 6 hours
  const lastTry = await db().scrapeRun.findFirst({ where: { trigger: "schedule" }, orderBy: { startedAt: "desc" } })
  if (lastTry && lastTry.status === "failed" && now.getTime() - lastTry.startedAt.getTime() < 6 * 3600_000) return false
  const { started } = await startRefresh("schedule", null)
  return started
}

/** Called once per server start (instrumentation.ts): checks every 15 minutes whether a run is due. */
export function startScheduler() {
  if (g.__scrapeTimer || process.env.VERCEL || process.env.SCRAPER_SCHEDULER === "off") return
  const tick = () => runIfDue().catch((e) => console.error("[refresh] scheduled check failed:", schemaProblem(e) ?? (e instanceof Error ? e.message : e)))
  g.__scrapeTimer = setInterval(tick, CHECK_EVERY_MS)
  g.__scrapeTimer.unref?.()
  setTimeout(tick, 60_000).unref?.()
}
