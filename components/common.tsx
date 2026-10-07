"use client"

import { Bookmark, Check, ExternalLink, Flag, Info } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { ROLLING_DAYS, catById, coById, daysLeft, fmt, isLive, jobLocations, type CatId, type Job } from "@/lib/data"
import type { MyStatus } from "@/lib/backend"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

export function CatChip({ id, className }: { id: CatId | string; className?: string }) {
  const c = catById(id)
  return (
    <span className={cn("inline-flex items-center gap-1.5 whitespace-nowrap text-[0.8rem] font-medium", className)}>
      <span className="size-2 shrink-0 rounded-[2px]" style={{ background: `var(${c.color})` }} aria-hidden />
      <span className="truncate">{c.short}</span>
    </span>
  )
}

export const ROLLING_HELP = `No fixed deadline. We count it as open for ${ROLLING_DAYS} days after we first see it, or until an admin marks it closed.`

export function DeadlineCell({ job, soonDays }: { job: Job; soonDays: number }) {
  if (job.closed)
    return (
      <div className="flex flex-col leading-tight">
        <span className="tabular-nums">{job.deadline ? fmt(job.deadline) : "Rolling"}</span>
        <span className="text-xs text-destructive">Taken down</span>
      </div>
    )
  if (!job.deadline)
    return (
      <div className="flex flex-col leading-tight">
        <span className="inline-flex items-center gap-1">
          Rolling
          <Tooltip>
            <TooltipTrigger asChild>
              <button type="button" onClick={(e) => e.stopPropagation()} className="rounded-full text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={ROLLING_HELP}>
                <Info className="size-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs">{ROLLING_HELP}</TooltipContent>
          </Tooltip>
        </span>
        <span className="text-xs text-muted-foreground">No fixed date</span>
      </div>
    )
  const d = daysLeft(job) as number
  let cls = "text-muted-foreground"
  let txt = `${d} days left`
  if (d < 0) {
    cls = "text-destructive"
    txt = "Closed"
  } else if (d === 0) {
    cls = "text-warn font-semibold"
    txt = "Closes today"
  } else if (d <= soonDays) {
    cls = "text-warn font-semibold"
    txt = d === 1 ? "1 day left" : `${d} days left`
  }
  return (
    <div className="flex flex-col leading-tight">
      <span className="tabular-nums">{fmt(job.deadline)}</span>
      <span className={cn("text-xs", cls)}>{txt}</span>
    </div>
  )
}

export function StatusPill({ job }: { job: Job }) {
  return isLive(job) ? (
    <span className="rounded-full bg-good/15 px-2 py-0.5 text-xs font-medium text-good">Live</span>
  ) : (
    <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">{job.closed ? "Taken down" : "Expired"}</span>
  )
}

export function NewBadge() {
  return <span className="rounded-full bg-primary/10 px-1.5 py-px text-[0.68rem] font-semibold uppercase tracking-[0.06em] text-primary">New</span>
}

export function PageHead({ title, sub, right }: { title: string; sub?: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="font-display text-[1.65rem] font-semibold leading-tight text-balance">{title}</h1>
        {sub && <p className="mt-1 max-w-[64ch] text-[0.95rem] text-muted-foreground">{sub}</p>}
      </div>
      {right}
    </div>
  )
}

/** The one panel style used on every page. */
export function Panel({ title, sub, right, children, className = "", id, flush = false }: { title?: string; sub?: React.ReactNode; right?: React.ReactNode; children: React.ReactNode; className?: string; id?: string; flush?: boolean }) {
  return (
    <section id={id} className={cn("spotlight flex min-w-0 scroll-mt-6 flex-col rounded-lg border bg-card", flush ? "overflow-hidden" : "p-5", className)}>
      {(title || right) && (
        <div className={cn("mb-3 flex flex-wrap items-start justify-between gap-3", flush && "mb-0 p-5 pb-3")}>
          <div className="min-w-0">
            {title && <h2 className="font-display text-[1rem] font-semibold leading-snug">{title}</h2>}
            {sub && <p className="text-[0.82rem] text-muted-foreground">{sub}</p>}
          </div>
          {right}
        </div>
      )}
      {children}
    </section>
  )
}

