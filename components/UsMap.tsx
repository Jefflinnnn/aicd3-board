"use client"

import { useEffect, useMemo, useRef } from "react"
import { Minus, Plus, RotateCcw } from "lucide-react"
import { geoAlbersUsa } from "d3-geo"
import { feature } from "topojson-client"
import type { FeatureCollection } from "geojson"
import type { GeometryCollection, Topology } from "topojson-specification"
import statesTopo from "us-atlas/states-10m.json"
import { Button } from "@/components/ui/button"
import { EChart, chartBase, cssColor, echarts } from "@/components/EChart"
import { cityCoord, coById, jobLocations, type Job } from "@/lib/data"

/* ---------- one-time map setup ---------- */
const STATES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut", DE: "Delaware",
  DC: "District of Columbia", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa",
  KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota",
  MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey",
  NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon",
  PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah",
  VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming", PR: "Puerto Rico",
}
const stateOf = (loc: string) => STATES[loc.split(",").pop()?.trim() || ""]

// Albers USA keeps the lower 48 in proportion and tucks Alaska and Hawaii in as insets.
// The shapes and city points are projected once up front, so the chart only ever applies a plain
// pan and zoom; that keeps the dots locked to their states while you move around.
const albers = geoAlbersUsa().scale(1000).translate([480, 300])
const toPlane = (lonLat: [number, number]): [number, number] | null => {
  const p = albers(lonLat)
  return p ? [p[0], -p[1]] : null // the chart flips y back, so store it negated
}
type Ring = [number, number][]
const projectRing = (ring: Ring) => ring.map(toPlane).filter((p): p is [number, number] => !!p)

let registered = false
function ensureMap() {
  if (registered) return
  const topo = statesTopo as unknown as Topology<{ states: GeometryCollection<{ name: string }> }>
  const geo = feature(topo, topo.objects.states) as unknown as FeatureCollection
  geo.features.forEach((f) => {
    const g = f.geometry as { type: string; coordinates: unknown }
    if (g.type === "Polygon") g.coordinates = (g.coordinates as Ring[]).map(projectRing).filter((r) => r.length > 3)
    else if (g.type === "MultiPolygon")
      g.coordinates = (g.coordinates as Ring[][]).map((poly) => poly.map(projectRing).filter((r) => r.length > 3)).filter((poly) => poly.length)
  })
  echarts.registerMap("USA", geo as never)
  registered = true
}

