"use client"

import { useLayoutEffect, useRef, useState } from "react"
import { cn } from "@/lib/utils"

/**
 * Segmented control whose selection pill slides between options.
 * Keyboard: arrow keys move the selection, like a radio group.
 */
export function Segmented<T extends string>({
  value,
  onChange,
  items,
  label,
  size = "sm",
  className,
}: {
  value: T
  onChange: (v: T) => void
  items: [T, React.ReactNode][]
  label: string
  size?: "sm" | "md"
  className?: string
}) {
  const wrap = useRef<HTMLDivElement>(null)
  const btns = useRef<Record<string, HTMLButtonElement | null>>({})
  const [pill, setPill] = useState<{ left: number; top: number; width: number; height: number } | null>(null)
  const [ready, setReady] = useState(false)

  useLayoutEffect(() => {
    const measure = () => {
      const b = btns.current[value]
      if (b) setPill({ left: b.offsetLeft, top: b.offsetTop, width: b.offsetWidth, height: b.offsetHeight })
    }
    measure()
    const ro = new ResizeObserver(measure)
    if (wrap.current) ro.observe(wrap.current)
    Object.values(btns.current).forEach((b) => b && ro.observe(b))
    // enable the slide only after the first placement, so the pill doesn't fly in on load
    const t = requestAnimationFrame(() => setReady(true))
    return () => {
      ro.disconnect()
      cancelAnimationFrame(t)
    }
  }, [value, items.length])

  const onKey = (e: React.KeyboardEvent) => {
    const i = items.findIndex(([v]) => v === value)
    let n = -1
    if (e.key === "ArrowRight" || e.key === "ArrowDown") n = (i + 1) % items.length
    if (e.key === "ArrowLeft" || e.key === "ArrowUp") n = (i - 1 + items.length) % items.length
    if (n < 0) return
    e.preventDefault()
    onChange(items[n][0])
    btns.current[items[n][0]]?.focus()
  }

  return (
    <div ref={wrap} role="radiogroup" aria-label={label} onKeyDown={onKey} className={cn("relative inline-flex max-w-full flex-wrap rounded-lg bg-muted p-0.5", className)}>
      {pill && (
        <span
          aria-hidden
          className={cn("absolute rounded-md bg-card shadow-sm", ready && "transition-[left,top,width] duration-300 ease-[cubic-bezier(.3,.7,.2,1)]")}
          style={{ left: pill.left, top: pill.top, width: pill.width, height: pill.height }}
        />
      )}
      {items.map(([v, l]) => {
        const on = v === value
        return (
          <button
            key={v}
            ref={(el) => { btns.current[v] = el }}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(v)}
            className={cn(
              "relative z-[1] inline-flex items-center gap-2 whitespace-nowrap rounded-md font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              size === "sm" ? "h-7 px-2.5 text-xs" : "h-9 px-4 text-sm",
              on ? "text-foreground" : "text-muted-foreground hover:text-foreground"
            )}
          >
            {l}
          </button>
        )
      })}
    </div>
  )
}
