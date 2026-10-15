"use client"

import { useEffect, useRef, useState } from "react"
import type { RouteTo, RoutingTally } from "@/lib/types"

/**
 * Where every scraped posting went, drawn to scale and live while d3 routes them:
 *
 *   scraped ──keyword check──────────────────────────────▶ left out: undergrad-only
 *          └──▶ d3 (answered | waiting) ──▶ published / review queue / not a fit / outside the US
 *
 * Band widths follow the counts. New counts arrive every few seconds; they're eased in over about a second, so the
 * bands grow instead of jumping. While a run goes, the band that just received postings carries a moving stream of
 * dashes (and so does the way into d3 while postings are waiting), so you can see where things are flowing. With
 * reduced motion the bands change in one step and nothing streams.
 */

const W = 760
const TOP = 34
const AVAIL = 190   // the tallest node's height
const NW = 12       // node width
const X_SCRAPED = 4, X_D3 = 250, X_OUT = 520
const GAP = 18

const OUT: { key: RouteTo; label: string; color: string }[] = [
  { key: "publish", label: "Published", color: "hsl(var(--good))" },
  { key: "review", label: "Review queue", color: "hsl(var(--warn))" },
  { key: "skip", label: "Left out: not a fit", color: "hsl(var(--muted-foreground))" },
  { key: "not_us", label: "Left out: outside the US", color: "hsl(var(--muted-foreground))" },
  { key: "undergrad", label: "Left out: undergraduate-only", color: "hsl(var(--muted-foreground))" },
]
const KEYS = ["publish", "review", "skip", "not_us", "undergrad", "pending"] as const
type Counts = Record<(typeof KEYS)[number], number>

const reduced = () => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
const easeOut = (t: number) => 1 - Math.pow(1 - t, 3)

