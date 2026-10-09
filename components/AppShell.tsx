"use client"

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import { BriefcaseBusiness, Building2, ChevronRight, ChevronsUpDown, Keyboard, LogOut, Monitor, Moon, Sun, GraduationCap, LayoutDashboard, Lock, PanelLeftClose, PanelLeftOpen, Search, Settings as SettingsIcon, ShieldCheck } from "lucide-react"
import { Toaster } from "@/components/ui/sonner"
import {
  DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup,
  DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuShortcut, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { JobDialog } from "@/components/common"
import { toast } from "sonner"
import { AppCtx, DEFAULT_SETTINGS, type AppState, type BoardTab, type JobFilters, type Settings, type ThemePref } from "@/lib/state"
import { CATS, isLive, parse, setHomeLocation, sod, store, type Job } from "@/lib/data"
import { useBackend } from "@/lib/backend"
import { Gate } from "@/components/Gate"
import { ReportDialog } from "@/components/ReportDialog"
import { cn } from "@/lib/utils"
import { AICD_LOGO_INNER } from "@/components/aicdLogo"
import { CommandMenu, Keys } from "@/components/CommandMenu"
import { Backdrop } from "@/components/Backdrop"
import { Footer } from "@/components/Footer"
import { ago } from "@/views/Admin"

const PAGES = [
  { id: "dashboard", label: "Dashboard", Icon: LayoutDashboard },
  { id: "jobs", label: "Job Board", Icon: BriefcaseBusiness },
  { id: "companies", label: "Company Info", Icon: Building2 },
  { id: "admin", label: "Admin", Icon: ShieldCheck },
] as const
const ALL_PAGES = ["dashboard", "jobs", "companies", "admin", "settings"]
/** Each page has its own URL: / is the dashboard, the rest are /jobs, /companies, /admin and /settings. */
const pageFromPath = (path: string | null) => {
  const seg = (path || "/").split("/")[1] || "dashboard"
  return ALL_PAGES.includes(seg) ? seg : "dashboard"
}
const hrefFor = (page: string) => (page === "dashboard" ? "/" : "/" + page)

/** The AICD3 program logo. */
function Logo() {
  return <svg viewBox="52 50 400 400" className="size-[26px]" aria-hidden dangerouslySetInnerHTML={{ __html: AICD_LOGO_INNER }} />
}

const PAGE_LABEL: Record<string, string> = { dashboard: "Dashboard", jobs: "Job board", companies: "Company info", admin: "Admin", settings: "Settings" }
const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)

/** Data freshness, the way Vercel and Baseten show deployment health: a coloured dot and a short label. */
function SyncPill({ mode, updatedAt }: { mode: string; updatedAt?: number }) {
  const stale = !updatedAt || Date.now() - updatedAt > 2 * 864e5
  const preview = mode === "preview"
  const tone = preview || stale ? "warn" : "good"
  const label = preview ? "Sample data" : updatedAt ? `Updated ${ago(updatedAt)}` : "Not updated yet"
  const tip = preview
    ? "No database is connected yet, so this site runs on sample postings saved in this browser only."
    : updatedAt ? `Postings last changed ${new Date(updatedAt).toLocaleString("en-US")}${stale ? ". Some may be out of date." : "."}` : "No postings have been loaded yet."
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className="hidden h-8 items-center gap-2 rounded-md px-2 text-xs text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:inline-flex">
          <span className="relative flex size-2">
            {tone === "good" && <span className="absolute inline-flex size-full animate-ping rounded-full bg-good opacity-40 motion-reduce:animate-none" />}
            <span className={cn("relative inline-flex size-2 rounded-full", tone === "good" ? "bg-good" : "bg-warn")} />
          </span>
          {label}
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-64">{tip}</TooltipContent>
    </Tooltip>
  )
}

const hostTheme = document.documentElement.getAttribute("data-theme")

