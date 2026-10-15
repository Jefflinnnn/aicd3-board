"use client"

import { Cpu } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { D3_QUESTIONS, D3_RULES as R } from "@/lib/d3-routing"
import { cn } from "@/lib/utils"
import type { RefreshStatus, RoutingTally } from "@/lib/types"

const pc = (x: number) => `${Math.round(x * 100)}%`

/**
 * "How d3 routes": the decision a refresh makes about each posting, step by step, with the latest run's counts
 * beside each outcome. Opened from its own button on the Admin page's Job data refresh panel.
 */
export function D3RoutingDialog({ open, onOpenChange, status, tally, onSetup, busy }: {
  open: boolean
  onOpenChange: (o: boolean) => void
  status: RefreshStatus | null
  /** where the latest run's postings went (live while it runs) */
  tally: RoutingTally | null
  onSetup?: () => void
  busy?: boolean
}) {
  const t = tally
  const routed = t ? t.publish + t.review + t.skip + t.not_us : 0
  const share = (n: number) => (routed ? ` · ${Math.round((n / routed) * 100)}%` : "")
  const server = status?.classifier.server
  const canSetUpHere = status && !status.classifier.d3 && !status.classifier.canSetup && !status.queue
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-2xl gap-5 overflow-y-auto">
        <DialogHeader className="text-left">
          <DialogTitle className="font-display text-2xl">How d3 routes a posting</DialogTitle>
          <DialogDescription className="flex flex-wrap items-center gap-x-2">
            <Cpu className="size-3.5" />
            {status?.queue
              ? "vllm-sr/d3, on the GPU PC that runs the refreshes"
              : server?.up ? `vllm-sr/d3 · ${server.detail} · answering` : `vllm-sr/d3 · not answering${server?.detail ? ` at ${server.detail}` : ""}`}
            <span>· prompt version {R.QUESTIONS_V}</span>
            {t && <span>· counts from the latest refresh</span>}
          </DialogDescription>
        </DialogHeader>

        <ol className="flex flex-col gap-5 text-sm">
          <Stage n={1} title="Keyword check, before d3" count={t ? `${t.undergrad} left out` : undefined}>
            Undergraduate-only roles and co-ops are recognised from their title and description and left out without asking the model.
          </Stage>

          <Stage n={2} title="d3 answers four questions" count={t ? `${routed}${t.pending ? ` answered, ${t.pending} waiting` : " answered"}` : undefined}>
            <p>It reads the title, company, locations and the first 6,000 characters of the description, and returns a probability for each answer. It doesn&apos;t write any text.</p>
            <ul className="mt-2 grid gap-2 sm:grid-cols-2">
              {D3_QUESTIONS.map((q) => (
                <li key={q.key} className="rounded-md bg-muted px-3 py-2">
                  <span className="flex items-baseline justify-between gap-2"><b className="font-medium text-foreground">{q.name}</b><span className="text-[0.7rem]">{q.answers}</span></span>
                  <span className="mt-0.5 block text-xs leading-relaxed">{q.asks}</span>
                </li>
              ))}
            </ul>
          </Stage>

          <Stage n={3} title="Rules turn the answers into a decision">
            <table className="mt-1 w-full text-xs">
              <tbody className="[&_td]:border-t [&_td]:py-2 [&_td]:pr-3 [&_td]:align-top">
                <Rule to="Left out" cls="text-muted-foreground" n={t ? `${t.not_us}` : ""}>
                  Undergraduate-only {pc(R.UNDERGRAD_SKIP)} or more, or in the US under {pc(R.US_SKIP)}
                </Rule>
                <Rule to="Published" cls="text-good" n={t ? `${t.publish}${share(t.publish)}` : ""}>
                  AICD3 fit {pc(R.FIT_MIN)} or more, and discovery, development or tech
                </Rule>
                <Rule to="Review queue" cls="text-warn" n={t ? `${t.review}${share(t.review)}` : ""}>
                  Fit {pc(R.REVIEW_MIN)}–{pc(R.FIT_MIN)} in discovery or development; fit {pc(R.FIT_MIN)}+ filed under other; or one that would be published
                  but whose eligibility is unsure (undergraduate-only {pc(R.UNDERGRAD_REVIEW)}–{pc(R.UNDERGRAD_SKIP)}, in the US {pc(R.US_SKIP)}–{pc(R.US_REVIEW)})
                </Rule>
                <Rule to="Left out" cls="text-muted-foreground" n={t ? `${t.skip}${share(t.skip)}` : ""}>Everything else: not a fit for AICD3</Rule>
              </tbody>
            </table>
          </Stage>

          <Stage n={4} title="Title check">
            If d3 files a role under tech but its title names a drug-pipeline area (clinical, DMPK, drug metabolism, virology, chemistry…), the title wins.
            <span className="mt-1 block text-xs">“Intern - Research - Drug Metabolism - AI” is discovery; “Intern - Research - Clinical Virology - AI” is development.</span>
          </Stage>

          <Stage n={5} title="When d3 can't answer">
            The GPU PC&apos;s refreshes only let d3 decide. If its server isn&apos;t answering, the run stops before scraping and changes nothing; if it stops partway,
            nothing is imported; a single posting it couldn&apos;t answer goes to the review queue.
          </Stage>
        </ol>

        <p className="text-xs text-muted-foreground">
          Answers are remembered per posting, so each refresh only asks d3 about new or changed postings. The exact wording of the questions is in
          <code className="mx-1 rounded bg-muted px-1">scraper/classify.py</code>; changing it means bumping the prompt version so every posting is asked again.
        </p>

        {canSetUpHere && onSetup && (
          <div className={cn("flex flex-wrap items-center gap-3 rounded-md border px-3 py-2 text-sm")}>
            <span className="min-w-0 flex-1">d3 isn&apos;t set up on this computer. Setup downloads about 52 GB once and takes 30–60 minutes; it needs an NVIDIA GPU with 64 GB or more.</span>
            <Button size="sm" variant="outline" disabled={busy} onClick={onSetup}>Set up d3</Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

function Stage({ n, title, count, children }: { n: number; title: string; count?: string; children: React.ReactNode }) {
  return (
    <li className="grid grid-cols-[1.75rem_minmax(0,1fr)] gap-x-2">
      <span className="grid size-6 place-items-center rounded-full border text-xs font-medium tabular-nums">{n}</span>
      <div className="min-w-0">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3">
          <b className="font-medium">{title}</b>
          {count && <span className="text-xs tabular-nums text-muted-foreground">{count}</span>}
        </div>
        <div className="mt-0.5 leading-relaxed text-muted-foreground">{children}</div>
      </div>
    </li>
  )
}

function Rule({ to, cls, n, children }: { to: string; cls: string; n: string; children: React.ReactNode }) {
  return (
    <tr>
      <td className="text-foreground">{children}</td>
      <td className={cn("whitespace-nowrap font-medium", cls)}>{to}</td>
      <td className="whitespace-nowrap text-right tabular-nums text-muted-foreground">{n}</td>
    </tr>
  )
}