/** Counts eased from where they are to the latest ones (about a second), so the picture moves continuously. */
function useEased(target: Counts, ms = 1100): Counts {
  const [shown, setShown] = useState(target)
  const from = useRef(target)
  const cur = useRef(target)
  const key = KEYS.map((k) => target[k]).join(",")
  useEffect(() => {
    const to = Object.fromEntries(KEYS.map((k) => [k, Number(key.split(",")[KEYS.indexOf(k)])])) as Counts
    // with reduced motion the counts change in one step (on the next frame, like the eased ones)
    const dur = reduced() ? 0 : ms
    from.current = cur.current
    const t0 = performance.now()
    let raf = 0
    const step = (now: number) => {
      const t = dur ? Math.min(1, (now - t0) / dur) : 1
      const e = easeOut(t)
      const v = Object.fromEntries(KEYS.map((k) => [k, from.current[k] + (to[k] - from.current[k]) * e])) as Counts
      cur.current = v
      setShown(v)
      if (t < 1) raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [key, ms])
  return shown
}

/** Which bands received postings in the last few seconds (they carry the moving stream). */
function useRecent(target: Counts, live: boolean, holdMs = 4500): Set<string> {
  const prev = useRef<Counts | null>(null)
  const [hot, setHot] = useState<Record<string, number>>({})
  const key = KEYS.map((k) => target[k]).join(",")
  useEffect(() => {
    const p = prev.current
    const now = Date.now()
    prev.current = Object.fromEntries(KEYS.map((k, i) => [k, Number(key.split(",")[i])])) as Counts
    if (!p || !live) return
    const grew = KEYS.filter((k) => k !== "pending" && prev.current![k] > p[k])
    if (grew.length) setHot((h) => ({ ...h, ...Object.fromEntries(grew.map((k) => [k, now])) }))
  }, [key, live])
  const [, tick] = useState(0)
  useEffect(() => {
    if (!live) return
    const id = window.setInterval(() => tick((n) => n + 1), 1000)
    return () => window.clearInterval(id)
  }, [live])
  // eslint-disable-next-line react-hooks/purity
  const now = Date.now()
  return new Set(live ? Object.entries(hot).filter(([, t]) => now - t < holdMs).map(([k]) => k) : [])
}

const band = (x1: number, y1: number, x2: number, y2: number, h: number) => {
  const m = (x1 + x2) / 2
  return `M${x1},${y1} C${m},${y1} ${m},${y2} ${x2},${y2} L${x2},${y2 + h} C${m},${y2 + h} ${m},${y1 + h} ${x1},${y1 + h} Z`
}
const mid = (x1: number, y1: number, x2: number, y2: number) => {
  const m = (x1 + x2) / 2
  return `M${x1},${y1} C${m},${y1} ${m},${y2} ${x2},${y2}`
}
const fmt = (n: number) => Math.round(n).toLocaleString("en-US")

export function RoutingFlow({ tally, live, classifier }: { tally: RoutingTally; live: boolean; classifier: string }) {
  const target: Counts = { publish: tally.publish, review: tally.review, skip: tally.skip, not_us: tally.not_us, undergrad: tally.undergrad, pending: tally.pending }
  const c = useEased(target)
  const hot = useRecent(target, live)
  const routed = c.publish + c.review + c.skip + c.not_us
  const toD3 = routed + c.pending
  const scraped = toD3 + c.undergrad
  const finalTotal = Object.values(target).reduce((a, b) => a + b, 0)
  const k = AVAIL / Math.max(finalTotal, 1)
  const h = (n: number) => (n > 0.01 ? Math.max(1.5, n * k) : 0)
  const mid0 = TOP + AVAIL / 2

  const sH = h(scraped), sY = mid0 - sH / 2
  const dH = h(toD3), dY = mid0 - dH / 2 - 10
  // outcomes stacked down the right, in a fixed order, the space between them fixed so labels never collide
  const outs: (typeof OUT[number] & { n: number; target: number; y: number; h: number })[] = []
  let y = TOP - 6
  for (const o of OUT) {
    const hh = h(c[o.key])
    outs.push({ ...o, n: c[o.key], target: target[o.key], y, h: hh })
    y += Math.max(hh, 1.5) + GAP
  }
  const H = Math.max(TOP + AVAIL + 28, y + 8)
  const name = classifier === "d3" ? "d3" : classifier === "llm" ? "Claude" : classifier ? "Keyword rules" : "Classifier"

  const flows: (typeof outs[number] & { y1: number })[] = []
  let dOff = 0
  for (const o of outs) {
    if (o.key === "undergrad") continue
    flows.push({ ...o, y1: dY + dOff })
    dOff += o.h
  }
  const ug = outs.find((o) => o.key === "undergrad")!
  const ugY = sY + dH

  const label = `${fmt(scraped)} postings scraped. ${fmt(target.undergrad)} left out as undergraduate-only by the keyword check. ` +
    `${name} has routed ${fmt(target.publish + target.review + target.skip + target.not_us)}${target.pending ? `, ${fmt(target.pending)} waiting` : ""}: ` +
    `${target.publish} published, ${target.review} to review, ${target.skip} not a fit, ${target.not_us} outside the US.`

  return (
    <figure className="flex flex-col gap-2">
      <style>{`
        .rf-stream { stroke-dasharray: 2 9; animation: rf-flow 0.9s linear infinite; }
        @keyframes rf-flow { to { stroke-dashoffset: -11; } }
        .rf-band { transition: opacity .5s ease; }
        @media (prefers-reduced-motion: reduce) { .rf-stream { animation: none; display: none; } }
      `}</style>
      <div className="overflow-x-auto">
        <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full min-w-[560px]" role="img" aria-label={label}>
          <g fontSize="10.5" fill="hsl(var(--muted-foreground))" letterSpacing=".06em">
            <text x={X_SCRAPED} y={12}>SCRAPED</text>
            <text x={X_D3} y={12}>{name.toUpperCase()}</text>
            <text x={X_OUT} y={12}>WHERE IT WENT</text>
          </g>

          {/* scraped */}
          <rect x={X_SCRAPED} y={sY} width={NW} height={Math.max(sH, 1.5)} rx={2} fill="hsl(var(--foreground))" />
          <text x={X_SCRAPED} y={sY - 7} fontSize="12" fill="hsl(var(--foreground))" style={{ fontVariantNumeric: "tabular-nums" }}>{fmt(scraped)}</text>

          {/* scraped -> d3, and scraped -> undergraduate-only (the keyword check, before the model) */}
          {dH > 0 && <path d={band(X_SCRAPED + NW, sY, X_D3, dY, dH)} fill="hsl(var(--foreground))" opacity={0.08} />}
          {live && target.pending > 0 && dH > 3 && (
            <path d={mid(X_SCRAPED + NW, sY + dH / 2, X_D3, dY + dH / 2)} fill="none" stroke="hsl(var(--primary))" strokeWidth={1.5} strokeLinecap="round" className="rf-stream" opacity={0.7} />
          )}
          {ug.h > 0 && <path d={band(X_SCRAPED + NW, ugY, X_OUT, ug.y + 8, ug.h)} fill={ug.color} opacity={0.1} />}
          {ug.h > 0 && <text x={X_SCRAPED + NW + 8} y={Math.min(sY + sH + 16, H - 4)} fontSize="10.5" fill="hsl(var(--muted-foreground))">keyword check</text>}

          {/* d3: answered (solid) over waiting (faint) */}
          {dH > 0 && (
            <g>
              <rect x={X_D3} y={dY} width={NW} height={Math.max(dH, 1.5)} rx={2} fill="hsl(var(--primary))" opacity={0.22} />
              <rect x={X_D3} y={dY} width={NW} height={h(routed)} rx={2} fill="hsl(var(--primary))" />
              <text x={X_D3} y={dY - 7} fontSize="12" fill="hsl(var(--foreground))" style={{ fontVariantNumeric: "tabular-nums" }}>
                {target.pending ? `${fmt(routed)} of ${fmt(toD3)}` : fmt(toD3)}
              </text>
              {target.pending > 0 && (
                <text x={X_D3 + NW + 6} y={dY + dH + 14} fontSize="10.5" fill="hsl(var(--muted-foreground))" style={{ fontVariantNumeric: "tabular-nums" }}>{fmt(c.pending)} waiting</text>
              )}
            </g>
          )}

          {/* d3 -> each outcome */}
          {flows.map((o) => o.h > 0 && (
            <g key={o.key}>
              <path d={band(X_D3 + NW, o.y1, X_OUT, o.y + 8, o.h)} fill={o.color} className="rf-band" opacity={hot.has(o.key) ? 0.42 : 0.2} />
              {hot.has(o.key) && (
                <path d={mid(X_D3 + NW, o.y1 + o.h / 2, X_OUT, o.y + 8 + o.h / 2)} fill="none" stroke={o.color} strokeWidth={Math.min(2, Math.max(1, o.h / 3))} strokeLinecap="round" className="rf-stream" />
              )}
            </g>
          ))}

          {/* outcomes */}
          {outs.map((o) => (
            <g key={o.key}>
              <rect x={X_OUT} y={o.y + 8} width={NW} height={Math.max(o.h, 1.5)} rx={2} fill={o.color} opacity={o.target ? 1 : 0.3} />
              <text x={X_OUT + NW + 8} y={o.y + 18} fontSize="12" fill="hsl(var(--foreground))">
                {o.label} <tspan fontWeight={600} style={{ fontVariantNumeric: "tabular-nums" }}>{fmt(o.n)}</tspan>
              </text>
            </g>
          ))}
        </svg>
      </div>
      {live && tally.last && (
        <figcaption aria-live="polite" className="truncate text-xs text-muted-foreground">
          <span className="font-medium text-foreground">Just routed:</span> {tally.last.title} ({tally.last.company}) →{" "}
          <span className={tally.last.to === "publish" ? "text-good" : tally.last.to === "review" ? "text-warn" : ""}>{OUT.find((o) => o.key === tally.last!.to)?.label}</span>
        </figcaption>
      )}
    </figure>
  )
}