export default function AppShell({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const pathname = usePathname()
  const backend = useBackend()
  const { mode, jobs, mine, prevVisit, setStatus } = backend
  // Staff (employees) are the people who can edit this page. "Student view" lets staff see the page as a student would.
  const isStaff = backend.me.canEdit
  const [studentView, setStudentViewS] = useState(() => store.get<boolean>("studentView", false))
  const setStudentView = (v: boolean) => {
    setStudentViewS(v)
    store.set("studentView", v)
    if (v && pageFromPath(window.location.pathname) === "admin") router.replace("/")
    toast(v ? "Showing the student view" : "Back to the staff view")
  }
  const me = useMemo(() => ({ ...backend.me, canEdit: backend.me.canEdit && !studentView }), [backend.me, studentView])
  const [reportOpen, setReportOpen] = useState(false)
  const [reportJob, setReportJob] = useState<string | null>(null)
  const [settings, setSettingsS] = useState<Settings>(() => {
    const s = { ...DEFAULT_SETTINGS, ...store.get<Partial<Settings>>("settings", {}) }
    setHomeLocation(s.home)
    return s
  })
  const page = pageFromPath(pathname)
  const [leaving, setLeaving] = useState(false)
  const [navPage, setNavPage] = useState(page) // the sidebar highlight moves right away
  const [narrow, setNarrow] = useState(() => window.innerWidth <= 760)
  const [collapsed, setCollapsed] = useState(() => window.innerWidth <= 760 || settings.sidebarCollapsed)
  const [jobId, setJobId] = useState<string | null>(null)
  const [jobOpen, setJobOpen] = useState(false)
  const [pendingFilter, setPendingFilter] = useState<Partial<JobFilters> | null>(null)
  const [pendingTab, setPendingTab] = useState<BoardTab | null>(null)
  const [cmdOpen, setCmdOpen] = useState(false)
  const [osDark, setOsDark] = useState(() => window.matchMedia("(prefers-color-scheme: dark)").matches)
  const [hostAttr, setHostAttr] = useState(hostTheme)

  const applied = useMemo(() => new Set(Object.keys(mine.status).filter((k) => mine.status[k] === "applied")), [mine.status])
  const saved = useMemo(() => new Set(Object.keys(mine.status).filter((k) => mine.status[k] === "saved")), [mine.status])

  /* routing: the URL decides the page; a new page fades in, and the scroll goes back to the top */
  useEffect(() => {
    setNavPage(page)
    setLeaving(false)
    document.getElementById("main")?.scrollTo(0, 0)
  }, [page])
  const leaveTimer = useRef(0)
  useEffect(() => () => window.clearTimeout(leaveTimer.current), [])

  useEffect(() => {
    const on = () => setNarrow(window.innerWidth <= 760)
    window.addEventListener("resize", on)
    return () => window.removeEventListener("resize", on)
  }, [])
  useEffect(() => {
    if (narrow) setCollapsed(true)
  }, [narrow])

  /* theme: an explicit choice here wins; "system" defers to the viewer, then the OS */
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)")
    const on = () => setOsDark(mq.matches)
    mq.addEventListener("change", on)
    return () => mq.removeEventListener("change", on)
  }, [])
  useEffect(() => {
    if (settings.theme !== "system") return
    const mo = new MutationObserver(() => setHostAttr(document.documentElement.getAttribute("data-theme")))
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] })
    return () => mo.disconnect()
  }, [settings.theme])
  const dark = settings.theme === "dark" || (settings.theme === "system" && (hostAttr ? hostAttr === "dark" : osDark))
  useEffect(() => {
    const root = document.documentElement
    if (settings.theme === "system") {
      if (hostTheme) root.setAttribute("data-theme", hostAttr || hostTheme)
      else root.removeAttribute("data-theme")
    } else root.setAttribute("data-theme", settings.theme)
    root.classList.toggle("dark", dark)
  }, [settings.theme, dark, hostAttr])

  /* state API */
  const toggleApplied = useCallback(
    (id: string) => {
      setStatus([id], mine.status[id] === "applied" ? null : "applied").catch(() => toast("Couldn't save that change. Try again in a moment."))
    },
    [mine.status, setStatus]
  )
  const openReport = useCallback((jobId?: string) => { setReportJob(jobId || null); setReportOpen(true) }, [])
  const setSettings = useCallback((patch: Partial<Settings>) => {
    setSettingsS((s) => {
      const next = { ...s, ...patch }
      store.set("settings", next)
      if (patch.home !== undefined) {
        setHomeLocation(next.home)
        store.set("homeSet", true) // ticks the getting-started step
      }
      return next
    })
    if ("sidebarCollapsed" in patch && window.innerWidth > 760) setCollapsed(!!patch.sidebarCollapsed)
  }, [])
  // Following a link (a chart, a map city, a heatmap cell) fades the current page out briefly, then
  // moves to the next one, so it reads as one smooth move.
  const go = useCallback((p: string, f?: Partial<JobFilters>, tab?: BoardTab) => {
    if (f) setPendingFilter(f)
    if (tab) setPendingTab(tab)
    if (p === pageFromPath(window.location.pathname)) return
    setNavPage(p)
    window.clearTimeout(leaveTimer.current)
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return router.push(hrefFor(p))
    setLeaving(true)
    leaveTimer.current = window.setTimeout(() => router.push(hrefFor(p)), 160)
  }, [router])
  const clearPendingFilter = useCallback(() => { setPendingFilter(null); setPendingTab(null) }, [])
  const openJob = useCallback((id: string) => { setJobId(id); setJobOpen(true) }, [])
  const isNew = useCallback(
    (j: Job) => {
      if (prevVisit == null) return false
      if (j.addedAt) return j.addedAt > prevVisit
      return parse(j.posted).getTime() > sod(new Date(prevVisit)).getTime()
    },
    [prevVisit]
  )

  const ctx: AppState = {
    ...backend,
    me,
    applied, saved, toggleApplied, isNew, settings, setSettings, dark, openJob, openReport, go,
    pendingFilter, pendingTab, clearPendingFilter, openCommand: () => setCmdOpen(true),
  }
  const job = jobs.find((j) => j.id === jobId) || null

  // counts that are worth a glance: new roles for everyone, the review queue for staff
  const newCount = useMemo(() => jobs.filter((j) => isLive(j) && isNew(j)).length, [jobs, isNew])
  const reviewCount = me.canEdit ? backend.staged.filter((x) => x.review.status === "pending").length : 0
  const badgeFor = (id: string) => (id === "jobs" ? newCount : id === "admin" ? reviewCount : 0)

  const NavItem = ({ id, label, Icon }: { id: string; label: string; Icon: typeof LayoutDashboard }) => {
    const active = navPage === id
    const n = badgeFor(id)
    const badgeLabel = id === "admin" ? `${n} waiting for review` : `${n} new since your last visit`
    const link = (
      <Link
        href={hrefFor(id)}
        data-nav={id}
        aria-current={active ? "page" : undefined}
        onClick={(e) => {
          if (narrow) setCollapsed(true)
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return // let new-tab clicks through
          e.preventDefault()
          go(id)
        }}
        className={cn(
          "relative z-[1] flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-sm text-sidebar-fg transition-colors hover:text-sidebar-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          !active && "hover:bg-sidebar-hover",
          active && "font-medium text-sidebar-strong",
          collapsed && "w-9 justify-center px-0"
        )}
      >
        <Icon className="size-[18px] shrink-0" strokeWidth={1.8} />
        {!collapsed && <span className="truncate">{label}</span>}
        {!collapsed && n > 0 && (
          <span aria-label={badgeLabel} className={cn("ml-auto min-w-5 rounded-full px-1.5 text-center text-[0.68rem] font-semibold leading-5 tabular-nums", id === "admin" ? "bg-warn-soft text-warn" : "bg-primary/10 text-primary")}>{n}</span>
        )}
        {!collapsed && id === "admin" && n === 0 && <Lock className="ml-auto size-3.5 opacity-50" aria-label="staff only" />}
        {collapsed && n > 0 && <span aria-label={badgeLabel} className={cn("absolute right-1 top-1 size-2 rounded-full ring-2 ring-sidebar", id === "admin" ? "bg-warn" : "bg-primary")} />}
      </Link>
    )
    if (!collapsed) return link
    return (
      <Tooltip>
        <TooltipTrigger asChild>{link}</TooltipTrigger>
        <TooltipContent side="right">{label}{n > 0 ? `, ${badgeLabel}` : ""}</TooltipContent>
      </Tooltip>
    )
  }

  /* the highlight behind the current page glides between items instead of jumping */
  const navRef = useRef<HTMLElement>(null)
  const [pill, setPill] = useState<{ top: number; left: number; width: number; height: number } | null>(null)
  const [pillReady, setPillReady] = useState(false)
  useLayoutEffect(() => {
    const el = navRef.current?.querySelector<HTMLElement>(`[data-nav="${navPage}"]`)
    setPill(el ? { top: el.offsetTop, left: el.offsetLeft, width: el.offsetWidth, height: el.offsetHeight } : null)
    const t = requestAnimationFrame(() => setPillReady(true))
    return () => cancelAnimationFrame(t)
  }, [navPage, collapsed, me.canEdit, newCount, reviewCount])

  const initials = (backend.myName || (mode === "preview" ? "Guest" : isStaff ? "Staff" : "Student"))
    .split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase()
  const roleLabel = isStaff ? (studentView ? "Staff, viewing as student" : backend.me.role === "admin" ? "Admin" : "Program staff") : mode === "pending" ? "Waiting for approval" : "Student"

  const toggle = () => {
    const next = !collapsed
    setCollapsed(next)
    if (!narrow) setSettingsS((s) => { const n = { ...s, sidebarCollapsed: next }; store.set("settings", n); return n })
  }
  const iconBtn = "grid size-9 shrink-0 place-items-center rounded-lg text-sidebar-fg hover:bg-sidebar-hover hover:text-sidebar-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"

  return (
    <AppCtx.Provider value={ctx}>
      <TooltipProvider delayDuration={150}>
        <div className={cn("grid h-full transition-[grid-template-columns] duration-200", collapsed || narrow ? "grid-cols-[56px_minmax(0,1fr)]" : "grid-cols-[248px_minmax(0,1fr)]")}>
          <aside
            aria-label="Main navigation"
            className={cn(
              "relative z-40 flex h-full min-w-0 flex-col gap-0.5 overflow-hidden border-r border-sidebar-line bg-sidebar px-2.5 pb-2.5 pt-2.5",
              narrow && !collapsed && "w-[248px] shadow-2xl"
            )}
          >
            <div className="mb-3 flex h-10 items-center justify-between">
              {collapsed ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button onClick={toggle} aria-label="Expand sidebar" className={cn(iconBtn, "group")}>
                      <span className="group-hover:hidden group-focus-visible:hidden"><Logo /></span>
                      <PanelLeftOpen className="hidden size-[18px] group-hover:block group-focus-visible:block" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="right">Expand sidebar</TooltipContent>
                </Tooltip>
              ) : (
                <>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button onClick={toggle} aria-label="Collapse sidebar" className={iconBtn}><Logo /></button>
                    </TooltipTrigger>
                    <TooltipContent side="right">Collapse sidebar</TooltipContent>
                  </Tooltip>
                  <span className="min-w-0 flex-1 truncate pl-1.5 text-[0.95rem] leading-none tracking-tight duration-200 animate-in fade-in">
                    <b className="font-semibold text-sidebar-strong">AICD3</b> <span className="font-normal text-sidebar-fg">Launchpad</span>
                  </span>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button onClick={toggle} aria-label="Collapse sidebar" className={iconBtn}><PanelLeftClose className="size-[18px]" /></button>
                    </TooltipTrigger>
                    <TooltipContent side="right">Collapse sidebar</TooltipContent>
                  </Tooltip>
                </>
              )}
            </div>
            <nav ref={navRef} className="relative flex flex-col gap-0.5">
              <span
                aria-hidden
                className={cn("absolute rounded-lg bg-sidebar-active", pillReady && "transition-[top,left,width,height,opacity] duration-300 ease-[cubic-bezier(.3,.7,.2,1)]", !pill && "opacity-0")}
                style={pill ? { top: pill.top, left: pill.left, width: pill.width, height: pill.height } : undefined}
              />
              {PAGES.filter((p) => p.id !== "admin" || me.canEdit).map((p) => <NavItem key={p.id} {...p} />)}
            </nav>
            {/* account block: who you are, with settings, theme, student view and shortcuts in one menu */}
            <div className="mt-auto border-t border-sidebar-line pt-2.5">
              <DropdownMenu>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <DropdownMenuTrigger
                      className={cn(
                        "flex w-full items-center gap-2.5 rounded-lg p-1.5 text-left text-sm hover:bg-sidebar-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-sidebar-hover",
                        navPage === "settings" && "bg-sidebar-active",
                        collapsed && "w-9 justify-center p-0"
                      )}
                      aria-label={`Account menu, ${roleLabel}`}
                    >
                      <span className={cn("relative grid size-7 shrink-0 place-items-center rounded-full text-[0.7rem] font-semibold", studentView ? "bg-primary/15 text-primary" : "bg-sidebar-strong text-sidebar")}>
                        {initials}
                      </span>
                      {!collapsed && (
                        <>
                          <span className="min-w-0 flex-1 leading-tight">
                            <span className="block truncate font-medium text-sidebar-strong">{backend.myName || (mode === "preview" ? "Guest" : "You")}</span>
                            <span className={cn("block truncate text-xs", studentView ? "text-primary" : "text-sidebar-muted")}>{roleLabel}</span>
                          </span>
                          <ChevronsUpDown className="size-3.5 shrink-0 text-sidebar-muted" />
                        </>
                      )}
                    </DropdownMenuTrigger>
                  </TooltipTrigger>
                  {collapsed && <TooltipContent side="right">{roleLabel}</TooltipContent>}
                </Tooltip>
                <DropdownMenuContent side={collapsed ? "right" : "top"} align={collapsed ? "end" : "start"} className="w-60">
                  <DropdownMenuLabel className="font-normal">
                    <span className="block text-sm font-medium">{backend.myName || (mode === "preview" ? "Guest" : "You")}</span>
                    {backend.me.email && <span className="block truncate text-xs text-muted-foreground">{backend.me.email}</span>}
                    <span className="block text-xs text-muted-foreground">{roleLabel}</span>
                  </DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem className="pl-8" onSelect={() => go("settings")}>
                    <SettingsIcon className="mr-2 size-4" /> Settings <DropdownMenuShortcut>G S</DropdownMenuShortcut>
                  </DropdownMenuItem>
                  <DropdownMenuItem className="pl-8" onSelect={() => window.dispatchEvent(new Event("open-shortcuts"))}>
                    <Keyboard className="mr-2 size-4" /> Keyboard shortcuts <DropdownMenuShortcut>?</DropdownMenuShortcut>
                  </DropdownMenuItem>
                  {isStaff && (
                    <DropdownMenuCheckboxItem checked={studentView} onCheckedChange={(c) => setStudentView(!!c)}>
                      <GraduationCap className="mr-2 size-4" /> View as student
                    </DropdownMenuCheckboxItem>
                  )}
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel className="pl-8 text-xs font-medium text-muted-foreground">Theme</DropdownMenuLabel>
                  <DropdownMenuRadioGroup value={settings.theme} onValueChange={(v) => setSettings({ theme: v as ThemePref })}>
                    <DropdownMenuRadioItem value="system"><Monitor className="mr-2 size-4" /> System</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="light"><Sun className="mr-2 size-4" /> Light</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="dark"><Moon className="mr-2 size-4" /> Dark</DropdownMenuRadioItem>
                  </DropdownMenuRadioGroup>
                  {mode !== "preview" && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem className="pl-8" onSelect={() => backend.signOut()}>
                        <LogOut className="mr-2 size-4" /> Sign out
                      </DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </aside>
          <main
            id="main"
            className="relative isolate h-full min-w-0 overflow-y-auto"
            onPointerMove={(e) => {
              // cards marked .spotlight light up under the pointer (Linear and Vercel do this)
              const el = (e.target as HTMLElement).closest<HTMLElement>(".spotlight")
              if (!el) return
              const r = el.getBoundingClientRect()
              el.style.setProperty("--mx", `${e.clientX - r.left}px`)
              el.style.setProperty("--my", `${e.clientY - r.top}px`)
            }}
          >
            {settings.backdrop && <Backdrop key={navPage} />}
            {/* sticky top bar: where you are, how fresh the data is, and the ⌘K search */}
            <header className="sticky top-0 z-30 flex h-12 items-center gap-3 border-b border-border/70 bg-background/60 px-4 backdrop-blur-xl backdrop-saturate-150 sm:px-6 lg:px-9">
              <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-sm">
                <span className="hidden text-muted-foreground sm:inline">AICD3 Launchpad</span>
                <ChevronRight className="hidden size-3.5 text-muted-foreground/60 sm:inline" />
                <span className="truncate font-medium">{PAGE_LABEL[navPage]}</span>
                {studentView && <span className="ml-1 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">Student view</span>}
              </nav>
              <div className="ml-auto flex items-center gap-2">
                <SyncPill mode={mode} updatedAt={backend.meta.lastUpdated} />
                <button
                  onClick={() => setCmdOpen(true)}
                  className="flex h-8 w-56 items-center gap-2 rounded-md border bg-card px-2.5 text-sm text-muted-foreground shadow-sm hover:border-input hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring max-md:w-8 max-md:justify-center max-md:px-0"
                  aria-label="Search and commands"
                >
                  <Search className="size-3.5 shrink-0" />
                  <span className="flex-1 text-left max-md:hidden">Search…</span>
                  <span className="max-md:hidden"><Keys keys={[isMac ? "⌘" : "Ctrl", "K"]} /></span>
                </button>
              </div>
            </header>
            <div key={page + ":" + CATS.map((c) => c.id).join(",") + ":" + settings.home} className={cn(
                "page-enter mx-auto w-full max-w-[1320px] px-4 pb-16 pt-6 transition-[opacity,transform] duration-150 ease-in sm:px-6 lg:px-9 lg:pt-7",
                leaving && "-translate-y-1 opacity-0"
              )}>
              {mode === "cloud" || mode === "preview" ? (
                page === "settings" || page === "admin" ? (
                  children
                ) : !backend.loaded.jobs ? (
                  <Gate kind="loading" />
                ) : jobs.length === 0 && page !== "companies" ? (
                  <Gate kind="empty" />
                ) : (
                  children
                )
              ) : page === "settings" ? (
                children
              ) : (
                <Gate kind={mode} />
              )}
              <Footer onShortcuts={() => window.dispatchEvent(new Event("open-shortcuts"))} />
            </div>
          </main>
        </div>
        <JobDialog
          job={job}
          open={jobOpen}
          onOpenChange={setJobOpen}
          status={job ? mine.status[job.id] || null : null}
          note={job ? mine.notes[job.id] || "" : ""}
          onNote={(t) => job && backend.setNote(job.id, t)}
          onSetStatus={(st) => job && setStatus([job.id], st).then(() => toast(st === "applied" ? "Marked as applied" : st === "saved" ? "Saved for later" : "Moved back to To apply", { description: job.title }), () => toast("Couldn't save that change. Try again in a moment."))}
          onReport={() => {
            if (!job) return
            setJobOpen(false)
            openReport(job.id)
          }}
        />
        <CommandMenu open={cmdOpen} onOpenChange={setCmdOpen} onToggleSidebar={toggle} />
        <ReportDialog open={reportOpen} onOpenChange={setReportOpen} jobId={reportJob} />
        <Toaster theme={dark ? "dark" : "light"} position="bottom-center" />
      </TooltipProvider>
    </AppCtx.Provider>
  )
}
