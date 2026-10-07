"use client"

/**
 * Dashboard pieces borrowed from the dev-tool startups:
 * - KPI cards with a sparkline and a week-over-week change (Vercel, Stripe, PostHog)
 * - a status bar that splits one total into states (Baseten's deployment status bar)
 * - a getting-started checklist (PostHog, Resend, Supabase onboarding)
 * - a recent-activity feed (Vercel deployments, Linear inbox)
 * - a layout each person can reorder and trim (Baseten's customizable metrics page)
 */
import { useLayoutEffect, useRef, useState } from "react"
import { ArrowDown, ArrowRight, ArrowUp, Check, EyeOff, GripVertical, Plus, RotateCcw, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { useApp } from "@/lib/state"
import { DEFAULT_SETTINGS } from "@/lib/state"
import {
  CATS, ROLLING_DAYS, TODAY, addDays, coById, daysLeft, diffDays, fmt, isLive, parse, store, type Job,
} from "@/lib/data"

/* ---------- sparkline ---------- */
export function Sparkline({ values, className, label }: { values: number[]; className?: string; label: string }) {
  const max = Math.max(1, ...values)
  const min = Math.min(0, ...values)
  const pts = values.map((v, i) => [(i / Math.max(1, values.length - 1)) * 100, 28 - ((v - min) / (max - min || 1)) * 24] as const)
  const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(2)},${y.toFixed(2)}`).join(" ")
  const id = useRef("sp" + Math.random().toString(36).slice(2, 8)).current
  return (
    <svg viewBox="0 0 100 30" preserveAspectRatio="none" className={cn("h-9 w-full overflow-visible", className)} role="img" aria-label={label}>
      <defs>
        <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="currentColor" stopOpacity="0.22" />
          <stop offset="1" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`${line} L100,30 L0,30 Z`} fill={`url(#${id})`} />
      <path d={line} fill="none" stroke="currentColor" strokeWidth="1.6" vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={pts[pts.length - 1][0]} cy={pts[pts.length - 1][1]} r="2.2" fill="currentColor" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

/* ---------- KPI band ---------- */
const liveOn = (j: Job, d: Date) =>
  !j.closed && parse(j.posted) <= d && (j.deadline ? parse(j.deadline) >= d : diffDays(d, parse(j.posted)) <= ROLLING_DAYS)
const WEEKS = 12

export function KpiBand() {
  const { jobs, settings, go } = useApp()
  const ends = Array.from({ length: WEEKS }, (_, i) => addDays(TODAY, -7 * (WEEKS - 1 - i)))
  const liveSeries = ends.map((d) => jobs.filter((j) => liveOn(j, d)).length)
  const newSeries = ends.map((d) => jobs.filter((j) => { const p = parse(j.posted); return p <= d && diffDays(d, p) < 7 }).length)
  const expSeries = ends.map((d) => jobs.filter((j) => parse(j.posted) <= d && !liveOn(j, d)).length)
  const ahead = Array.from({ length: 8 }, (_, i) => addDays(TODAY, 7 * i))
  const closeSeries = ahead.map((d) => jobs.filter((j) => isLive(j) && j.deadline && parse(j.deadline) >= d && diffDays(parse(j.deadline), d) < 7).length)
  const soon = jobs.filter((j) => isLive(j) && j.deadline && (daysLeft(j) as number) <= settings.soonDays).sort((a, b) => a.deadline.localeCompare(b.deadline))
  const last = (a: number[]) => a[a.length - 1]
  const prev = (a: number[]) => a[a.length - 2]
  const cards: { k: string; v: number; series: number[]; delta?: number; good?: "up" | "down" | "none"; note?: string; spark: string; onClick: () => void }[] = [
    { k: "Live internships", v: jobs.filter(isLive).length, series: liveSeries, delta: last(liveSeries) - prev(liveSeries), good: "up", spark: "Live postings each week, past 12 weeks", onClick: () => go("jobs", { status: "live" }) },
    { k: "New this week", v: last(newSeries), series: newSeries, delta: last(newSeries) - prev(newSeries), good: "up", spark: "New postings each week, past 12 weeks", onClick: () => go("jobs", { status: "live" }) },
    {
      k: `Closing in ${settings.soonDays} days`, v: soon.length, series: closeSeries, good: "none", spark: "Deadlines each week, next 8 weeks",
      note: soon[0] ? `Next ${fmt(soon[0].deadline, { month: "short", day: "numeric" })}` : "None coming up",
      onClick: () => go("jobs", { deadline: settings.soonDays <= 7 ? "week" : settings.soonDays <= 14 ? "14" : "30", status: "live" }),
    },
    { k: "Expired", v: jobs.filter((j) => !isLive(j)).length, series: expSeries, delta: last(expSeries) - prev(expSeries), good: "none", spark: "Expired postings each week, past 12 weeks", onClick: () => go("jobs", { status: "expired" }) },
  ]
  return (
    <div className="glass grid overflow-hidden rounded-lg border sm:grid-cols-2 xl:grid-cols-4">
      {cards.map((c, i) => {
        const up = (c.delta ?? 0) > 0
        const tone = c.delta === undefined || c.delta === 0 || c.good === "none" ? "flat" : (up === (c.good === "up")) ? "good" : "bad"
        return (
          <button
            key={c.k}
            onClick={c.onClick}
            className={cn(
              "spotlight group flex min-w-0 flex-col gap-3 p-5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
              i > 0 && "border-t sm:[&:nth-child(2)]:border-t-0 sm:[&:nth-child(even)]:border-l xl:border-l xl:border-t-0"
            )}
          >
            <span className="flex items-center justify-between text-[0.8rem] font-medium text-muted-foreground">
              {c.k}
              <ArrowRight className="size-3.5 -translate-x-1 opacity-0 transition-[opacity,transform] group-hover:translate-x-0 group-hover:opacity-70" />
            </span>
            <span className="flex items-end justify-between gap-4">
              <span className="flex flex-col gap-1.5">
                <span className="text-[2rem] font-semibold leading-none tracking-tight tabular-nums">{c.v}</span>
                {c.note ? (
                  <span className="font-mono text-[0.72rem] text-muted-foreground">{c.note}</span>
                ) : (
                  <span className={cn("inline-flex w-fit items-center gap-0.5 whitespace-nowrap rounded px-1 font-mono text-[0.72rem] tabular-nums",
                    tone === "good" && "bg-good/10 text-good", tone === "bad" && "bg-destructive/10 text-destructive", tone === "flat" && "bg-muted text-muted-foreground")}>
                    {up ? <ArrowUp className="size-3" /> : (c.delta ?? 0) < 0 ? <ArrowDown className="size-3" /> : null}
                    {(c.delta ?? 0) === 0 ? "no change" : Math.abs(c.delta ?? 0)} <span className="opacity-70">vs last wk</span>
                  </span>
                )}
              </span>
              <Sparkline values={c.series} label={c.spark} className={cn("min-w-0 max-w-[7.5rem] flex-1", i === 0 ? "text-primary" : i === 2 ? "text-warn" : "text-muted-foreground")} />
            </span>
          </button>
        )
      })}
    </div>
  )
}

/* ---------- card shell for the "you" row ---------- */
function Card({ title, right, children, className }: { title: string; right?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={cn("glass spotlight flex min-w-0 flex-col rounded-lg border p-5", className)}>
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="font-display text-[1rem] font-semibold">{title}</h2>
        {right}
      </div>
      {children}
    </section>
  )
}

/* ---------- your pipeline (status bar) ---------- */
export function PipelineCard() {
  const { jobs, saved, applied, go } = useApp()
  const todo = jobs.filter((j) => isLive(j) && !saved.has(j.id) && !applied.has(j.id)).length
  const segs = [
    { id: "todo" as const, label: "To apply", n: todo, color: "bg-[var(--chart-neutral)]" },
    { id: "saved" as const, label: "Saved", n: saved.size, color: "bg-primary" },
    { id: "done" as const, label: "Applied", n: applied.size, color: "bg-good" },
  ]
  const total = Math.max(1, segs.reduce((a, s) => a + s.n, 0))
  const byCat = CATS.map((c) => ({ ...c, n: jobs.filter((j) => isLive(j) && j.category === c.id).length }))
  const catMax = Math.max(1, ...byCat.map((c) => c.n))
  const savedSoon = jobs.filter((j) => saved.has(j.id) && isLive(j) && j.deadline && (daysLeft(j) as number) <= 7).length
  return (
    <Card title="Your pipeline" right={<Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => go("jobs")}>Open board <ArrowRight className="size-3" /></Button>}>
      <div className="flex h-2.5 gap-0.5 overflow-hidden rounded-full bg-muted" role="img" aria-label={segs.map((s) => `${s.label} ${s.n}`).join(", ")}>
        {segs.map((s) => s.n > 0 && <span key={s.id} className={cn("h-full transition-[width] duration-500 ease-out", s.color)} style={{ width: `${(s.n / total) * 100}%` }} />)}
      </div>
      <ul className="mt-4 grid grid-cols-3 gap-2">
        {segs.map((s) => (
          <li key={s.id}>
            <button onClick={() => go("jobs", undefined, s.id)} className="group flex w-full flex-col gap-1 rounded-md p-2 text-left hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground"><span className={cn("size-2 rounded-full", s.color)} />{s.label}</span>
              <span className="text-2xl font-semibold leading-none tabular-nums">{s.n}</span>
            </button>
          </li>
        ))}
      </ul>
      <div className="mt-4 border-t pt-3">
        <p className="mb-2 text-xs font-medium text-muted-foreground">Live roles by area</p>
        <ul className="flex flex-col gap-1">
          {byCat.map((c) => (
            <li key={c.id}>
              <button onClick={() => go("jobs", { category: [c.id], status: "live" })} className="grid w-full grid-cols-[6.5rem_minmax(0,1fr)_2rem] items-center gap-2 rounded px-1 py-0.5 text-left text-xs hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <span className="truncate">{c.short}</span>
                <span className="h-1.5 overflow-hidden rounded-full bg-muted"><span className="block h-full rounded-full transition-[width] duration-500" style={{ width: `${(c.n / catMax) * 100}%`, background: `var(${c.color})` }} /></span>
                <span className="text-right font-mono tabular-nums text-muted-foreground">{c.n}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      <p className="mt-auto pt-3 text-xs text-muted-foreground">
        {savedSoon ? <><b className="font-medium text-warn">{savedSoon}</b> saved role{savedSoon === 1 ? "" : "s"} close within a week.</> : saved.size ? "None of your saved roles close this week." : "Save roles on the job board to track them here."}
      </p>
    </Card>
  )
}

/* ---------- getting started, then your next deadlines ---------- */
export function StartCard() {
  const { saved, applied, settings, go, jobs, openJob } = useApp()
  const [hidden, setHidden] = useState(() => store.get<boolean>("checklistHidden", false))
  const steps = [
    { label: "Set your location", hint: "Roles with several sites show the closest one.", done: store.get<boolean>("homeSet", false) || settings.home !== DEFAULT_SETTINGS.home, act: () => go("settings") },
    { label: "Save a role you like", hint: "Bookmark it on the job board.", done: saved.size + applied.size > 0, act: () => go("jobs") },
    { label: "Mark a role as applied", hint: "Tick the box once you've sent it.", done: applied.size > 0, act: () => go("jobs", undefined, "saved") },
    { label: "Add deadlines to your calendar", hint: "Export from Settings.", done: store.get<boolean>("exportedDeadlines", false), act: () => go("settings") },
  ]
  const done = steps.filter((s) => s.done).length
  if (!hidden && done < steps.length)
    return (
      <Card
        title="Get started"
        right={<button onClick={() => { setHidden(true); store.set("checklistHidden", true) }} className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label="Hide the getting-started list"><X className="size-3.5" /></button>}
      >
        <div className="mb-3 flex items-center gap-3">
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary transition-[width] duration-500" style={{ width: `${(done / steps.length) * 100}%` }} /></div>
          <span className="font-mono text-xs tabular-nums text-muted-foreground">{done}/{steps.length}</span>
        </div>
        <ol className="flex flex-col">
          {steps.map((s, i) => (
            <li key={s.label}>
              <button onClick={s.act} disabled={s.done} className="group flex w-full items-start gap-3 rounded-md px-1.5 py-2 text-left hover:bg-muted disabled:hover:bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <span className={cn("mt-0.5 grid size-5 shrink-0 place-items-center rounded-full border text-[0.65rem] font-semibold", s.done ? "border-good bg-good text-white" : "text-muted-foreground")}>
                  {s.done ? <Check className="size-3" strokeWidth={3} /> : i + 1}
                </span>
                <span className="min-w-0 flex-1">
                  <span className={cn("block text-sm font-medium", s.done && "text-muted-foreground line-through decoration-muted-foreground/50")}>{s.label}</span>
                  {!s.done && <span className="block text-xs text-muted-foreground">{s.hint}</span>}
                </span>
                {!s.done && <ArrowRight className="mt-1 size-3.5 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />}
              </button>
            </li>
          ))}
        </ol>
      </Card>
    )
  const next = jobs.filter((j) => (saved.has(j.id) || applied.has(j.id)) && isLive(j) && j.deadline).sort((a, b) => a.deadline.localeCompare(b.deadline)).slice(0, 5)
  return (
    <Card title="Your next deadlines" right={<Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => go("jobs", undefined, "saved")}>Saved <ArrowRight className="size-3" /></Button>}>
      {next.length ? (
        <ul className="-mx-1.5 flex flex-col">
          {next.map((j) => (
            <li key={j.id}>
              <button onClick={() => openJob(j.id)} className="flex w-full items-center gap-3 rounded-md px-1.5 py-2 text-left hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <span className="w-14 shrink-0 font-mono text-xs tabular-nums text-muted-foreground">{fmt(j.deadline, { month: "short", day: "numeric" })}</span>
                <span className="min-w-0 flex-1 truncate text-sm"><b className="font-medium">{j.title}</b><span className="text-muted-foreground">, {coById(j.company).name}</span></span>
                {applied.has(j.id) && <span className="text-xs text-good">Applied</span>}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="py-6 text-center text-sm text-muted-foreground">Save roles with a deadline and they'll line up here.</p>
      )}
      {hidden && done < steps.length && (
        <button className="mt-auto self-start pt-2 text-xs text-muted-foreground hover:text-foreground" onClick={() => { setHidden(false); store.set("checklistHidden", false) }}>Show the getting-started list</button>
      )}
    </Card>
  )
}

/* ---------- recent activity ---------- */
const since = (t: number) => {
  const m = Math.max(0, Math.round((Date.now() - t) / 60000))
  if (m < 60) return `${Math.max(1, m)}m`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h`
  const d = Math.round(h / 24)
  return d < 30 ? `${d}d` : `${Math.round(d / 30)}mo`
}
export function ActivityCard() {
  const { jobs, openJob, isNew } = useApp()
  const events = [
    ...jobs.map((j) => ({ j, t: j.addedAt ?? parse(j.posted).getTime() + 9 * 36e5, kind: "new" as const })),
    ...jobs
      .filter((j) => j.deadline && parse(j.deadline) < TODAY && diffDays(TODAY, parse(j.deadline)) <= 21)
      .map((j) => ({ j, t: addDays(parse(j.deadline), 1).getTime(), kind: "closed" as const })),
  ]
    .filter((e) => e.t <= Date.now())
    .sort((a, b) => b.t - a.t)
    .slice(0, 6)
  return (
    <Card title="Recent activity">
      <ol className="relative -mx-1.5 flex flex-col">
        <span aria-hidden className="absolute bottom-3 left-[0.97rem] top-3 w-px bg-border" />
        {events.map(({ j, t, kind }) => (
          <li key={kind + j.id}>
            <button onClick={() => openJob(j.id)} className="relative flex w-full items-start gap-3 rounded-md px-1.5 py-1.5 text-left hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <span className={cn("relative z-[1] mt-1.5 size-2 shrink-0 rounded-full ring-4 ring-card", kind === "new" ? "bg-good" : "bg-muted-foreground/50")} />
              <span className="min-w-0 flex-1 text-sm leading-snug">
                <span className="block truncate"><b className="font-medium">{coById(j.company).name}</b> <span className="text-muted-foreground">{kind === "new" ? "posted" : "closed"}</span></span>
                <span className="block truncate text-muted-foreground">{j.title}</span>
              </span>
              <span className="mt-0.5 flex shrink-0 flex-col items-end gap-1">
                <span className="font-mono text-[0.7rem] tabular-nums text-muted-foreground">{since(t)}</span>
                {kind === "new" && isNew(j) && <span className="rounded bg-primary/10 px-1 text-[0.62rem] font-semibold uppercase tracking-wide text-primary">New</span>}
              </span>
            </button>
          </li>
        ))}
      </ol>
    </Card>
  )
}

/* ---------- arrange sections ---------- */
export interface SectionDef { id: string; label: string; node: React.ReactNode }
export function normalizeLayout(ids: string[], saved?: { order: string[]; hidden: string[] }) {
  const order = [...(saved?.order || []).filter((id) => ids.includes(id)), ...ids.filter((id) => !(saved?.order || []).includes(id))]
  return { order, hidden: (saved?.hidden || []).filter((id) => ids.includes(id)) }
}

/**
 * Renders the dashboard sections in each person's order. In customize mode every section gets a
 * handle: drag it, or use the arrows, to move it; hide what you don't use and add it back later.
 */
export function Arranger({ sections, order, hidden, editing, onChange }: { sections: SectionDef[]; order: string[]; hidden: string[]; editing: boolean; onChange: (order: string[], hidden: string[]) => void }) {
  const els = useRef<Record<string, HTMLElement | null>>({})
  const tops = useRef<Record<string, number>>({})
  const [dragging, setDragging] = useState<string | null>(null)
  const byId = Object.fromEntries(sections.map((s) => [s.id, s]))
  const visible = order.filter((id) => !hidden.includes(id) && byId[id])

  // glide sections to their new places whenever the order changes (FLIP)
  useLayoutEffect(() => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    const next: Record<string, number> = {}
    visible.forEach((id) => {
      const el = els.current[id]
      if (!el) return
      next[id] = el.getBoundingClientRect().top + (document.getElementById("main")?.scrollTop || 0)
      const before = tops.current[id]
      if (!reduce && before !== undefined && Math.abs(before - next[id]) > 1)
        el.animate([{ transform: `translateY(${before - next[id]}px)` }, { transform: "none" }], { duration: 320, easing: "cubic-bezier(.3,.7,.2,1)" })
    })
    tops.current = next
  })

  const move = (id: string, dir: -1 | 1) => {
    const i = visible.indexOf(id)
    const j = i + dir
    if (j < 0 || j >= visible.length) return
    const swapWith = visible[j]
    const o = [...order]
    const a = o.indexOf(id), b = o.indexOf(swapWith)
    ;[o[a], o[b]] = [o[b], o[a]]
    onChange(o, hidden)
  }
  const dragOver = (overId: string) => {
    if (!dragging || dragging === overId) return
    const o = order.filter((x) => x !== dragging)
    const at = o.indexOf(overId)
    const from = order.indexOf(dragging), to = order.indexOf(overId)
    o.splice(from < to ? at + 1 : at, 0, dragging)
    onChange(o, hidden)
  }

  return (
    <>
      {visible.map((id, i) => (
        <div
          key={id}
          ref={(el) => { els.current[id] = el }}
          onDragOver={(e) => { if (editing && dragging) { e.preventDefault(); dragOver(id) } }}
          onDrop={(e) => { e.preventDefault(); setDragging(null) }}
          className={cn("relative rounded-lg transition-[box-shadow,opacity] duration-200", editing && "outline-dashed outline-1 outline-offset-[6px] outline-border", dragging === id && "opacity-50")}
        >
          {editing && (
            <div className="mb-2 flex items-center gap-2 duration-200 animate-in fade-in slide-in-from-top-1">
              <span
                draggable
                onDragStart={(e) => { setDragging(id); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", id) }}
                onDragEnd={() => setDragging(null)}
                className="flex cursor-grab items-center gap-1.5 rounded-md border bg-card px-2 py-1 text-xs font-medium shadow-sm active:cursor-grabbing"
                title="Drag to move"
              >
                <GripVertical className="size-3.5 text-muted-foreground" /> {byId[id].label}
              </span>
              <div className="ml-auto flex items-center gap-1">
                <Button size="icon" variant="ghost" className="size-7" disabled={i === 0} onClick={() => move(id, -1)} aria-label={`Move ${byId[id].label} up`}><ArrowUp className="size-3.5" /></Button>
                <Button size="icon" variant="ghost" className="size-7" disabled={i === visible.length - 1} onClick={() => move(id, 1)} aria-label={`Move ${byId[id].label} down`}><ArrowDown className="size-3.5" /></Button>
                <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => onChange(order, [...hidden, id])}><EyeOff className="size-3.5" /> Hide</Button>
              </div>
            </div>
          )}
          <div className={cn(editing && "pointer-events-none select-none")}>{byId[id].node}</div>
        </div>
      ))}
      {editing && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed p-4 text-sm duration-200 animate-in fade-in">
          <span className="text-muted-foreground">{hidden.length ? "Hidden:" : "Every section is showing."}</span>
          {hidden.map((id) => byId[id] && (
            <Button key={id} size="sm" variant="outline" className="h-7 text-xs" onClick={() => onChange(order, hidden.filter((h) => h !== id))}><Plus className="size-3.5" /> {byId[id].label}</Button>
          ))}
          <Button size="sm" variant="ghost" className="ml-auto h-7 text-xs" onClick={() => onChange(sections.map((s) => s.id), [])}><RotateCcw className="size-3.5" /> Reset layout</Button>
        </div>
      )}
    </>
  )
}
