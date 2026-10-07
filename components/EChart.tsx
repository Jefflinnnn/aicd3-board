"use client"

import { useEffect, useRef } from "react"
import * as echarts from "echarts/core"
import { BarChart, LineChart, HeatmapChart, PieChart, MapChart, ScatterChart, EffectScatterChart } from "echarts/charts"
import {
  GridComponent,
  TooltipComponent,
  LegendComponent,
  VisualMapComponent,
  CalendarComponent,
  GeoComponent,
} from "echarts/components"
import { CanvasRenderer } from "echarts/renderers"
import type { EChartsCoreOption } from "echarts/core"

echarts.use([BarChart, LineChart, HeatmapChart, PieChart, MapChart, ScatterChart, EffectScatterChart, GridComponent, TooltipComponent, LegendComponent, VisualMapComponent, CalendarComponent, GeoComponent, CanvasRenderer])
export { echarts }

/** Reads a CSS custom property from :root. Accepts either a plain color or an "H S% L%" shadcn triplet. */
export function cssColor(name: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  if (!v) return "#888"
  if (/^\d/.test(v)) return `hsl(${v.replace(/\s+/g, ", ")})`
  return v
}

/** Shared chrome so every chart reads as one system. */
export function chartBase() {
  const muted = cssColor("--muted-foreground")
  const grid = cssColor("--chart-grid")
  const fg = cssColor("--foreground")
  const card = cssColor("--card")
  return {
    muted,
    grid,
    fg,
    card,
    base: {
      backgroundColor: "transparent",
      textStyle: { fontFamily: getComputedStyle(document.body).fontFamily || "system-ui, sans-serif", color: muted },
      tooltip: {
        backgroundColor: fg,
        borderWidth: 0,
        textStyle: { color: card, fontSize: 12 },
        extraCssText: "border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.18);",
      },
      legend: { bottom: 0, icon: "roundRect", itemWidth: 10, itemHeight: 10, textStyle: { color: muted, fontSize: 12 } },
      animationDuration: 500,
      // when data changes, bars grow or shrink from their current length instead of redrawing
      animationDurationUpdate: 550,
      animationEasingUpdate: "cubicOut" as const,
    },
    valueAxis: {
      type: "value" as const,
      minInterval: 1,
      axisLine: { show: false },
      axisTick: { show: false },
      splitLine: { lineStyle: { color: grid } },
      axisLabel: { color: muted, fontSize: 11 },
    },
    catAxis: {
      type: "category" as const,
      axisLine: { lineStyle: { color: grid } },
      axisTick: { show: false },
      axisLabel: { color: muted, fontSize: 11 },
    },
  }
}

export interface ChartClick {
  seriesIndex?: number
  dataIndex: number
  value: unknown
  name: string
  componentType: string
}

export function EChart({
  option,
  height = 260,
  label,
  merge = false,
  replay = false,
  onClick,
  onAxisClick,
  onReady,
  className,
}: {
  option: EChartsCoreOption
  height?: number | string
  label: string
  /** Merge updates into the existing chart so marks animate in place instead of redrawing the whole plot. */
  merge?: boolean
  /** Redraw from empty on every change so marks animate in again (used for the bar fill). */
  replay?: boolean
  onClick?: (p: ChartClick) => void
  /** Fires with the category index when anywhere in a category's column (or row) of the plot is clicked. */
  onAxisClick?: (index: number) => void
  /** Hands back the chart instance once it exists (for zoom buttons and similar). */
  onReady?: (c: echarts.ECharts) => void
  className?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const inst = useRef<echarts.ECharts | null>(null)
  const clickRef = useRef(onClick)
  clickRef.current = onClick
  const axisRef = useRef(onAxisClick)
  axisRef.current = onAxisClick

  useEffect(() => {
    if (!ref.current) return
    const c = echarts.init(ref.current, undefined, { renderer: "canvas" })
    inst.current = c
    c.on("click", (p) => clickRef.current?.(p as unknown as ChartClick))
    const zr = c.getZr()
    zr.on("click", (e) => {
      if (!axisRef.current) return
      const pt = [e.offsetX, e.offsetY]
      if (!c.containPixel({ gridIndex: 0 }, pt)) return
      const v = c.convertFromPixel({ gridIndex: 0 }, pt) as number[]
      if (v && Number.isFinite(v[0])) axisRef.current(Math.round(v[0]))
    })
    zr.on("mousemove", (e) => {
      if (!axisRef.current) return
      zr.setCursorStyle(c.containPixel({ gridIndex: 0 }, [e.offsetX, e.offsetY]) ? "pointer" : "default")
    })
    onReady?.(c)
    const ro = new ResizeObserver(() => c.resize())
    ro.observe(ref.current)
    return () => {
      ro.disconnect()
      c.dispose()
      inst.current = null
    }
  }, [])

  useEffect(() => {
    const c = inst.current
    if (!c) return
    if (replay) c.clear() // start from empty so bars run their entry animation again
    c.setOption(option, merge ? { replaceMerge: ["series"] } : { notMerge: true })
  }, [option, merge, replay])

  return <div ref={ref} role="img" aria-label={label} className={className} style={{ height, width: "100%", cursor: onClick ? "pointer" : undefined }} />
}

/**
 * Animation settings that make a stacked bar fill from its baseline outward as one continuous sweep:
 * each segment starts when the one before it finishes, and runs for a share of the time equal to its share of the bar.
 * `stack[k][i]` is the value of series k at category i.
 */
export function fillAnimation(stack: number[][], k: number, total = 650) {
  const totals = stack[0].map((_, i) => stack.reduce((s, row) => s + (row[i] || 0), 0))
  const before = (i: number) => stack.slice(0, k).reduce((s, row) => s + (row[i] || 0), 0)
  return {
    animationEasing: "linear" as const,
    animationDuration: (i: number) => (totals[i] ? ((stack[k][i] || 0) / totals[i]) * total : 0),
    animationDelay: (i: number) => (totals[i] ? (before(i) / totals[i]) * total : 0),
  }
}
