"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { AlertTriangle, Cpu, RefreshCw, Square } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import { Panel } from "@/components/common"
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
const when = (t: number) => new Date(t).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
function took(r: RefreshRun) {
  const ms = (r.finishedAt ?? Date.now()) - r.startedAt
  const m = Math.round(ms / 60_000)
  return m < 1 ? "under a minute" : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`
}

/**
 * Admin: run the scraper pipeline (scrape -> classify -> import -> re-check) now, or every 2 days.
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
          toast(r.status === "succeeded" ? "d3-flash is set up." : r.status === "cancelled" ? "Setup stopped." : "The d3-flash setup didn't finish.", {
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
  const everyDays = st ? Math.round(st.everyHours / 24) : 2

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
        ) : (
          <Button disabled={busy || !st || !!st.problem} onClick={() => act(async () => { const r = await refreshNow(); if (!r.started) toast("A refresh is already running.") }, "Refresh started. You can leave this page; it keeps going.")}>
            <RefreshCw className="size-4" /> Refresh now
          </Button>
        )
      }
    >
      {st?.problem && (
        <p className="mb-3 flex items-start gap-2 rounded-md bg-warn-soft px-3 py-2 text-sm text-warn">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" /> {st.problem}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b pb-3">
        <Switch id="auto-refresh" checked={!!st?.autoRefresh} disabled={busy || !st} onCheckedChange={(on) => act(() => setAutoRefresh(on), on ? `Will refresh every ${everyDays} days` : "Automatic refresh off")} />
        <Label htmlFor="auto-refresh" className="cursor-pointer">Refresh automatically every {everyDays} days</Label>
        <span className="text-xs text-muted-foreground">
          {st?.autoRefresh ? (st.nextAt && st.nextAt > now ? `Next run ${when(st.nextAt)}` : running ? "Running now" : "Next run within 15 minutes") : "Off"}
          {st?.autoRefresh && " (while this server is running)"}
        </span>
      </div>

      {st && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b py-3 text-sm">
          <Cpu className="size-4 text-muted-foreground" aria-hidden />
          <span>
            Classifier: <b className="font-medium">{st.classifier.llm ? "Claude" : st.classifier.d3 ? "d3-flash" : "keyword rules"}</b>
            {st.classifier.llm && <span className="text-muted-foreground"> ({st.classifier.llm}; needs the UCSF VPN, keyword rules otherwise)</span>}
            {!st.classifier.llm && st.classifier.d3 && st.classifier.revision && <span className="text-muted-foreground"> (version {st.classifier.revision.slice(0, 7)})</span>}
          </span>
          {!st.classifier.llm && !st.classifier.d3 && !st.classifier.canSetup && (
            <>
              <Button size="sm" variant="outline" className="h-8" disabled={busy || running}
                onClick={() => act(async () => { const r = await setupClassifier(); if (!r.started) toast("Something is already running; try again when it finishes.") }, "Setting up d3-flash. You can leave this page; it keeps going.")}>
                Set up d3-flash
              </Button>
              <span className="basis-full text-xs text-muted-foreground">
                The machine-learning classifier: more accurate than keyword rules. Setup downloads about 17 GB once and takes 20–40 minutes; it needs an Apple-silicon Mac with 24 GB or more of memory, or a Windows or Linux PC with an NVIDIA GPU with 20 GB or more.
              </span>
            </>
          )}
          {!st.classifier.llm && !st.classifier.d3 && st.classifier.canSetup && <span className="basis-full text-xs text-muted-foreground">{st.classifier.canSetup}</span>}
        </div>
      )}

      {!st ? (
        <p className="py-6 text-center text-sm text-muted-foreground">Loading…</p>
      ) : !last ? (
        <p className="py-6 text-center text-sm text-muted-foreground">No refresh has run yet.</p>
      ) : (
        <>
          <RunRow run={last} detailed />
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
          · {run.status === "running" ? `${took(run)} so far` : took(run)} · {run.trigger === "setup" ? `d3-flash setup, started by ${run.by || "staff"}` : run.trigger === "schedule" ? "automatic" : `started by ${run.by || "staff"}`}
        </span>
      </div>
      {s && d && (
        <p className="mt-1 text-sm text-muted-foreground">
          {s.scraped} US internships found: <b className="font-medium text-foreground">{d.added} new on the board</b>, {d.staged} sent to review,{" "}
          {d.updated} updated, {d.closed} closed{d.dropped ? `, ${d.dropped} cleared from review` : ""}{d.unlisted ? `, ${d.unlisted} moved to the bin as no longer a fit` : ""}, {s.skip} left out as not ML/automation-focused{s.undergrad ? `, ${s.undergrad} left out as undergraduate-only` : ""}
          {s.checked && `; re-check: ${s.checked.closed} taken down, ${s.checked.unknown} need a look`}.
          {detailed && ` Classifier: ${s.classifier === "llm" ? "Claude" : s.classifier === "d3" ? "d3-flash" : "keyword rules"}.`}
        </p>
      )}
      {detailed && s?.failed?.length ? (
        <p className="mt-1 text-xs text-warn">Couldn&apos;t scrape: {s.failed.map((n) => `${n} (${s.companies[n]})`).join("; ")}</p>
      ) : null}
      {reason && <p className="mt-1 text-xs text-warn"><AlertTriangle className="mr-1 inline size-3" />{reason}</p>}
      {detailed && s?.classifierNote && <p className="mt-1 text-xs text-warn"><AlertTriangle className="mr-1 inline size-3" />Claude wasn’t used for this run, so keyword rules classified it: {s.classifierNote}</p>}
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
