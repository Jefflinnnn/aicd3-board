"use client"

import { useEffect, useMemo, useState } from "react"
import { ChevronRight, ExternalLink, Search } from "lucide-react"
import { toast } from "sonner"
import { Input } from "@/components/ui/input"
import { Panel } from "@/components/common"
import { Segmented } from "@/components/Segmented"
import { cn } from "@/lib/utils"
import { useApp } from "@/lib/state"
import { reloadIfStale } from "@/lib/stale"
import { listApplications } from "@/lib/application-actions"
import { coById, fmt } from "@/lib/data"
import type { AppliedPostingState, AppliedRole, StudentApplications } from "@/lib/types"

type Show = "all" | "closed"
const STATE_LABEL: Record<AppliedPostingState, string> = { open: "Open", expired: "Expired", removed: "Removed from board" }
const STATE_STYLE: Record<AppliedPostingState, string> = {
  open: "bg-good/15 text-good",
  expired: "bg-muted text-muted-foreground",
  removed: "bg-muted text-muted-foreground",
}
const day = (t: number) => new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })

/** A student's applications grouped under their company, companies A to Z, newest application first within each. */
function byCompany(list: AppliedRole[]): [string, AppliedRole[]][] {
  const groups = new Map<string, AppliedRole[]>()
  for (const a of list) {
    const name = coById(a.company).name
    groups.set(name, [...(groups.get(name) || []), a])
  }
  return [...groups].sort(([x], [y]) => x.localeCompare(y)).map(([name, roles]) => [name, roles.sort((a, b) => b.appliedAt - a.appliedAt)])
}

/**
 * Admin page: which student applied to which role, as the students marked it on the job board.
 * Each application keeps its own copy of the role, so ones that have since expired or been deleted still show.
 */
export function Applications({ flash }: { flash?: boolean }) {
  const { mode } = useApp()
  const [students, setStudents] = useState<StudentApplications[] | null>(null)
  const [q, setQ] = useState("")
  const [show, setShow] = useState<Show>("all")

  useEffect(() => {
    if (mode !== "cloud") return
    let off = false
    listApplications().then(
      (r) => { if (!off) setStudents(r.students) },
      (e) => {
        if (off || reloadIfStale(e)) return
        setStudents([])
        toast("Couldn't load the applications list.")
      }
    )
    return () => { off = true }
  }, [mode])

  const rows = useMemo(() => {
    const term = q.trim().toLowerCase()
    return (students || [])
      .filter((s) => !term || [s.name || "", s.email].join(" ").toLowerCase().includes(term))
      .map((s) => ({ ...s, applications: show === "closed" ? s.applications.filter((a) => a.state !== "open") : s.applications }))
      .filter((s) => s.applications.length > 0)
  }, [students, q, show])

  if (mode !== "cloud") return null

  const total = (students || []).reduce((n, s) => n + s.applications.length, 0)
  const closed = (students || []).reduce((n, s) => n + s.applications.filter((a) => a.state !== "open").length, 0)

  return (
    <Panel
      id="admin-applications"
      flush
      className={cn("transition-shadow duration-500", flash && "ring-2 ring-primary")}
      title="Student applications"
      sub={students === null ? "Roles students have marked as applied on the job board." : `${total} application${total === 1 ? "" : "s"} from ${students.length} student${students.length === 1 ? "" : "s"}. Roles stay listed after they expire or are removed from the board.`}
      right={
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input type="search" aria-label="Filter by student name or email" placeholder="Find a student" value={q} onChange={(e) => setQ(e.target.value)} className="h-9 w-48 pl-8" />
          </div>
          <Segmented label="Show" value={show} onChange={setShow} items={[["all", `All (${total})`], ["closed", `Expired or removed (${closed})`]]} />
        </div>
      }
    >
      {students === null ? (
        <p className="border-t px-5 py-8 text-center text-sm text-muted-foreground">Loading…</p>
      ) : rows.length ? (
        <ul>
          {rows.map((s) => (
            <li key={s.id} className="border-t">
              <details className="group" open={rows.length === 1 || !!q.trim()}>
                <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1 px-5 py-2.5 text-sm hover:bg-accent/40 focus-visible:bg-accent/40 focus-visible:outline-none [&::-webkit-details-marker]:hidden">
                  <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{s.name || s.email}</p>
                    {s.name && <p className="truncate text-xs text-muted-foreground">{s.email}</p>}
                  </div>
                  {s.status === "blocked" && <span className="text-xs text-muted-foreground">Blocked</span>}
                  <span className="tabular-nums text-muted-foreground">{s.applications.length} applied</span>
                </summary>
                <div className="bg-muted/30">
                  {byCompany(s.applications).map(([company, roles]) => (
                    <section key={company} aria-label={`${company}, ${roles.length} applied`}>
                      <h4 className="flex items-baseline gap-2 border-t bg-muted/50 py-1.5 pl-12 pr-5 text-xs font-semibold uppercase tracking-[0.07em] text-muted-foreground">
                        {company} <span className="font-normal tabular-nums normal-case tracking-normal">{roles.length}</span>
                      </h4>
                      <ul>
                        {roles.map((a) => (
                          <li key={a.postingId} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t py-2 pl-12 pr-5 text-sm">
                            <div className="min-w-0 flex-1">
                              <p className="truncate font-medium">{a.title}</p>
                              <p className="truncate text-xs text-muted-foreground">
                                {a.location}{a.location && a.deadline ? " · " : ""}{a.deadline ? `deadline ${fmt(a.deadline)}` : ""}
                              </p>
                            </div>
                            <span className="text-xs tabular-nums text-muted-foreground">Applied {day(a.appliedAt)}</span>
                            <span className={cn("rounded px-1.5 py-px text-xs font-medium", STATE_STYLE[a.state])}>{STATE_LABEL[a.state]}</span>
                            {a.url && (
                              <a href={a.url} target="_blank" rel="noopener noreferrer" className="text-muted-foreground hover:text-foreground" aria-label={`Open ${a.title} at ${company} (new tab)`}>
                                <ExternalLink className="size-3.5" />
                              </a>
                            )}
                          </li>
                        ))}
                      </ul>
                    </section>
                  ))}
                </div>
              </details>
            </li>
          ))}
        </ul>
      ) : (
        <p className="border-t px-5 py-8 text-center text-sm text-muted-foreground">
          {total === 0 ? "No student has marked a role as applied yet." : "Nothing matches."}
        </p>
      )}
    </Panel>
  )
}
