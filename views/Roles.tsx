"use client"

import { useEffect, useMemo, useState } from "react"
import { Bookmark, Check, ChevronDown, ExternalLink, Info, Lock, RefreshCw, Search } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Segmented } from "@/components/Segmented"
import { CatChip, LocationCell, PageHead, Panel } from "@/components/common"
import { Gate } from "@/components/Gate"
import { loadRoles } from "@/lib/actions"
import { useApp } from "@/lib/state"
import { CATS, ageDays, coById, fmt, isBayArea, jobLocations, type Job } from "@/lib/data"
import { cn } from "@/lib/utils"

type Where = "us" | "bay" | "remote"
type Level = "all" | "entry" | "mid"
type Show = "all" | "saved" | "applied"

const LEVEL_LABEL: Record<string, string> = { entry: "Entry · 0–2 yrs", mid: "Mid · 2–5 yrs" }
const isRemote = (l: string) => /remote/i.test(l)

/**
 * The private Full-time roles tab: junior to mid-level (0–5 years) AI and computational drug R&D roles at the tracked
 * companies, anywhere in the US. The scraper on the GPU PC finds them in the same 9 AM / 9 PM runs as internships, and
 * d3 checks the fit and the level. Only PRIVATE_ROLES_EMAILS can load them; the server checks that, not this page.
 */
export default function Roles() {
  const { me, mode } = useApp()
  const [roles, setRoles] = useState<Job[] | null>(null)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)

  const allowed = mode === "cloud" && !!me.roles
  const fetchRoles = async (quiet = false) => {
    setBusy(true)
    try {
      const r = await loadRoles()
      setRoles(r.roles)
      setError("")
      if (!quiet) toast.success(`${r.roles.length} role${r.roles.length === 1 ? "" : "s"} loaded`)
    } catch {
      setError("Couldn't load the roles. Try again in a moment.")
    } finally {
      setBusy(false)
    }
  }
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the first load of this page's own data
    if (allowed) void fetchRoles(true)
  }, [allowed])

  if (!allowed) {
    if (mode !== "cloud") return <Gate kind={mode === "preview" ? "empty" : "loading"} />
    return (
      <Panel>
        <div className="flex items-center gap-3 py-6 text-muted-foreground">
          <Lock className="size-5" aria-hidden />
          <p>This page isn&apos;t available on your account.</p>
        </div>
      </Panel>
    )
  }
  return <RolesBoard roles={roles} busy={busy} error={error} onReload={() => fetchRoles()} />
}