export function JobDialog({
  job,
  open,
  onOpenChange,
  status,
  onSetStatus,
  note,
  onNote,
  onReport,
}: {
  job: Job | null
  open: boolean
  onOpenChange: (o: boolean) => void
  status: MyStatus | null
  onSetStatus: (s: MyStatus | null) => void
  note: string
  onNote: (t: string) => void
  onReport?: () => void
}) {
  if (!job) return null
  const c = coById(job.company)
  const live = isLive(job)
  const locs = jobLocations(job)
  const facts: [string, React.ReactNode][] = [
    ["Deadline", job.closed ? "Taken down" : job.deadline ? fmt(job.deadline, { month: "long", day: "numeric", year: "numeric" }) + (live ? "" : " (closed)") : "Rolling"],
    ["Category", <CatChip key="cat" id={job.category} />],
    ["Company type", c.type],
    ["Term", job.term],
    ["Work mode", job.mode],
    ["Pay", job.pay || "None listed"],
  ]
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-2xl gap-0 overflow-y-auto p-0">
        <DialogHeader className="border-b px-6 pb-4 pt-6 text-left">
          <div className="mb-1 text-xs font-semibold uppercase tracking-[0.08em] text-primary">{c.name}</div>
          <DialogTitle className="font-display text-2xl leading-tight">{job.title}</DialogTitle>
          <DialogDescription className="flex flex-col">
            <span>{locs.join("; ")}</span>
            <span>First seen {fmt(job.posted, { month: "long", day: "numeric", year: "numeric" })}</span>
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-5 px-6 py-5">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 rounded-lg bg-muted px-4 py-3 sm:grid-cols-3">
            {facts.map(([k, v]) => (
              <div key={k} className="min-w-0">
                <dt className="text-[0.7rem] font-semibold uppercase tracking-[0.07em] text-muted-foreground">{k}</dt>
                <dd className={cn("text-sm", k === "Deadline" && !live && "text-destructive")}>{v}</dd>
              </div>
            ))}
          </dl>
          {!job.deadline && !job.closed && <p className="-mt-2 text-xs text-muted-foreground">{ROLLING_HELP}</p>}
          <section>
            <h3 className="mb-1.5 text-[0.72rem] font-semibold uppercase tracking-[0.08em] text-muted-foreground">About the role</h3>
            <p className="max-w-[65ch] text-[0.95rem] leading-relaxed">{job.summary}</p>
          </section>
          {job.resp.length > 0 && (
            <section>
              <h3 className="mb-1.5 text-[0.72rem] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Responsibilities</h3>
              <ul className="flex max-w-[65ch] list-disc flex-col gap-1 pl-5 text-[0.95rem]">
                {job.resp.map((r) => <li key={r}>{r}</li>)}
              </ul>
            </section>
          )}
          {job.quals.length > 0 && (
            <section>
              <h3 className="mb-1.5 text-[0.72rem] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Qualifications</h3>
              <ul className="flex max-w-[65ch] list-disc flex-col gap-1 pl-5 text-[0.95rem]">
                {job.quals.map((r) => <li key={r}>{r}</li>)}
              </ul>
            </section>
          )}
          <section>
            <label htmlFor="mynote" className="mb-1.5 block text-[0.72rem] font-semibold uppercase tracking-[0.08em] text-muted-foreground">My notes</label>
            <Textarea id="mynote" rows={3} value={note} onChange={(e) => onNote(e.target.value)} placeholder="Contacts, referral, what to mention in your cover letter…" />
            <p className="mt-1 text-xs text-muted-foreground">Only you can see your notes.</p>
          </section>
        </div>
        <div className="sticky bottom-0 flex flex-wrap items-center justify-end gap-2 border-t bg-background px-6 py-4">
          {onReport && (
            <Button variant="ghost" className="mr-auto text-muted-foreground" onClick={onReport}>
              <Flag className="size-4" /> Report an issue
            </Button>
          )}
          {status === "saved" ? (
            <Button variant="outline" onClick={() => onSetStatus(null)}><Bookmark className="size-4 fill-current" /> Saved</Button>
          ) : status !== "applied" ? (
            <Button variant="outline" onClick={() => onSetStatus("saved")}><Bookmark className="size-4" /> Save for later</Button>
          ) : null}
          <Button variant="outline" onClick={() => onSetStatus(status === "applied" ? null : "applied")}>
            {status === "applied" ? <><Check className="size-4" /> Applied</> : "Mark as applied"}
          </Button>
          <Button asChild>
            <a href={job.url} target="_blank" rel="noopener noreferrer">
              Open posting <ExternalLink className="size-4" />
            </a>
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** Closest site to the viewer's city, plus a "+n" badge that lists the other sites on hover. */
export function LocationCell({ job }: { job: Job }) {
  const locs = jobLocations(job)
  const [first, ...rest] = locs
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      {first}
      {rest.length > 0 && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={(e) => e.stopPropagation()}
              aria-label={`${rest.length} more location${rest.length === 1 ? "" : "s"}: ${rest.join("; ")}`}
              className="rounded-full bg-muted px-1.5 py-px text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              +{rest.length}
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom" align="start">
            <ul className="flex flex-col gap-0.5">{rest.map((l) => <li key={l}>{l}</li>)}</ul>
          </TooltipContent>
        </Tooltip>
      )}
    </span>
  )
}
