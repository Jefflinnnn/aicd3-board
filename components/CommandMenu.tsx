"use client"

import { useEffect, useRef, useState } from "react"
import {
  ArrowRight, BriefcaseBusiness, Building2, Flag, Keyboard, LayoutDashboard, Moon, PanelLeft, Settings as SettingsIcon, ShieldCheck, Sun,
} from "lucide-react"
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from "@/components/ui/command"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { CatChip } from "@/components/common"
import { useApp } from "@/lib/state"
import { COMPANIES, coById, isLive } from "@/lib/data"

/** Keyboard shortcuts shown in the palette, the cheat sheet and the sidebar tooltips. */
export const SHORTCUTS: { keys: string[]; label: string }[] = [
  { keys: ["⌘", "K"], label: "Search and run commands" },
  { keys: ["G", "D"], label: "Go to Dashboard" },
  { keys: ["G", "J"], label: "Go to Job board" },
  { keys: ["G", "C"], label: "Go to Company info" },
  { keys: ["G", "A"], label: "Go to Admin (staff)" },
  { keys: ["G", "S"], label: "Go to Settings" },
  { keys: ["/"], label: "Search the job board" },
  { keys: ["["], label: "Collapse or expand the sidebar" },
  { keys: ["?"], label: "Show these shortcuts" },
]
export const Keys = ({ keys }: { keys: string[] }) => (
  <span className="inline-flex items-center gap-1">{keys.map((k) => <kbd key={k}>{k}</kbd>)}</span>
)

const typing = (t: EventTarget | null) => {
  const el = t as HTMLElement | null
  return !!el && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName))
}

/**
 * The ⌘K palette (Linear, Vercel, Raycast): one box that finds any posting or company and runs any
 * command, so moving around never needs the mouse. Also wires the G-then-letter page shortcuts.
 */