/** The list itself, with its filters (separate from loading, so it can be shown with any list of roles). */
export function RolesBoard({ roles, busy, error, onReload }: { roles: Job[] | null; busy: boolean; error: string; onReload: () => void }) {
  const { saved, applied, setStatus } = useApp()
  const [q, setQ] = useState("")
  const [where, setWhere] = useState<Where>("us")
  const [level, setLevel] = useState<Level>("all")
  const [area, setArea] = useState("all")
  const [company, setCompany] = useState("all")
  const [show, setShow] = useState<Show>("all")
  const [open, setOpen] = useState<string | null>(null)
  const [sort, setSort] = useState<"match" | "newest">("match")

  const companies = useMemo(() => [...new Set((roles || []).map((r) => r.company))].sort((a, b) => coById(a).name.localeCompare(coById(b).name)), [roles])
  const list = useMemo(() => {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean)
    return (roles || []).filter((r) => {
      if (r.closed) return false
      const locs = jobLocations(r)
      if (where === "bay" && !locs.some(isBayArea)) return false
      if (where === "remote" && !locs.some(isRemote) && r.mode !== "Remote") return false
      if (level !== "all" && r.level !== level) return false
      if (area !== "all" && r.category !== area) return false
      if (company !== "all" && r.company !== company) return false
      if (show === "saved" && !saved.has(r.id)) return false
      if (show === "applied" && !applied.has(r.id)) return false
      if (words.length) {
        const hay = [r.title, coById(r.company).name, ...locs, r.reqId || ""].join(" ").toLowerCase()
        if (!words.every((w) => hay.includes(w))) return false
      }
      return true
    }).sort((a, b) => (sort === "match" ? (b.score ?? -1) - (a.score ?? -1) : 0) || b.posted.localeCompare(a.posted))
  }, [roles, q, where, level, area, company, show, saved, applied, sort])

  const toggle = (id: string, s: "saved" | "applied") => {
    const has = s === "saved" ? saved.has(id) : applied.has(id)
    void setStatus([id], has ? null : s)
  }
  const fresh = (roles || []).filter((r) => !r.closed && ageDays(r) <= 7).length

  return (
    <div className="flex flex-col gap-5">
      <PageHead
        title="Full-time roles"
        sub={<>Junior to mid-level (0–5 years) AI and computational drug R&amp;D roles at the tracked companies, anywhere in the US. Only you can see this page.</>}
        right={
          <Button variant="outline" size="sm" onClick={onReload} disabled={busy}>
            <RefreshCw className={cn("size-4", busy && "animate-spin")} aria-hidden /> Reload
          </Button>
        }
      />

      <Panel flush>
        <div className="flex flex-wrap items-center gap-2 border-b p-4">
          <div className="relative min-w-[220px] flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search title, company, location or job ID" className="pl-8" aria-label="Search roles" />
          </div>
          <Segmented label="Location" value={where} onChange={setWhere} items={[["us", "All US"], ["bay", "Bay Area"], ["remote", "Remote"]]} />
          <Segmented label="Level" value={level} onChange={setLevel} items={[["all", "Any level"], ["entry", "Entry"], ["mid", "Mid"]]} />
          <Select value={area} onValueChange={setArea}>
            <SelectTrigger className="w-[170px]" aria-label="Area"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All areas</SelectItem>
              {CATS.map((c) => <SelectItem key={c.id} value={c.id}>{c.label}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={company} onValueChange={setCompany}>
            <SelectTrigger className="w-[170px]" aria-label="Company"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All companies</SelectItem>
              {companies.map((c) => <SelectItem key={c} value={c}>{coById(c).name}</SelectItem>)}
            </SelectContent>
          </Select>
          <Segmented label="Sort" value={sort} onChange={setSort} items={[["match", "Best match"], ["newest", "Newest"]]} />
          <Segmented label="Show" value={show} onChange={setShow} items={[["all", "All"], ["saved", `Saved (${(roles || []).filter((r) => saved.has(r.id)).length})`], ["applied", "Applied"]]} />
        </div>

        <div className="flex items-center justify-between px-4 py-2.5 text-[0.82rem] text-muted-foreground">
          <span>
            {roles === null ? "Loading…" : `${list.length} of ${roles.filter((r) => !r.closed).length} open roles`}
            {fresh > 0 && roles && <> · {fresh} new this week</>}
          </span>
          {error && <span className="text-destructive">{error}</span>}
        </div>

        {roles !== null && list.length === 0 ? (
          <p className="px-4 pb-8 pt-4 text-center text-muted-foreground">
            {roles.length === 0
              ? "No roles yet. They're added by the GPU PC's 9 AM and 9 PM refresh."
              : "No roles match these filters."}
          </p>
        ) : (
          <ul className="divide-y border-t">
            {list.map((r) => {
              const isOpen = open === r.id
              return (
                <li key={r.id}>
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-4 py-3">
                    <div className="flex min-w-0 flex-1 items-start gap-2">
                      <ChevronDown className={cn("mt-1 size-4 shrink-0 text-muted-foreground transition-transform", isOpen && "rotate-180")} aria-hidden />
                      <div className="min-w-0">
                        <button
                          type="button"
                          onClick={() => setOpen(isOpen ? null : r.id)}
                          aria-expanded={isOpen}
                          className="rounded text-left font-medium leading-snug hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          {r.title}
                        </button>
                        <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.82rem] text-muted-foreground">
                          {r.score != null && (
                            <span title="How well it fits your background (d3)" className={cn("rounded-full px-2 py-px text-xs font-semibold tabular-nums",
                              r.score >= 80 ? "bg-good/15 text-good" : r.score >= 60 ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground")}>
                              {r.score}% match
                            </span>
                          )}
                          <span className="font-medium text-foreground/80">{coById(r.company).name}</span>
                          <LocationCell job={r} />
                          <CatChip id={r.category} />
                          {r.level && <span className="rounded-full bg-muted px-2 py-px text-xs font-medium">{LEVEL_LABEL[r.level] || r.level}</span>}
                          {r.note && (
                            <span title={r.note} className="inline-flex items-center gap-1 rounded-full bg-warn-soft px-2 py-px text-xs font-medium text-warn">
                              <Info className="size-3" aria-hidden /> Unsure
                            </span>
                          )}
                          <span className="tabular-nums">First seen {fmt(r.posted)}</span>
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 max-sm:pl-5">
                      <Button variant={saved.has(r.id) ? "secondary" : "ghost"} size="sm" onClick={() => toggle(r.id, "saved")} aria-pressed={saved.has(r.id)}>
                        <Bookmark className={cn("size-4", saved.has(r.id) && "fill-current")} aria-hidden /> {saved.has(r.id) ? "Saved" : "Save"}
                      </Button>
                      <Button variant={applied.has(r.id) ? "secondary" : "ghost"} size="sm" onClick={() => toggle(r.id, "applied")} aria-pressed={applied.has(r.id)}>
                        <Check className="size-4" aria-hidden /> {applied.has(r.id) ? "Applied" : "Mark applied"}
                      </Button>
                      <Button asChild size="sm">
                        <a href={r.url} target="_blank" rel="noopener noreferrer">Open <ExternalLink className="size-3.5" aria-hidden /></a>
                      </Button>
                    </div>
                  </div>
                  {isOpen && (
                    <div className="grid gap-4 bg-muted/30 px-10 pb-5 pt-1 text-[0.9rem] md:grid-cols-2">
                      {r.note && <p className="md:col-span-2 rounded-md border border-warn/30 bg-warn/10 px-3 py-2 text-[0.85rem]"><b className="font-semibold">d3 was unsure:</b> {r.note}</p>}
                      {r.summary && <p className="md:col-span-2 whitespace-pre-line text-muted-foreground">{r.summary}</p>}
                      {r.resp.length > 0 && <Bullets title="Responsibilities" items={r.resp} />}
                      {r.quals.length > 0 && <Bullets title="Qualifications" items={r.quals} />}
                      <p className="md:col-span-2 text-[0.82rem] text-muted-foreground">
                        {[r.mode, r.pay, r.reqId && `Job ID ${r.reqId}`].filter(Boolean).join(" · ")}
                      </p>
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </Panel>
    </div>
  )
}

function Bullets({ title, items }: { title: string; items: string[] }) {
  return (
    <div>
      <h3 className="mb-1.5 text-[0.8rem] font-semibold uppercase tracking-[0.06em] text-muted-foreground">{title}</h3>
      <ul className="list-disc space-y-1 pl-5">{items.slice(0, 12).map((x, i) => <li key={i}>{x}</li>)}</ul>
    </div>
  )
}
