"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { AlertTriangle, Clock, RefreshCw, Route, Square, X } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import { Panel } from "@/components/common"
import { RefreshRoutes, progressFor } from "@/components/RefreshRoutes"
import { RefreshSteps, type StepId } from "@/components/RefreshSteps"
import { RoutingFlow } from "@/components/RoutingFlow"
import { D3RoutingDialog } from "@/components/D3RoutingDialog"
import { cn } from "@/lib/utils"
import { useApp } from "@/lib/state"
import { reloadIfStale } from "@/lib/stale"
import { getRefreshStatus, refreshNow, setAutoRefresh, setupClassifier, stopRefresh } from "@/lib/refresh-actions"
import type { RefreshRun, RefreshStatus, RoutingTally, RunProgress } from "@/lib/types"

const STATUS: Record<RefreshRun["status"], { label: string; cls: string }> = {
  running: { label: "Running", cls: "bg-primary/10 text-primary" },
  succeeded: { label: "Up to date", cls: "bg-good/15 text-good" },
  partial: { label: "Done, some sites failed", cls: "bg-warn-soft text-warn" },
  failed: { label: "Last refresh failed", cls: "bg-destructive/10 text-destructive" },
  cancelled: { label: "Last refresh stopped", cls: "bg-muted text-muted-foreground" },
}
const NOW_LABEL: Record<RunProgress["step"], string> = { scrape: "Scraping", classify: "Routing", import: "Updating the board", check: "Re-checking", done: "Finishing" }
/** no automatic refresh for over a day (the GPU PC refreshes twice a day, at 9 AM and 9 PM) */
const stale = (last: { at: number } | null, now: number) => !!now && (!last || now - last.at > 864e5)
const when = (t: number) => new Date(t).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
function took(r: RefreshRun) {
  const ms = (r.finishedAt ?? Date.now()) - r.startedAt
  const m = Math.round(ms / 60_000)
  return m < 1 ? "under a minute" : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`
}
/** where the run's postings went: live while routing, the final counts afterwards */
function tallyOf(p: RunProgress | null): RoutingTally | null {
  if (!p) return null
  if (p.routing && !p.outcome) return p.routing
  if (p.outcome) return { ...p.outcome, pending: 0, last: null }
  return p.routing ?? null
}
const hostOf = (run: RefreshRun, p: RunProgress | null) => p?.host || ""
/** "2 min ago", "3 h ago", "Oct 14" */
function ago(t: number, now: number) {
  const m = Math.max(0, Math.round((now - t) / 60_000))
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric" })
}
/** the GPU PC checks for Refresh now every 5 minutes; a check within the last 12 means it's listening */
const listening = (st: RefreshStatus | null, now: number) => !!st?.requestCheck && !!now && now - st.requestCheck.at < 12 * 6e4

/**
 * Admin: the job data refresh. One status line (what's happening, the schedule, and the two buttons: How d3 routes
 * and Refresh now), then the latest run's four steps as cards; the selected step's detail shows below them and
 * follows the running step until someone picks one. Earlier runs fold away at the bottom.
 */
export function Refresh() {
  const { mode, reload, demo } = useApp()
  const [st, setSt] = useState<RefreshStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [now, setNow] = useState(0)
  const [flowOpen, setFlowOpen] = useState(false)
  const [picked, setPicked] = useState<StepId | null>(null)
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
    // every 3 s while a run goes (the counts are eased between updates, so this is smooth enough)
    const id = window.setInterval(() => getRefreshStatus().then(apply, reloadIfStale), running ? 3_000 : 60_000)
    return () => window.clearInterval(id)
  }, [mode, apply, running])

  // a new run starts with the panel following it again
  const lastId = st?.runs[0]?.id ?? ""
  const [pickedFor, setPickedFor] = useState(lastId)
  if (pickedFor !== lastId) {
    setPickedFor(lastId)
    setPicked(null)
  }

  if (mode !== "cloud" && demo)
    return (
      <Panel id="admin-refresh" title="Job data refresh" sub="How postings get onto the board.">
        <p className="text-sm text-muted-foreground">
          The demo’s postings are examples. On the real board, a scraper visits each tracked company’s career site twice a
          day, keeps US internships, has the d3 model judge whether each is centred on ML or computational work and in drug
          discovery or development, and sends unsure ones to the review queue above. Postings that close are taken down
          automatically. Each run’s progress and results appear here.
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
  const isRefresh = !!last && last.trigger !== "setup"
  const p = last && isRefresh ? progressFor(last) : null
  const classifier = p?.classifier || last?.summary?.classifier || (st?.classifier.server.up ? "d3" : "")
  const tally = tallyOf(p)
  const liveStep: StepId | null = running && p ? (p.step === "done" ? "check" : p.step) : null
  const shown: StepId = picked ?? liveStep ?? "classify"
  const history = st?.runs.slice(1) ?? []
  const host = last ? hostOf(last, p) : ""
  const everyDays = st?.autoRefresh ? Math.max(1, Math.round(st.everyHours / 24)) : 1
  const heard = listening(st, now)
  const notHeard = st?.requestCheck
    ? `The GPU PC hasn't checked for Refresh now requests since ${ago(st.requestCheck.at, now)}${st.requestCheck.host ? ` (${st.requestCheck.host})` : ""}`
    : "The GPU PC has never checked for Refresh now requests"
  const pill = running && p ? { label: NOW_LABEL[p.step], cls: STATUS.running.cls } : last ? STATUS[last.status] : null
  const setUp = () => act(async () => { const r = await setupClassifier(); if (!r.started) toast("Something is already running; try again when it finishes.") }, "Setting up d3. You can leave this page; it keeps going.")

  const primary = running ? (
    <Button size="sm" variant="outline" disabled={busy} onClick={() => act(stopRefresh, "Stopping the refresh…")}>
      <Square className="size-3.5" /> Stop
    </Button>
  ) : st?.requested ? (
    <Button size="sm" variant="outline" disabled={busy} onClick={() => act(stopRefresh, "Request withdrawn")}>
      <X className="size-3.5" /> Cancel request
    </Button>
  ) : (
    <Button
      size="sm"
      disabled={busy || !st || !!st.problem}
      onClick={() => act(async () => {
        const r = await refreshNow()
        if (r.queued) toast("Refresh requested", {
          description: heard
            ? "The GPU PC starts it within 5 minutes, with d3. You can leave this page."
            : `${notHeard}, so it won't start until it does. On the PC: git pull, then scraper\\register_daily_refresh.ps1 -Url <this site>.`,
        })
        else if (r.started) toast("Refresh started. You can leave this page; it keeps going.")
        else toast("A refresh is already running.")
      })}
    >
      <RefreshCw className="size-4" /> Refresh now
    </Button>
  )

  return (
    <Panel id="admin-refresh" title="Job data refresh" sub="Scrapes the tracked companies' career sites, routes each internship with d3, and updates the job board.">
      {/* the status line: what's happening, the schedule, and the two buttons */}
      <div className="flex flex-wrap items-start gap-x-4 gap-y-3 border-b pb-4">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            {pill && (
              <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium", pill.cls)}>
                {running && <RefreshCw className="size-3 animate-spin motion-reduce:animate-none" />}
                {pill.label}
              </span>
            )}
            <span className="text-sm">
              {!st ? "Loading…"
                : !last ? "No refresh has run yet."
                : running ? <>{last.trigger === "schedule" ? "Scheduled" : last.trigger === "setup" ? "d3 setup" : "Manual"} refresh{host && <> on <b className="font-medium">{host}</b></>}, started {when(last.startedAt)} · {took(last)} so far</>
                : <>Last refresh <b className="font-medium">{when(last.startedAt)}</b>{host && <> on {host}</>} · took {took(last)}{last.trigger === "manual" && last.by ? ` · by ${last.by}` : ""}</>}
            </span>
          </div>
          {st && (
            st.schedulerHere ? (
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <Switch id="auto-refresh" className="scale-90" checked={st.autoRefresh} disabled={busy} onCheckedChange={(on) => act(() => setAutoRefresh(on, 24), on ? "Will refresh every day" : "Automatic refresh off")} />
                <Label htmlFor="auto-refresh" className="cursor-pointer text-xs font-normal">
                  Refresh automatically {everyDays === 1 ? "every day" : `every ${everyDays} days`} while this server is running
                </Label>
                {st.autoRefresh && <span>· next {st.nextAt && st.nextAt > now ? when(st.nextAt) : "within 15 minutes"}</span>}
              </div>
            ) : (
              <p className={cn("text-xs", stale(st.lastScheduled, now) ? "text-warn" : "text-muted-foreground")}>
                <Clock className="mr-1 inline size-3 -translate-y-px" />
                Twice daily (9 AM and 9 PM) from the GPU PC
                {st.lastScheduled
                  ? ` · last scheduled run ${when(st.lastScheduled.at)}: ${st.lastScheduled.status}`
                  : " · no scheduled run has reached this site yet (see the README)"}
                {stale(st.lastScheduled, now) && st.lastScheduled ? ". That's over a day ago: check the PC is on and signed in." : ""}
                {st.queue && (
                  <span className={cn("block", !heard && now ? "text-warn" : "")}>
                    {heard
                      ? `Refresh now: ${st.requestCheck!.host || "the GPU PC"} checks every 5 minutes (last check ${ago(st.requestCheck!.at, now)})`
                      : `${notHeard}: Refresh now won't reach it until its request check is set up (scraper\\register_daily_refresh.ps1 -Url <this site>).`}
                  </span>
                )}
              </p>
            )
          )}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => setFlowOpen(true)}><Route className="size-4" /> How d3 routes</Button>
          {primary}
        </div>
      </div>

      {st?.requested && !running && (
        <p className={cn("mt-3 flex items-start gap-2 rounded-md px-3 py-2 text-sm", heard || !now ? "bg-muted text-muted-foreground" : "bg-warn-soft text-warn")}>
          <Clock className="mt-0.5 size-4 shrink-0" />
          <span>
            Refresh requested {when(st.requested.at)}{st.requested.by ? ` by ${st.requested.by}` : ""}.{" "}
            {heard || !now
              ? "The GPU PC checks every 5 minutes and starts it then; scheduled refreshes aren't affected."
              : `${notHeard}, so this won't start until it does. Check the PC is on and signed in; on the PC, run git pull and then scraper\\register_daily_refresh.ps1 -Url <this site> (-Status shows whether the "AICD3 refresh requests" task is there).`}
          </span>
        </p>
      )}
      {st?.problem && (
        <p className="mt-3 flex items-start gap-2 rounded-md bg-warn-soft px-3 py-2 text-sm text-warn">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" /> {st.problem}
        </p>
      )}
      {st && !st.queue && st.classifier.d3 && !st.classifier.server.up && (
        <p className="mt-3 flex items-start gap-2 rounded-md bg-warn-soft px-3 py-2 text-sm text-warn">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          The d3 server isn&apos;t answering at {st.classifier.server.detail}. Start it with scraper\start_d3_server.ps1, or sign out and back in.
        </p>
      )}

      {!st ? (
        <p className="py-8 text-center text-sm text-muted-foreground">Loading…</p>
      ) : !last ? (
        <p className="py-8 text-center text-sm text-muted-foreground">No refresh has run yet. Refresh now starts the first one.</p>
      ) : !isRefresh ? (
        <div className="mt-3"><RunRow run={last} detailed /></div>
      ) : (
        <div className="mt-4 flex flex-col gap-3">
          <RefreshSteps run={last} p={p} selected={shown} onSelect={setPicked} classifier={classifier} />
          <div key={shown} className="min-w-0 rounded-md border p-4 duration-300 ease-out animate-in fade-in slide-in-from-bottom-1 motion-reduce:animate-none">
            {shown === "scrape" && (p ? <RefreshRoutes run={last} stages={false} /> : <Quiet>This run didn&apos;t report its progress.</Quiet>)}
            {shown === "classify" && (tally
              ? <RoutingFlow tally={tally} live={running && p?.step === "classify"} classifier={classifier} />
              : <Quiet>{running ? "Routing starts once scraping finishes." : "This run didn't report where its postings went."}</Quiet>)}
            {shown === "import" && <BoardStep run={last} p={p} running={running} />}
            {shown === "check" && <CheckStep p={p} running={running} />}
          </div>
          <RunNotes run={last} />
        </div>
      )}

      {history.length > 0 && (
        <details className="mt-4 border-t pt-3 text-sm">
          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">Earlier runs ({history.length})</summary>
          <ul className="mt-1">{history.map((r) => <li key={r.id}><RunRow run={r} /></li>)}</ul>
        </details>
      )}

      <D3RoutingDialog open={flowOpen} onOpenChange={setFlowOpen} status={st} tally={tally} onSetup={setUp} busy={busy || running} />
    </Panel>
  )
}

