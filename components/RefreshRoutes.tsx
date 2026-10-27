"use client"

import { useEffect, useRef, useState } from "react"
import { AICD_LOGO_INNER } from "@/components/aicdLogo"
import type { RefreshRun, RunProgress } from "@/lib/types"

/**
 * A live picture of a job data refresh, after Biorouter's landing-page "hub" art
 * (github.com/BaranziniLab/biorouter, landing/art/hub.js and hub.css, Apache-2.0), which shows a chat turn being
 * routed to a local, institutional or public model. Same tree and the same motion, carried over to a refresh:
 *
 *   run card  ->  scraper hub  ->  company groups (big pharma / biotech / AI & tech)  ->  one row per company
 *
 * Every connector rests as a thin hairline. When a company starts being searched, a short pulse travels the one
 * path from the run card through the hub and down its group to its row (a dash window slid along the path's
 * length: mostly even speed, softened at both ends); the route it took then stays lit, and the row gets a tint and
 * a bar that grows in from its left edge, for as long as the search goes. Several can be lit at once: the scraper
 * searches up to five sites side by side. A finished company goes quiet with a check and its number of postings;
 * one that couldn't be scraped shows "!" and why. While postings are classified, imported and re-checked, pulses
 * run back from the hub to the run card, whose current stage is marked the same way. With reduced motion the
 * routes and marks still show, without pulses.
 */

type Co = RunProgress["companies"][number]

const GROUPS: { id: string; label: string; dot: string; names: string[] }[] = [
  { id: "pharma", label: "Big pharma", dot: "var(--c1)", names: ["Pfizer", "Merck", "AbbVie", "AstraZeneca", "Bristol Myers Squibb", "Sanofi", "GSK", "Boehringer Ingelheim", "Novartis", "Takeda", "Eli Lilly", "Johnson & Johnson", "Novo Nordisk", "Bayer", "Astellas", "Daiichi Sankyo", "Merck KGaA", "Otsuka", "Eisai", "UCB", "CSL", "Viatris"] },
  { id: "biotech", label: "Biotech", dot: "var(--c2)", names: ["Amgen", "Gilead Sciences", "Genentech", "Regeneron", "Vertex Pharmaceuticals", "Biogen", "Revolution Medicines", "Moderna", "Denali Therapeutics", "Cytokinetics", "Nurix Therapeutics", "Septerna", "Maze Therapeutics", "Arsenal Bioscience", "BridgeBio"] },
  { id: "ai", label: "AI & tech", dot: "var(--c3)", names: ["Recursion", "Generate:Biomedicines", "insitro", "Genesis Molecular AI", "Chai Discovery", "Profluent", "Noetik", "Tahoe Therapeutics", "Atomic AI", "Chan Zuckerberg Biohub", "Calico Life Sciences", "Altos Labs", "10x Genomics", "GRAIL", "Freenome", "NVIDIA"] },
]

const W = 860
const RH = 24            // row height
const HEAD = 22          // group label above its rows
const GGAP = 18          // between groups
const DOT_X = 560        // group dots and spines
const ROW_X = DOT_X + 12 // row text
const ROW_W = 270
const CARD_X = 4, CARD_W = 262
const HUB = 56, HUB_X = 352

const INK = "hsl(var(--foreground))"
const MUTED = "hsl(var(--muted-foreground))"
const LINE = "hsl(var(--border))"
const LIT = "hsl(var(--primary))"
const TINT = "hsl(var(--accent))"
const GOOD = "hsl(var(--good))"
const WARN = "hsl(var(--warn))"

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

const f = (n: number) => Math.round(n * 10) / 10
const curve = (x1: number, y1: number, x2: number, y2: number) => {
  const mx = (x1 + x2) / 2
  return `M${f(x1)},${f(y1)} C${f(mx)},${f(y1)} ${f(mx)},${f(y2)} ${f(x2)},${f(y2)}`
}
const easeInOut = (p: number) => 0.5 - 0.5 * Math.cos(Math.PI * p)
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v))

/** The geometry: groups stacked down the right, the hub and the run card centred on them. */
function layout(cos: Co[]) {
  const known = new Set(GROUPS.flatMap((g) => g.names))
  const extra = cos.filter((c) => !known.has(c.name)).map((c) => c.name)
  const groups = GROUPS.map((g, i) => ({ ...g, names: [...g.names.filter((n) => cos.some((c) => c.name === n)), ...(i === GROUPS.length - 1 ? extra : [])] }))
    .filter((g) => g.names.length)
  let y = 18
  const rowY: Record<string, number> = {}
  const placed = groups.map((g) => {
    const dotY = y + 6
    g.names.forEach((n, i) => { rowY[n] = dotY + HEAD + i * RH })
    const last = dotY + HEAD + (g.names.length - 1) * RH
    y = last + RH / 2 + GGAP
    return { ...g, dotY, last }
  })
  const H = Math.max(y, 300)
  const hubY = H / 2
  return { groups: placed, rowY, H, hubY }
}

