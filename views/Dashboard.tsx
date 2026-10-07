"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { ArrowRight, BellRing, Check, ChevronLeft, ChevronRight, LayoutGrid, Sparkles } from "lucide-react"
import { toast } from "sonner"
import { ActivityCard, Arranger, KpiBand, PipelineCard, StartCard, normalizeLayout, type SectionDef } from "@/views/DashboardWidgets"
import { Button } from "@/components/ui/button"
import { Segmented } from "@/components/Segmented"
import { EChart, chartBase, cssColor, echarts } from "@/components/EChart"
import { CatChip } from "@/components/common"
import { UsMap } from "@/components/UsMap"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useApp } from "@/lib/state"
import {
  CATS, COMPANIES, THIS_MONTH, TODAY, addDays, addMonths, ageDays, coById, daysLeft, fmt, inMonth, iso,
  isLive, monthEnd, monthLabel, type Job,
} from "@/lib/data"
import { cn } from "@/lib/utils"

/* ---------- small building blocks ---------- */
function Panel({ title, sub, right, children, className = "" }: { title: string; sub?: React.ReactNode; right?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={"spotlight flex min-w-0 flex-col rounded-lg border bg-card p-5 " + className}>
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-display text-[1rem] font-semibold leading-snug">{title}</h2>
          {sub && <p className="text-[0.82rem] text-muted-foreground">{sub}</p>}
        </div>
        {right}
      </div>
      {children}
    </section>
  )
}

function Seg<T extends string>({ value, onChange, items, label }: { value: T; onChange: (v: T) => void; items: [T, string][]; label: string }) {
  return <Segmented value={value} onChange={onChange} items={items} label={label} />
}

function Stepper({ label, onPrev, onNext, prevDisabled, nextDisabled, what }: { label: string; onPrev: () => void; onNext: () => void; prevDisabled?: boolean; nextDisabled?: boolean; what: string }) {
  return (
    <div className="inline-flex items-center gap-1 rounded-lg border bg-card p-0.5">
      <Button variant="ghost" size="icon" className="size-7" onClick={onPrev} disabled={prevDisabled} aria-label={`Previous ${what}`}>
        <ChevronLeft className="size-4" />
      </Button>
      <span className="w-[9.5rem] text-center text-sm font-medium tabular-nums" aria-live="polite">{label}</span>
      <Button variant="ghost" size="icon" className="size-7" onClick={onNext} disabled={nextDisabled} aria-label={`Next ${what}`}>
        <ChevronRight className="size-4" />
      </Button>
    </div>
  )
}

const MONTHS_BACK = 11 // the sample data covers the last 12 months
const SEQ = ["--seq-0", "--seq-1", "--seq-2", "--seq-3", "--seq-4"]