function Quiet({ children }: { children: React.ReactNode }) {
  return <p className="py-6 text-center text-sm text-muted-foreground">{children}</p>
}

/** step 3: what the run changed on the job board */
function BoardStep({ run, p, running }: { run: RefreshRun; p: RunProgress | null; running: boolean }) {
  const s = run.summary
  const d = s?.database
  if (!d) {
    const at = p?.step
    return <Quiet>{running && at === "import" ? (p?.dryRun ? "Comparing with the job board (dry run, nothing saved)…" : "Saving the changes to the job board…") : running ? "Waiting for routing to finish." : "This run didn't get as far as updating the board."}</Quiet>
  }
  const items: [string, number, string?][] = [
    ["New on the board", d.added, "text-good"],
    ["Sent to review", d.staged, "text-warn"],
    ["Updated", d.updated],
    ["Closed (gone from the site)", d.closed],
    ...(d.unlisted ? [["Moved to the bin (no longer a fit)", d.unlisted] as [string, number]] : []),
  ]
  return (
    <div className="flex flex-col gap-3">
      {s.dryRun && <p className="text-sm font-medium">Dry run, nothing saved. This is what it would have changed:</p>}
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3 lg:grid-cols-5">
        {items.map(([k, v, cls]) => (
          <div key={k} className="flex flex-col gap-0.5">
            <dt className="text-xs text-muted-foreground">{k}</dt>
            <dd className={cn("text-xl font-semibold tabular-nums", v ? cls : "text-muted-foreground")}>{v}</dd>
          </div>
        ))}
      </dl>
      <p className="text-xs text-muted-foreground">
        {s.scraped} US internships scraped; {d.unchanged ?? 0} already on the board unchanged{d.rejected ? `, ${d.rejected} that staff had rejected` : ""}.
      </p>
    </div>
  )
}

