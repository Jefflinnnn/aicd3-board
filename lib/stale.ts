"use client"

/**
 * After a deploy, a tab opened on the previous version still calls the old server actions, which the new
 * deployment no longer has ("Failed to find Server Action ... older or newer deployment"). Reloading
 * loads the new version and everything works again, so the app does that by itself, once a minute at
 * most so a real outage can't cause a reload loop.
 */
const STALE = /failed to find server action|failed-to-find-server-action|older or newer deployment|server action .* was not found/i
const KEY = "aicd3:stale-reload"

export function isStaleDeployment(e: unknown): boolean {
  const msg = e instanceof Error ? `${e.message} ${e.stack || ""}` : String(e ?? "")
  return STALE.test(msg)
}

/** Reloads the page if `e` is a stale-deployment error (and it hasn't just done so). Returns whether it did. */
export function reloadIfStale(e: unknown): boolean {
  if (typeof window === "undefined" || !isStaleDeployment(e)) return false
  try {
    const last = Number(sessionStorage.getItem(KEY) || 0)
    if (Date.now() - last < 60_000) return false
    sessionStorage.setItem(KEY, String(Date.now()))
  } catch {
    /* storage unavailable: reload anyway, the guard is only against loops */
  }
  window.location.reload()
  return true
}
