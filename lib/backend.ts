"use client"

/**
 * Where the app's data lives, as seen from the browser.
 *
 * - cloud: signed in and approved. Data comes from Postgres on Neon through the server actions in
 *   lib/actions.ts, which check the person's role on every call. Students get the live job board and
 *   their own lists, notes, requests and reports; staff also get the review queue, the bin and
 *   everyone's requests and reports.
 * - pending / blocked: signed in, but staff haven't approved this account (or have blocked it).
 * - signedout: the session ended; the page goes to /auth/sign-in.
 * - preview: local development before `neon deploy` (no database or sign-in configured):
 *   sample data kept in this browser, as in the original MVP.
 * - unavailable: the server couldn't be reached or isn't configured.
 *
 * Writes update the screen straight away and are sent to the server one at a time, in order.
 * If one fails, the page reloads the server's copy and the caller shows an error.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import * as api from "./actions"
import { BIN_DAYS, seedJobs, setCustomCategories, store, type BinItem, type Category, type CompanyRequest, type IssueReport, type Job, type StagedJob } from "./data"
import { seedStaged, unstage } from "./review"
import type { DashLayout, InboxDoc, LoadResult, Me, Meta, Mine, Mode, MyStatus } from "./types"

export type { DashLayout, InboxDoc, Meta, Mine, Mode, MyStatus } from "./types"

const EMPTY_MINE: Mine = { status: {}, notes: {} }
const EMPTY_META: Meta = { customCats: [] }
const NOBODY: Me = { id: null, canEdit: false, role: "student", name: null, email: null }
const REFRESH_MS = 60_000

/** State plus a ref that always holds the latest value, for callbacks that outlive a render. */
function useLatest<T>(initial: T) {
  const [value, setValue] = useState<T>(initial)
  const ref = useRef<T>(initial)
  const set = useCallback((next: T) => {
    ref.current = next
    setValue(next)
  }, [])
  return [value, ref, set] as const
}

