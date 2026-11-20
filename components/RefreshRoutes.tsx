"use client"

import { useState } from "react"
import { cn } from "@/lib/utils"
import type { RefreshRun, RunProgress } from "@/lib/types"

/**
 * The scrape step of a job data refresh, kept short enough to read without scrolling: one bar for how far the
 * search has got, then names only where they matter (being searched now, couldn't be scraped, postings found).
 * Companies with nothing found are counted and folded away, and "Show every company" opens the full table.
 *
 * GROUPS sorts the companies into big pharma / biotech / AI & tech for that table; every company the scraper
 * knows must be in one (scraper/test_pharma_internships.py checks).
 */

type Co = RunProgress["companies"][number]

const GROUPS: { id: string; label: string; dot: string; names: string[] }[] = [
  { id: "pharma", label: "Big pharma", dot: "var(--c1)", names: ["Pfizer", "Merck", "AbbVie", "AstraZeneca", "Bristol Myers Squibb", "Sanofi", "GSK", "Boehringer Ingelheim", "Novartis", "Takeda", "Eli Lilly", "Johnson & Johnson", "Novo Nordisk", "Bayer", "Astellas", "Daiichi Sankyo", "Merck KGaA", "Eisai", "UCB", "CSL", "Viatris", "Thermo Fisher Scientific", "Lonza", "Catalent", "IQVIA", "Labcorp", "Abbott", "Zoetis"] },
  { id: "biotech", label: "Biotech", dot: "var(--c2)", names: ["Amgen", "Gilead Sciences", "Genentech", "Regeneron", "Vertex Pharmaceuticals", "Biogen", "Revolution Medicines", "Moderna", "Denali Therapeutics", "Cytokinetics", "Nurix Therapeutics", "Septerna", "Maze Therapeutics", "Arsenal Bioscience", "BridgeBio", "BeiGene", "Genmab", "Exelixis"] },
  { id: "ai", label: "AI & tech", dot: "var(--c3)", names: ["Recursion", "Generate:Biomedicines", "insitro", "Genesis Molecular AI", "Chai Discovery", "Profluent", "Noetik", "Tahoe Therapeutics", "Atomic AI", "Chan Zuckerberg Biohub", "Calico Life Sciences", "Altos Labs", "U.S. Food and Drug Administration", "GRAIL", "Freenome", "NVIDIA", "Lila Sciences", "Ginkgo Bioworks", "BigHat Biosciences"] },
]

const groupOf = (name: string) => GROUPS.find((g) => g.names.includes(name))

/** Progress for any run: what the pipeline reported, else rebuilt from a finished run's summary (older runs). */
export function progressFor(run: RefreshRun): RunProgress | null {
  if (run.progress) return run.progress
  const s = run.summary
  if (!s?.companies) return null
  return {
    at: run.finishedAt ?? run.startedAt, host: "", step: "done", classifier: s.classifier,
    companies: Object.entries(s.companies).map(([name, st]) => {
      const m = /^ok \((\d+)\)/.exec(st)
      return { name, state: m ? "done" : "failed", found: m ? Number(m[1]) : 0, note: m ? "" : st }
    }),
    classify: { done: s.scraped, total: s.scraped },
    outcome: { publish: s.publish, review: s.review, skip: s.skip, undergrad: s.undergrad ?? 0, not_us: s.not_us ?? 0 },
    checked: s.checked,
  }
}

