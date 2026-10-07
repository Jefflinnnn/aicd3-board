"use client"

/**
 * Where the app's data lives.
 *
 * - cloud: the artifact's shared store (`db` capability). Postings, the bin, categories and the
 *   freshness stamp are shared and only editors (admins) can change them. Each person's saved/applied
 *   list, notes and last visit live in their private subtree. Requests and reports go to the person's
 *   own inbox document, which admins can read.
 * - review: postings held back for staff to check before students see them. This area is readable and
 *   writable by admins only, so held postings never reach a student's browser.
 * - preview: the page is open outside Claude (a saved copy), so it runs on sample data kept in this browser.
 * - signedout: inside Claude but the shared store isn't available to this viewer (for example signed out).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  BIN_DAYS, seedJobs, setCustomCategories, store,
  type BinItem, type Category, type CompanyRequest, type IssueReport, type Job, type StagedJob,
} from "./data"
import { seedStaged, unstage } from "./review"

export type Mode = "loading" | "cloud" | "preview" | "signedout"
export type MyStatus = "saved" | "applied"
export interface Mine {
  status: Record<string, MyStatus>
  notes: Record<string, string>
  lastVisit?: number
  /** this person's dashboard arrangement: section order and the ones they hid */
  layout?: DashLayout
}
export interface DashLayout { order: string[]; hidden: string[] }
export interface Meta {
  customCats: Category[]
  lastUpdated?: number
  lastImport?: { at: number; added: number; updated: number; closed: number }
}
export interface InboxDoc {
  uid: string
  requests: CompanyRequest[]
  reports: IssueReport[]
}

/* minimal shapes of the platform capabilities this file uses */
type Snap = { id: string; exists: boolean; data(): Record<string, unknown> | undefined }
type QSnap = { docs: Snap[] }
type DocRef = {
  set(d: Record<string, unknown>): Promise<void>
  delete(): Promise<void>
  onSnapshot(n: (s: Snap) => void, e?: (err: { code: string }) => void): () => void
}
type ColRef = { onSnapshot(n: (s: QSnap) => void, e?: (err: { code: string }) => void): () => void }
type DB = { doc(p: string): DocRef; collection(p: string): ColRef }
type UserCap = { id(): Promise<string | null>; canEdit(): Promise<boolean>; profiles(ids: string[]): Promise<Record<string, { name: string }>> }
type ClaudeWin = { use(name: string): Promise<unknown> }

const EMPTY_MINE: Mine = { status: {}, notes: {} }
const EMPTY_META: Meta = { customCats: [] }

