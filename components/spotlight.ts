/**
 * Cards marked .spotlight glow near the pointer (Linear and Vercel do this). The glow is one shape
 * centred on the pointer, drawn by every card it reaches, so it carries across neighbouring cards
 * instead of being cut off at the edge of the card under the pointer.
 *
 * Its head sits on the pointer; a tail point lags behind it, so a quick move leaves a fading trail
 * that catches up and disappears when the pointer slows. Each card gets the head and tail in its own
 * coordinates (--mx/--my, --tx/--ty) and a data-glow attribute while in reach; app/globals.css draws it.
 */
const REACH = 150 // px from the pointer (or its tail) within which a card draws its part of the glow
const TAIL_MS = 110 // the tail closes about 63% of the gap to the pointer every TAIL_MS

let px = 0, py = 0 // pointer, viewport coordinates
let tx = 0, ty = 0 // tail
let on = false
let raf = 0
let last = 0
let root: HTMLElement | null = null
const lit = new Set<HTMLElement>()

const reduced = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches

function paint() {
  const now = new Set<HTMLElement>()
  if (on && root) {
    const minX = Math.min(px, tx) - REACH, maxX = Math.max(px, tx) + REACH
    const minY = Math.min(py, ty) - REACH, maxY = Math.max(py, ty) + REACH
    for (const el of root.querySelectorAll<HTMLElement>(".spotlight")) {
      const r = el.getBoundingClientRect()
      if (r.right < minX || r.left > maxX || r.bottom < minY || r.top > maxY) continue
      el.style.setProperty("--mx", `${(px - r.left).toFixed(1)}px`)
      el.style.setProperty("--my", `${(py - r.top).toFixed(1)}px`)
      el.style.setProperty("--tx", `${(tx - r.left).toFixed(1)}px`)
      el.style.setProperty("--ty", `${(ty - r.top).toFixed(1)}px`)
      if (!lit.has(el)) el.setAttribute("data-glow", "")
      now.add(el)
    }
  }
  for (const el of lit) if (!now.has(el)) el.removeAttribute("data-glow")
  lit.clear()
  for (const el of now) lit.add(el)
}

function frame(t: number) {
  const dt = Math.min(64, t - last)
  last = t
  const k = 1 - Math.exp(-dt / TAIL_MS)
  tx += (px - tx) * k
  ty += (py - ty) * k
  paint()
  raf = on && Math.abs(px - tx) + Math.abs(py - ty) > 0.5 ? requestAnimationFrame(frame) : 0
}

function schedule() {
  if (raf) return
  last = performance.now()
  raf = requestAnimationFrame(frame)
}

/** onPointerMove on the scrolling main area. */
export function spotlightMove(e: { clientX: number; clientY: number; pointerType?: string; currentTarget: EventTarget | null }) {
  if (e.pointerType && e.pointerType !== "mouse" && e.pointerType !== "pen") return
  root = e.currentTarget as HTMLElement
  px = e.clientX
  py = e.clientY
  if (!on || reduced()) {
    tx = px // a fresh start (or reduced motion): no trail
    ty = py
  }
  on = true
  schedule()
}

/** onPointerLeave: the glow fades out where it is. */
export function spotlightLeave() {
  on = false
  if (raf) cancelAnimationFrame(raf)
  raf = 0
  paint()
}

/** onScroll: cards moved under a still pointer. */
export function spotlightScroll() {
  if (on) schedule()
}