const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`

export function RefreshRoutes({ run }: { run: RefreshRun }) {
  const [list, setList] = useState(false)
  const [showQuiet, setShowQuiet] = useState(false)
  const p = progressFor(run)
  const live = run.status === "running"
  const cos = p?.companies ?? []
  if (!p || !cos.length) return null

  const by = (s: Co["state"]) => cos.filter((c) => c.state === s)
  const running = by("running"), failed = by("failed"), waiting = by("waiting")
  const done = by("done")
  const found = done.filter((c) => (c.found ?? 0) > 0).sort((a, b) => (b.found ?? 0) - (a.found ?? 0) || a.name.localeCompare(b.name))
  const none = done.filter((c) => !c.found).sort((a, b) => a.name.localeCompare(b.name))
  const total = cos.length
  const searched = done.length + failed.length
  const postings = done.reduce((a, c) => a + (c.found ?? 0), 0)
  const o = p.outcome
  const pct = (n: number) => `${(n / total) * 100}%`
  const label = `${searched} of ${total} company sites searched, ${plural(postings, "posting")} found${failed.length ? `, ${failed.length} couldn't be scraped` : ""}.`

  return (
    <figure className="flex flex-col gap-4">
      {/* the headline numbers */}
      <div className="flex flex-wrap items-end gap-x-8 gap-y-2">
        <Stat value={`${searched}/${total}`} label={live ? "sites searched so far" : "sites searched"} />
        <Stat value={String(postings)} label={`US internship posting${postings === 1 ? "" : "s"} found`} />
        <Stat value={String(found.length)} label={`compan${found.length === 1 ? "y" : "ies"} with postings`} />
        {failed.length > 0 && <Stat value={String(failed.length)} label="couldn't be scraped" warn />}
      </div>

      {/* one bar: done, couldn't be scraped, searching now, still to go */}
      <div>
        <div className="flex h-2 w-full overflow-hidden rounded-full bg-muted" role="img" aria-label={label}>
          <span className="h-full bg-good transition-[width] duration-500" style={{ width: pct(done.length) }} />
          <span className="h-full bg-warn transition-[width] duration-500" style={{ width: pct(failed.length) }} />
          <span className={cn("h-full bg-primary transition-[width] duration-500", live && "animate-pulse motion-reduce:animate-none")} style={{ width: pct(running.length) }} />
        </div>
        <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <Key cls="bg-good">{plural(done.length, "searched", "searched")}</Key>
          {failed.length > 0 && <Key cls="bg-warn">{failed.length} couldn&apos;t be scraped</Key>}
          {running.length > 0 && <Key cls="bg-primary">{running.length} searching now</Key>}
          {waiting.length > 0 && <Key cls="bg-muted-foreground/30">{waiting.length} still to search</Key>}
        </div>
      </div>

      {live && running.length > 0 && (
        <Row title="Searching now">
          <p aria-live="polite" className="text-sm">{running.map((c) => c.name).join(", ")}</p>
        </Row>
      )}

      {failed.length > 0 && (
        <Row title="Couldn't be scraped" warn>
          <ul className="flex flex-col gap-1 text-sm">
            {failed.map((c) => (
              <li key={c.name}><b className="font-medium">{c.name}</b>{c.note && <span className="text-muted-foreground">: {c.note}</span>}</li>
            ))}
          </ul>
        </Row>
      )}

      {found.length > 0 && (
        <Row title="Postings found">
          <ul className="flex flex-wrap gap-1.5">
            {found.map((c) => (
              <li key={c.name} className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs">
                {c.name}
                <span className="tabular-nums text-muted-foreground">{c.found}</span>
              </li>
            ))}
          </ul>
        </Row>
      )}

      {none.length > 0 && (
        <Row title="Nothing found">
          <p className="text-sm text-muted-foreground">
            {plural(none.length, "company", "companies")} had no US internship postings{live ? " so far" : ""}.{" "}
            <button type="button" className="text-primary hover:underline" onClick={() => setShowQuiet((v) => !v)} aria-expanded={showQuiet}>
              {showQuiet ? "Hide" : "Show"} them
            </button>
          </p>
          {showQuiet && <p className="mt-1 text-sm text-muted-foreground duration-200 animate-in fade-in">{none.map((c) => c.name).join(", ")}</p>}
        </Row>
      )}

      <figcaption className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t pt-3 text-xs text-muted-foreground">
        {o && <span>Left out after scraping: {o.skip} not a fit{o.undergrad ? `, ${o.undergrad} undergraduate-only` : ""}{o.not_us ? `, ${o.not_us} outside the US` : ""}</span>}
        {p.checked && <span>Re-check: {p.checked.closed} taken down (filled or removed), {p.checked.unknown} sent to review</span>}
        <button type="button" className="ml-auto underline-offset-2 hover:underline" onClick={() => setList((v) => !v)} aria-expanded={list}>
          {list ? "Hide the table" : `Show every company (${total})`}
        </button>
      </figcaption>

      {list && (
        <div className="max-h-96 overflow-y-auto rounded-md border">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-card">
              <tr className="text-left text-xs text-muted-foreground"><th className="px-3 py-1.5 font-normal">Company</th><th className="font-normal">Group</th><th className="font-normal">State</th><th className="px-3 text-right font-normal">Postings</th></tr>
            </thead>
            <tbody>
              {cos.map((c) => (
                <tr key={c.name} className="border-t">
                  <td className="px-3 py-1">{c.name}</td>
                  <td className="text-muted-foreground">{groupOf(c.name)?.label ?? "Other"}</td>
                  <td>{c.state === "done" ? "Done" : c.state === "failed" ? `Couldn't be scraped${c.note ? ` (${c.note})` : ""}` : c.state === "running" ? "Searching now" : "Waiting"}</td>
                  <td className="px-3 text-right tabular-nums">{c.state === "done" ? c.found ?? 0 : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </figure>
  )
}

function Stat({ value, label, warn = false }: { value: string; label: string; warn?: boolean }) {
  return (
    <div className="flex flex-col">
      <b className={cn("font-display text-2xl font-semibold leading-none tabular-nums", warn && "text-warn")}>{value}</b>
      <span className={cn("mt-1 text-xs", warn ? "text-warn" : "text-muted-foreground")}>{label}</span>
    </div>
  )
}

function Key({ cls, children }: { cls: string; children: React.ReactNode }) {
  return <span className="inline-flex items-center gap-1.5"><span className={cn("size-2 rounded-[2px]", cls)} aria-hidden />{children}</span>
}

function Row({ title, warn = false, children }: { title: string; warn?: boolean; children: React.ReactNode }) {
  return (
    <section className={cn("grid gap-1 sm:grid-cols-[11rem_1fr] sm:gap-4", warn && "rounded-md bg-warn-soft px-3 py-2 sm:-mx-3")}>
      <h3 className={cn("text-xs font-semibold uppercase tracking-[0.06em]", warn ? "text-warn" : "text-muted-foreground")}>{title}</h3>
      <div className="min-w-0">{children}</div>
    </section>
  )
}
