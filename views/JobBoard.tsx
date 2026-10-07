"use client"

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { ArrowDown, ArrowUp, ArrowUpDown, Bookmark, BellRing, Check, ChevronDown, ExternalLink, Flag, ListFilter, NotebookPen, Plus, Search, X } from "lucide-react"
import { toast } from "sonner"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Segmented } from "@/components/Segmented"
import { Pager } from "@/components/Pager"
import {
  DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup,
  DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { CatChip, DeadlineCell, LocationCell, NewBadge, PageHead, StatusPill } from "@/components/common"
import { EMPTY_FILTERS, SORT_PRESETS, useApp, type DeadlineFilter, type JobFilters, type SortKey, type SortSpec, type StatusFilter } from "@/lib/state"
import { CATS, COMPANIES, TYPES, catById, coById, daysLeft, fmt, isLive, jobLocations, milesFromHome, parse, store, type Job } from "@/lib/data"
import type { MyStatus } from "@/lib/backend"
import { cn } from "@/lib/utils"

/* ---------- filter vocabulary ---------- */
type ListProp = "company" | "location" | "category" | "type"
type Tab = "todo" | "saved" | "done"

const PROP_LABEL: Record<ListProp | "deadline" | "status", string> = {
  company: "Company", location: "Location", category: "Category", type: "Company type", deadline: "Deadline", status: "Status",
}
const DEADLINE_OPTS: [DeadlineFilter, string][] = [["", "Any time"], ["week", "Closes within 7 days"], ["14", "Closes within 14 days"], ["30", "Closes within 30 days"], ["rolling", "Rolling only"]]
const STATUS_OPTS: [StatusFilter, string][] = [["live", "Live"], ["expired", "Expired or taken down"], ["all", "Everything"]]
const presetOf = (id: string): SortSpec => (SORT_PRESETS.find((p) => p.id === id) || SORT_PRESETS[0]).sort
const presetId = (s: SortSpec) => SORT_PRESETS.find((p) => p.sort.key === s.key && p.sort.dir === s.dir)?.id
const sortLabel = (s: SortSpec) =>
  SORT_PRESETS.find((p) => p.sort.key === s.key && p.sort.dir === s.dir)?.label ||
  `${{ title: "Title", company: "Company", location: "Location", deadline: "Deadline", posted: "First seen" }[s.key]} ${s.dir === 1 ? "A to Z" : "Z to A"}`

function deadlineRank(j: Job): [number, number] {
  const d = daysLeft(j)
  if (!isLive(j)) return [2, -(d ?? 0)]
  if (d === null) return [1, 0]
  return [0, d]
}

/** Per-viewer convenience: the board remembers its view in this browser. */
interface BoardView { q: string; filters: JobFilters; sort: SortSpec; tab: Tab; pageSize: number }

/* ---------- menu content shared by headers, chips and “+ Filter” ---------- */
function ListOptions({ prop, options, selected, onChange }: { prop: ListProp; options: [string, string][]; selected: string[]; onChange: (v: string[]) => void }) {
  return (
    <>
      <DropdownMenuLabel className="flex items-center justify-between gap-4 text-xs font-semibold uppercase tracking-[0.07em] text-muted-foreground">
        {PROP_LABEL[prop]}
        {selected.length > 0 && (
          <button className="normal-case tracking-normal text-primary hover:underline" onClick={() => onChange([])}>Clear</button>
        )}
      </DropdownMenuLabel>
      <div className="max-h-72 overflow-y-auto">
        {options.map(([v, l]) => (
          <DropdownMenuCheckboxItem
            key={v}
            checked={selected.includes(v)}
            onSelect={(e) => e.preventDefault()}
            onCheckedChange={(c) => onChange(c ? [...selected, v] : selected.filter((x) => x !== v))}
          >
            {prop === "category" ? <CatChip id={v} /> : l}
          </DropdownMenuCheckboxItem>
        ))}
      </div>
    </>
  )
}

function RadioOptions<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <>
      <DropdownMenuLabel className="text-xs font-semibold uppercase tracking-[0.07em] text-muted-foreground">{label}</DropdownMenuLabel>
      <DropdownMenuRadioGroup value={value} onValueChange={(v) => onChange(v as T)}>
        {options.map(([v, l]) => (
          <DropdownMenuRadioItem key={v || "any"} value={v} onSelect={(e) => e.preventDefault()}>{l}</DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
    </>
  )
}

/* ---------- the board ---------- */
export default function JobBoard() {
  const { jobs, mine, applied, saved, setStatus, openJob, openReport, settings, pendingFilter, pendingTab, clearPendingFilter, isNew } = useApp()
  const remembered = store.get<Partial<BoardView>>("board", {})
  // arriving from a link elsewhere (a chart, the map): start with its filters so nothing flips after the page appears
  const [q, setQ] = useState(pendingFilter ? "" : remembered.q ?? "")
  const [filters, setFilters] = useState<JobFilters>(pendingFilter ? { ...EMPTY_FILTERS, ...pendingFilter } : { ...EMPTY_FILTERS, ...(remembered.filters || {}) })
  const [sort, setSort] = useState<SortSpec>(remembered.sort || presetOf(settings.sort))
  const [tab, setTab] = useState<Tab>(pendingTab || (pendingFilter ? "todo" : remembered.tab || "todo"))
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(remembered.pageSize || 25)
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    store.set("board", { q, filters, sort, tab, pageSize } satisfies BoardView)
  }, [q, filters, sort, tab, pageSize])
  useEffect(() => setPage(1), [q, filters, sort, tab, pageSize])

  useEffect(() => {
    if (pendingFilter || pendingTab) {
      if (pendingFilter) {
        setFilters({ ...EMPTY_FILTERS, ...pendingFilter })
        setQ("")
      }
      setTab(pendingTab || "todo")
      clearPendingFilter()
    }
  }, [pendingFilter, pendingTab, clearPendingFilter])

  /* "/" jumps to search */
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return
      if (t.closest("input, textarea, select, [contenteditable=true], [role=dialog], [role=menu]")) return
      e.preventDefault()
      searchRef.current?.focus()
    }
    window.addEventListener("keydown", on)
    return () => window.removeEventListener("keydown", on)
  }, [])

  const setF = (patch: Partial<JobFilters>) => setFilters((f) => ({ ...f, ...patch }))

  const options: Record<ListProp, [string, string][]> = useMemo(() => ({
    company: COMPANIES.filter((c) => jobs.some((j) => j.company === c.id)).map((c) => [c.id, c.name] as [string, string]),
    location: [...new Set(jobs.flatMap(jobLocations))].sort((a, b) => milesFromHome(a) - milesFromHome(b) || a.localeCompare(b)).map((l) => [l, l] as [string, string]),
    category: CATS.map((c) => [c.id, c.label] as [string, string]),
    type: TYPES.map((t) => [t, t] as [string, string]),
  }), [jobs])

  const list = useMemo(() => {
    const ql = q.trim().toLowerCase()
    const out = jobs.filter((j) => {
      const c = coById(j.company)
      if (ql) {
        const hay = [j.title, c.name, jobLocations(j).join(" "), j.summary, j.resp.join(" "), j.quals.join(" "), catById(j.category).label, j.term].join(" ").toLowerCase()
        if (!ql.split(/\s+/).every((w) => hay.includes(w))) return false
      }
      if (filters.company.length && !filters.company.includes(j.company)) return false
      if (filters.location.length && !jobLocations(j).some((l) => filters.location.includes(l))) return false
      if (filters.category.length && !filters.category.includes(j.category)) return false
      if (filters.type.length && !filters.type.includes(c.type)) return false
      const live = isLive(j)
      // saved and applied roles stay visible after they close, so students can track them
      const mineToo = tab !== "todo"
      if (filters.status === "live" && !live && !mineToo) return false
      if (filters.status === "expired" && live) return false
      if (filters.deadline) {
        const d = daysLeft(j)
        if (filters.deadline === "rolling") { if (j.deadline) return false }
        else if (d === null || d < 0 || d > (filters.deadline === "week" ? 7 : Number(filters.deadline))) return false
      }
      return true
    })
    const val = (j: Job): string | number => {
      switch (sort.key) {
        case "title": return j.title
        case "company": return coById(j.company).name
        case "location": return jobLocations(j)[0]
        case "posted": return parse(j.posted).getTime()
        default: return 0
      }
    }
    out.sort((a, b) => {
      let r: number
      if (sort.key === "deadline") {
        const [ra, da] = deadlineRank(a), [rb, db] = deadlineRank(b)
        r = ra - rb || da - db
      } else {
        const va = val(a), vb = val(b)
        r = typeof va === "number" ? va - (vb as number) : va.localeCompare(vb as string)
      }
      return r * sort.dir || a.title.localeCompare(b.title)
    })
    return out
  }, [jobs, q, filters, sort, tab])

  const groups = {
    todo: list.filter((j) => !applied.has(j.id) && !saved.has(j.id)),
    saved: list.filter((j) => saved.has(j.id)),
    done: list.filter((j) => applied.has(j.id)),
  }
  const rows = groups[tab]
  const pages = Math.max(1, Math.ceil(rows.length / pageSize))
  const cur = Math.min(page, pages)
  const pageRows = rows.slice((cur - 1) * pageSize, cur * pageSize)

  /* reminders: roles I saved that close within 3 days */
  const urgent = jobs
    .filter((j) => saved.has(j.id) && isLive(j) && j.deadline && (daysLeft(j) as number) <= 3)
    .sort((a, b) => (daysLeft(a) as number) - (daysLeft(b) as number))

  const activeList = (Object.keys(options) as ListProp[]).filter((p) => filters[p].length)
  const anyFilter = !!(q || activeList.length || filters.deadline || filters.status !== "live")
  const resetAll = () => { setQ(""); setFilters({ ...EMPTY_FILTERS }) }

  const chipText = (p: ListProp) => {
    const names = filters[p].map((v) => options[p].find((o) => o[0] === v)?.[1] || v)
    return names.length > 2 ? `${names[0]} +${names.length - 1}` : names.join(", ")
  }

  /* moving a role between tabs: slide the row out, then let the rest glide up; Undo in the toast reverses it */
  const [leaving, setLeaving] = useState<Record<string, MyStatus | "none">>({})
  const [bump, setBump] = useState<Record<Tab, number>>({ todo: 0, saved: 0, done: 0 })
  const tabFor = (s: MyStatus | null): Tab => (s === "applied" ? "done" : s === "saved" ? "saved" : "todo")
  const move = (ids: string[], s: MyStatus | null, msg: string) => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    const target = tabFor(s)
    const go = () => {
      changeStatus(ids, s, msg)
      setLeaving({})
      setBump((b) => ({ ...b, [target]: b[target] + 1 }))
    }
    if (reduce || target === tab) return go()
    setLeaving(Object.fromEntries(ids.map((id) => [id, s ?? "none"])))
    window.setTimeout(go, 320)
  }
  const tbodyRef = useRef<HTMLTableSectionElement>(null)
  const lastTops = useRef<Record<string, number>>({})
  useLayoutEffect(() => {
    const body = tbodyRef.current
    if (!body) return
    const tops: Record<string, number> = {}
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    const hadRows = Object.keys(lastTops.current).length > 0
    let entering = 0
    body.querySelectorAll<HTMLTableRowElement>("tr[data-id]").forEach((tr) => {
      const id = tr.dataset.id as string
      tops[id] = tr.offsetTop
      const before = lastTops.current[id]
      if (reduce) return
      if (before !== undefined && before !== tr.offsetTop) {
        tr.animate([{ transform: `translateY(${before - tr.offsetTop}px)` }, { transform: "none" }], { duration: 300, easing: "cubic-bezier(.3,.7,.2,1)" })
      } else if (before === undefined && hadRows) {
        // rows that appear because a filter was removed fade in, gently staggered
        tr.animate([{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "none" }], {
          duration: 280, delay: Math.min(entering++ * 18, 220), easing: "cubic-bezier(.2,.7,.2,1)", fill: "backwards",
        })
      }
    })
    lastTops.current = tops
  })

  const changeStatus = (ids: string[], s: MyStatus | null, msg: string) => {
    const before = Object.fromEntries(ids.map((id) => [id, mine.status[id] || null])) as Record<string, MyStatus | null>
    setStatus(ids, s).then(
      () =>
        toast(msg, {
          action: {
            label: "Undo",
            onClick: async () => {
              for (const st of ["saved", "applied", null] as (MyStatus | null)[]) {
                const back = ids.filter((id) => before[id] === st)
                if (back.length) await setStatus(back, st)
              }
            },
          },
        }),
      () => toast("Couldn't save that change. Check that you have access to save, then try again.")
    )
  }

  /* header cell: sortable columns sort, categorical ones only filter */
  const Head = ({ k, label, filterProp, sortKey }: { k: string; label: string; filterProp?: ListProp | "deadline" | "status"; sortKey?: SortKey }) => {
    const sorted = !!sortKey && sort.key === sortKey
    const filtered = filterProp === "deadline" ? !!filters.deadline : filterProp === "status" ? filters.status !== "live" : filterProp ? filters[filterProp].length > 0 : false
    return (
      <th key={k} className="px-1 py-1.5 font-semibold" aria-sort={sortKey ? (sorted ? (sort.dir === 1 ? "ascending" : "descending") : "none") : undefined}>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className={cn("inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-md px-1.5 uppercase tracking-[0.07em] hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-accent", (sorted || filtered) && "text-foreground")}>
              {label}
              {sortKey ? (sorted ? (sort.dir === 1 ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />) : <ArrowUpDown className="size-3 opacity-40" />) : <ListFilter className="size-3 opacity-40" />}
              {filtered && <span className="size-1.5 rounded-full bg-primary" aria-label="filtered" />}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-60 normal-case tracking-normal">
            {sortKey && (
              <>
                <DropdownMenuItem onSelect={() => setSort({ key: sortKey, dir: 1 })}><ArrowUp className="mr-2 size-3.5" /> {sortKey === "deadline" ? "Soonest first" : "Sort A to Z"}</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setSort({ key: sortKey, dir: -1 })}><ArrowDown className="mr-2 size-3.5" /> {sortKey === "deadline" ? "Latest first" : "Sort Z to A"}</DropdownMenuItem>
              </>
            )}
            {k === "title" && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => setTimeout(() => searchRef.current?.focus(), 0)}><Search className="mr-2 size-3.5" /> Search postings</DropdownMenuItem>
              </>
            )}
            {filterProp && filterProp !== "deadline" && filterProp !== "status" && (
              <>
                {sortKey && <DropdownMenuSeparator />}
                <ListOptions prop={filterProp} options={options[filterProp]} selected={filters[filterProp]} onChange={(v) => setF({ [filterProp]: v })} />
              </>
            )}
            {filterProp === "deadline" && (
              <>
                <DropdownMenuSeparator />
                <RadioOptions label="Closes" value={filters.deadline} options={DEADLINE_OPTS} onChange={(v) => setF({ deadline: v })} />
              </>
            )}
            {filterProp === "status" && <RadioOptions label="Show" value={filters.status} options={STATUS_OPTS} onChange={(v) => setF({ status: v })} />}
          </DropdownMenuContent>
        </DropdownMenu>
      </th>
    )
  }

  const chipCls = "inline-flex h-8 items-center gap-1 rounded-full border border-primary/30 bg-primary/10 pl-3 pr-1 text-sm text-foreground"
  const chipBtn = "inline-flex items-center gap-1 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
  const xBtn = "grid size-6 place-items-center rounded-full text-muted-foreground hover:bg-primary/15 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
  const shownIds = rows.map((j) => j.id)

  return (
    <div className="flex flex-col gap-5">
      <PageHead
        title="Job board"
        sub={<>Save roles you're interested in, then check them off once you apply.<br />Click a column to sort or filter, or a row for details. Press / to search.</>}
        right={<Button variant="outline" onClick={() => openReport()}><Flag className="size-4" /> Report an issue</Button>}
      />

      {urgent.length > 0 && (
        <div className="flex flex-wrap items-start gap-3 rounded-lg border border-warn/30 bg-warn-soft px-4 py-3 text-sm duration-300 animate-in fade-in">
          <BellRing className="mt-0.5 size-4 shrink-0 text-warn" />
          <div className="min-w-0 flex-1">
            <p className="font-medium text-foreground">{urgent.length === 1 ? "A role you saved closes soon" : `${urgent.length} roles you saved close soon`}</p>
            <ul className="mt-1 flex flex-col gap-0.5">
              {urgent.map((j) => (
                <li key={j.id}>
                  <button className="text-left hover:underline" onClick={() => openJob(j.id)}>
                    {j.title}, {coById(j.company).name}: {daysLeft(j) === 0 ? "closes today" : `closes ${fmt(j.deadline)} (${daysLeft(j)} day${daysLeft(j) === 1 ? "" : "s"})`}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      <Segmented
        size="md"
        label="Which roles to show"
        value={tab}
        onChange={(v) => setTab(v)}
        className="self-start p-1"
        items={[
          ["todo", <>To apply <span key={bump.todo} className="rounded-full bg-foreground/[0.06] px-2 text-xs tabular-nums text-muted-foreground duration-500 ease-out animate-in zoom-in-50">{groups.todo.length}</span></>],
          ["saved", <>Saved <span key={bump.saved} className="rounded-full bg-primary/10 px-2 text-xs tabular-nums text-primary duration-500 ease-out animate-in zoom-in-50">{groups.saved.length}</span></>],
          ["done", <>Applied <span key={bump.done} className="rounded-full bg-good/15 px-2 text-xs tabular-nums text-good duration-500 ease-out animate-in zoom-in-50">{groups.done.length}</span></>],
        ]}
      />

      <section className="spotlight overflow-hidden rounded-lg border bg-card">
        <div className="flex items-start gap-3 border-b p-3">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
            <div className="relative w-full sm:w-72">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input ref={searchRef} type="search" aria-label="Search postings, including descriptions" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search postings and descriptions" className="h-8 bg-background pl-8 pr-8" />
              {!q && <kbd className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 rounded border bg-muted px-1.5 text-[0.7rem] text-muted-foreground">/</kbd>}
            </div>

            {filters.status !== "live" && (
              <span className={chipCls}>
                <DropdownMenu>
                  <DropdownMenuTrigger className={chipBtn}><span className="text-muted-foreground">Status:</span> {STATUS_OPTS.find((s) => s[0] === filters.status)?.[1]}</DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="w-56"><RadioOptions label="Show" value={filters.status} options={STATUS_OPTS} onChange={(v) => setF({ status: v })} /></DropdownMenuContent>
                </DropdownMenu>
                <button className={xBtn} aria-label="Remove status filter" onClick={() => setF({ status: "live" })}><X className="size-3.5" /></button>
              </span>
            )}

            {activeList.map((p) => (
              <span key={p} className={chipCls}>
                <DropdownMenu>
                  <DropdownMenuTrigger className={chipBtn}>
                    <span className="text-muted-foreground">{PROP_LABEL[p]}:</span> <span className="max-w-[14rem] truncate">{chipText(p)}</span>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="w-60"><ListOptions prop={p} options={options[p]} selected={filters[p]} onChange={(v) => setF({ [p]: v })} /></DropdownMenuContent>
                </DropdownMenu>
                <button className={xBtn} aria-label={`Remove ${PROP_LABEL[p]} filter`} onClick={() => setF({ [p]: [] })}><X className="size-3.5" /></button>
              </span>
            ))}

            {filters.deadline && (
              <span className={chipCls}>
                <DropdownMenu>
                  <DropdownMenuTrigger className={chipBtn}><span className="text-muted-foreground">Deadline:</span> {DEADLINE_OPTS.find((d) => d[0] === filters.deadline)?.[1]}</DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="w-56"><RadioOptions label="Closes" value={filters.deadline} options={DEADLINE_OPTS} onChange={(v) => setF({ deadline: v })} /></DropdownMenuContent>
                </DropdownMenu>
                <button className={xBtn} aria-label="Remove deadline filter" onClick={() => setF({ deadline: "" })}><X className="size-3.5" /></button>
              </span>
            )}

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" className="h-8 gap-1.5 text-muted-foreground"><Plus className="size-3.5" /> Filter</Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-52">
                <DropdownMenuLabel className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.07em] text-muted-foreground"><ListFilter className="size-3.5" /> Filter by</DropdownMenuLabel>
                {(Object.keys(options) as ListProp[]).map((p) => (
                  <DropdownMenuSub key={p}>
                    <DropdownMenuSubTrigger>{PROP_LABEL[p]}{filters[p].length > 0 && <span className="ml-auto mr-1 text-xs text-primary">{filters[p].length}</span>}</DropdownMenuSubTrigger>
                    <DropdownMenuSubContent className="w-60"><ListOptions prop={p} options={options[p]} selected={filters[p]} onChange={(v) => setF({ [p]: v })} /></DropdownMenuSubContent>
                  </DropdownMenuSub>
                ))}
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>Status</DropdownMenuSubTrigger>
                  <DropdownMenuSubContent className="w-56"><RadioOptions label="Show" value={filters.status} options={STATUS_OPTS} onChange={(v) => setF({ status: v })} /></DropdownMenuSubContent>
                </DropdownMenuSub>
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>Deadline</DropdownMenuSubTrigger>
                  <DropdownMenuSubContent className="w-56"><RadioOptions label="Closes" value={filters.deadline} options={DEADLINE_OPTS} onChange={(v) => setF({ deadline: v })} /></DropdownMenuSubContent>
                </DropdownMenuSub>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          {/* fixed summary: stays put however many filter chips wrap on the left */}
          <div className="flex h-8 shrink-0 items-center gap-2 text-sm text-muted-foreground">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" className="h-8 gap-1 text-muted-foreground">
                  {sort.dir === 1 ? <ArrowUp className="size-3.5" /> : <ArrowDown className="size-3.5" />} {sortLabel(sort)} <ChevronDown className="size-3.5 opacity-60" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                <DropdownMenuLabel className="text-xs font-semibold uppercase tracking-[0.07em] text-muted-foreground">Sort by</DropdownMenuLabel>
                <DropdownMenuRadioGroup value={presetId(sort) || ""} onValueChange={(v) => setSort(presetOf(v))}>
                  {SORT_PRESETS.map((p) => <DropdownMenuRadioItem key={p.id} value={p.id}>{p.label}</DropdownMenuRadioItem>)}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            <span aria-hidden className="h-3.5 w-px bg-border" />
            <span className="w-[4.75rem] text-right tabular-nums">{rows.length} shown</span>
            <Button variant="ghost" size="sm" className={cn("h-8", !anyFilter && "invisible")} aria-hidden={!anyFilter} tabIndex={anyFilter ? 0 : -1} onClick={resetAll}>Reset</Button>
          </div>
        </div>

        <div key={tab} className="duration-200 ease-out animate-in fade-in">
          {rows.length === 0 ? (
            <p className="px-4 py-14 text-center text-sm text-muted-foreground">
              {tab === "done" && !applied.size ? "Roles you mark as applied show up here." : tab === "saved" && !saved.size ? "Save roles with the bookmark to come back to them." : "No postings match these filters."}
              {anyFilter && <> <button className="text-primary hover:underline" onClick={resetAll}>Reset filters</button></>}
            </p>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[980px] border-collapse text-sm">
                  <thead>
                    <tr className="border-b bg-muted/50 text-left text-[0.7rem] uppercase tracking-[0.07em] text-muted-foreground">
                      <th className="w-[76px] py-1.5 pl-3 pr-0 font-semibold">
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <button className="inline-flex h-7 items-center gap-1 rounded-md px-1.5 uppercase tracking-[0.07em] hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                              Track <ChevronDown className="size-3 opacity-50" />
                            </button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="start" className="w-64 normal-case tracking-normal">
                            <DropdownMenuLabel className="text-xs font-semibold uppercase tracking-[0.07em] text-muted-foreground">All {rows.length} shown</DropdownMenuLabel>
                            {tab !== "done" && <DropdownMenuItem onSelect={() => move(shownIds, "applied", `Marked ${shownIds.length} as applied`)}><Check className="mr-2 size-3.5" /> Mark as applied</DropdownMenuItem>}
                            {tab !== "saved" && <DropdownMenuItem onSelect={() => move(shownIds, "saved", `Saved ${shownIds.length} roles`)}><Bookmark className="mr-2 size-3.5" /> Save for later</DropdownMenuItem>}
                            {tab !== "todo" && <DropdownMenuItem onSelect={() => move(shownIds, null, `Moved ${shownIds.length} back to To apply`)}><X className="mr-2 size-3.5" /> Move back to To apply</DropdownMenuItem>}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </th>
                      {Head({ k: "title", label: "Title", sortKey: "title" })}
                      {Head({ k: "company", label: "Company", filterProp: "company", sortKey: "company" })}
                      {Head({ k: "location", label: "Location", filterProp: "location", sortKey: "location" })}
                      {Head({ k: "deadline", label: "Deadline", filterProp: "deadline", sortKey: "deadline" })}
                      {Head({ k: "status", label: "Status", filterProp: "status" })}
                      {Head({ k: "category", label: "Category", filterProp: "category" })}
                      {Head({ k: "type", label: "Type", filterProp: "type" })}
                      <th className="w-12 px-2 py-1.5 font-semibold">Link</th>
                    </tr>
                  </thead>
                  <tbody ref={tbodyRef} key={`${cur}-${pageSize}`} className="duration-200 animate-in fade-in">
                    {pageRows.map((j) => {
                      const c = coById(j.company)
                      const live = isLive(j)
                      const st = mine.status[j.id]
                      const py = settings.compact ? "py-2" : "py-3"
                      return (
                        <tr
                          key={j.id}
                          data-id={j.id}
                          tabIndex={0}
                          onClick={() => openJob(j.id)}
                          onKeyDown={(e) => {
                            if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); openJob(j.id) }
                          }}
                          className={cn(
                            "cursor-pointer border-b transition-[opacity,transform,background-color] duration-300 ease-out last:border-b-0 hover:bg-accent/60 focus-visible:bg-accent/60 focus-visible:outline-none",
                            !live && "text-muted-foreground",
                            leaving[j.id] && "pointer-events-none translate-x-6 opacity-0",
                            leaving[j.id] === "applied" && "bg-good/10"
                          )}
                        >
                          <td className={cn("pl-4 pr-0", py)} onClick={(e) => e.stopPropagation()}>
                            <div className="flex items-center gap-1.5">
                              <Checkbox
                                checked={st === "applied" || leaving[j.id] === "applied"}
                                onCheckedChange={() => move([j.id], st === "applied" ? null : "applied", st === "applied" ? "Moved back to To apply" : "Marked as applied")}
                                aria-label={`Applied to ${j.title} at ${c.name}`}
                                className="size-[18px] rounded-[5px] transition-colors duration-200 data-[state=checked]:border-good data-[state=checked]:bg-good"
                              />
                              <button
                                type="button"
                                aria-pressed={st === "saved"}
                                aria-label={st === "saved" ? `Unsave ${j.title}` : `Save ${j.title} for later`}
                                onClick={() => move([j.id], st === "saved" ? null : "saved", st === "saved" ? "Removed from Saved" : "Saved for later")}
                                className={cn("grid size-7 place-items-center rounded-md hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", st === "saved" ? "text-primary" : "text-muted-foreground/70")}
                              >
                                <Bookmark className={cn("size-4", st === "saved" && "fill-current")} />
                              </button>
                            </div>
                          </td>
                          <td className={cn("min-w-[260px] px-2.5", py)}>
                            <div className="flex items-center gap-2">
                              <span className={cn("font-semibold", live && "text-foreground")}>{j.title}</span>
                              {isNew(j) && <NewBadge />}
                              {mine.notes[j.id] && (
                                <Tooltip>
                                  <TooltipTrigger asChild><NotebookPen className="size-3.5 shrink-0 text-muted-foreground" aria-label="You have notes on this role" /></TooltipTrigger>
                                  <TooltipContent className="max-w-xs whitespace-pre-wrap">{mine.notes[j.id]}</TooltipContent>
                                </Tooltip>
                              )}
                            </div>
                            {!settings.compact && <div className="text-xs text-muted-foreground">{j.term}, {j.mode.toLowerCase().startsWith("remote") ? "remote" : j.mode.toLowerCase()}</div>}
                          </td>
                          <td className="px-2.5">{c.name}</td>
                          <td className="px-2.5"><LocationCell job={j} /></td>
                          <td className="px-2.5"><DeadlineCell job={j} soonDays={settings.soonDays} /></td>
                          <td className="px-2.5"><StatusPill job={j} /></td>
                          <td className="px-2.5"><CatChip id={j.category} className="max-w-[9rem]" /></td>
                          <td className="px-2.5"><span className="whitespace-nowrap rounded-full bg-muted px-2 py-0.5 text-xs font-medium">{c.type}</span></td>
                          <td className="px-2" onClick={(e) => e.stopPropagation()}>
                            <a href={j.url} target="_blank" rel="noopener noreferrer" aria-label={`Open posting for ${j.title} in a new tab`} className="inline-grid size-8 place-items-center rounded-md text-primary hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                              <ExternalLink className="size-4" />
                            </a>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              <Pager id="board-rows" page={cur} pageSize={pageSize} total={rows.length} sizes={[25, 50, 100]} onPage={setPage} onPageSize={setPageSize} />
            </>
          )}
        </div>
      </section>

    </div>
  )
}
