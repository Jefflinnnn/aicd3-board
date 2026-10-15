"use client"

import { Check } from "lucide-react"
import { cn } from "@/lib/utils"
import type { RefreshRun, RunProgress } from "@/lib/types"

/**
 * The four steps of a refresh as cards: scrape, route, update the board, re-check. While a run goes, the current
 * step's card fills from the left as it progresses (eased, so it creeps rather than jumps). Clicking a card shows
 * that step's detail below; the panel follows the running step until someone picks one.
 */
export type StepId = "scrape" | "classify" | "import" | "check"
export const STEP_IDS: StepId[] = ["scrape", "classify", "import", "check"]
const ORDER = ["scrape", "classify", "import", "check", "done"]

export function stepStateOf(run: RefreshRun, p: RunProgress | null, id: StepId): "done" | "now" | "next" | "failed" {
  const live = run.status === "running"
  const at = ORDER.indexOf(p?.step ?? (live ? "scrape" : "done"))
  const i = ORDER.indexOf(id)
  if (!live && (run.status === "failed" || run.status === "cancelled") && at === i) return "failed"
  if (at > i) return "done"
  if (at === i) return live ? "now" : "done"
  return "next"
}

function share(p: RunProgress | null, id: StepId): number | null {
  if (!p) return null
  if (id === "scrape") {
    const n = p.companies.length
    return n ? p.companies.filter((c) => c.state === "done" || c.state === "failed").length / n : null
  }
  if (id === "classify") {
    const r = p.routing
    if (r) {
      const routed = r.publish + r.review + r.skip + r.not_us
      return routed + r.pending ? routed / (routed + r.pending) : 1
    }
    return p.classify.total ? p.classify.done / p.classify.total : null
  }
  return null   // importing and re-checking don't report a fraction: an indeterminate bar
}

function note(run: RefreshRun, p: RunProgress | null, id: StepId, classifier: string): string {
  if (!p) return ""
  const d = run.summary?.database
  if (id === "scrape") {
    const done = p.companies.filter((c) => c.state === "done" || c.state === "failed").length
    const found = p.companies.reduce((a, c) => a + (c.state === "done" ? c.found ?? 0 : 0), 0)
    const failed = p.companies.filter((c) => c.state === "failed").length
    return `${done}/${p.companies.length} sites · ${found.toLocaleString("en-US")} found${failed ? ` · ${failed} blocked` : ""}`
  }
  if (id === "classify") {
    const o = p.routing ?? p.outcome
    if (!o) return ""
    const pend = p.routing?.pending ?? 0
    return `${o.publish} fit · ${o.review} to review${pend ? ` · ${pend} waiting` : ""}`
  }
  if (id === "import") return d ? `+${d.added} new · ${d.updated} updated · ${d.closed} closed` : p.step === "import" ? (p.dryRun ? "Comparing (dry run)" : "Saving changes") : ""
  if (id === "check") return p.checked ? `${p.checked.closed} taken down · ${p.checked.unknown} to review` : p.step === "check" ? "Checking each open posting" : ""
  return classifier
}

export function RefreshSteps({ run, p, selected, onSelect, classifier }: {
  run: RefreshRun; p: RunProgress | null; selected: StepId; onSelect: (id: StepId) => void; classifier: string
}) {
  const name = classifier === "d3" ? "d3" : classifier === "llm" ? "Claude" : classifier ? "keyword rules" : "the classifier"
  const steps: { id: StepId; label: string; what: string }[] = [
    { id: "scrape", label: "Scrape", what: `${p?.companies.length || "All"} career sites` },
    { id: "classify", label: `Route with ${name}`, what: "Fit, area, eligibility" },
    { id: "import", label: p?.dryRun ? "Compare with the board" : "Update the board", what: "Add, update, close" },
    { id: "check", label: "Re-check", what: "Open postings" },
  ]
  return (
    <ol className="grid grid-cols-2 gap-2 lg:grid-cols-4" aria-label="Steps of this refresh">
      {steps.map((s, i) => {
        const st = stepStateOf(run, p, s.id)
        const frac = st === "now" ? share(p, s.id) : null
        const text = note(run, p, s.id, name)
        return (
          <li key={s.id} className="min-w-0">
            <button
              type="button"
              onClick={() => onSelect(s.id)}
              aria-pressed={selected === s.id}
              aria-current={st === "now" ? "step" : undefined}
              className={cn(
                "relative flex h-full w-full flex-col items-start gap-0.5 overflow-hidden rounded-md border px-3 pb-3 pt-2 text-left transition-[border-color,background-color,box-shadow] duration-300",
                "hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                st === "now" && "border-primary/50 bg-primary/[0.05]",
                st === "failed" && "border-destructive/40",
                selected === s.id && "shadow-[inset_0_0_0_1px_hsl(var(--foreground)/0.25)]",
              )}
            >
              <span className="flex items-center gap-1.5 text-[0.68rem] font-semibold uppercase tracking-[0.07em] text-muted-foreground">
                <span className={cn(
                  "grid size-4 place-items-center rounded-full text-[0.6rem] transition-colors duration-300",
                  st === "done" ? "bg-good text-white" : st === "now" ? "bg-primary text-primary-foreground" : st === "failed" ? "bg-destructive text-white" : "border",
                )}>
                  {st === "done" ? <Check className="size-2.5" /> : st === "failed" ? "!" : i + 1}
                </span>
                {s.what}
              </span>
              <span className={cn("text-sm font-medium", st === "next" && "text-muted-foreground")}>{s.label}</span>
              <span className="min-h-[1rem] truncate text-xs tabular-nums text-muted-foreground" style={{ maxWidth: "100%" }}>
                {text || (st === "next" ? "Waiting" : st === "failed" ? "Stopped here" : "")}
              </span>
              {st === "now" && (
                <span className="absolute inset-x-0 bottom-0 h-[3px] bg-primary/15" aria-hidden>
                  {frac === null
                    ? <span className="block h-full w-1/3 animate-[rs-slide_1.6s_ease-in-out_infinite] bg-primary motion-reduce:w-full motion-reduce:animate-none motion-reduce:opacity-60" />
                    : <span className="block h-full bg-primary transition-[width] duration-1000 ease-out" style={{ width: `${Math.max(3, Math.round(frac * 100))}%` }} />}
                </span>
              )}
            </button>
          </li>
        )
      })}
      <style>{`@keyframes rs-slide { 0% { transform: translateX(-100%) } 100% { transform: translateX(300%) } }`}</style>
    </ol>
  )
}