export function CommandMenu({ open, onOpenChange, onToggleSidebar }: { open: boolean; onOpenChange: (o: boolean) => void; onToggleSidebar: () => void }) {
  const { jobs, me, go, openJob, settings, setSettings, dark, openReport } = useApp()
  const [q, setQ] = useState("")
  const [help, setHelp] = useState(false)
  const gAt = useRef(0)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault()
        onOpenChange(!open)
        return
      }
      if (typing(e.target) || e.metaKey || e.ctrlKey || e.altKey || document.querySelector("[role=dialog]")) return
      const k = e.key.toLowerCase()
      if (e.key === "?") { e.preventDefault(); setHelp(true); return }
      if (e.key === "[") { e.preventDefault(); onToggleSidebar(); return }
      if (k === "g") { gAt.current = Date.now(); return }
      if (Date.now() - gAt.current < 900) {
        const dest = { d: "dashboard", j: "jobs", c: "companies", a: me.canEdit ? "admin" : "", s: "settings" }[k]
        gAt.current = 0
        if (dest) { e.preventDefault(); go(dest) }
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [open, onOpenChange, onToggleSidebar, go, me.canEdit])

  useEffect(() => { if (!open) setQ("") }, [open])
  // other parts of the page (the footer) can ask for the shortcut sheet
  useEffect(() => {
    const on = () => setHelp(true)
    window.addEventListener("open-shortcuts", on)
    return () => window.removeEventListener("open-shortcuts", on)
  }, [])
  const run = (fn: () => void) => { onOpenChange(false); window.setTimeout(fn, 60) }

  const pages = [
    { id: "dashboard", label: "Dashboard", Icon: LayoutDashboard, keys: ["G", "D"] },
    { id: "jobs", label: "Job board", Icon: BriefcaseBusiness, keys: ["G", "J"] },
    { id: "companies", label: "Company info", Icon: Building2, keys: ["G", "C"] },
    ...(me.canEdit ? [{ id: "admin", label: "Admin", Icon: ShieldCheck, keys: ["G", "A"] }] : []),
    { id: "settings", label: "Settings", Icon: SettingsIcon, keys: ["G", "S"] },
  ]
  const term = q.trim().toLowerCase()
  // postings only appear once you type, so the empty palette stays a short list of places and actions
  const postings = term.length < 2 ? [] : jobs
    .filter((j) => `${j.title} ${coById(j.company).name} ${j.location}`.toLowerCase().includes(term))
    .sort((a, b) => Number(isLive(b)) - Number(isLive(a)))
    .slice(0, 8)
  const companies = term.length < 1 ? [] : COMPANIES.filter((c) => c.name.toLowerCase().includes(term)).slice(0, 5)

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="top-[18%] w-[calc(100vw-2rem)] max-w-xl translate-y-0 gap-0 overflow-hidden p-0 [&>button:last-child]:hidden">
          <DialogHeader className="sr-only">
            <DialogTitle>Search and commands</DialogTitle>
            <DialogDescription>Find a posting or company, jump to a page, or run a command.</DialogDescription>
          </DialogHeader>
          <Command shouldFilter={false} className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:text-[0.68rem] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.08em] [&_[cmdk-input]]:h-12 [&_[cmdk-item]]:gap-2.5 [&_[cmdk-item]]:rounded-md [&_[cmdk-item]]:px-2 [&_[cmdk-item]]:py-2">
            <CommandInput value={q} onValueChange={setQ} placeholder="Search postings, companies, pages or commands…" />
            <CommandList className="max-h-[min(60vh,420px)] p-1">
              <CommandEmpty>No matches for “{q}”.</CommandEmpty>
              {postings.length > 0 && (
                <CommandGroup heading="Postings">
                  {postings.map((j) => (
                    <CommandItem key={j.id} value={"job-" + j.id} onSelect={() => run(() => openJob(j.id))}>
                      <BriefcaseBusiness className="size-4 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate">
                        <span className="font-medium">{j.title}</span>
                        <span className="text-muted-foreground">, {coById(j.company).name}</span>
                      </span>
                      <CatChip id={j.category} className="text-xs text-muted-foreground" />
                      {!isLive(j) && <span className="text-xs text-muted-foreground">Expired</span>}
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}
              {companies.length > 0 && (
                <CommandGroup heading="Companies">
                  {companies.map((c) => (
                    <CommandItem key={c.id} value={"co-" + c.id} onSelect={() => run(() => go("jobs", { company: [c.id] }))}>
                      <Building2 className="size-4 text-muted-foreground" />
                      <span className="flex-1">{c.name}</span>
                      <span className="text-xs text-muted-foreground">See roles <ArrowRight className="inline size-3" /></span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}
              {(postings.length > 0 || companies.length > 0) && <CommandSeparator className="my-1" />}
              <CommandGroup heading="Go to">
                {pages.filter((p) => !term || p.label.toLowerCase().includes(term)).map((p) => (
                  <CommandItem key={p.id} value={"page-" + p.id} onSelect={() => run(() => go(p.id))}>
                    <p.Icon className="size-4 text-muted-foreground" />
                    <span className="flex-1">{p.label}</span>
                    <Keys keys={p.keys} />
                  </CommandItem>
                ))}
              </CommandGroup>
              <CommandGroup heading="Commands">
                {[
                  { id: "theme", label: dark ? "Switch to light theme" : "Switch to dark theme", Icon: dark ? Sun : Moon, fn: () => setSettings({ theme: dark ? "light" : "dark" }) },
                  { id: "sidebar", label: settings.sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar", Icon: PanelLeft, keys: ["["], fn: onToggleSidebar },
                  { id: "report", label: "Report an issue with a posting", Icon: Flag, fn: () => openReport() },
                  { id: "keys", label: "Keyboard shortcuts", Icon: Keyboard, keys: ["?"], fn: () => setHelp(true) },
                ].filter((c) => !term || c.label.toLowerCase().includes(term)).map((c) => (
                  <CommandItem key={c.id} value={"cmd-" + c.id} onSelect={() => run(c.fn)}>
                    <c.Icon className="size-4 text-muted-foreground" />
                    <span className="flex-1">{c.label}</span>
                    {c.keys && <Keys keys={c.keys} />}
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
            <div className="flex items-center gap-4 border-t bg-muted/40 px-3 py-2 text-[0.72rem] text-muted-foreground">
              <span className="inline-flex items-center gap-1.5"><Keys keys={["↑", "↓"]} /> move</span>
              <span className="inline-flex items-center gap-1.5"><kbd>↵</kbd> open</span>
              <span className="inline-flex items-center gap-1.5"><kbd>esc</kbd> close</span>
            </div>
          </Command>
        </DialogContent>
      </Dialog>

      <Dialog open={help} onOpenChange={setHelp}>
        <DialogContent className="w-[calc(100vw-2rem)] max-w-md">
          <DialogHeader className="text-left">
            <DialogTitle className="font-display text-lg">Keyboard shortcuts</DialogTitle>
            <DialogDescription>Press G, then a letter, to jump between pages.</DialogDescription>
          </DialogHeader>
          <ul className="flex flex-col divide-y text-sm">
            {SHORTCUTS.filter((s) => me.canEdit || !s.label.includes("Admin")).map((s) => (
              <li key={s.label} className="flex items-center justify-between py-2">
                <span>{s.label}</span>
                <Keys keys={s.keys} />
              </li>
            ))}
          </ul>
        </DialogContent>
      </Dialog>
    </>
  )
}
