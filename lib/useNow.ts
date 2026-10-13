"use client"
import { useEffect, useState } from "react"

/**
 * The current time, refreshed every `everyMs`. Components read the clock through this instead of
 * calling Date.now() while rendering, so a render always shows one consistent time and React's
 * rules about pure rendering hold.
 */
export function useNow(everyMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), everyMs)
    return () => window.clearInterval(t)
  }, [everyMs])
  return now
}