export function UsMap({ jobs, onCity, onState }: { jobs: Job[]; onCity: (city: string) => void; onState: (cities: string[]) => void }) {
  ensureMap()
  const inst = useRef<echarts.ECharts | null>(null)
  const box = useRef<HTMLDivElement>(null)
  const zoomRef = useRef(1)
  const homeCenter = useRef<number[] | null>(null)
  const labelsOn = useRef(false) // city names appear once zoomed in

  const { byCity, byState, remote } = useMemo(() => {
    const byCity: Record<string, Job[]> = {}
    let remote = 0
    jobs.forEach((j) => {
      const locs = jobLocations(j)
      if (locs.every((l) => /remote/i.test(l))) remote++
      locs.forEach((l) => {
        if (/remote/i.test(l) || !cityCoord(l)) return
        ;(byCity[l] = byCity[l] || []).push(j)
      })
    })
    const byState: Record<string, { n: number; cities: string[] }> = {}
    Object.entries(byCity).forEach(([city, list]) => {
      const st = stateOf(city)
      if (!st) return
      const s = (byState[st] = byState[st] || { n: 0, cities: [] })
      s.n += list.length
      s.cities.push(city)
    })
    return { byCity, byState, remote }
  }, [jobs])

  const option = useMemo(() => {
    const { base, fg, card, muted } = chartBase()
    const maxState = Math.max(1, ...Object.values(byState).map((s) => s.n))
    const maxCity = Math.max(1, ...Object.values(byCity).map((l) => l.length))
    return {
      ...base,
      legend: { show: false },
      tooltip: {
        ...base.tooltip,
        trigger: "item",
        formatter: (p: { seriesType: string; name: string; value: number | number[] }) => {
          if (p.seriesType === "scatter") {
            const list = byCity[p.name] || []
            const titles = [...new Set(list.map((j) => `${j.title}, ${coById(j.company).name}`))]
            return `<b>${p.name}</b><br/>${list.length} posting${list.length === 1 ? "" : "s"}<br/>` +
              titles.slice(0, 4).map((t) => `<span style="opacity:.8">${t}</span>`).join("<br/>") +
              (titles.length > 4 ? `<br/><span style="opacity:.8">+${titles.length - 4} more</span>` : "") +
              `<br/><span style="opacity:.65">Click to see them on the job board</span>`
          }
          const s = byState[p.name]
          return s ? `<b>${p.name}</b><br/>${s.n} posting${s.n === 1 ? "" : "s"} in ${s.cities.length} cit${s.cities.length === 1 ? "y" : "ies"}` : `<b>${p.name}</b><br/>No postings`
        },
      },
      visualMap: {
        type: "continuous",
        seriesIndex: 0,
        min: 0,
        max: maxState,
        left: 8,
        bottom: 8,
        itemHeight: 90,
        itemWidth: 10,
        text: ["More", "Fewer"],
        textStyle: { color: muted, fontSize: 11 },
        calculable: false,
        inRange: { color: ["--seq-0", "--seq-1", "--seq-2", "--seq-3"].map(cssColor) },
      },
      geo: {
        map: "USA",
        aspectScale: 1,
        // panning stays built in; zoom runs through our own gentler wheel handler below
        roam: "move",
        scaleLimit: { min: 1, max: 12 },
        layoutCenter: ["50%", "52%"],
        layoutSize: "100%",
        itemStyle: { areaColor: cssColor("--seq-0"), borderColor: card, borderWidth: 0.8 },
        emphasis: { label: { show: false }, itemStyle: { areaColor: cssColor("--seq-1"), borderColor: fg, borderWidth: 1 } },
        select: { disabled: true },
        label: { show: false },
      },
      series: [
        {
          id: "states",
          type: "map",
          geoIndex: 0,
          data: Object.entries(byState).map(([name, s]) => ({ name, value: s.n })),
        },
        {
          id: "cities",
          type: "scatter",
          coordinateSystem: "geo",
          symbolSize: (v: number[]) => 7 + 15 * Math.sqrt(v[2] / maxCity),
          itemStyle: { color: cssColor("--map-dot"), borderColor: card, borderWidth: 1.5, opacity: 0.95 },
          emphasis: { scale: 1.3, itemStyle: { borderColor: fg } },
          labelLayout: { hideOverlap: true },
          label: { show: false, formatter: (p: { name: string }) => p.name.split(",")[0], position: "right", color: fg, fontSize: 11 },
          data: Object.entries(byCity).map(([name, list]) => {
            const c = cityCoord(name) as [number, number]
            const p = toPlane([c[1], c[0]]) || [0, 0]
            return { name, value: [p[0], p[1], list.length] }
          }),
        },
      ],
    }
  }, [byCity, byState])
  // new data arrives with labels off; put them back if the map is zoomed in
  useEffect(() => {
    if (labelsOn.current) inst.current?.setOption({ series: [{ id: "cities", label: { show: true } }] })
  }, [option])

  /* Zooming eases toward a target zoom a little each frame, so wheel notches, the buttons and reset
     all glide instead of jumping. Zoom and center are set as options (not a roam action) so the states
     and the dots are always redrawn together. */
  const getCenter = (c: echarts.ECharts) =>
    ((c as unknown as { getModel: () => unknown }).getModel() as { getComponent: (t: string, i: number) => { coordinateSystem: { getCenter: () => number[] } } })
      .getComponent("geo", 0).coordinateSystem.getCenter()
  const anim = useRef({ target: 1, anchor: null as [number, number] | null, home: false, raf: 0 })
  const EASE = 0.25
  const frame = () => {
    const a = anim.current
    a.raf = 0
    const c = inst.current
    if (!c) return
    const cur = zoomRef.current
    const center = getCenter(c)
    const home = homeCenter.current
    const zoomDone = Math.abs(Math.log(a.target / cur)) < 0.004
    const next = zoomDone ? a.target : cur * Math.pow(a.target / cur, EASE)
    let nextCenter: number[]
    let done = zoomDone
    if (a.home && home) {
      // heading back to the whole country: glide the center home as well
      const off = Math.hypot(center[0] - home[0], center[1] - home[1])
      const t = zoomDone && off < 0.5 ? 1 : EASE
      nextCenter = [center[0] + (home[0] - center[0]) * t, center[1] + (home[1] - center[1]) * t]
      done = zoomDone && t === 1
    } else {
      // keep the point under the pointer fixed while the zoom changes
      const px = a.anchor ?? [c.getWidth() / 2, c.getHeight() / 2]
      const p = c.convertFromPixel({ geoIndex: 0 }, px) as number[]
      const k = cur / next
      nextCenter = [p[0] + (center[0] - p[0]) * k, p[1] + (center[1] - p[1]) * k]
    }
    zoomRef.current = next
    const want = next >= 2.5
    const labels = want !== labelsOn.current
    labelsOn.current = want
    c.setOption({
      geo: { zoom: next, center: nextCenter },
      ...(labels ? { series: [{ id: "cities", label: { show: want } }] } : {}),
    })
    if (done) a.home = false
    else a.raf = requestAnimationFrame(frame)
  }
  const zoomTo = (target: number, anchor: [number, number] | null) => {
    const a = anim.current
    a.target = Math.min(12, Math.max(1, target))
    a.anchor = anchor
    // fully zoomed out always settles back on the whole country, centered
    a.home = a.target <= 1
    if (!a.raf) a.raf = requestAnimationFrame(frame)
  }
  const zoomBy = (factor: number) => zoomTo(anim.current.target * factor, null)
  useEffect(() => {
    const el = box.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const r = el.getBoundingClientRect()
      // trackpad pinches arrive as ctrl+wheel with small deltas; mouse wheels send large ones
      const unit = e.deltaMode === 1 ? 16 : 1
      const d = Math.max(-120, Math.min(120, e.deltaY * unit * (e.ctrlKey ? 4 : 1)))
      zoomTo(anim.current.target * Math.exp(-d * 0.002), [e.clientX - r.left, e.clientY - r.top])
    }
    el.addEventListener("wheel", onWheel, { passive: false, capture: true })
    return () => {
      el.removeEventListener("wheel", onWheel, { capture: true })
      cancelAnimationFrame(anim.current.raf)
      anim.current.raf = 0
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const reset = () => zoomTo(1, null)

  return (
    <div className="relative" ref={box}>
      <EChart
        option={option}
        merge
        height={520}
        label={`Map of postings by state and city. ${Object.keys(byCity).length} cities in ${Object.keys(byState).length} states.`}
        onReady={(c) => {
          inst.current = c
          // remember where the whole-country view sits so zooming out can glide back to it
          requestAnimationFrame(() => { if (!homeCenter.current && zoomRef.current === 1) homeCenter.current = getCenter(c) })
        }}
        onClick={(p) => {
          if ((p as unknown as { seriesType: string }).seriesType === "scatter") onCity(p.name)
          else if (byState[p.name]) onState(byState[p.name].cities)
        }}
      />
      <div className="absolute right-2 top-2 flex flex-col overflow-hidden rounded-lg border bg-card shadow-sm">
        <Button variant="ghost" size="icon" className="size-8 rounded-none" onClick={() => zoomBy(1.5)} aria-label="Zoom in"><Plus className="size-4" /></Button>
        <Button variant="ghost" size="icon" className="size-8 rounded-none border-t" onClick={() => zoomBy(1 / 1.5)} aria-label="Zoom out"><Minus className="size-4" /></Button>
        <Button variant="ghost" size="icon" className="size-8 rounded-none border-t" onClick={reset} aria-label="Reset map"><RotateCcw className="size-3.5" /></Button>
      </div>
      {remote > 0 && <p className="absolute bottom-2 right-2 rounded-md bg-card/90 px-2 py-1 text-xs text-muted-foreground">{remote} remote-only role{remote === 1 ? "" : "s"} not on the map</p>}
    </div>
  )
}

