"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { AlertTriangle, Clock, Cpu, RefreshCw, Square, X } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import { Panel } from "@/components/common"
import { RefreshRoutes } from "@/components/RefreshRoutes"
import { cn } from "@/lib/utils"
import { useApp } from "@/lib/state"
import { reloadIfStale } from "@/lib/stale"
import { getRefreshStatus, refreshNow, setAutoRefresh, setupClassifier, stopRefresh } from "@/lib/refresh-actions"
import type { RefreshRun, RefreshStatus } from "@/lib/types"

const STATUS: Record<RefreshRun["status"], { label: string; cls: string }> = {
  running: { label: "Running", cls: "bg-accent text-foreground" },
  succeeded: { label: "Done", cls: "bg-good/15 text-good" },
  partial: { label: "Done, some sites failed", cls: "bg-warn-soft text-warn" },
  failed: { label: "Failed", cls: "bg-destructive/10 text-destructive" },
  cancelled: { label: "Stopped", cls: "bg-muted text-muted-foreground" },
}
/** no automatic refresh for over a day (the GPU PC refreshes twice a day, at 9 AM and 9 PM) */
const stale = (last: { at: number } | null, now: number) => !!now && (!last || now - last.at > 864e5)
const when = (t: number) => new Date(t).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
function took(r: RefreshRun) {
  const ms = (r.finishedAt ?? Date.now()) - r.startedAt
  const m = Math.round(ms / 60_000)
  return m < 1 ? "under a minute" : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`
}

/**
 * Admin: run the scraper pipeline (scrape -> classify -> import -> re-check) now, or every day.
 * The server runs it in the background; this panel polls for progress.
 */
export function Refresh() {
  const { mode, reload, demo } = useApp()
  const [st, setSt] = useState<RefreshStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [now, setNow] = useState(0)
  const wasRunning = useRef(false)

  const apply = useCallback((s: RefreshStatus) => {
      setSt(s)
      setNow(Date.now())
      const running = s.runs[0]?.status === "running"
      if (wasRunning.current && !running && s.runs[0]) {
        const r = s.runs[0]
        const d = r.summary?.database
        if (r.trigger === "setup") {
          toast(r.status === "succeeded" ? "d3 is set up and its server is running." : r.status === "cancelled" ? "Setup stopped." : "The d3 setup didn't finish.", {
            description: r.status === "succeeded" ? "The next refresh classifies with it." : r.status === "failed" ? "The panel shows why." : undefined,
          })
        } else {
          toast(r.status === "failed" ? "The refresh failed." : r.status === "cancelled" ? "Refresh stopped." : "Job data refreshed.", {
            description: d ? `${d.added} published, ${d.staged} sent to review, ${d.updated} updated, ${d.closed} closed.` : undefined,
          })
          reload()
        }
      }
      wasRunning.current = running
  }, [reload])
  const load = useCallback(() => getRefreshStatus().then(apply, reloadIfStale), [apply])

  const running = st?.runs[0]?.status === "running"
  useEffect(() => {
    if (mode !== "cloud") return
    getRefreshStatus().then(apply, reloadIfStale)
    const id = window.setInterval(() => getRefreshStatus().then(apply, reloadIfStale), running ? 5_000 : 60_000)
    return () => window.clearInterval(id)
  }, [mode, apply, running])

  if (mode !== "cloud" && demo)
    return (
      <Panel id="admin-refresh" title="Job data refresh" sub="How postings get onto the board.">
        <p className="text-sm text-muted-foreground">
          The demo’s postings are examples. On the real board, a scraper visits each tracked company’s career site every
          other day, keeps US internships, has Claude judge whether each is centred on ML or computational work and in drug
          discovery or development, writes a summary, and sends unsure ones to the review queue above. Postings that close
          are taken down automatically. Each run’s results and log appear here.
        </p>
      </Panel>
    )
  if (mode !== "cloud")
    return (
      <Panel id="admin-refresh" title="Job data refresh" sub="Scraping the career sites works once the database and sign-in are set up (see the README).">
        <p className="text-sm text-muted-foreground">This preview copy uses sample postings.</p>
      </Panel>
    )

  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true)
    try {
      await fn()
      if (ok) toast(ok)
    } catch (e) {
      if (reloadIfStale(e)) return
      toast("That didn't work.", { description: e instanceof Error && e.message && !/server components render/i.test(e.message) ? e.message : "Check that you have permission, then try again." })
    } finally {
      setBusy(false)
      load()
    }
  }

  const last = st?.runs[0]
  const history = st?.runs.slice(last?.status === "running" ? 1 : 0) ?? []
  // turning the switch on asks for a daily refresh, so that's what it says while it's off; while it's on, it says
  // what's actually saved (an older setting of every 2 days shows until the switch is turned off and on again)
  const everyDays = st?.autoRefresh ? Math.max(1, Math.round(st.everyHours / 24)) : 1
  const every = everyDays === 1 ? "every day" : `every ${everyDays} days`

  return (
    <Panel
      id="admin-refresh"
      title="Job data refresh"
      sub="Scrapes every tracked company's US internships, keeps the ones centred on machine learning or computational automation, files each under discovery, development, tech or other, and updates the job board. A full run takes 10–30 minutes."
      right={
        running ? (
          <Button variant="outline" disabled={busy} onClick={() => act(stopRefresh, "Stopping the refresh…")}>
            <Square className="size-3.5" /> Stop
          </Button>
        ) : st?.requested ? (
          <Button variant="outline" disabled={busy} onClick={() => act(stopRefresh, "Request withdrawn")}>
            <X className="size-3.5" /> Cancel request
          </Button>
        ) : (
          <Button
            disabled={busy || !st || !!st.problem}
            onClick={() => act(async () => {
              const r = await refreshNow()
              if (r.queued) toast("Refresh requested", { description: "The GPU PC starts it within 5 minutes, with d3. You can leave this page." })
              else if (r.started) toast("Refresh started. You can leave this page; it keeps going.")
              else toast("A refresh is already running.")
            })}
          >
            <RefreshCw className="size-4" /> Refresh now
          </Button>
        )
      }
    >
      {st?.requested && !running && (
        <p className={cn("mb-3 flex items-start gap-2 rounded-md px-3 py-2 text-sm", now && now - st.requested.at > 15 * 6e4 ? "bg-warn-soft text-warn" : "bg-muted text-muted-foreground")}>
          <Clock className="mt-0.5 size-4 shrink-0" />
          <span>
            Refresh requested {when(st.requested.at)}{st.requested.by ? ` by ${st.requested.by}` : ""}. The GPU PC checks every 5 minutes and
            starts it then; scheduled refreshes aren&apos;t affected.
            {now && now - st.requested.at > 15 * 6e4 ? " It hasn't been picked up yet: check that the GPU PC is on and signed in, and that its request check is set up (scraper\\register_daily_refresh.ps1 -Status)." : ""}
          </span>
        </p>
      )}
      {st?.problem && (
        <p className="mb-3 flex items-start gap-2 rounded-md bg-warn-soft px-3 py-2 text-sm text-warn">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" /> {st.problem}
        </p>
      )}

      {st && !st.schedulerHere ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b pb-3 text-sm">
          <span>
            Automatic refresh runs from the GPU PC&apos;s scheduled task (scraper\register_daily_refresh.ps1), not from this server.
          </span>
          <span className={cn("basis-full text-xs", stale(st.lastScheduled, now) ? "text-warn" : "text-muted-foreground")}>
            {!st.lastScheduled
              ? "No automatic refresh has reached this site yet. Set up the scheduled task on the GPU PC (see the README)."
              : `Last automatic refresh ${when(st.lastScheduled.at)}${st.lastScheduled.host ? ` on ${st.lastScheduled.host}` : ""}: ${st.lastScheduled.status}.` +
                (stale(st.lastScheduled, now) ? " That's more than a day ago: check that the PC is on and signed in (scraper\\register_daily_refresh.ps1 -Status)." : "")}
          </span>
        </div>
      ) : (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b pb-3">
        <Switch id="auto-refresh" checked={!!st?.autoRefresh} disabled={busy || !st} onCheckedChange={(on) => act(() => setAutoRefresh(on, 24), on ? "Will refresh every day" : "Automatic refresh off")} />
        <Label htmlFor="auto-refresh" className="cursor-pointer">Refresh automatically {every}</Label>
        <span className="text-xs text-muted-foreground">
          {st?.autoRefresh ? (st.nextAt && st.nextAt > now ? `Next run ${when(st.nextAt)}` : running ? "Running now" : "Next run within 15 minutes") : "Off"}
          {st?.autoRefresh && " (while this server is running)"}
        </span>
      </div>
      )}

      {st && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b py-3 text-sm">
          <Cpu className="size-4 text-muted-foreground" aria-hidden />
          <span>
            Classifier: <b className="font-medium">{st.classifier.server.up ? "d3" : "keyword rules"}</b>
            {st.classifier.server.up && <span className="text-muted-foreground"> ({st.classifier.server.detail}, on this PC)</span>}
            {!st.classifier.server.up && st.classifier.d3 && (
              <span className="text-warn"> (the d3 server isn&apos;t answering at {st.classifier.server.detail}; start it with scraper\start_d3_server.ps1, or sign out and back in)</span>
            )}
          </span>
          {!st.classifier.d3 && !st.classifier.canSetup && (
            <>
              <Button size="sm" variant="outline" className="h-8" disabled={busy || running}
                onClick={() => act(async () => { const r = await setupClassifier(); if (!r.started) toast("Something is already running; try again when it finishes.") }, "Setting up d3. You can leave this page; it keeps going.")}>
                Set up d3
              </Button>
              <span className="basis-full text-xs text-muted-foreground">
                The vllm-sr/d3 decision model, hosted on this PC: more accurate than keyword rules. Setup downloads about 52 GB once and takes 30–60 minutes; it needs an NVIDIA GPU with 64 GB or more (e.g. an RTX PRO 6000).
              </span>
            </>
          )}
          {!st.classifier.d3 && !st.classifier.server.up && st.classifier.canSetup && <span className="basis-full text-xs text-muted-foreground">{st.classifier.canSetup}</span>}
        </div>
      )}

      {!st ? (
        <p className="py-6 text-center text-sm text-muted-foreground">Loading…</p>
      ) : !last ? (
        <p className="py-6 text-center text-sm text-muted-foreground">No refresh has run yet.</p>
      ) : (
        <>
          <RunRow run={last} detailed />
          {last.trigger !== "setup" && <RefreshRoutes run={last} />}
          {running && last.log && (
            <pre aria-live="polite" className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-muted px-3 py-2 font-mono text-[0.72rem] leading-relaxed text-muted-foreground">{last.log}</pre>
          )}
          {history.length > (running ? 0 : 1) && (
            <details className="mt-3 text-sm">
              <summary className="cursor-pointer text-muted-foreground">Earlier runs</summary>
              <ul className="mt-1">{history.slice(running ? 0 : 1).map((r) => <li key={r.id}><RunRow run={r} /></li>)}</ul>
            </details>
          )}
        </>
      )}
    </Panel>
  )
}

/** The line that says why a run failed: the pipeline's own "[run] FAILED…" / "Import failed…", else the last error-looking line. */
function failureReason(log: string): string | null {
  const lines = log.split("\n").map((l) => l.trim()).filter(Boolean)
  const pick = (re: RegExp) => [...lines].reverse().find((l) => re.test(l))
  const failed = pick(/^\[run\] (FAILED|STOPPED)/)
  const why = pick(/^\[error\]|Import failed|^\[server\] (stopped|could not start)|Error:|Traceback/)
  if (failed && why && why !== failed) return `${why.replace(/^\[(error|server)\] /, "")} (${failed.replace(/^\[run\] /, "").toLowerCase()})`
  return (failed || why || null)?.replace(/^\[(run|error|server)\] /, "") ?? null
}

function RunRow({ run, detailed = false }: { run: RefreshRun; detailed?: boolean }) {
  const s = run.summary
  const d = s?.database
  const reason = run.status === "failed" || run.status === "cancelled" ? failureReason(run.log || "") : null
  return (
    <div className="border-b py-2.5 last:border-b-0">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        <span className={cn("rounded-full px-2 py-0.5 text-xs font-medium", STATUS[run.status].cls)}>
          {run.status === "running" && <RefreshCw className="mr-1 inline size-3 animate-spin motion-reduce:animate-none" />}
          {STATUS[run.status].label}
        </span>
        <span>{when(run.startedAt)}</span>
        <span className="text-muted-foreground">
          · {run.status === "running" ? `${took(run)} so far` : took(run)} · {run.trigger === "setup" ? `d3 setup, started by ${run.by || "staff"}` : run.trigger === "schedule" ? "automatic" : `started by ${run.by || "staff"}`}
        </span>
      </div>
      {s && d && (
        <p className="mt-1 text-sm text-muted-foreground">
          {s.dryRun && <b className="font-medium text-foreground">Dry run, nothing saved. Would have been: </b>}
          {s.scraped} US internships found: <b className="font-medium text-foreground">{d.added} new on the board</b>, {d.staged} sent to review,{" "}
          {d.updated} updated, {d.closed} closed{d.dropped ? `, ${d.dropped} cleared from review` : ""}{d.unlisted ? `, ${d.unlisted} moved to the bin as no longer a fit` : ""}, {s.skip} left out as not a fit{s.undergrad ? `, ${s.undergrad} left out as undergraduate-only` : ""}{s.not_us ? `, ${s.not_us} left out as outside the US` : ""}
          {s.checked && `; re-check: ${s.checked.closed} taken down, ${s.checked.unknown} need a look`}.
          {detailed && ` Classifier: ${s.classifier === "llm" ? "Claude" : s.classifier === "d3" ? "d3" : "keyword rules"}.`}
        </p>
      )}
      {detailed && s?.failed?.length ? (
        <p className="mt-1 text-xs text-warn">Couldn&apos;t scrape: {s.failed.map((n) => `${n} (${s.companies[n]})`).join("; ")}</p>
      ) : null}
      {reason && <p className="mt-1 text-xs text-warn"><AlertTriangle className="mr-1 inline size-3" />{reason}</p>}
      {detailed && s?.classifierNote && <p className="mt-1 text-xs text-warn"><AlertTriangle className="mr-1 inline size-3" />{s.classifier === "rules" ? "Keyword rules classified this run" : "Keyword rules classified part of this run"}: {s.classifierNote}</p>}
      {s?.checkError && <p className="mt-1 text-xs text-warn">Re-checking open postings stopped early ({s.checkError}); the import was still saved.</p>}
      {run.status !== "running" && run.log && (
        <details className="mt-1 text-xs" open={detailed && run.status === "failed"}>
          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">Log</summary>
          <pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap rounded-md bg-muted px-3 py-2 font-mono text-[0.72rem] leading-relaxed text-muted-foreground">{run.log}</pre>
          <p className="mt-1 text-muted-foreground">The full log of each run is on the computer that ran it, in <code>scraper/out/logs/</code>.</p>
        </details>
      )}
    </div>
  )
}