export function useBackend() {
  const router = useRouter()
  const [mode, modeRef, setMode] = useLatest<Mode>("loading")
  const [me, setMe] = useState<Me>(NOBODY)
  const [jobs, jobsRef, setJobsS] = useLatest<Job[]>([])
  const [bin, binRef, setBinS] = useLatest<BinItem[]>([])
  const [staged, stagedRef, setStagedS] = useLatest<StagedJob[]>([])
  const [meta, setMetaS] = useState<Meta>(EMPTY_META)
  const [mine, mineRef, setMineS] = useLatest<Mine>(EMPTY_MINE)
  const [prevVisit, setPrevVisit] = useState<number | null>(null)
  const [myInbox, myInboxRef, setMyInbox] = useLatest<{ requests: CompanyRequest[]; reports: IssueReport[] }>({ requests: [], reports: [] })
  const [inbox, setInbox] = useState<InboxDoc[]>([])
  const [names, setNames] = useState<Record<string, string>>({})
  const [loaded, setLoaded] = useState({ jobs: false, mine: false })
  const lastLoad = useRef(0)
  const pending = useRef(0)

  const cloud = mode === "cloud"

  /* ---------- load ---------- */
  /** Sample data in this browser (local development before Neon is set up). */
  const startPreview = useCallback(() => {
    const cats = store.get<Category[]>("cats", [])
    setCustomCategories(cats)
    setMetaS({ customCats: cats, lastUpdated: store.get<number | undefined>("lastUpdated", undefined) })
    setJobsS(store.get<Job[] | null>("jobs", null) || seedJobs())
    const cutoff = Date.now() - BIN_DAYS * 864e5
    setBinS(store.get<BinItem[]>("bin", []).filter((b) => b.deletedAt > cutoff))
    setStagedS(store.get<StagedJob[] | null>("review", null) || seedStaged())
    const m = store.get<Mine>("mine", EMPTY_MINE)
    setPrevVisit(m.lastVisit ?? null)
    const stamped = { ...m, lastVisit: Date.now() }
    store.set("mine", stamped)
    setMineS(stamped)
    setMyInbox(store.get("myInbox", { requests: [], reports: [] }))
    setMe({ id: "local", canEdit: true, role: "admin", name: null, email: null })
    setLoaded({ jobs: true, mine: true })
    setMode("preview")
  }, [setBinS, setJobsS, setMineS, setMode, setMyInbox, setStagedS])

  const apply = useCallback((r: LoadResult, first: boolean) => {
    lastLoad.current = Date.now()
    if (r.mode === "signedout") {
      setMode("signedout")
      router.replace("/auth/sign-in")
      return
    }
    if (r.mode === "preview") return startPreview()
    if (r.mode !== "cloud") {
      setMode(r.mode)
      if ("me" in r) setMe(r.me)
      return
    }
    setCustomCategories(r.meta.customCats || [])
    setMe(r.me)
    setJobsS(r.jobs)
    setMetaS(r.meta)
    setMineS(r.mine)
    setMyInbox(r.myInbox)
    if (first) setPrevVisit(r.prevVisit)
    if (r.staff) {
      setBinS(r.staff.bin)
      setStagedS(r.staff.staged)
      setInbox(r.staff.inbox)
      setNames(r.staff.names)
    }
    setLoaded({ jobs: true, mine: true })
    setMode("cloud")
  }, [router, startPreview, setBinS, setJobsS, setMineS, setMode, setMyInbox, setStagedS])

  const reload = useCallback(async () => {
    try {
      apply(await api.loadState({ refresh: true }), false)
    } catch {
      /* keep what's on screen */
    }
  }, [apply])

  useEffect(() => {
    let cancelled = false
    api.loadState().then(
      (r) => { if (!cancelled) apply(r, true) },
      () => { if (!cancelled) setMode("unavailable") }
    )
    // pick up other people's changes when the tab comes back into view
    const onFocus = () => {
      if (modeRef.current === "cloud" && !pending.current && Date.now() - lastLoad.current > REFRESH_MS) reload()
    }
    window.addEventListener("focus", onFocus)
    document.addEventListener("visibilitychange", onFocus)
    return () => {
      cancelled = true
      window.removeEventListener("focus", onFocus)
      document.removeEventListener("visibilitychange", onFocus)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  /* ---------- writing ---------- */
  // one server write at a time, in the order they were made
  const chain = useRef<Promise<unknown>>(Promise.resolve())
  const send = useCallback(<T,>(fn: () => Promise<T>): Promise<T> => {
    pending.current++
    const next = chain.current.catch(() => undefined).then(fn)
    chain.current = next
    return next.then(
      (v) => { pending.current--; return v },
      (e) => { pending.current--; reload(); throw e }
    )
  }, [reload])

  const setJobs = (next: Job[]) => { setJobsS(next); if (modeRef.current === "preview") store.set("jobs", next) }
  const setBin = (next: BinItem[]) => { setBinS(next); if (modeRef.current === "preview") store.set("bin", next) }
  const setStaged = (next: StagedJob[]) => { setStagedS(next); if (modeRef.current === "preview") store.set("review", next) }
  const stampMeta = (patch: Partial<Meta> = {}) => {
    setMetaS((m) => {
      const next = { ...m, ...patch, lastUpdated: Date.now() }
      if (modeRef.current === "preview") {
        store.set("cats", next.customCats)
        store.set("lastUpdated", next.lastUpdated)
      }
      return next
    })
  }
  const isPreview = () => modeRef.current === "preview"

  /* ---------- postings (staff) ---------- */
  const saveJobs = useCallback(async (list: Job[]) => {
    if (!list.length) return
    const byId = new Map(jobsRef.current.map((j) => [j.id, j]))
    list.forEach((j) => byId.set(j.id, j))
    setJobs([...byId.values()])
    stampMeta()
    if (!isPreview()) await send(() => api.saveJobs(list))
  }, [send]) // eslint-disable-line react-hooks/exhaustive-deps

  const moveToBin = useCallback(async (ids: string[]) => {
    const now = Date.now()
    const moving = jobsRef.current.filter((j) => ids.includes(j.id))
    setJobs(jobsRef.current.filter((j) => !ids.includes(j.id)))
    setBin([...moving.map((job) => ({ job, deletedAt: now })), ...binRef.current])
    stampMeta()
    if (!isPreview()) await send(() => api.moveToBin(ids))
    return moving
  }, [send]) // eslint-disable-line react-hooks/exhaustive-deps

  const restore = useCallback(async (ids: string[]) => {
    const back = binRef.current.filter((b) => ids.includes(b.job.id))
    setJobs([...back.map((b) => b.job), ...jobsRef.current])
    setBin(binRef.current.filter((b) => !ids.includes(b.job.id)))
    stampMeta()
    if (!isPreview()) await send(() => api.restore(ids))
    return back.length
  }, [send]) // eslint-disable-line react-hooks/exhaustive-deps

  const deleteForever = useCallback(async (ids: string[]) => {
    setBin(binRef.current.filter((b) => !ids.includes(b.job.id)))
    if (!isPreview()) await send(() => api.deleteForever(ids))
  }, [send]) // eslint-disable-line react-hooks/exhaustive-deps

  /* ---------- review queue (staff only) ---------- */
  /** Put postings in the queue, or update ones already there. */
  const saveStaged = useCallback(async (list: StagedJob[]) => {
    if (!list.length) return
    const byId = new Map(stagedRef.current.map((j) => [j.id, j]))
    list.forEach((j) => byId.set(j.id, j))
    setStaged([...byId.values()])
    if (!isPreview()) await send(() => api.saveStaged(list))
  }, [send]) // eslint-disable-line react-hooks/exhaustive-deps

  const dropStaged = useCallback(async (ids: string[]) => {
    setStaged(stagedRef.current.filter((j) => !ids.includes(j.id)))
    if (!isPreview()) await send(() => api.dropStaged(ids))
  }, [send]) // eslint-disable-line react-hooks/exhaustive-deps

  /** Approve: publish to the job board and clear from the queue. */
  const approve = useCallback(async (ids: string[]) => {
    const going = stagedRef.current.filter((j) => ids.includes(j.id))
    const byId = new Map(jobsRef.current.map((j) => [j.id, j]))
    going.map(unstage).forEach((j) => byId.set(j.id, j))
    setJobs([...byId.values()])
    setStaged(stagedRef.current.filter((j) => !ids.includes(j.id)))
    stampMeta()
    if (!isPreview()) await send(() => api.approve(ids))
    return going
  }, [send]) // eslint-disable-line react-hooks/exhaustive-deps

  /** Take published postings off the job board and back into the queue. */
  const pullToReview = useCallback(async (ids: string[], reason: string) => {
    const pulling = jobsRef.current.filter((j) => ids.includes(j.id))
    const now = Date.now()
    const items: StagedJob[] = pulling.map((j) => ({ ...j, review: { flags: [reason], source: "pulled", at: now, status: "pending" } }))
    setStaged([...items, ...stagedRef.current.filter((s) => !ids.includes(s.id))])
    setJobs(jobsRef.current.filter((j) => !ids.includes(j.id)))
    stampMeta()
    if (!isPreview()) await send(() => api.pullToReview(ids, reason))
    return pulling
  }, [send]) // eslint-disable-line react-hooks/exhaustive-deps

  /** Reject keeps the posting in a staff-only list, so later imports don't send it back for review. */
  const setReviewStatus = useCallback(async (ids: string[], status: "pending" | "rejected") => {
    const now = Date.now()
    setStaged(stagedRef.current.map((j) => (ids.includes(j.id) ? { ...j, review: { ...j.review, status, decidedAt: status === "rejected" ? now : undefined } } : j)))
    if (!isPreview()) await send(() => api.setReviewStatus(ids, status))
  }, [send]) // eslint-disable-line react-hooks/exhaustive-deps

  const setCustomCats = useCallback(async (cats: Category[]) => {
    setCustomCategories(cats)
    stampMeta({ customCats: cats })
    if (!isPreview()) await send(() => api.setCustomCats(cats))
  }, [send]) // eslint-disable-line react-hooks/exhaustive-deps

  const touchMeta = useCallback(async (patch: Partial<Meta> = {}) => {
    stampMeta(patch)
    if (!isPreview()) await send(() => api.bumpMeta(patch.lastImport ? { lastImport: patch.lastImport } : {}))
  }, [send]) // eslint-disable-line react-hooks/exhaustive-deps

  /* ---------- personal state ---------- */
  const writeMineLocal = (next: Mine) => {
    setMineS(next)
    if (isPreview()) store.set("mine", next)
  }

  const setStatus = useCallback((ids: string[], s: MyStatus | null) => {
    const status = { ...mineRef.current.status }
    ids.forEach((id) => {
      if (s) status[id] = s
      else delete status[id]
    })
    writeMineLocal({ ...mineRef.current, status })
    return isPreview() ? Promise.resolve() : send(() => api.setStatus(ids, s))
  }, [send]) // eslint-disable-line react-hooks/exhaustive-deps

  /** Each person arranges their own dashboard; it follows their account. */
  const setLayout = useCallback((layout: DashLayout | undefined) => {
    const next = { ...mineRef.current }
    if (layout) next.layout = layout
    else delete next.layout
    writeMineLocal(next)
    return isPreview() ? Promise.resolve() : send(() => api.setLayout(layout ?? null))
  }, [send]) // eslint-disable-line react-hooks/exhaustive-deps

  const noteTimers = useRef<Record<string, number>>({})
  const setNote = useCallback((id: string, text: string) => {
    const notes = { ...mineRef.current.notes }
    if (text.trim()) notes[id] = text
    else delete notes[id]
    writeMineLocal({ ...mineRef.current, notes })
    if (isPreview()) return
    // one write per pause in typing
    window.clearTimeout(noteTimers.current[id])
    noteTimers.current[id] = window.setTimeout(() => {
      send(() => api.setNote(id, mineRef.current.notes[id] || "")).catch(() => undefined)
    }, 700)
  }, [send]) // eslint-disable-line react-hooks/exhaustive-deps

  /* ---------- requests and reports ---------- */
  const writeMyInboxLocal = (next: { requests: CompanyRequest[]; reports: IssueReport[] }) => {
    setMyInbox(next)
    if (isPreview()) store.set("myInbox", next)
  }
  const addRequest = useCallback(async (r: CompanyRequest) => {
    writeMyInboxLocal({ ...myInboxRef.current, requests: [r, ...myInboxRef.current.requests] })
    if (isPreview()) return true
    try {
      await send(() => api.addRequest(r))
      return true
    } catch {
      return false
    }
  }, [send]) // eslint-disable-line react-hooks/exhaustive-deps
  const addReport = useCallback(async (r: IssueReport) => {
    writeMyInboxLocal({ ...myInboxRef.current, reports: [r, ...myInboxRef.current.reports] })
    if (isPreview()) return true
    try {
      await send(() => api.addReport(r))
      return true
    } catch {
      return false
    }
  }, [send]) // eslint-disable-line react-hooks/exhaustive-deps

  /** Everything in every inbox (staff), or this browser's own items in preview. */
  const allInbox: InboxDoc[] = useMemo(() => (cloud ? inbox : [{ uid: "local", ...myInbox }]), [cloud, inbox, myInbox])
  const resolveInbox = useCallback(async (uid: string, kind: "requests" | "reports", itemId: string) => {
    if (isPreview() || uid === "local") {
      const next = { ...myInboxRef.current, [kind]: myInboxRef.current[kind].filter((x) => x.id !== itemId) }
      writeMyInboxLocal(next)
      return
    }
    setInbox((all) => all.map((d) => (d.uid === uid ? { ...d, [kind]: d[kind].filter((x) => x.id !== itemId) } : d)))
    await send(() => api.resolveInbox(uid, kind, itemId))
  }, [send]) // eslint-disable-line react-hooks/exhaustive-deps

  /** Preview only: put the original sample postings back. */
  const resetSample = useCallback(() => {
    setJobs(seedJobs())
    setBin([])
    setStaged(seedStaged())
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const signOut = useCallback(async () => {
    const { authClient } = await import("./auth/client")
    await authClient.signOut().catch(() => undefined)
    router.replace("/auth/sign-in")
    router.refresh()
  }, [router])

  return {
    mode, me, loaded, jobs, bin, staged, meta, mine, prevVisit, myInbox, allInbox, names, myName: me.name,
    saveJobs, moveToBin, saveStaged, dropStaged, approve, pullToReview, setReviewStatus, restore, deleteForever, setCustomCats, touchMeta,
    setStatus, setNote, setLayout, addRequest, addReport, resolveInbox, resetSample, signOut, reload,
  }
}

export type Backend = ReturnType<typeof useBackend>