/** step 4: open postings checked on their own pages */
function CheckStep({ p, running }: { p: RunProgress | null; running: boolean }) {
  const c = p?.checked
  if (!c) return <Quiet>{running && p?.step === "check" ? "Checking each open posting on its own page…" : running ? "Waiting for the board update." : "Open postings weren't re-checked in this run."}</Quiet>
  return (
    <dl className="grid grid-cols-3 gap-4">
      {([["Still open", c.open], ["Taken down (filled or removed)", c.closed], ["Couldn't tell: sent to review", c.unknown]] as [string, number][]).map(([k, v]) => (
        <div key={k} className="flex flex-col gap-0.5">
          <dt className="text-xs text-muted-foreground">{k}</dt>
          <dd className="text-xl font-semibold tabular-nums">{v}</dd>
        </div>
      ))}
    </dl>
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

/** what needs attention about a run (why it failed, sites that couldn't be scraped…) and its log */
function RunNotes({ run }: { run: RefreshRun }) {
  const s = run.summary
  const reason = run.status === "failed" || run.status === "cancelled" ? failureReason(run.log || "") : null
  const notes = [
    reason,
    s?.failed?.length ? `Couldn't scrape: ${s.failed.map((n) => `${n} (${s.companies[n]})`).join("; ")}` : null,
    s?.classifierNote ? `${s.classifier === "rules" ? "Keyword rules classified this run" : "Keyword rules classified part of this run"}: ${s.classifierNote}` : null,
    s?.checkError ? `Re-checking open postings stopped early (${s.checkError}); the import was still saved.` : null,
  ].filter(Boolean) as string[]
  if (!notes.length && (run.status === "running" || !run.log)) return null
  return (
    <div className="flex flex-col gap-1 text-xs">
      {notes.map((n) => <p key={n} className="text-warn"><AlertTriangle className="mr-1 inline size-3" />{n}</p>)}
      {run.status !== "running" && run.log && (
        <details open={run.status === "failed"}>
          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">Log</summary>
          <pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap rounded-md bg-muted px-3 py-2 font-mono text-[0.72rem] leading-relaxed text-muted-foreground">{run.log}</pre>
          <p className="mt-1 text-muted-foreground">The full log of each run is on the computer that ran it, in <code>scraper/out/logs/</code>.</p>
        </details>
      )}
    </div>
  )
}

/** one earlier run on one line: when, how it went, what it changed */
function RunRow({ run, detailed = false }: { run: RefreshRun; detailed?: boolean }) {
  const d = run.summary?.database
  const tone = run.status === "succeeded" ? "bg-good" : run.status === "partial" ? "bg-warn" : run.status === "failed" ? "bg-destructive" : "bg-muted-foreground"
  return (
    <div className="border-b py-2 last:border-b-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <span className={cn("inline-block size-2 shrink-0 rounded-full", tone)} aria-hidden />
        <span className="min-w-[11rem]">{when(run.startedAt)}</span>
        <span className="text-muted-foreground">
          {run.trigger === "setup" ? `d3 setup, by ${run.by || "staff"}` : run.trigger === "schedule" ? "Scheduled" : `Manual${run.by ? `, ${run.by}` : ""}`} · {run.status === "running" ? `${took(run)} so far` : took(run)}
        </span>
        <span className="ml-auto text-xs tabular-nums text-muted-foreground">
          {d ? `${run.summary?.dryRun ? "dry run · " : ""}+${d.added} new · ${d.staged} to review · ${d.closed} closed` : STATUS[run.status].label}
        </span>
      </div>
      {(detailed || run.status === "failed") && <div className="mt-1 pl-5"><RunNotes run={run} /></div>}
    </div>
  )
}
