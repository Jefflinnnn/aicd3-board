"use client"

import { useMemo, useState } from "react"
import { ArrowDown, ClipboardCheck, EyeOff, FileUp, Pencil, Plus, RotateCcw, Search, ShieldCheck, Trash2, Undo2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Checkbox } from "@/components/ui/checkbox"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Segmented } from "@/components/Segmented"
import { Pager } from "@/components/Pager"
import { EChart, chartBase, cssColor } from "@/components/EChart"
import { CatChip, DeadlineCell, LocationCell, PageHead, Panel, StatusPill } from "@/components/common"
import { ImportDialog, JobForm } from "@/views/AdminForms"
import { ReviewQueue } from "@/views/ReviewQueue"
import { reviewFlags, stage } from "@/lib/review"
import { cn } from "@/lib/utils"
import { useApp } from "@/lib/state"
import { BIN_DAYS, CATS, COMPANIES, CUSTOM_CAT_COLORS, ageDays, catById, coById, fmt, isLive, store, type Category, type Job, type StagedJob } from "@/lib/data"

export function ago(t?: number) {
  if (!t) return "never"
  const m = Math.round((Date.now() - t) / 60000)
  if (m < 1) return "just now"
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`
  const d = Math.round(h / 24)
  return `${d} day${d === 1 ? "" : "s"} ago`
}

/** Compact "time since" for the stat tiles, so it fits at the same size as the counts. */
function agoShort(t?: number) {
  if (!t) return "Never"
  const m = Math.round((Date.now() - t) / 60000)
  if (m < 1) return "Now"
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}

export default function Admin() {
  const app = useApp()
  const { mode, me, jobs, bin, staged, meta, allInbox, names, settings, dark, openJob, saveJobs, moveToBin, restore, deleteForever, setCustomCats, resolveInbox, resetSample, saveStaged, approve, pullToReview } = app
  const [q, setQ] = useState("")
  const [co, setCo] = useState("all")
  const [chartRange, setChartRange] = useState<"7" | "14" | "30" | "90" | "all">("30")
  const [split, setSplit] = useState<"category" | "status">("category")
  const [formOpen, setFormOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [editing, setEditing] = useState<Job | null>(null)
  const [editingStaged, setEditingStaged] = useState(false)
  const [formKey, setFormKey] = useState(0)
  const [resetOpen, setResetOpen] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [binSel, setBinSel] = useState<Set<string>>(new Set())
  const [purge, setPurge] = useState<string[] | null>(null)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSizeS] = useState<number>(() => store.get("adminPageSize", 10))
  const setPageSize = (n: number) => { setPageSizeS(n); store.set("adminPageSize", n); setPage(1) }
  const [newCat, setNewCat] = useState("")
  const [catErr, setCatErr] = useState("")
  const [removeCat, setRemoveCat] = useState<string | null>(null)
  const [flash, setFlash] = useState<string | null>(null)
  const jumpTo = (id: string) => {
    const el = document.getElementById(id)
    if (!el) return
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    el.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" })
    setFlash(id)
    window.setTimeout(() => setFlash((f) => (f === id ? null : f)), 1600)
  }

  /* ---------- chart ---------- */
  const chartJobs = chartRange === "all" ? jobs : jobs.filter((j) => ageDays(j) < Number(chartRange))
  const chartCos = useMemo(() => {
    const tot = (id: string) => chartJobs.filter((j) => j.company === id).length
    return [...COMPANIES].sort((a, b) => tot(b.id) - tot(a.id) || a.name.localeCompare(b.name))
  }, [jobs, chartRange]) // eslint-disable-line react-hooks/exhaustive-deps
  const chart = useMemo(() => {
    const { base, valueAxis, catAxis } = chartBase()
    const groups =
      split === "category"
        ? CATS.map((k) => ({ name: k.short, color: cssColor(k.color), test: (j: Job) => j.category === k.id }))
        : [
            { name: "Live", color: cssColor("--primary"), test: (j: Job) => isLive(j) },
            { name: "Expired", color: cssColor("--chart-neutral"), test: (j: Job) => !isLive(j) },
          ]
    const stack = groups.map((g) => chartCos.map((c) => chartJobs.filter((j) => j.company === c.id && g.test(j)).length))
    return {
      ...base,
      tooltip: {
        ...base.tooltip,
        trigger: "axis",
        axisPointer: { type: "shadow" },
        formatter: (ps: { name: string; seriesName: string; value: number; marker: string }[]) =>
          `<b>${ps[0]?.name}</b>` + (ps.some((p) => p.value) ? ps.filter((p) => p.value).map((p) => `<br/>${p.marker}${p.seriesName}: ${p.value}`).join("") : "<br/>No postings"),
      },
      grid: { left: 168, right: 24, top: 4, bottom: 56, containLabel: false },
      yAxis: { ...catAxis, inverse: true, data: chartCos.map((c) => c.name), axisLabel: { color: cssColor("--foreground"), fontSize: 12, width: 158, overflow: "truncate" } },
      xAxis: { ...valueAxis, min: 0 },
      // A fixed set of bar slots is reused by both splits, so switching the split (or the time range)
      // grows and shrinks the existing segments in place instead of redrawing the bars from zero.
      animationDurationUpdate: 550,
      animationEasingUpdate: "cubicOut" as const,
      series: Array.from({ length: Math.max(CATS.length, 2) }, (_, gi) => {
        const g = groups[gi]
        return {
          id: "slot" + gi,
          name: g?.name ?? "",
          type: "bar", stack: "all", barMaxWidth: 16,
          itemStyle: { color: g?.color ?? "transparent", borderColor: cssColor("--card"), borderWidth: g ? 1 : 0 },
          data: g ? stack[gi] : chartCos.map(() => 0),
        }
      }),
    }
  }, [chartCos, dark, split, chartRange]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!me.canEdit)
    return (
      <div className="mx-auto mt-[8vh] flex max-w-md flex-col gap-3 rounded-lg border bg-card p-6">
        <span className="grid size-10 place-items-center rounded-lg bg-muted"><ShieldCheck className="size-5" /></span>
        <h1 className="font-display text-xl font-semibold">Program staff only</h1>
        <p className="text-sm text-muted-foreground">Admin tools are for program employees. If you work on the program and need access, contact the program lead.</p>
      </div>
    )

  const live = jobs.filter(isLive).length
  const requests = allInbox.flatMap((d) => d.requests.map((r) => ({ ...r, uid: d.uid })))
  const reports = allInbox.flatMap((d) => d.reports.map((r) => ({ ...r, uid: d.uid })))
  const list = jobs
    .filter((j) => (!q.trim() || j.title.toLowerCase().includes(q.trim().toLowerCase())) && (co === "all" || j.company === co))
    .sort((a, b) => b.posted.localeCompare(a.posted) || a.title.localeCompare(b.title))
  const openForm = (j: Job | null, inReview = false) => { setEditing(j); setEditingStaged(inReview); setFormKey((k) => k + 1); setFormOpen(true) }
  const pending = staged.filter((s) => s.review.status === "pending")
  const toReview = async (ids: string[]) => {
    try {
      const pulled = await pullToReview(ids, "Pulled back by staff for a closer look")
      setSelected(new Set())
      toast(pulled.length === 1 ? "Sent to the review queue" : `Sent ${pulled.length} postings to the review queue`, {
        description: "Hidden from students until someone approves it.",
        action: { label: "Show me", onClick: () => jumpTo("admin-review") },
      })
    } catch { fail() }
  }
  const fail = () => toast("Couldn't save that change. Check your connection and try again.")

  const pages = Math.max(1, Math.ceil(list.length / pageSize))
  const cur = Math.min(page, pages)
  const pageRows = list.slice((cur - 1) * pageSize, cur * pageSize)
  const pageIds = pageRows.map((j) => j.id)
  const pageAllSel = pageIds.length > 0 && pageIds.every((id) => selected.has(id))
  const pageSomeSel = pageIds.some((id) => selected.has(id))
  const daysLeftInBin = (t: number) => Math.max(0, BIN_DAYS - Math.floor((Date.now() - t) / 864e5))

  const toBin = async (ids: string[]) => {
    try {
      const moved = await moveToBin(ids)
      setSelected(new Set())
      toast(moved.length === 1 ? "Moved to bin" : `Moved ${moved.length} postings to bin`, {
        description: moved.length === 1 ? moved[0].title : `They'll be deleted for good in ${BIN_DAYS} days.`,
        action: { label: "Undo", onClick: () => restore(moved.map((j) => j.id)).catch(fail) },
      })
    } catch { fail() }
  }
  const setTakenDown = async (ids: string[], closed: boolean) => {
    try {
      await saveJobs(jobs.filter((j) => ids.includes(j.id)).map((j) => ({ ...j, closed: closed || undefined })))
      setSelected(new Set())
      toast(closed ? `Marked ${ids.length} as taken down` : `Reopened ${ids.length}`)
    } catch { fail() }
  }
  const addCategory = async () => {
    const name = newCat.trim()
    const custom = CATS.filter((c) => c.custom) as Category[]
    if (!name) return setCatErr("Enter a name for the category.")
    if (CATS.some((c) => c.label.toLowerCase() === name.toLowerCase() || c.short.toLowerCase() === name.toLowerCase())) return setCatErr(`There's already a category called ${name}.`)
    if (custom.length >= CUSTOM_CAT_COLORS.length) return setCatErr(`You can add up to ${CUSTOM_CAT_COLORS.length} categories so the chart colors stay easy to tell apart. Remove one first.`)
    const used = new Set(custom.map((c) => c.color))
    const color = CUSTOM_CAT_COLORS.find((c) => !used.has(c)) as string
    const id = "c-" + name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") + "-" + Date.now().toString(36)
    try {
      await setCustomCats([...custom, { id, label: name, short: name, color, custom: true }])
      toast("Category added", { description: name })
      setNewCat("")
      setCatErr("")
    } catch { fail() }
  }
  const doRemoveCat = async (id: string) => {
    try {
      const moving = jobs.filter((j) => j.category === id).map((j) => ({ ...j, category: "other" }))
      await saveJobs(moving)
      await setCustomCats((CATS.filter((c) => c.custom) as Category[]).filter((c) => c.id !== id))
      toast("Category removed", { description: moving.length ? `${moving.length} posting(s) moved to Other.` : undefined })
    } catch { fail() }
  }
  const stale = meta.lastUpdated ? Date.now() - meta.lastUpdated > 2 * 864e5 : true

  return (
    <div className="flex flex-col gap-5">
      <PageHead
        title="Admin"
        sub={<>Program staff only. Add, import, edit and remove postings.<br />Anything vague or off-target waits in the review queue until someone approves it.</>}
        right={
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => setImportOpen(true)}><FileUp className="size-4" /> Import postings</Button>
            <Button onClick={() => openForm(null)}><Plus className="size-4" /> Add job</Button>
          </div>
        }
      />

      <div className="grid gap-px overflow-hidden rounded-lg border bg-border sm:grid-cols-3 xl:grid-cols-6">
        {([
          ["Needs review", String(pending.length), pending.length ? "Hidden from students until approved" : "Nothing waiting", "admin-review"],
          ["Postings", String(jobs.length), `${live} live, ${jobs.length - live} expired`, "admin-postings"],
          ["Last updated", agoShort(meta.lastUpdated), meta.lastImport ? `Last import: ${meta.lastImport.added} new, ${meta.lastImport.updated} updated` : "No imports yet", "import"],
          ["In the bin", String(bin.length), `Cleared after ${BIN_DAYS} days`, "admin-bin"],
          ["Requests", String(requests.length), requests.length ? `Latest: ${requests[0].name}` : "None yet", "admin-requests"],
          ["Reports", String(reports.length), reports.length ? `Latest: ${fmt(reports[0].date)}` : "None yet", "admin-reports"],
        ] as [string, string, string, string][]).map(([k, v, d, target], i) => (
          <button
            key={i}
            onClick={() => (target === "import" ? setImportOpen(true) : jumpTo(target))}
            className="spotlight group relative flex min-w-0 flex-col items-center gap-2 bg-card px-4 py-5 text-center transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          >
            {target === "import" ? (
              <FileUp className="absolute right-3 top-3 size-3.5 opacity-0 transition-opacity group-hover:opacity-70 group-focus-visible:opacity-70" />
            ) : (
              <ArrowDown className="absolute right-3 top-3 size-3.5 opacity-0 transition-opacity group-hover:opacity-70 group-focus-visible:opacity-70" />
            )}
            <span className="text-[0.72rem] font-semibold uppercase tracking-[0.08em] text-muted-foreground">{k}</span>
            <span className={cn("whitespace-nowrap font-display text-3xl font-semibold leading-none tabular-nums", target === "import" && stale && "text-warn", target === "admin-review" && pending.length > 0 && "text-warn")}>{v}</span>
            {/* room for two lines, so every tile lines up and nothing is cut off */}
            <span className="min-h-[2.5em] text-[0.8rem] leading-[1.25] text-muted-foreground text-balance [overflow-wrap:anywhere]">{d}</span>
          </button>
        ))}
      </div>

      <ReviewQueue flash={flash === "admin-review"} onEdit={(sj) => openForm(sj, true)} />

      <Panel
        id="admin-chart"
        className={cn("transition-shadow duration-500", flash === "admin-chart" && "ring-2 ring-primary")}
        title="Postings by company"
        sub={`${chartJobs.length} posting${chartJobs.length === 1 ? "" : "s"} first seen ${chartRange === "all" ? "since tracking began" : `in the past ${chartRange} days`}, live and expired`}
        right={
          <div className="flex flex-wrap items-center gap-2">
            <Segmented label="Time range" value={chartRange} onChange={setChartRange} items={[["7", "7d"], ["14", "14d"], ["30", "30d"], ["90", "90d"], ["all", "All time"]]} />
            <Segmented label="Split bars by" value={split} onChange={setSplit} items={[["category", "By category"], ["status", "Live vs. expired"]]} />
          </div>
        }
      >
        <EChart option={chart} merge height={COMPANIES.length * 24 + 72} label="Postings by company" />
      </Panel>

      <Panel
        id="admin-postings"
        flush
        className={cn("transition-shadow duration-500", flash === "admin-postings" && "ring-2 ring-primary")}
        title="All postings"
        sub={<>{list.length} of {jobs.length}, newest first.{" "}<button className="text-primary hover:underline" onClick={() => jumpTo("admin-bin")}>Bin ({bin.length})</button></>}
        right={
          <div className="flex flex-wrap gap-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input type="search" aria-label="Filter by title" placeholder="Filter by title" value={q} onChange={(e) => { setQ(e.target.value); setPage(1) }} className="h-9 w-52 pl-8" />
            </div>
            <Select value={co} onValueChange={(v) => { setCo(v); setPage(1) }}>
              <SelectTrigger className="h-9 w-48" aria-label="Filter by company"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All companies</SelectItem>
                {COMPANIES.filter((c) => jobs.some((j) => j.company === c.id)).map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        }
      >
        {selected.size > 0 && (
          <div className="flex flex-wrap items-center gap-2 border-t bg-accent/60 px-5 py-2 text-sm duration-150 animate-in fade-in">
            <span className="font-medium">{selected.size} selected</span>
            {pageAllSel && selected.size < list.length && (
              <button className="text-primary hover:underline" onClick={() => setSelected(new Set(list.map((j) => j.id)))}>Select all {list.length} matching</button>
            )}
            <div className="ml-auto flex flex-wrap gap-2">
              <Button size="sm" variant="ghost" className="h-8" onClick={() => setSelected(new Set())}>Clear selection</Button>
              <Button size="sm" variant="outline" className="h-8" onClick={() => toReview([...selected])}><ClipboardCheck className="size-3.5" /> Send to review</Button>
              <Button size="sm" variant="outline" className="h-8" onClick={() => setTakenDown([...selected], true)}><EyeOff className="size-3.5" /> Mark taken down</Button>
              <Button size="sm" variant="outline" className="h-8 border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={() => toBin([...selected])}>
                <Trash2 className="size-3.5" /> Move to bin
              </Button>
            </div>
          </div>
        )}
        {list.length ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] border-collapse text-sm">
              <thead>
                <tr className="border-y bg-muted/60 text-left text-[0.7rem] uppercase tracking-[0.07em] text-muted-foreground">
                  <th className="w-12 py-2.5 pl-5 pr-1">
                    <Checkbox
                      aria-label="Select every posting on this page"
                      checked={pageAllSel ? true : pageSomeSel ? "indeterminate" : false}
                      onCheckedChange={(c) => {
                        const next = new Set(selected)
                        pageIds.forEach((id) => (c ? next.add(id) : next.delete(id)))
                        setSelected(next)
                      }}
                    />
                  </th>
                  <th className="px-3 py-2.5 font-semibold">Title</th>
                  <th className="px-3 py-2.5 font-semibold">Company</th>
                  <th className="px-3 py-2.5 font-semibold">Location</th>
                  <th className="px-3 py-2.5 font-semibold">Deadline</th>
                  <th className="px-3 py-2.5 font-semibold">Status</th>
                  <th className="px-5 py-2.5 text-right font-semibold">Actions</th>
                </tr>
              </thead>
              <tbody key={`${cur}-${pageSize}`} className="duration-200 animate-in fade-in">
                {pageRows.map((j) => (
                  <tr
                    key={j.id}
                    tabIndex={0}
                    onClick={() => openJob(j.id)}
                    onKeyDown={(e) => {
                      if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); openJob(j.id) }
                    }}
                    className={cn("cursor-pointer border-b transition-colors duration-150 last:border-b-0 hover:bg-accent/60 focus-visible:bg-accent/60 focus-visible:outline-none", selected.has(j.id) && "bg-accent/40")}
                  >
                    <td className="py-2.5 pl-5 pr-1" onClick={(e) => e.stopPropagation()}>
                      <Checkbox
                        aria-label={`Select ${j.title} at ${coById(j.company).name}`}
                        checked={selected.has(j.id)}
                        onCheckedChange={(c) => {
                          const next = new Set(selected)
                          if (c) next.add(j.id)
                          else next.delete(j.id)
                          setSelected(next)
                        }}
                      />
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="font-semibold">{j.title}</div>
                      <div className="text-xs text-muted-foreground">{catById(j.category).short}, first seen {fmt(j.posted)}</div>
                    </td>
                    <td className="px-3">{coById(j.company).name}</td>
                    <td className="px-3"><LocationCell job={j} /></td>
                    <td className="px-3"><DeadlineCell job={j} soonDays={settings.soonDays} /></td>
                    <td className="px-3"><StatusPill job={j} /></td>
                    <td className="px-5" onClick={(e) => e.stopPropagation()}>
                      <div className="flex justify-end gap-1">
                        <Button size="icon" variant="ghost" className="size-8" aria-label={`Edit ${j.title}`} onClick={() => openForm(j)}><Pencil className="size-4" /></Button>
                        <Button size="icon" variant="ghost" className="size-8" aria-label={`Send ${j.title} to the review queue`} title="Send to review" onClick={() => toReview([j.id])}><ClipboardCheck className="size-4" /></Button>
                        {j.closed ? (
                          <Button size="icon" variant="ghost" className="size-8" aria-label={`Reopen ${j.title}`} title="Reopen" onClick={() => setTakenDown([j.id], false)}><Undo2 className="size-4" /></Button>
                        ) : (
                          <Button size="icon" variant="ghost" className="size-8" aria-label={`Mark ${j.title} as taken down`} title="Mark taken down" onClick={() => setTakenDown([j.id], true)}><EyeOff className="size-4" /></Button>
                        )}
                        <Button size="icon" variant="ghost" className="size-8 text-destructive hover:bg-destructive/10 hover:text-destructive" aria-label={`Move ${j.title} to bin`} onClick={() => toBin([j.id])}><Trash2 className="size-4" /></Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="border-t px-5 py-12 text-center text-sm text-muted-foreground">No postings match.</p>
        )}
        {list.length > 0 && <Pager id="admin-rows" page={cur} pageSize={pageSize} total={list.length} sizes={[10, 20, 50, 100]} onPage={setPage} onPageSize={setPageSize} />}
      </Panel>

      <Panel
        id="admin-bin"
        flush
        className={cn("transition-shadow duration-500", flash === "admin-bin" && "ring-2 ring-primary")}
        title="Deleted postings"
        sub={`Postings stay here for ${BIN_DAYS} days before they are deleted for good. Restore them any time before then.`}
        right={bin.length > 0 && <Button size="sm" variant="outline" className="h-8 border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={() => setPurge(bin.map((b) => b.job.id))}>Empty bin</Button>}
      >
        {binSel.size > 0 && (
          <div className="flex flex-wrap items-center gap-2 border-t bg-accent/60 px-5 py-2 text-sm duration-150 animate-in fade-in">
            <span className="font-medium">{binSel.size} selected</span>
            <div className="ml-auto flex gap-2">
              <Button size="sm" variant="ghost" className="h-8" onClick={() => setBinSel(new Set())}>Clear selection</Button>
              <Button size="sm" variant="outline" className="h-8" onClick={() => restore([...binSel]).then((n) => { setBinSel(new Set()); toast(`Restored ${n} posting${n === 1 ? "" : "s"}`) }, fail)}><RotateCcw className="size-3.5" /> Restore</Button>
              <Button size="sm" variant="outline" className="h-8 border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={() => setPurge([...binSel])}>Delete for good</Button>
            </div>
          </div>
        )}
        {bin.length ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] border-collapse text-sm">
              <thead>
                <tr className="border-y bg-muted/60 text-left text-[0.7rem] uppercase tracking-[0.07em] text-muted-foreground">
                  <th className="w-12 py-2.5 pl-5 pr-1">
                    <Checkbox
                      aria-label="Select every deleted posting"
                      checked={binSel.size === bin.length ? true : binSel.size ? "indeterminate" : false}
                      onCheckedChange={(c) => setBinSel(c ? new Set(bin.map((b) => b.job.id)) : new Set())}
                    />
                  </th>
                  <th className="px-3 py-2.5 font-semibold">Title</th>
                  <th className="px-3 py-2.5 font-semibold">Company</th>
                  <th className="px-3 py-2.5 font-semibold">Deleted</th>
                  <th className="px-3 py-2.5 font-semibold">Removed for good</th>
                  <th className="px-5 py-2.5 text-right font-semibold">Actions</th>
                </tr>
              </thead>
              <tbody>
                {bin.map(({ job: j, deletedAt }) => {
                  const left = daysLeftInBin(deletedAt)
                  return (
                    <tr key={j.id} className={cn("border-b text-muted-foreground last:border-b-0", binSel.has(j.id) && "bg-accent/40")}>
                      <td className="py-2.5 pl-5 pr-1">
                        <Checkbox
                          aria-label={`Select deleted ${j.title}`}
                          checked={binSel.has(j.id)}
                          onCheckedChange={(c) => {
                            const next = new Set(binSel)
                            if (c) next.add(j.id)
                            else next.delete(j.id)
                            setBinSel(next)
                          }}
                        />
                      </td>
                      <td className="px-3 py-2.5 font-medium text-foreground">{j.title}</td>
                      <td className="px-3">{coById(j.company).name}</td>
                      <td className="px-3 tabular-nums">{new Date(deletedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</td>
                      <td className={cn("px-3", left <= 3 && "text-destructive")}>{left === 0 ? "Today" : `In ${left} day${left === 1 ? "" : "s"}`}</td>
                      <td className="px-5">
                        <div className="flex justify-end gap-1">
                          <Button size="sm" variant="ghost" className="h-8" onClick={() => restore([j.id]).then(() => toast("Posting restored", { description: j.title }), fail)}><RotateCcw className="size-3.5" /> Restore</Button>
                          <Button size="sm" variant="ghost" className="h-8 text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={() => deleteForever([j.id]).then(() => toast("Deleted for good"), fail)}>Delete for good</Button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="border-t px-5 py-10 text-center text-sm text-muted-foreground">The bin is empty. Deleted postings show up here.</p>
        )}
      </Panel>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel id="admin-reports" className={cn("transition-shadow duration-500", flash === "admin-reports" && "ring-2 ring-primary")} title="Issue reports" sub="Sent from the job board">
          {reports.length ? (
            <ul>
              {reports.map((r) => {
                const j = jobs.find((x) => x.id === r.jobId)
                return (
                  <li key={r.uid + r.id} className="flex flex-wrap items-start gap-x-3 gap-y-1 border-t py-3 first:border-t-0">
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold">{r.kind}</p>
                      {r.jobId && (j ? (
                        <button className="text-left text-sm text-primary hover:underline" onClick={() => openJob(j.id)}>{j.title}, {coById(j.company).name}</button>
                      ) : (
                        <p className="text-sm text-muted-foreground">Posting no longer listed</p>
                      ))}
                      <p className="mt-1 text-sm">{r.details}</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {names[r.uid] || (mode === "preview" ? "You" : "Someone")}, {fmt(r.date)}
                        {r.email ? <><br />{r.email}</> : null}
                      </p>
                    </div>
                    <Button size="sm" variant="ghost" className="h-7" onClick={() => resolveInbox(r.uid, "reports", r.id).then(() => toast("Report resolved"), fail)}>Resolve</Button>
                  </li>
                )
              })}
            </ul>
          ) : (
            <p className="py-8 text-center text-sm text-muted-foreground">No open reports.</p>
          )}
        </Panel>

        <Panel id="admin-categories" title="Categories" sub="Used to group postings across the site. Removing a category moves its postings to Other.">
          <ul>
            {CATS.map((c) => {
              const n = jobs.filter((j) => j.category === c.id).length
              return (
                <li key={c.id} className="flex items-center gap-3 border-t py-2.5 first:border-t-0">
                  <CatChip id={c.id} className="min-w-0 flex-1 text-sm" />
                  <span className="text-sm tabular-nums text-muted-foreground">{n} posting{n === 1 ? "" : "s"}</span>
                  {c.custom ? (
                    <Button size="sm" variant="ghost" className="h-7 text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={() => setRemoveCat(c.id)}>Remove</Button>
                  ) : (
                    <span className="w-[68px] text-right text-xs text-muted-foreground">Built in</span>
                  )}
                </li>
              )
            })}
          </ul>
          <form className="mt-3 flex flex-col gap-1.5 border-t pt-3" onSubmit={(e) => { e.preventDefault(); addCategory() }}>
            <Label htmlFor="newcat">Add a category</Label>
            <div className="flex gap-2">
              <Input id="newcat" value={newCat} onChange={(e) => { setNewCat(e.target.value); setCatErr("") }} placeholder="e.g. Medical affairs" maxLength={40} aria-invalid={!!catErr} aria-describedby={catErr ? "newcat-err" : undefined} />
              <Button type="submit" variant="outline"><Plus className="size-4" /> Add</Button>
            </div>
            {catErr && <p id="newcat-err" className="text-xs text-destructive">{catErr}</p>}
          </form>
        </Panel>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel id="admin-requests" className={cn("transition-shadow duration-500", flash === "admin-requests" && "ring-2 ring-primary")} title="Company requests" sub="Sent from the Company Info page">
          {requests.length ? (
            <ul>
              {requests.map((r) => (
                <li key={r.uid + r.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-t py-2.5 first:border-t-0">
                  <b>{r.name}</b>
                  <span className="flex basis-full flex-col text-sm text-muted-foreground">
                    {[r.cat, r.site, r.email].filter(Boolean).map((x) => <span key={x}>{x}</span>)}
                    <span className="text-xs">{names[r.uid] || (mode === "preview" ? "You" : "Someone")}, {fmt(r.date)}</span>
                  </span>
                  <Button size="sm" variant="ghost" className="ml-auto h-7" onClick={() => resolveInbox(r.uid, "requests", r.id).then(() => toast("Request dismissed"), fail)}>Dismiss</Button>
                  {r.why && <p className="basis-full text-sm text-muted-foreground">{r.why}</p>}
                </li>
              ))}
            </ul>
          ) : (
            <p className="py-8 text-center text-sm text-muted-foreground">No requests yet.</p>
          )}
        </Panel>
        {mode === "preview" && (
          <Panel title="Sample data" sub="This preview copy runs on sample postings in this browser.">
            <Button variant="outline" className="self-start border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={() => setResetOpen(true)}>Reset sample data</Button>
          </Panel>
        )}
      </div>

      <JobForm
        key={formKey}
        job={editing}
        open={formOpen}
        onOpenChange={setFormOpen}
        inReview={editingStaged}
        onSave={async (data, action) => {
          try {
            if (editingStaged && editing) {
              const merged = { ...editing, ...data } as StagedJob
              const flags = reviewFlags(merged)
              await saveStaged([{ ...merged, review: { ...merged.review, flags: flags.length ? flags : merged.review.flags } }])
              if (action === "approve") {
                await approve([merged.id])
                toast("Approved and published", { description: data.title })
              } else toast("Saved changes", { description: "Still waiting for review." })
            } else if (!editing && action === "hold") {
              const job = { ...(data as Job), id: "j" + Date.now().toString(36) }
              await saveStaged([stage(job, ["Held by staff for a closer look", ...reviewFlags(job)], "held")])
              toast("Held for review", { description: data.title, action: { label: "Show me", onClick: () => jumpTo("admin-review") } })
            } else {
              const next = editing ? ({ ...editing, ...data } as Job) : ({ ...(data as Job), id: "j" + Date.now().toString(36) })
              await saveJobs([next])
              toast(editing ? "Saved changes" : "Posting published", { description: data.title })
            }
            setFormOpen(false)
          } catch { fail() }
        }}
      />
      <ImportDialog open={importOpen} onOpenChange={setImportOpen} />

      <Dialog open={!!purge} onOpenChange={(o) => !o && setPurge(null)}>
        <DialogContent className="w-[calc(100vw-2rem)] max-w-md">
          <DialogHeader className="text-left">
            <DialogTitle className="font-display text-xl">Delete {purge && purge.length === 1 ? "this posting" : `${purge?.length ?? 0} postings`} for good?</DialogTitle>
            <DialogDescription>They can't be restored after this.</DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setPurge(null)}>Cancel</Button>
            <Button variant="destructive" onClick={() => { if (purge) deleteForever(purge).then(() => { setBinSel(new Set()); toast(`Deleted ${purge.length} for good`) }, fail); setPurge(null) }}>Delete for good</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!removeCat} onOpenChange={(o) => !o && setRemoveCat(null)}>
        <DialogContent className="w-[calc(100vw-2rem)] max-w-md">
          <DialogHeader className="text-left">
            <DialogTitle className="font-display text-xl">Remove {removeCat ? catById(removeCat).label : ""}?</DialogTitle>
            <DialogDescription>{removeCat ? `${jobs.filter((j) => j.category === removeCat).length} posting(s) in this category will move to Other.` : ""}</DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setRemoveCat(null)}>Cancel</Button>
            <Button variant="destructive" onClick={() => { if (removeCat) doRemoveCat(removeCat); setRemoveCat(null) }}>Remove category</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={resetOpen} onOpenChange={setResetOpen}>
        <DialogContent className="w-[calc(100vw-2rem)] max-w-md">
          <DialogHeader className="text-left">
            <DialogTitle className="font-display text-xl">Reset to sample data?</DialogTitle>
            <DialogDescription>This preview copy goes back to the original sample postings, and the bin is emptied.</DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setResetOpen(false)}>Cancel</Button>
            <Button variant="destructive" onClick={() => { resetSample(); setResetOpen(false); toast("Sample data restored") }}>Reset data</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