export default function Dashboard() {
  const { jobs, settings, dark, openJob, go, saved, isNew, prevVisit, mine, setLayout } = useApp()
  const [editing, setEditing] = useState(false)
  const [heatAll, setHeatAll] = useState(false)
  const [heatView, setHeatView] = useState<"chart" | "table">("chart")
  const [calView, setCalView] = useState<"calendar" | "list">("calendar")
  const [mapSet, setMapSet] = useState<"live" | "all">("live")
  const [statusRange, setStatusRange] = useState<"7" | "30" | "60" | "90" | "all">("7")
  const [monthIdx, setMonthIdx] = useState(MONTHS_BACK) // index into the 12-month window; 11 = this month
  const [topMode, setTopMode] = useState<"7" | "30" | "month" | "365">("30")
  const [topMonth, setTopMonth] = useState(0) // months back from this month
  const [calOffset, setCalOffset] = useState(-2) // first month shown, relative to this month
  const [calDay, setCalDay] = useState<string | null>(null)

  const live = jobs.filter(isLive)
  const soon = live.filter((j) => j.deadline && (daysLeft(j) as number) <= settings.soonDays).sort((a, b) => (daysLeft(a) as number) - (daysLeft(b) as number))

  /* ---------- postings per month ---------- */
  const months = useMemo(() => Array.from({ length: MONTHS_BACK + 1 }, (_, i) => addMonths(THIS_MONTH, i - MONTHS_BACK)), [])
  const selMonth = months[monthIdx]
  const monthJobs = jobs.filter((j) => inMonth(j.posted, selMonth)).sort((a, b) => b.posted.localeCompare(a.posted))
  // How bright each month's column is. Clicking a month fades the old column down and the new one up
  // over a few frames instead of snapping, while the bar heights stay put.
  const DIM = 0.32
  const monthChart = useRef<echarts.ECharts | null>(null)
  const shade = useRef<number[]>(months.map((_, i) => (i === monthIdx ? 1 : DIM)))
  const counts = useMemo(() => CATS.map((c) => months.map((m) => jobs.filter((j) => j.category === c.id && inMonth(j.posted, m)).length)), [jobs, months])
  const monthSeries = (op: number[]) =>
    CATS.map((c, ci) => ({ id: "m-" + c.id, data: counts[ci].map((value, i) => ({ value, itemStyle: { opacity: op[i] } })) }))
  const monthly = useMemo(() => {
    const { base, valueAxis, catAxis } = chartBase()
    return {
      ...base,
      tooltip: { ...base.tooltip, trigger: "axis", axisPointer: { type: "shadow" } },
      grid: { left: 8, right: 8, top: 12, bottom: 36, containLabel: true },
      xAxis: { ...catAxis, data: months.map((m) => m.toLocaleDateString("en-US", { month: "short" }) + (m.getMonth() === 0 ? " ’" + String(m.getFullYear()).slice(2) : "")) },
      yAxis: valueAxis,
      animationDurationUpdate: 300,
      animationEasingUpdate: "cubicOut" as const,
      series: CATS.map((c, ci) => ({
        id: "m-" + c.id,
        name: c.short,
        type: "bar",
        stack: "all",
        barMaxWidth: 34,
        itemStyle: { color: cssColor(c.color), borderColor: cssColor("--card"), borderWidth: 1 },
        data: counts[ci].map((value, i) => ({ value, itemStyle: { opacity: shade.current[i] } })),
      })),
    }
  }, [counts, dark, months]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const from = [...shade.current]
    const to = months.map((_, i) => (i === monthIdx ? 1 : DIM))
    if (from.every((v, i) => v === to[i])) return
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    const start = performance.now()
    const DUR = reduce ? 0 : 380
    let raf = 0
    const step = (now: number) => {
      const t = DUR ? Math.min(1, (now - start) / DUR) : 1
      const e = 1 - Math.pow(1 - t, 3) // ease out
      shade.current = from.map((f, i) => f + (to[i] - f) * e)
      // our own frames drive the fade, so the chart's built-in update animation is paused meanwhile
      monthChart.current?.setOption({ animation: t >= 1, series: monthSeries(shade.current) }, { silent: true })
      if (t < 1) raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => {
      cancelAnimationFrame(raf)
      monthChart.current?.setOption({ animation: true })
    }
  }, [monthIdx]) // eslint-disable-line react-hooks/exhaustive-deps

  /* ---------- live vs expired ---------- */
  const statusSet = statusRange === "all" ? jobs : jobs.filter((j) => ageDays(j) < Number(statusRange))
  const status = useMemo(() => {
    const { base, valueAxis, catAxis } = chartBase()
    const stack = [true, false].map((want) => CATS.map((c) => statusSet.filter((j) => j.category === c.id && isLive(j) === want).length))
    const mk = (name: string, color: string, wantLive: boolean, labelColor: string) => ({
      id: wantLive ? "live" : "expired",
      name,
      type: "bar",
      stack: "s",
      barMaxWidth: 26,
      itemStyle: { color, borderColor: cssColor("--card"), borderWidth: 1 },
      label: { show: true, position: "inside", color: labelColor, fontSize: 11, formatter: (p: { value: number }) => (p.value ? String(p.value) : "") },
      data: stack[wantLive ? 0 : 1],
    })
    return {
      ...base,
      tooltip: { ...base.tooltip, trigger: "axis", axisPointer: { type: "shadow" } },
      grid: { left: 96, right: 16, top: 4, bottom: 52, containLabel: false },
      yAxis: { ...catAxis, data: CATS.map((c) => c.short), inverse: true, axisLabel: { color: cssColor("--foreground"), fontSize: 12, width: 86, overflow: "truncate" } },
      xAxis: valueAxis,
      series: [mk("Live", cssColor("--primary"), true, cssColor("--primary-foreground")), mk("Expired", cssColor("--chart-neutral"), false, cssColor("--foreground"))],
    }
  }, [jobs, dark, statusRange]) // eslint-disable-line react-hooks/exhaustive-deps

  /* ---------- most active companies ---------- */
  const ROWS = 8
  const topMonthDate = addMonths(THIS_MONTH, -topMonth)
  const topRows = useMemo(() => {
    const set = jobs.filter((j) => (topMode === "month" ? inMonth(j.posted, topMonthDate) : ageDays(j) < Number(topMode)))
    const counts: Record<string, number[]> = {}
    set.forEach((j) => {
      const c = (counts[j.company] = counts[j.company] || CATS.map(() => 0))
      c[CATS.findIndex((k) => k.id === j.category)]++
    })
    const tot = (n: number[]) => n.reduce((a, b) => a + b, 0)
    return Object.entries(counts).sort((a, b) => tot(b[1]) - tot(a[1]) || coById(a[0]).name.localeCompare(coById(b[0]).name)).slice(0, ROWS)
  }, [jobs, topMode, topMonth]) // eslint-disable-line react-hooks/exhaustive-deps
  const top = useMemo(() => {
    const { base, catAxis, valueAxis } = chartBase()
    const names = Array.from({ length: ROWS }, (_, i) => (topRows[i] ? coById(topRows[i][0]).name : ""))
    const totals = Array.from({ length: ROWS }, (_, i) => (topRows[i] ? topRows[i][1].reduce((a, b) => a + b, 0) : 0))
    const stack = CATS.map((_, ci) => Array.from({ length: ROWS }, (_, i) => (topRows[i] ? topRows[i][1][ci] : 0)))
    return {
      ...base,
      tooltip: {
        ...base.tooltip,
        trigger: "axis",
        axisPointer: { type: "shadow", shadowStyle: { color: "rgba(127,127,127,0.08)" } },
        formatter: (ps: { name: string; seriesName: string; value: number; marker: string }[]) =>
          !ps[0]?.name ? "" : `<b>${ps[0].name}</b>` + ps.filter((p) => p.value).map((p) => `<br/>${p.marker}${p.seriesName}: ${p.value}`).join(""),
      },
      grid: { left: 158, right: 36, top: 6, bottom: 56, containLabel: false },
      yAxis: { ...catAxis, inverse: true, data: names, axisLine: { show: false }, axisLabel: { color: cssColor("--foreground"), fontSize: 12, width: 148, overflow: "truncate" } },
      xAxis: { ...valueAxis, min: 0, max: Math.max(1, ...totals) },
      series: CATS.map((k, ci) => ({
        id: k.id,
        name: k.short,
        type: "bar",
        stack: "co",
        barWidth: 16,
        itemStyle: { color: cssColor(k.color), borderColor: cssColor("--card"), borderWidth: 1 },
        label:
          ci === CATS.length - 1
            ? { show: true, position: "right", color: cssColor("--muted-foreground"), fontSize: 11, formatter: (p: { dataIndex: number }) => (totals[p.dataIndex] ? String(totals[p.dataIndex]) : "") }
            : { show: false },
        data: stack[ci],
      })),
    }
  }, [topRows, dark])
  const topSub =
    topMode === "7" ? "Postings first seen in the past 7 days"
      : topMode === "30" ? "Postings first seen in the past 30 days"
        : topMode === "365" ? "Postings first seen in the past 12 months"
          : `Postings first seen in ${monthLabel(topMonthDate)}`

  /* ---------- deadline calendar (GitHub-style) ---------- */
  const calStart = addMonths(THIS_MONTH, calOffset)
  const calEnd = monthEnd(addMonths(calStart, 5))
  const byDay = useMemo(() => {
    const m: Record<string, Job[]> = {}
    jobs.forEach((j) => {
      if (j.deadline) (m[j.deadline] = m[j.deadline] || []).push(j)
    })
    return m
  }, [jobs])
  const calendar = useMemo(() => {
    const { base, muted } = chartBase()
    const data: { value: [string, number]; itemStyle?: object }[] = []
    let max = 1
    for (let d = calStart; d <= calEnd; d = addDays(d, 1)) {
      const k = iso(d)
      const n = (byDay[k] || []).length
      max = Math.max(max, n)
      const isToday = k === iso(TODAY)
      data.push({
        value: [k, n],
        itemStyle: {
          ...(d < TODAY && n ? { opacity: 0.45 } : {}),
          ...(isToday ? { borderColor: cssColor("--foreground"), borderWidth: 1.5 } : {}),
          ...(k === calDay ? { borderColor: cssColor("--primary"), borderWidth: 2 } : {}),
        },
      })
    }
    return {
      ...base,
      legend: { show: false },
      tooltip: {
        ...base.tooltip,
        formatter: (p: { value: [string, number] }) => {
          const list = byDay[p.value[0]] || []
          const head = `<b>${p.value[1] || "No"}</b> deadline${p.value[1] === 1 ? "" : "s"} on ${fmt(p.value[0], { weekday: "short", month: "short", day: "numeric" })}`
          return list.length ? head + "<br/><span style='opacity:.75'>Click to list them</span>" : head
        },
      },
      visualMap: { show: false, min: 0, max: Math.max(3, max), inRange: { color: SEQ.map(cssColor) } },
      calendar: {
        top: 22,
        left: 34,
        right: 4,
        bottom: 2,
        cellSize: [18, 18],
        range: [iso(calStart), iso(calEnd)],
        splitLine: { show: false },
        itemStyle: { borderColor: cssColor("--card"), borderWidth: 3, color: cssColor("--seq-0") },
        yearLabel: { show: false },
        dayLabel: { firstDay: 0, nameMap: ["", "Mon", "", "Wed", "", "Fri", ""], color: muted, fontSize: 10, margin: 6 },
        monthLabel: { color: muted, fontSize: 11, position: "start", margin: 6 },
      },
      series: [{ type: "heatmap", coordinateSystem: "calendar", data, itemStyle: { borderRadius: 2 } }],
    }
  }, [byDay, dark, calOffset, calDay]) // eslint-disable-line react-hooks/exhaustive-deps
  const calLabel = `${calStart.toLocaleDateString("en-US", { month: "short" })} – ${calEnd.toLocaleDateString("en-US", { month: "short", year: "numeric" })}`
  const dayJobs = calDay ? byDay[calDay] || [] : []

  /* ---------- where each company hires ---------- */
  const heatRows = useMemo(
    () =>
      COMPANIES.map((c) => ({ c, n: CATS.map((k) => jobs.filter((j) => j.company === c.id && j.category === k.id).length) }))
        .filter((r) => r.n.some(Boolean))
        .sort((a, b) => b.n.reduce((s, v) => s + v, 0) - a.n.reduce((s, v) => s + v, 0)),
    [jobs]
  )
  const heatShown = heatAll ? heatRows : heatRows.slice(0, 10)
  const heat = useMemo(() => {
    const { base, catAxis } = chartBase()
    const raw: [number, number, number][] = []
    heatShown.forEach((r, y) => r.n.forEach((v, x) => raw.push([x, y, v])))
    const max = Math.max(1, ...raw.map((d) => d[2]))
    const strongInk = dark ? "#1f1e1d" : "#ffffff"
    return {
      ...base,
      legend: { show: false },
      tooltip: { show: false },
      grid: { left: 8, right: 8, top: 28, bottom: 4, containLabel: true },
      xAxis: { ...catAxis, position: "top", data: CATS.map((c) => c.short), axisLine: { show: false }, axisLabel: { color: cssColor("--foreground"), fontSize: 12 } },
      yAxis: { ...catAxis, inverse: true, data: heatShown.map((r) => r.c.name), axisLine: { show: false }, axisLabel: { color: cssColor("--foreground"), fontSize: 12 } },
      visualMap: { show: false, min: 0, max, inRange: { color: SEQ.map(cssColor) } },
      series: [{
        type: "heatmap",
        data: raw.map((v) => ({ value: v, label: { color: v[2] / max > 0.55 ? strongInk : cssColor("--foreground") } })),
        label: { show: true, fontSize: 11, formatter: (p: { value: [number, number, number] }) => (p.value[2] ? String(p.value[2]) : "") },
        itemStyle: { borderColor: cssColor("--card"), borderWidth: 3, borderRadius: 5 },
        emphasis: { itemStyle: { borderColor: cssColor("--primary"), borderWidth: 2, shadowBlur: 8, shadowColor: "rgba(0,0,0,0.18)" } },
      }],
    }
  }, [heatRows, dark, heatAll]) // eslint-disable-line react-hooks/exhaustive-deps
  const heatMax = Math.max(1, ...heatRows.flatMap((r) => r.n))

  /* freshness and personal reminders */
  const newCount = prevVisit == null ? 0 : jobs.filter((j) => isLive(j) && isNew(j)).length
  const urgent = jobs.filter((j) => saved.has(j.id) && isLive(j) && j.deadline && (daysLeft(j) as number) <= 3)
  const upcomingDays = Object.keys(byDay)
    .filter((k) => k >= iso(calStart) && k <= iso(calEnd))
    .sort()

  const sections: SectionDef[] = [
    {
      id: "you",
      label: "You",
      node: (
        <div className="grid gap-4 lg:grid-cols-3">
          <PipelineCard />
          <StartCard />
          <ActivityCard />
        </div>
      ),
    },
    { id: "trends", label: "Posting trends", node: (
      <div className="grid gap-4 lg:grid-cols-5">
        <Panel
          className="lg:col-span-3"
          title="Postings per month"
          sub="Click a month or use the arrows to step through them"
          right={<Stepper what="month" label={monthLabel(selMonth)} onPrev={() => setMonthIdx((i) => i - 1)} onNext={() => setMonthIdx((i) => i + 1)} prevDisabled={monthIdx === 0} nextDisabled={monthIdx === MONTHS_BACK} />}
        >
          <div className="relative min-h-[280px] flex-1">
            <div className="absolute inset-0">
              <EChart option={monthly} merge height="100%" label="Postings per month by category" onReady={(c) => { monthChart.current = c }} onAxisClick={(i) => i >= 0 && i <= MONTHS_BACK && setMonthIdx(i)} />
            </div>
          </div>
          <p key={monthIdx} className="mt-2 text-sm text-muted-foreground duration-200 animate-in fade-in">
            <b className="font-display text-lg text-foreground">{monthJobs.length}</b> posting{monthJobs.length === 1 ? "" : "s"} first seen in {monthLabel(selMonth)}
          </p>
        </Panel>
        <Panel
          className="lg:col-span-2"
          title="Live vs. expired"
          sub={<span className="block truncate">{statusRange === "all" ? `Every posting tracked (${statusSet.length})` : `Postings first seen in the past ${statusRange} days (${statusSet.length})`}</span>}
        >
          <div className="mb-3 flex justify-center">
            <Seg value={statusRange} onChange={setStatusRange} label="Time range" items={[["7", "7d"], ["30", "30d"], ["60", "60d"], ["90", "90d"], ["all", "All time"]]} />
          </div>
          <EChart merge option={status} height={300} label="Live and expired postings by category" />
        </Panel>
      </div>
    ) },
    { id: "map", label: "Map", node: (
      <Panel
        title="Where the roles are"
        sub={`Postings by state and city. Scroll or use the buttons to zoom, drag to pan, and click a city or state to open its roles.`}
        right={<Seg value={mapSet} onChange={setMapSet} label="Which postings" items={[["live", "Live"], ["all", "All time"]]} />}
      >
        <UsMap
          jobs={mapSet === "live" ? jobs.filter(isLive) : jobs}
          onCity={(city) => go("jobs", { location: [city], status: mapSet === "live" ? "live" : "all" })}
          onState={(cities) => go("jobs", { location: cities, status: mapSet === "live" ? "live" : "all" })}
        />
      </Panel>
    ) },
    { id: "companies", label: "Companies and deadlines", node: (
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel
          title="Most active companies"
          sub={<span className="block truncate">{topSub}</span>}
          right={
            <div className={cn(topMode !== "month" && "invisible")} aria-hidden={topMode !== "month"}>
              <Stepper what="month" label={monthLabel(topMonthDate)} onPrev={() => setTopMonth((m) => m + 1)} onNext={() => setTopMonth((m) => m - 1)} prevDisabled={topMonth >= MONTHS_BACK} nextDisabled={topMonth === 0} />
            </div>
          }
        >
          <div className="mb-3 flex justify-center">
            <Seg value={topMode} onChange={setTopMode} label="Time range" items={[["7", "7 days"], ["30", "30 days"], ["365", "12 months"], ["month", "By month"]]} />
          </div>
          <div className="relative">
            <EChart merge option={top} height={ROWS * 30 + 66} label="Companies with the most postings, by category" />
            {topRows.length === 0 && <p className="absolute inset-x-0 top-0 grid h-[240px] place-items-center text-sm text-muted-foreground">No postings in this period.</p>}
            {topRows.length > 0 && topRows.length < ROWS && (
              <p
                className="absolute left-[158px] right-9 grid place-items-center rounded-md border border-dashed text-xs text-muted-foreground"
                style={{ top: 6 + topRows.length * ((ROWS * 30 + 4) / ROWS) + 4, height: (ROWS - topRows.length) * ((ROWS * 30 + 4) / ROWS) - 8 }}
              >
                No other companies posted in this period
              </p>
            )}
          </div>
        </Panel>

        <Panel
          title="Deadline calendar"
          sub="Each square is a day; darker means more postings close that day."
          right={<Stepper what="months" label={calLabel} onPrev={() => setCalOffset((o) => o - 1)} onNext={() => setCalOffset((o) => o + 1)} prevDisabled={calOffset <= -MONTHS_BACK} nextDisabled={calOffset >= 3} />}
        >
          <div className="mb-2 flex justify-end">
            <Seg value={calView} onChange={setCalView} label="Show deadlines as" items={[["calendar", "Calendar"], ["list", "List"]]} />
          </div>
          {calView === "calendar" ? (
            <div className="overflow-x-auto">
              <div className="min-w-[540px]">
                <EChart
                  option={calendar}
                  merge
                  height={162}
                  label="Calendar of application deadlines. Switch to List for a keyboard-friendly view."
                  onClick={(p) => {
                    const v = p.value as [string, number]
                    if (p.componentType === "series" && v) setCalDay(v[0] === calDay ? null : v[0])
                  }}
                />
              </div>
            </div>
          ) : (
            <ul className="flex max-h-[162px] flex-wrap content-start gap-1.5 overflow-y-auto" aria-label="Days with deadlines">
              {upcomingDays.length ? upcomingDays.map((d) => (
                <li key={d}>
                  <button
                    onClick={() => setCalDay(d === calDay ? null : d)}
                    aria-pressed={d === calDay}
                    className={cn("rounded-md border px-2 py-1 text-xs tabular-nums hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", d === calDay && "border-primary bg-primary/10", d < iso(TODAY) && "text-muted-foreground")}
                  >
                    {fmt(d, { month: "short", day: "numeric" })} <b className="font-semibold">{byDay[d].length}</b>
                  </button>
                </li>
              )) : <li className="text-sm text-muted-foreground">No deadlines in these months.</li>}
            </ul>
          )}
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>Faded squares are past deadlines. The outlined square is today.</span>
            <span className="inline-flex items-center gap-1">
              Less
              {SEQ.map((v) => <span key={v} className="size-[11px] rounded-[2px]" style={{ background: `var(${v})` }} />)}
              More
            </span>
          </div>
          <div key={calDay || "none"} className="mt-3 border-t pt-3 duration-200 animate-in fade-in slide-in-from-top-1">
            {calDay ? (
              <>
                <p className="mb-1 text-sm font-medium">{dayJobs.length || "No"} deadline{dayJobs.length === 1 ? "" : "s"} on {fmt(calDay, { weekday: "long", month: "long", day: "numeric" })}</p>
                <ul className="flex flex-col">
                  {dayJobs.slice(0, 5).map((j) => (
                    <li key={j.id}>
                      <button onClick={() => openJob(j.id)} className="flex w-full min-w-0 items-center gap-2 rounded-md px-1.5 py-1.5 text-left text-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium">{j.title}</span>
                          <span className="block truncate text-xs text-muted-foreground">{coById(j.company).name}</span>
                        </span>
                        {!isLive(j) && <span className="text-xs text-destructive">Closed</span>}
                      </button>
                    </li>
                  ))}
                </ul>
                {dayJobs.length > 5 && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button className="mt-1 rounded-md px-1.5 py-0.5 text-sm font-medium text-primary hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">+{dayJobs.length - 5} more</button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" align="start" className="max-w-xs">
                      <ul className="flex flex-col gap-1.5 py-0.5">
                        {dayJobs.slice(5).map((j) => (
                          <li key={j.id}><span className="block font-medium">{j.title}</span><span className="block opacity-75">{coById(j.company).name}</span></li>
                        ))}
                      </ul>
                    </TooltipContent>
                  </Tooltip>
                )}
              </>
            ) : (
              <p className="text-sm text-muted-foreground">Choose a day to list the postings that close then.</p>
            )}
          </div>
        </Panel>
      </div>
    ) },
    { id: "closing", label: "Closing soon and hiring mix", node: (
      <div className="grid gap-4 lg:grid-cols-5">
        <Panel
          className="lg:col-span-2"
          title="Closing soon"
          sub={`Live postings closing in the next ${settings.soonDays} days`}
          right={<Button variant="outline" size="sm" onClick={() => go("jobs", { deadline: settings.soonDays <= 7 ? "week" : settings.soonDays <= 14 ? "14" : "30", status: "live" })}>View all <ArrowRight className="size-3.5" /></Button>}
        >
          {soon.length ? (
            <ul className="-mx-2 flex flex-col">
              {soon.slice(0, 8).map((j) => (
                <li key={j.id} className="border-t first:border-t-0">
                  <button onClick={() => openJob(j.id)} className="grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-md px-2 py-2.5 text-left hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    <span className="min-w-12 rounded-md bg-warn-soft px-1.5 py-1 text-center text-xs font-semibold tabular-nums text-warn">{daysLeft(j) === 0 ? "today" : `${daysLeft(j)}d`}</span>
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-semibold">{j.title}</span>
                      <span className="block truncate text-xs text-muted-foreground">{coById(j.company).name}, due {fmt(j.deadline)}</span>
                    </span>
                    <CatChip id={j.category} />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="py-10 text-center text-sm text-muted-foreground">No live postings close in the next {settings.soonDays} days.</p>
          )}
        </Panel>
        <Panel
          className="lg:col-span-3"
          title="Where each company hires"
          sub="All-time postings by category. Choose a square to open those postings on the job board."
          right={<Seg value={heatView} onChange={setHeatView} label="Show as" items={[["chart", "Chart"], ["table", "Table"]]} />}
        >
          {heatView === "chart" ? (
            <EChart
              option={heat}
              height={heatShown.length * 28 + 40}
              label="Postings per company and category. Switch to Table for a keyboard-friendly view."
              onClick={(p) => {
                const v = p.value as [number, number, number]
                if (p.componentType !== "series" || !v || !v[2]) return
                go("jobs", { company: [heatShown[v[1]].c.id], category: [CATS[v[0]].id], status: "all" })
              }}
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="text-left text-[0.7rem] uppercase tracking-[0.07em] text-muted-foreground">
                    <th className="py-1.5 pr-3 font-semibold">Company</th>
                    {CATS.map((c) => <th key={c.id} className="px-1 py-1.5 text-center font-semibold">{c.short}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {heatShown.map((r) => (
                    <tr key={r.c.id} className="border-t">
                      <th scope="row" className="py-1 pr-3 text-left font-medium">{r.c.name}</th>
                      {r.n.map((v, i) => (
                        <td key={i} className="px-1 py-1 text-center">
                          {v ? (
                            <button
                              onClick={() => go("jobs", { company: [r.c.id], category: [CATS[i].id], status: "all" })}
                              aria-label={`${v} ${CATS[i].label} postings at ${r.c.name}`}
                              className="min-w-10 rounded-md px-2 py-1 tabular-nums hover:ring-2 hover:ring-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                              style={{ background: `color-mix(in srgb, var(--seq-3) ${Math.round(12 + 60 * (v / heatMax))}%, transparent)` }}
                            >
                              {v}
                            </button>
                          ) : (
                            <span className="text-muted-foreground">0</span>
                          )}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {heatRows.length > 10 && (
            <Button variant="ghost" size="sm" className="mt-2 self-start" onClick={() => setHeatAll((x) => !x)}>
              {heatAll ? "Show top 10" : `Show all ${heatRows.length} companies`}
            </Button>
          )}
        </Panel>
      </div>
    ) },
  ]
  const weekNew = jobs.filter((j) => isLive(j) && ageDays(j) < 7).length
  const layout = normalizeLayout(sections.map((x) => x.id), mine.layout)
  const saveLayout = (order: string[], hidden: string[]) => {
    setLayout({ order, hidden }).catch(() => toast("Couldn't save your layout. Try again in a moment."))
  }

  return (
    <div className="flex flex-col gap-5">
      {/* page header: title, a one-line status, and the customize switch */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          {weekNew > 0 && (
            <button
              onClick={() => go("jobs", { status: "live" })}
              className="shine-pill group mb-3 inline-flex items-center gap-2 rounded-full py-1 pl-2 pr-3 text-xs font-medium shadow-sm duration-500 animate-in fade-in slide-in-from-top-1"
            >
              <span className="grid size-4 place-items-center rounded-full bg-primary/15 text-primary"><Sparkles className="size-2.5" /></span>
              {weekNew} new role{weekNew === 1 ? "" : "s"} this week
              <span className="text-muted-foreground transition-colors group-hover:text-foreground">See them <ArrowRight className="inline size-3 transition-transform group-hover:translate-x-0.5" /></span>
            </button>
          )}
          <h1 className="ink-sweep font-display text-[1.65rem] font-semibold leading-tight">Dashboard</h1>
          <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
            <span>{COMPANIES.length} companies tracked</span>
            <span aria-hidden className="h-3.5 w-px bg-border" />
            <span>{live.length} live roles</span>
            {newCount > 0 && (
              <>
                <span aria-hidden className="h-3.5 w-px bg-border" />
                <button className="font-medium text-primary hover:underline" onClick={() => go("jobs", { status: "live" })}>
                  {newCount} new since your last visit
                </button>
              </>
            )}
          </p>
        </div>
        <Button variant={editing ? "default" : "outline"} size="sm" onClick={() => setEditing((x) => !x)} aria-pressed={editing}>
          {editing ? <><Check className="size-3.5" /> Done</> : <><LayoutGrid className="size-3.5" /> Customize</>}
        </Button>
      </div>

      {urgent.length > 0 && (
        <button
          onClick={() => go("jobs")}
          className="flex items-center gap-3 rounded-lg border border-warn/30 bg-warn-soft px-4 py-3 text-left text-sm hover:border-warn/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <BellRing className="size-4 shrink-0 text-warn" />
          <span className="text-foreground">
            {urgent.length === 1 ? `${urgent[0].title} at ${coById(urgent[0].company).name}, which you saved, closes ${daysLeft(urgent[0]) === 0 ? "today" : fmt(urgent[0].deadline)}.` : `${urgent.length} roles you saved close within 3 days.`}
          </span>
          <span className="ml-auto inline-flex items-center gap-1 whitespace-nowrap text-warn">Open job board <ArrowRight className="size-3.5" /></span>
        </button>
      )}

      <KpiBand />

      <Arranger sections={sections} order={layout.order} hidden={layout.hidden} editing={editing} onChange={saveLayout} />
    </div>
  )
}