export function useBackend() {
  const [mode, setMode] = useState<Mode>("loading")
  const [me, setMe] = useState<{ id: string | null; canEdit: boolean }>({ id: null, canEdit: false })
  const [jobs, setJobsS] = useState<Job[]>([])
  const [bin, setBinS] = useState<BinItem[]>([])
  const [staged, setStagedS] = useState<StagedJob[]>([])
  const [meta, setMetaS] = useState<Meta>(EMPTY_META)
  const [mine, setMineS] = useState<Mine>(EMPTY_MINE)
  const [prevVisit, setPrevVisit] = useState<number | null>(null)
  const [myInbox, setMyInbox] = useState<{ requests: CompanyRequest[]; reports: IssueReport[] }>({ requests: [], reports: [] })
  const [inbox, setInbox] = useState<InboxDoc[]>([])
  const [names, setNames] = useState<Record<string, string>>({})
  const [myName, setMyName] = useState<string | null>(null)
  const [loaded, setLoaded] = useState({ jobs: false, mine: false })

  const dbRef = useRef<DB | null>(null)
  const userRef = useRef<UserCap | null>(null)
  const uidRef = useRef<string | null>(null)
  const mineRef = useRef<Mine>(EMPTY_MINE)
  const metaRef = useRef<Meta>(EMPTY_META)
  const visitStamped = useRef(false)
  // one write at a time per document
  const chains = useRef<Record<string, Promise<unknown>>>({})
  const queue = useCallback(<T,>(path: string, fn: () => Promise<T>): Promise<T> => {
    const prev = chains.current[path] || Promise.resolve()
    const next = prev.catch(() => undefined).then(fn)
    chains.current[path] = next
    return next
  }, [])

  /* ---------- boot ---------- */
  useEffect(() => {
    let cancelled = false
    const unsubs: (() => void)[] = []
    const claude = (window as unknown as { claude?: ClaudeWin }).claude

    if (!claude) {
      // saved copy outside Claude: sample data in this browser
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
      mineRef.current = stamped
      setMineS(stamped)
      setMyInbox(store.get("myInbox", { requests: [], reports: [] }))
      setMe({ id: "local", canEdit: true })
      setLoaded({ jobs: true, mine: true })
      setMode("preview")
      return
    }

    ;(async () => {
      const [db, user] = (await Promise.all([claude.use("db"), claude.use("user")])) as [DB | null, UserCap | null]
      if (cancelled) return
      if (!db) {
        setMode("signedout")
        return
      }
      dbRef.current = db
      userRef.current = user
      const [id, canEdit] = user ? await Promise.all([user.id(), user.canEdit()]) : [null, false]
      if (cancelled) return
      uidRef.current = id
      setMe({ id, canEdit })
      setMode("cloud")

      unsubs.push(
        db.collection("jobs").onSnapshot((s) => {
          setJobsS(s.docs.filter((d) => d.exists).map((d) => ({ ...(d.data() as unknown as Job), id: d.id })))
          setLoaded((l) => ({ ...l, jobs: true }))
        })
      )
      unsubs.push(
        db.collection("bin").onSnapshot((s) =>
          setBinS(s.docs.filter((d) => d.exists).map((d) => d.data() as unknown as BinItem).sort((a, b) => b.deletedAt - a.deletedAt))
        )
      )
      unsubs.push(
        db.doc("meta/site").onSnapshot((s) => {
          const m = s.exists ? ({ ...EMPTY_META, ...(s.data() as unknown as Meta) }) : EMPTY_META
          setCustomCategories(m.customCats || [])
          metaRef.current = m
          setMetaS(m)
        })
      )
      if (id) {
        unsubs.push(
          db.doc(`data/users/${id}/state`).onSnapshot((s) => {
            const m = s.exists ? ({ ...EMPTY_MINE, ...(s.data() as unknown as Mine) }) : EMPTY_MINE
            mineRef.current = m
            setMineS(m)
            setLoaded((l) => ({ ...l, mine: true }))
          })
        )
        unsubs.push(
          db.doc(`inbox/${id}`).onSnapshot((s) => {
            const d = (s.exists ? s.data() : {}) as { requests?: CompanyRequest[]; reports?: IssueReport[] }
            setMyInbox({ requests: d.requests || [], reports: d.reports || [] })
          })
        )
      } else setLoaded((l) => ({ ...l, mine: true }))
      if (canEdit) {
        unsubs.push(
          db.collection("review").onSnapshot((s) =>
            setStagedS(s.docs.filter((d) => d.exists).map((d) => ({ ...(d.data() as unknown as StagedJob), id: d.id })))
          )
        )
        unsubs.push(
          db.collection("inbox").onSnapshot((s) => {
            const docs = s.docs.filter((d) => d.exists).map((d) => {
              const x = d.data() as { requests?: CompanyRequest[]; reports?: IssueReport[] }
              return { uid: d.id, requests: x.requests || [], reports: x.reports || [] }
            })
            setInbox(docs)
          })
        )
      }
    })()

    return () => {
      cancelled = true
      unsubs.forEach((u) => u())
    }
  }, [])

  /* remember the previous visit, then stamp this one (once, after the first read of my state) */
  useEffect(() => {
    if (mode !== "cloud" || !loaded.mine || visitStamped.current) return
    visitStamped.current = true
    setPrevVisit(mineRef.current.lastVisit ?? null)
    const uid = uidRef.current
    if (uid) writeMine({ ...mineRef.current, lastVisit: Date.now() }).catch(() => undefined)
  }, [mode, loaded.mine]) // eslint-disable-line react-hooks/exhaustive-deps

  /* the viewer's own display name, for the account block in the sidebar */
  useEffect(() => {
    const u = userRef.current
    if (mode !== "cloud" || !u || !me.id) return
    u.profiles([me.id]).then((p) => setMyName(p[me.id as string]?.name || null)).catch(() => undefined)
  }, [mode, me.id])

  /* admin: resolve the names of people who sent requests or reports */
  useEffect(() => {
    const u = userRef.current
    const ids = inbox.map((d) => d.uid)
    if (!u || !ids.length) return
    u.profiles(ids).then((p) => setNames(Object.fromEntries(Object.entries(p).map(([k, v]) => [k, v.name || "Someone"])))).catch(() => undefined)
  }, [inbox])

  /* ---------- writers ---------- */
  const db = () => dbRef.current
  const cloud = mode === "cloud"

  const writeMine = useCallback(
    async (next: Mine) => {
      mineRef.current = next
      setMineS(next)
      if (!dbRef.current) {
        store.set("mine", next)
        return
      }
      const uid = uidRef.current
      if (!uid) {
        store.set("mine", next) // no private subtree for this visit: keep it in the browser
        return
      }
      const path = `data/users/${uid}/state`
      await queue(path, () => dbRef.current!.doc(path).set(next as unknown as Record<string, unknown>))
    },
    [queue]
  )

  const touchMeta = useCallback(
    async (patch: Partial<Meta> = {}) => {
      const next = { ...metaRef.current, ...patch, lastUpdated: Date.now() }
      metaRef.current = next
      setMetaS(next)
      if (!dbRef.current) {
        store.set("cats", next.customCats)
        store.set("lastUpdated", next.lastUpdated)
        return
      }
      await queue("meta/site", () => dbRef.current!.doc("meta/site").set(next as unknown as Record<string, unknown>))
    },
    [queue]
  )

  /* local-mode helpers */
  const localJobs = useRef<Job[]>([])
  localJobs.current = jobs
  const localBin = useRef<BinItem[]>([])
  localBin.current = bin
  const setLocalJobs = (next: Job[]) => { setJobsS(next); store.set("jobs", next) }
  const setLocalBin = (next: BinItem[]) => { setBinS(next); store.set("bin", next) }

  const saveJobs = useCallback(
    async (list: Job[]) => {
      if (!list.length) return
      const d = db()
      if (!d) {
        const byId = new Map(localJobs.current.map((j) => [j.id, j]))
        list.forEach((j) => byId.set(j.id, j))
        setLocalJobs([...byId.values()])
      } else {
        for (const j of list) await queue(`jobs/${j.id}`, () => d.doc(`jobs/${j.id}`).set(JSON.parse(JSON.stringify(j))))
      }
      await touchMeta()
    },
    [queue, touchMeta] // eslint-disable-line react-hooks/exhaustive-deps
  )

  const moveToBin = useCallback(
    async (ids: string[]) => {
      const now = Date.now()
      const moving = localJobs.current.filter((j) => ids.includes(j.id))
      const d = db()
      if (!d) {
        setLocalJobs(localJobs.current.filter((j) => !ids.includes(j.id)))
        setLocalBin([...moving.map((job) => ({ job, deletedAt: now })), ...localBin.current])
        return moving
      }
      for (const job of moving) {
        await queue(`bin/${job.id}`, () => d.doc(`bin/${job.id}`).set(JSON.parse(JSON.stringify({ job, deletedAt: now }))))
        await queue(`jobs/${job.id}`, () => d.doc(`jobs/${job.id}`).delete())
      }
      await touchMeta()
      return moving
    },
    [queue, touchMeta] // eslint-disable-line react-hooks/exhaustive-deps
  )

  const restore = useCallback(
    async (ids: string[]) => {
      const back = localBin.current.filter((b) => ids.includes(b.job.id))
      const d = db()
      if (!d) {
        setLocalJobs([...back.map((b) => b.job), ...localJobs.current])
        setLocalBin(localBin.current.filter((b) => !ids.includes(b.job.id)))
        return back.length
      }
      for (const b of back) {
        await queue(`jobs/${b.job.id}`, () => d.doc(`jobs/${b.job.id}`).set(JSON.parse(JSON.stringify(b.job))))
        await queue(`bin/${b.job.id}`, () => d.doc(`bin/${b.job.id}`).delete())
      }
      await touchMeta()
      return back.length
    },
    [queue, touchMeta] // eslint-disable-line react-hooks/exhaustive-deps
  )

  const deleteForever = useCallback(
    async (ids: string[]) => {
      const d = db()
      if (!d) {
        setLocalBin(localBin.current.filter((b) => !ids.includes(b.job.id)))
        return
      }
      for (const id of ids) await queue(`bin/${id}`, () => d.doc(`bin/${id}`).delete())
    },
    [queue] // eslint-disable-line react-hooks/exhaustive-deps
  )

  /* ---------- review queue (staff only) ---------- */
  const localStaged = useRef<StagedJob[]>([])
  localStaged.current = staged
  const setLocalStaged = (next: StagedJob[]) => { setStagedS(next); store.set("review", next) }

  /** Put postings in the queue, or update ones already there. */
  const saveStaged = useCallback(
    async (list: StagedJob[]) => {
      if (!list.length) return
      const d = db()
      if (!d) {
        const byId = new Map(localStaged.current.map((j) => [j.id, j]))
        list.forEach((j) => byId.set(j.id, j))
        setLocalStaged([...byId.values()])
        return
      }
      for (const j of list) await queue(`review/${j.id}`, () => d.doc(`review/${j.id}`).set(JSON.parse(JSON.stringify(j))))
    },
    [queue] // eslint-disable-line react-hooks/exhaustive-deps
  )
  const dropStaged = useCallback(
    async (ids: string[]) => {
      const d = db()
      if (!d) {
        setLocalStaged(localStaged.current.filter((j) => !ids.includes(j.id)))
        return
      }
      for (const id of ids) await queue(`review/${id}`, () => d.doc(`review/${id}`).delete())
    },
    [queue] // eslint-disable-line react-hooks/exhaustive-deps
  )
  /** Approve: publish to the job board and clear from the queue. */
  const approve = useCallback(
    async (ids: string[]) => {
      const going = localStaged.current.filter((j) => ids.includes(j.id))
      const d = db()
      if (!d) {
        const out = going.map(unstage)
        const byId = new Map(localJobs.current.map((j) => [j.id, j]))
        out.forEach((j) => byId.set(j.id, j))
        setLocalJobs([...byId.values()])
        setLocalStaged(localStaged.current.filter((j) => !ids.includes(j.id)))
        await touchMeta()
        return going
      }
      for (const s of going) {
        const j = unstage(s)
        await queue(`jobs/${j.id}`, () => d.doc(`jobs/${j.id}`).set(JSON.parse(JSON.stringify(j))))
        await queue(`review/${j.id}`, () => d.doc(`review/${j.id}`).delete())
      }
      await touchMeta()
      return going
    },
    [queue, touchMeta] // eslint-disable-line react-hooks/exhaustive-deps
  )
  /** Take published postings off the job board and back into the queue. */
  const pullToReview = useCallback(
    async (ids: string[], reason: string) => {
      const pulling = localJobs.current.filter((j) => ids.includes(j.id))
      const now = Date.now()
      const items: StagedJob[] = pulling.map((j) => ({ ...j, review: { flags: [reason], source: "pulled", at: now, status: "pending" } }))
      const d = db()
      if (!d) {
        setLocalStaged([...items, ...localStaged.current.filter((s) => !ids.includes(s.id))])
        setLocalJobs(localJobs.current.filter((j) => !ids.includes(j.id)))
        await touchMeta()
        return pulling
      }
      for (const s of items) {
        await queue(`review/${s.id}`, () => d.doc(`review/${s.id}`).set(JSON.parse(JSON.stringify(s))))
        await queue(`jobs/${s.id}`, () => d.doc(`jobs/${s.id}`).delete())
      }
      await touchMeta()
      return pulling
    },
    [queue, touchMeta] // eslint-disable-line react-hooks/exhaustive-deps
  )
  /** Reject keeps the posting in a staff-only list, so later imports don't send it back for review. */
  const setReviewStatus = useCallback(
    (ids: string[], status: "pending" | "rejected") =>
      saveStaged(localStaged.current.filter((j) => ids.includes(j.id)).map((j) => ({ ...j, review: { ...j.review, status, decidedAt: status === "rejected" ? Date.now() : undefined } }))),
    [saveStaged]
  )

  /* admins clear anything that has sat in the bin for 30 days */
  useEffect(() => {
    if (!cloud || !me.canEdit) return
    const cutoff = Date.now() - BIN_DAYS * 864e5
    const old = bin.filter((b) => b.deletedAt <= cutoff).map((b) => b.job.id)
    if (old.length) deleteForever(old).catch(() => undefined)
  }, [cloud, me.canEdit, bin, deleteForever])

  const setCustomCats = useCallback(
    async (cats: Category[]) => {
      setCustomCategories(cats)
      await touchMeta({ customCats: cats })
    },
    [touchMeta]
  )

  /* ---------- personal state ---------- */
  const setStatus = useCallback(
    (ids: string[], s: MyStatus | null) => {
      const status = { ...mineRef.current.status }
      ids.forEach((id) => {
        if (s) status[id] = s
        else delete status[id]
      })
      return writeMine({ ...mineRef.current, status })
    },
    [writeMine]
  )
  /** Each person arranges their own dashboard; it follows their account, like Baseten's per-user metric views. */
  const setLayout = useCallback((layout: DashLayout | undefined) => {
    const next = { ...mineRef.current }
    if (layout) next.layout = layout
    else delete next.layout
    return writeMine(next)
  }, [writeMine])
  const noteTimer = useRef<number | undefined>(undefined)
  const setNote = useCallback(
    (id: string, text: string) => {
      const notes = { ...mineRef.current.notes }
      if (text.trim()) notes[id] = text
      else delete notes[id]
      const next = { ...mineRef.current, notes }
      mineRef.current = next
      setMineS(next)
      // one write per pause in typing
      window.clearTimeout(noteTimer.current)
      noteTimer.current = window.setTimeout(() => writeMine(mineRef.current).catch(() => undefined), 700)
    },
    [writeMine]
  )

  /* ---------- inbox ---------- */
  const writeMyInbox = useCallback(
    async (next: { requests: CompanyRequest[]; reports: IssueReport[] }) => {
      const d = db()
      const uid = uidRef.current
      if (!d || !uid) {
        setMyInbox(next)
        store.set("myInbox", next)
        return true
      }
      try {
        await queue(`inbox/${uid}`, () => d.doc(`inbox/${uid}`).set(JSON.parse(JSON.stringify({ ...next, updatedAt: Date.now() }))))
        return true
      } catch {
        return false
      }
    },
    [queue] // eslint-disable-line react-hooks/exhaustive-deps
  )
  const myInboxRef = useRef(myInbox)
  myInboxRef.current = myInbox
  const addRequest = useCallback((r: CompanyRequest) => writeMyInbox({ ...myInboxRef.current, requests: [r, ...myInboxRef.current.requests] }), [writeMyInbox])
  const addReport = useCallback((r: IssueReport) => writeMyInbox({ ...myInboxRef.current, reports: [r, ...myInboxRef.current.reports] }), [writeMyInbox])

  /** Everything in every inbox (admin), or this browser's own items in preview. */
  const allInbox: InboxDoc[] = useMemo(
    () => (cloud ? inbox : [{ uid: "local", ...myInbox }]),
    [cloud, inbox, myInbox]
  )
  const resolveInbox = useCallback(
    async (uid: string, kind: "requests" | "reports", itemId: string) => {
      const d = db()
      const docIn = allInbox.find((x) => x.uid === uid)
      if (!docIn) return
      const next = { requests: docIn.requests, reports: docIn.reports, [kind]: docIn[kind].filter((x) => x.id !== itemId) }
      if (!d || uid === "local") {
        setMyInbox(next)
        store.set("myInbox", next)
        return
      }
      await queue(`inbox/${uid}`, () => d.doc(`inbox/${uid}`).set(JSON.parse(JSON.stringify({ ...next, updatedAt: Date.now() }))))
    },
    [allInbox, queue] // eslint-disable-line react-hooks/exhaustive-deps
  )

  /** Preview only: put the original sample postings back. */
  const resetSample = useCallback(() => {
    setLocalJobs(seedJobs())
    setLocalBin([])
    setLocalStaged(seedStaged())
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return {
    mode, me, loaded, jobs, bin, staged, meta, mine, prevVisit, myInbox, allInbox, names, myName,
    saveJobs, moveToBin, saveStaged, dropStaged, approve, pullToReview, setReviewStatus, restore, deleteForever, setCustomCats, touchMeta,
    setStatus, setNote, setLayout, addRequest, addReport, resolveInbox, resetSample,
  }
}

export type Backend = ReturnType<typeof useBackend>
