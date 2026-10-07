"use client"

import { ArrowUp, Keyboard } from "lucide-react"

/** A quiet line to end each page: the shortcut sheet and a way back to the top. */
export function Footer({ onShortcuts }: { onShortcuts: () => void }) {
  const reduce = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches
  return (
    <footer className="mt-16 flex items-center justify-end gap-4 border-t pt-5 text-xs text-muted-foreground">
      <button onClick={onShortcuts} className="inline-flex items-center gap-1.5 hover:text-foreground"><Keyboard className="size-3.5" /> Shortcuts <kbd>?</kbd></button>
      <button onClick={() => document.getElementById("main")?.scrollTo({ top: 0, behavior: reduce() ? "auto" : "smooth" })} className="inline-flex items-center gap-1.5 hover:text-foreground">
        <ArrowUp className="size-3.5" /> Back to top
      </button>
    </footer>
  )
}
