"use client"

import { useState } from "react"
import { AlertTriangle, Check, ChevronDown, ExternalLink, Pencil, RotateCcw, Trash2, X } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Segmented } from "@/components/Segmented"
import { CatChip, Panel } from "@/components/common"
import { useApp } from "@/lib/state"
import { cn } from "@/lib/utils"
import { coById, fmt, jobLocations, type StagedJob } from "@/lib/data"

/* one column template shared by the header and every row, so labels sit directly above their content */
const COLS = "grid grid-cols-[1rem_minmax(0,1fr)_auto] items-start gap-x-4 md:grid-cols-[1rem_minmax(0,1.1fr)_minmax(0,1fr)_13.5rem]"

const SOURCE: Record<StagedJob["review"]["source"], string> = {
  import: "Flagged by import checks",
  held: "Held by staff",
  pulled: "Pulled from the job board",
}

/**
 * Postings that need a person to look at them before students can see them: imports the checks
 * flagged as vague or off-target, postings staff chose to hold, and ones pulled back off the board.
 */
export function ReviewQueue({ onEdit, flash }: { onEdit: (s: StagedJob) => void; flash: boolean }) {
  const { staged, approve, pullToReview, saveStaged, setReviewStatus, dropStaged } = useApp()
  const [view, setView] = useState<"pending" | "rejected">("pending")
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [leaving, setLeaving] = useState<Set<string>>(new Set())

  const pending = staged.filter((s) => s.review.status === "pending").sort((a, b) => b.review.at - a.review.at)
  const rejected = staged.filter((s) => s.review.status === "rejected").sort((a, b) => (b.review.decidedAt || 0) - (a.review.decidedAt || 0))
  const list = view === "pending" ? pending : rejected
  const ids = list.map((s) => s.id)
  const selIds = ids.filter((id) => sel.has(id))
  const fail = () => toast("Couldn't save that change. Check your connection and try again.")

  // rows fold away before the change lands, so the list closes up smoothly
  const out = (go: string[], fn: () => Promise<unknown>) => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    setLeaving(new Set(go))
    window.setTimeout(() => {
      fn().catch(fail).finally(() => {
        setLeaving(new Set())
        setSel((s) => new Set([...s].filter((id) => !go.includes(id))))
      })
    }, reduce ? 0 : 280)
  }
  const doApprove = (go: string[]) => {
    const originals = staged.filter((s) => go.includes(s.id))
    out(go, async () => {
      await approve(go)
      toast(go.length === 1 ? "Approved and published" : `Approved ${go.length} postings`, {
        description: go.length === 1 ? originals[0]?.title : "They're on the job board now.",
        action: {
          label: "Undo",
          onClick: () => pullToReview(go, "").then(() => saveStaged(originals)).catch(fail),
        },
      })
    })
  }
  const doReject = (go: string[]) =>
    out(go, async () => {
      await setReviewStatus(go, "rejected")
      toast(go.length === 1 ? "Rejected" : `Rejected ${go.length} postings`, {
        description: "Kept out of the job board. Later imports of the same posting stay rejected.",
        action: { label: "Undo", onClick: () => setReviewStatus(go, "pending").catch(fail) },
      })
    })
  const doReopen = (go: string[]) =>
    out(go, async () => {
      await setReviewStatus(go, "pending")
      toast(go.length === 1 ? "Back in the review queue" : `${go.length} postings back in the review queue`)
    })
  const doForget = (go: string[]) =>
    out(go, async () => {
      await dropStaged(go)
      toast(go.length === 1 ? "Removed for good" : `Removed ${go.length} for good`, { description: "If the scraper finds it again, it will come back for review." })
    })

  const toggle = (set: Set<string>, id: string, on: boolean) => {
    const next = new Set(set)
    if (on) next.add(id)
    else next.delete(id)
    return next
  }

  return (
    <Panel
      id="admin-review"
      flush
      className={cn("transition-shadow duration-500", flash && "ring-2 ring-primary")}
      title="Review queue"
      sub={
        <>
          Postings that look vague or off-target wait here, hidden from students, until someone approves them.
          <br />
          Approve to publish, edit to fix the details first, or reject to keep it off the board.
        </>
      }
      right={
        <Segmented
          label="Which postings"
          value={view}
          onChange={(v) => { setView(v); setSel(new Set()) }}
          items={[
            ["pending", <>Needs review <span className="rounded-full bg-warn-soft px-1.5 text-[0.7rem] tabular-nums text-warn">{pending.length}</span></>],
            ["rejected", <>Rejected <span className="rounded-full bg-foreground/[0.06] px-1.5 text-[0.7rem] tabular-nums">{rejected.length}</span></>],
          ]}
        />
      }
    >
      <div className={cn("grid transition-[grid-template-rows] duration-200 ease-out", selIds.length ? "grid-rows-[1fr]" : "grid-rows-[0fr]")}>
        <div className="overflow-hidden" inert={!selIds.length}>
          <div className="flex flex-wrap items-center gap-2 border-t bg-accent/60 px-5 py-2 text-sm">
            <span className="font-medium">{selIds.length} selected</span>
            <div className="ml-auto flex flex-wrap gap-2">
              <Button size="sm" variant="ghost" className="h-8" onClick={() => setSel(new Set())}>Clear selection</Button>
              {view === "pending" ? (
                <>
                  <Button size="sm" variant="outline" className="h-8" onClick={() => doReject(selIds)}><X className="size-3.5" /> Reject</Button>
                  <Button size="sm" className="h-8" onClick={() => doApprove(selIds)}><Check className="size-3.5" /> Approve {selIds.length}</Button>
                </>
              ) : (
                <>
                  <Button size="sm" variant="outline" className="h-8 border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={() => doForget(selIds)}><Trash2 className="size-3.5" /> Remove for good</Button>
                  <Button size="sm" variant="outline" className="h-8" onClick={() => doReopen(selIds)}><RotateCcw className="size-3.5" /> Back to review</Button>
                </>
              )}
            </div>
          </div>
        </div>
      </div>

      {list.length ? (
        <>
          <div className={cn(COLS, "items-center border-y bg-muted/60 px-5 py-2.5 text-[0.7rem] font-semibold uppercase tracking-[0.07em] text-muted-foreground")}>
            <Checkbox
              aria-label="Select every posting in this list"
              checked={selIds.length === ids.length ? true : selIds.length ? "indeterminate" : false}
              onCheckedChange={(c) => setSel(c ? new Set(ids) : new Set())}
            />
            <span className="pl-6">Posting</span>
            <span className="hidden md:block">{view === "pending" ? "Concerns" : "Rejected on"}</span>
            <span className="text-right">Actions</span>
          </div>
          <ul key={view} className="duration-200 animate-in fade-in">
            {list.map((s) => {
              const isOpen = open.has(s.id)
              const gone = leaving.has(s.id)
              return (
                <li key={s.id} className={cn("grid transition-[grid-template-rows,opacity] duration-300 ease-out", gone ? "grid-rows-[0fr] opacity-0" : "grid-rows-[1fr]")}>
                  <div className="overflow-hidden">
                    <div className={cn("border-b transition-colors duration-150 last:border-b-0", sel.has(s.id) && "bg-accent/40")}>
                      <div className={cn(COLS, "px-5 py-3")}>
                        <Checkbox className="mt-1" aria-label={`Select ${s.title} at ${coById(s.company).name}`} checked={sel.has(s.id)} onCheckedChange={(c) => setSel(toggle(sel, s.id, !!c))} />
                        <button
                          type="button"
                          className="group flex min-w-0 flex-1 items-start gap-2 text-left focus-visible:outline-none"
                          aria-expanded={isOpen}
                          onClick={() => setOpen(toggle(open, s.id, !isOpen))}
                        >
                          <ChevronDown className={cn("mt-1 size-4 shrink-0 text-muted-foreground transition-transform duration-200", isOpen && "rotate-180")} />
                          <span className="min-w-0">
                            <span className="block font-semibold group-hover:underline group-focus-visible:underline">{s.title}</span>
                            <span className="block text-xs text-muted-foreground">
                              {coById(s.company).name}, {jobLocations(s)[0]}
                              <br />
                              {SOURCE[s.review.source]} {fmtAgo(s.review.at)}
                            </span>
                          </span>
                        </button>
                        <div className="hidden flex-wrap gap-1.5 pt-0.5 md:flex">
                          {view === "pending" ? (
                            s.review.flags.filter(Boolean).map((f) => (
                              <span key={f} className="inline-flex items-center gap-1 rounded-full bg-warn-soft px-2 py-0.5 text-xs text-warn">
                                <AlertTriangle className="size-3" /> {f}
                              </span>
                            ))
                          ) : (
                            <span className="pt-1 text-sm text-muted-foreground">{s.review.decidedAt ? fmt(new Date(s.review.decidedAt).toISOString().slice(0, 10)) : ""}</span>
                          )}
                        </div>
                        <div className="flex justify-end gap-1">
                          <Button size="icon" variant="ghost" className="size-8" aria-label={`Edit ${s.title}`} title="Edit" onClick={() => onEdit(s)}><Pencil className="size-4" /></Button>
                          {view === "pending" ? (
                            <>
                              <Button size="sm" variant="ghost" className="h-8" onClick={() => doReject([s.id])}>Reject</Button>
                              <Button size="sm" className="h-8" onClick={() => doApprove([s.id])}><Check className="size-3.5" /> Approve</Button>
                            </>
                          ) : (
                            <Button size="sm" variant="outline" className="h-8" onClick={() => doReopen([s.id])}><RotateCcw className="size-3.5" /> Back to review</Button>
                          )}
                        </div>
                      </div>
                      <div className={cn("grid transition-[grid-template-rows] duration-300 ease-out", isOpen ? "grid-rows-[1fr]" : "grid-rows-[0fr]")}>
                        <div className="overflow-hidden" inert={!isOpen}>
                          <div className="grid gap-4 px-5 pb-4 pl-[4.75rem] text-sm md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
                            <div className="flex flex-col gap-3">
                              <div className="flex flex-wrap gap-1.5 md:hidden">
                                {s.review.flags.filter(Boolean).map((f) => (
                                  <span key={f} className="inline-flex items-center gap-1 rounded-full bg-warn-soft px-2 py-0.5 text-xs text-warn"><AlertTriangle className="size-3" /> {f}</span>
                                ))}
                              </div>
                              <Section title="Description">{s.summary || <i className="text-muted-foreground">None given</i>}</Section>
                              <Section title="Responsibilities">{s.resp.length ? <ul className="list-disc pl-4">{s.resp.map((r) => <li key={r}>{r}</li>)}</ul> : <i className="text-muted-foreground">None listed</i>}</Section>
                              <Section title="Qualifications">{s.quals.length ? <ul className="list-disc pl-4">{s.quals.map((r) => <li key={r}>{r}</li>)}</ul> : <i className="text-muted-foreground">None listed</i>}</Section>
                            </div>
                            <dl className="grid grid-cols-[auto_1fr] content-start gap-x-4 gap-y-1.5 rounded-lg bg-muted/50 p-3 text-xs">
                              <dt className="text-muted-foreground">Category</dt><dd><CatChip id={s.category} className="text-xs" /></dd>
                              <dt className="text-muted-foreground">Locations</dt><dd>{jobLocations(s).join("; ")}</dd>
                              <dt className="text-muted-foreground">Deadline</dt><dd>{s.deadline ? fmt(s.deadline) : "Rolling"}</dd>
                              <dt className="text-muted-foreground">Term</dt><dd>{s.term || "Not given"}</dd>
                              <dt className="text-muted-foreground">Pay</dt><dd>{s.pay || "Not given"}</dd>
                              <dt className="text-muted-foreground">First seen</dt><dd>{fmt(s.posted)}</dd>
                              <dt className="text-muted-foreground">Link</dt>
                              <dd><a href={s.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">Open posting <ExternalLink className="size-3" /></a></dd>
                            </dl>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </li>
              )
            })}
          </ul>
        </>
      ) : (
        <p className="border-t px-5 py-10 text-center text-sm text-muted-foreground duration-200 animate-in fade-in">
          {view === "pending" ? "Nothing waiting for review. Imports send postings here when they look vague or off-target." : "No rejected postings."}
        </p>
      )}
    </Panel>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-0.5 text-[0.7rem] font-semibold uppercase tracking-[0.07em] text-muted-foreground">{title}</p>
      <div>{children}</div>
    </div>
  )
}

function fmtAgo(t: number) {
  const d = Math.floor((Date.now() - t) / 864e5)
  if (d <= 0) {
    const h = Math.floor((Date.now() - t) / 36e5)
    return h <= 0 ? "just now" : `${h} hour${h === 1 ? "" : "s"} ago`
  }
  return `${d} day${d === 1 ? "" : "s"} ago`
}