/** stages: list the run's four stages on its card (off where the Admin page shows them as step cards above) */
export function RefreshRoutes({ run, stages: showStages = true }: { run: RefreshRun; stages?: boolean }) {
  const [list, setList] = useState(false)
  const p = progressFor(run)
  const live = run.status === "running"
  const cos = p?.companies ?? []
  const geo = layout(cos)
  const hubL = HUB_X, hubR = HUB_X + HUB, cardR = CARD_X + CARD_W
  const groupOf = (name: string) => geo.groups.find((g) => g.names.includes(name))
  // the one path a search takes: run card -> hub -> its group -> its row (the stretch behind the hub is covered)
  const route = (name: string) => {
    const g = groupOf(name)
    if (!g) return ""
    return `M${cardR},${f(geo.hubY)} H${hubR}` + curve(hubR, geo.hubY, DOT_X, g.dotY).replace(/^M[^C]+/, "") + ` V${f(geo.rowY[name])}`
  }
  const back = `M${hubL},${f(geo.hubY)} H${cardR}`

  /* ---------- pulses (imperative, like hub.js: one path per pulse, removed when it arrives) ---------- */
  const pulses = useRef<SVGGElement>(null)
  const prev = useRef<Record<string, string> | null>(null)
  // plain strings, so the effect below runs when a company's state changes, not on every poll
  const statesKey = JSON.stringify(Object.fromEntries(cos.map((c) => [c.name, c.state])))
  const routesKey = JSON.stringify(Object.fromEntries(cos.map((c) => [c.name, route(c.name)])))
  useEffect(() => {
    const states = JSON.parse(statesKey) as Record<string, string>
    const routes = JSON.parse(routesKey) as Record<string, string>
    const before = prev.current
    prev.current = states
    if (!before || !live || !pulses.current) return   // first sight of a run: a still frame, no replay
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return
    const started = Object.keys(states).filter((n) => states[n] === "running" && before[n] !== "running")
    const timers = started.map((name, i) => window.setTimeout(() => pulse(pulses.current, routes[name]), i * 180))
    return () => timers.forEach(clearTimeout)
  }, [statesKey, routesKey, live])
  const replying = live && !!p && p.step !== "scrape"
  useEffect(() => {
    if (!replying || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return
    const id = window.setInterval(() => pulse(pulses.current, back), 1600)
    pulse(pulses.current, back)
    return () => window.clearInterval(id)
  }, [replying, back])

  if (!p || !cos.length) return null

  const doneN = cos.filter((c) => c.state === "done" || c.state === "failed").length
  const found = cos.reduce((a, c) => a + (c.state === "done" ? c.found ?? 0 : 0), 0)
  const running = cos.filter((c) => c.state === "running").map((c) => c.name)
  const o = p.outcome
  const clf = p.classifier === "d3" ? "d3" : p.classifier === "llm" ? "Claude" : p.classifier ? "keyword rules" : "the classifier"
  const order = ["scrape", "classify", "import", "check", "done"] as const
  const at = order.indexOf(p.step)
  const stages = [
    { id: "scrape", label: `Search ${cos.length} company sites`, note: `${doneN} of ${cos.length} searched · ${found} posting${found === 1 ? "" : "s"} found` },
    { id: "classify", label: `Classify with ${clf}`, note: p.classify.total ? `${p.classify.done} of ${p.classify.total} new postings` : at > 1 ? "nothing new to classify" : "" },
    { id: "import", label: p.dryRun ? "Compare with the job board" : "Update the job board", note: o ? `${o.publish} published · ${o.review} to review` : "" },
    { id: "check", label: "Re-check open postings", note: p.checked ? `${p.checked.closed} taken down (filled or removed)` : "" },
  ].filter((s) => showStages || s.id === "scrape").map((s, i) => ({ ...s, state: (at > i || (!live && run.status === "succeeded") ? "done" : at === i && live ? "now" : "next") as "done" | "now" | "next" }))
  const SH = 40   // a stage: its label, and its count under it
  const CARD_H = 44 + stages.length * SH + 8
  const cardY = geo.hubY - CARD_H / 2
  const stepText = !live ? null
    : p.step === "scrape" ? `Searching ${running.length ? running.join(", ") : "company sites"} (${doneN} of ${cos.length} done)`
    : p.step === "classify" ? `Classifying postings with ${clf}${p.classify.total ? `: ${p.classify.done} of ${p.classify.total}` : ""}`
    : p.step === "import" ? (p.dryRun ? "Comparing with the job board (dry run, nothing saved)" : "Updating the job board")
    : p.step === "check" ? "Re-checking open postings on their own pages (closing filled ones)"
    : "Finishing"
  const label = `Refresh ${live ? "in progress" : "result"}: ${doneN} of ${cos.length} companies searched, ${found} postings found${o ? `, ${o.publish} published, ${o.review} to review` : ""}.`

  return (
    <figure className="mt-3">
      <style>{`
        .rr-lit { transition: opacity .35s ease; }
        .rr-bar { transform-box: fill-box; transform-origin: center; transform: scaleY(0); transition: transform .35s ease; }
        .rr-bar.on { transform: scaleY(1); }
        .rr-tint { transition: opacity .25s ease; }
      `}</style>
      {stepText && <p aria-live="polite" className="mb-1 text-sm"><span className="font-medium">Now:</span> {stepText}</p>}
      <svg viewBox={`0 0 ${W} ${geo.H}`} className="h-auto w-full" role="img" aria-label={label}>
        {/* hairlines: card -> hub, hub -> each group, each group's spine */}
        <g fill="none" stroke={LINE} strokeWidth={1}>
          <path d={`M${cardR},${f(geo.hubY)} H${hubL}`} />
          {geo.groups.map((g) => <path key={g.id} d={curve(hubR, geo.hubY, DOT_X, g.dotY)} />)}
          {geo.groups.map((g) => <path key={g.id + "s"} d={`M${DOT_X},${g.dotY} V${f(g.last + 8)}`} />)}
        </g>
        {/* lit routes: every company being searched right now */}
        <g fill="none" stroke={LIT} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
          {cos.map((c) => <path key={c.name} d={route(c.name)} className="rr-lit" opacity={live && c.state === "running" ? 1 : 0} />)}
          {replying && <path d={back} />}
        </g>
        <g ref={pulses} fill="none" stroke={LIT} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" />

        {/* the run card, its stages marked like rows */}
        <g>
          <rect x={CARD_X} y={cardY} width={CARD_W} height={CARD_H} rx={12} fill="hsl(var(--card))" stroke={live ? LIT : LINE} strokeOpacity={live ? 0.6 : 1} />
          <text x={CARD_X + 14} y={cardY + 24} fontSize="13" fontWeight={600} fill={INK}>
            {run.trigger === "schedule" ? "Scheduled refresh" : "Refresh"}{p.dryRun && <tspan fontWeight={400} fill={MUTED}> · dry run</tspan>}
          </text>
          {stages.map((s, i) => {
            const y = cardY + 40 + i * SH
            return (
              <g key={s.id}>
                <rect x={CARD_X + 8} y={y} width={CARD_W - 16} height={SH - 4} rx={6} fill={TINT} className="rr-tint" opacity={s.state === "now" ? 1 : 0} />
                <rect x={CARD_X + 8} y={y + 8} width={2} height={SH - 20} rx={1} fill={LIT} className={`rr-bar ${s.state === "now" ? "on" : ""}`} />
                <text x={CARD_X + 18} y={y + 15} fontSize="12.5" fill={s.state === "next" ? MUTED : INK}>
                  <tspan fill={s.state === "done" ? GOOD : s.state === "now" ? LIT : MUTED}>{s.state === "done" ? "✓" : s.state === "now" ? "●" : "○"}</tspan> {s.label}
                </text>
                {s.note && <text x={CARD_X + 32} y={y + 30} fontSize="11" fill={MUTED}>{s.note}</text>}
              </g>
            )
          })}
        </g>

        {/* the hub: the scraper, with the program's mark */}
        <g>
          <rect x={hubL} y={geo.hubY - HUB / 2} width={HUB} height={HUB} rx={12} fill="hsl(var(--muted))" />
          <svg x={hubL + 9} y={geo.hubY - HUB / 2 + 9} width={HUB - 18} height={HUB - 18} viewBox="52 50 400 400" aria-hidden dangerouslySetInnerHTML={{ __html: AICD_LOGO_INNER }} />
          <text x={hubL + HUB / 2} y={geo.hubY + HUB / 2 + 16} fontSize="11" fill={MUTED} textAnchor="middle">Scraper</text>
        </g>

        {/* groups and their companies */}
        {geo.groups.map((g) => (
          <g key={g.id}>
            <circle cx={DOT_X} cy={g.dotY} r={3} fill={g.dot} />
            <text x={ROW_X} y={g.dotY + 4} fontSize="12" fill={MUTED}>{g.label}</text>
            {g.names.map((name) => {
              const c = cos.find((x) => x.name === name)!
              const y = geo.rowY[name]
              const on = live && c.state === "running"
              const note = c.state === "done" ? `${c.found ?? 0} posting${c.found === 1 ? "" : "s"}` : c.state === "failed" ? "couldn't be scraped" : on ? "searching…" : ""
              return (
                <g key={name}>
                  <title>{`${name}: ${c.state === "done" ? `done, ${c.found ?? 0} US internship postings` : c.state === "failed" ? `couldn't be scraped${c.note ? ` (${c.note})` : ""}` : on ? "being searched now" : "waiting"}`}</title>
                  <rect x={DOT_X - 1} y={y - RH / 2 + 1} width={ROW_W} height={RH - 2} rx={6} fill={TINT} className="rr-tint" opacity={on ? 1 : 0} />
                  <rect x={DOT_X - 1} y={y - 8} width={2} height={16} rx={1} fill={LIT} className={`rr-bar ${on ? "on" : ""}`} />
                  <text x={ROW_X} y={y + 4} fontSize="13" fill={c.state === "waiting" ? MUTED : INK}>
                    {name}
                    {c.state === "done" && <tspan fill={GOOD} dx={6}>✓</tspan>}
                    {c.state === "failed" && <tspan fill={WARN} dx={6}>!</tspan>}
                    {note && <tspan fill={MUTED} fontSize="12" dx={c.state === "done" || c.state === "failed" ? 4 : 8}>{note}</tspan>}
                  </text>
                </g>
              )
            })}
          </g>
        ))}
      </svg>

      <figcaption className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5"><span className="inline-block h-0.5 w-4 rounded" style={{ background: LIT }} aria-hidden />Lit route: being searched now</span>
        <span><span style={{ color: GOOD }}>✓</span> done, with postings found</span>
        <span><span style={{ color: WARN }}>!</span> couldn&apos;t be scraped</span>
        {o && <span>Left out: {o.skip} not a fit{o.undergrad ? `, ${o.undergrad} undergraduate-only` : ""}{o.not_us ? `, ${o.not_us} outside the US` : ""}</span>}
        {p.checked && <span>Re-check: {p.checked.closed} taken down (filled or removed), {p.checked.unknown} sent to review</span>}
        <button type="button" className="ml-auto underline-offset-2 hover:underline" onClick={() => setList((v) => !v)} aria-expanded={list}>
          {list ? "Hide list" : "Show as a list"}
        </button>
      </figcaption>
      {list && (
        <table className="mt-2 w-full text-sm">
          <thead><tr className="text-left text-xs text-muted-foreground"><th className="py-1 font-normal">Company</th><th className="font-normal">State</th><th className="text-right font-normal">Postings</th></tr></thead>
          <tbody>
            {cos.map((c) => (
              <tr key={c.name} className="border-t">
                <td className="py-1">{c.name}</td>
                <td>{c.state === "done" ? "✓ done" : c.state === "failed" ? `! couldn't be scraped${c.note ? ` (${c.note})` : ""}` : c.state === "running" ? "● searching now" : "○ waiting"}</td>
                <td className="text-right tabular-nums">{c.state === "done" ? c.found ?? 0 : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </figure>
  )
}

/**
 * One pulse along a path, as in Biorouter's hub.js runPulse: a short dash window slid along the path's length,
 * mostly even speed with soft ends, then removed.
 */
function pulse(layer: SVGGElement | null, d: string) {
  if (!layer || !d) return
  const el = document.createElementNS("http://www.w3.org/2000/svg", "path")
  el.setAttribute("d", d)
  layer.appendChild(el)
  const total = el.getTotalLength()
  const seg = Math.min(40, total * 0.2)
  const dur = clamp(total * 2, 1000, 1200)
  const t0 = performance.now()
  const step = (now: number) => {
    const t = Math.min(1, (now - t0) / dur)
    const q = 0.45 * t + 0.55 * easeInOut(t)
    const s = q * (total + seg)
    const a = clamp(s - seg, 0, total), b = clamp(s, 0, total)
    el.style.opacity = b - a < 0.5 ? "0" : "1"
    el.style.strokeDasharray = `${b - a} ${total * 2 + 10}`
    el.style.strokeDashoffset = String(-a)
    if (t < 1) requestAnimationFrame(step)
    else el.remove()
  }
  el.style.opacity = "0"
  requestAnimationFrame(step)
}
