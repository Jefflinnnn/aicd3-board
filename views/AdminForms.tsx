"use client"

import { useMemo, useRef, useState } from "react"
import { Copy, FileUp } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { normalizeUrl } from "@/lib/validate"
import { CATS, COMPANIES, TODAY, addDays, coById, iso, jobLocations, type CatId, type Job, type StagedJob } from "@/lib/data"
import { CSV_TEMPLATE, planImport, type ImportPlan } from "@/lib/importer"
import { useApp } from "@/lib/state"
import { cn } from "@/lib/utils"

type FormState = Omit<Job, "id" | "resp" | "quals"> & { resp: string; quals: string; rolling: boolean }


/** How the form was submitted: publish or hold a new posting, or save (and optionally approve) one in review. */
export type FormAction = "save" | "hold" | "approve"

export function JobForm({ job, open, onOpenChange, onSave, inReview = false }: { job: Job | null; open: boolean; onOpenChange: (o: boolean) => void; onSave: (j: Partial<Job>, action: FormAction) => void; inReview?: boolean }) {
  const action = useRef<FormAction>("save")
  const init = (): FormState => {
    const v = job || { title: "", company: COMPANIES[0].id, location: COMPANIES[0].hq, category: "discovery" as CatId, posted: iso(TODAY), deadline: iso(addDays(TODAY, 30)), term: "Summer " + (TODAY.getFullYear() + 1), mode: "Onsite", pay: "", url: "", summary: "", resp: [], quals: [] }
    return { ...v, location: job ? jobLocations(job).join("\n") : v.location, resp: v.resp.join("\n"), quals: v.quals.join("\n"), rolling: !v.deadline, deadline: v.deadline || iso(addDays(TODAY, 30)) }
  }
  const [f, setF] = useState<FormState>(init)
  const [err, setErr] = useState("")
  const [locTouched, setLocTouched] = useState(false)
  const set = (p: Partial<FormState>) => setF((s) => ({ ...s, ...p }))

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!f.title.trim()) return setErr("Add a title.")
    const locs = [...new Set(f.location.split("\n").map((x) => x.trim()).filter(Boolean))]
    if (!locs.length) return setErr("Add at least one location, or “Remote (US)”.")
    if (!f.posted) return setErr("Add the date the posting was first seen.")
    if (!f.rolling && !f.deadline) return setErr("Pick a deadline or turn on Rolling deadline.")
    if (!f.rolling && f.deadline < f.posted) return setErr("The deadline is before the first-seen date.")
    let url = f.url.trim()
    if (url) {
      const ok = normalizeUrl(url)
      if (!ok) return setErr("The posting link isn't a valid web address. Use a full link such as https://careers.example.com/job/123.")
      url = ok
    }
    onSave({
      title: f.title.trim(), company: f.company, location: locs[0], locations: locs, category: f.category, mode: f.mode, posted: f.posted,
      deadline: f.rolling ? "" : f.deadline, term: f.term.trim(), pay: f.pay.trim(), url: url || coById(f.company).site, summary: f.summary.trim(),
      resp: f.resp.split("\n").map((s) => s.trim()).filter(Boolean), quals: f.quals.split("\n").map((s) => s.trim()).filter(Boolean), sample: false,
      closed: f.closed || undefined, addedAt: job?.addedAt ?? Date.now(),
    }, action.current)
  }

  const L = ({ htmlFor, children }: { htmlFor: string; children: React.ReactNode }) => (
    <Label htmlFor={htmlFor} className="text-[0.7rem] font-semibold uppercase tracking-[0.07em] text-muted-foreground">{children}</Label>
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-2xl overflow-y-auto">
        <form onSubmit={submit} noValidate className="flex flex-col gap-4">
          <DialogHeader className="text-left">
            <DialogTitle className="font-display text-xl">{inReview ? "Edit posting in review" : job ? "Edit posting" : "Add a posting"}</DialogTitle>
            <DialogDescription>
              {inReview ? "Students won't see it until you approve it." : job ? `ID ${job.id}` : "Publish puts it on the job board right away. Hold for review keeps it in the review queue until someone approves it."}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5 sm:col-span-2"><L htmlFor="jt">Title</L><Input id="jt" autoFocus value={f.title} onChange={(e) => set({ title: e.target.value })} /></div>
            <div className="flex flex-col gap-1.5"><L htmlFor="jc">Company</L>
              <Select value={f.company} onValueChange={(v) => set({ company: v, ...(!job && !locTouched ? { location: coById(v).hq } : {}) })}>
                <SelectTrigger id="jc"><SelectValue /></SelectTrigger>
                <SelectContent>{COMPANIES.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5"><L htmlFor="jl">Locations, one per line</L><Textarea id="jl" rows={2} value={f.location} onChange={(e) => { setLocTouched(true); set({ location: e.target.value }) }} /></div>
            <div className="flex flex-col gap-1.5"><L htmlFor="jcat">Category</L>
              <Select value={f.category} onValueChange={(v) => set({ category: v as CatId })}>
                <SelectTrigger id="jcat"><SelectValue /></SelectTrigger>
                <SelectContent>{CATS.map((c) => <SelectItem key={c.id} value={c.id}>{c.label}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5"><L htmlFor="jm">Work mode</L>
              <Select value={f.mode} onValueChange={(v) => set({ mode: v })}>
                <SelectTrigger id="jm"><SelectValue /></SelectTrigger>
                <SelectContent>{["Onsite", "Hybrid", "Remote (US)"].map((m) => <SelectItem key={m} value={m}>{m}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5"><L htmlFor="jp">First seen</L><Input id="jp" type="date" value={f.posted} onChange={(e) => set({ posted: e.target.value })} /></div>
            <div className="flex flex-col gap-1.5">
              <L htmlFor="jd">Deadline</L>
              <Input id="jd" type="date" value={f.deadline} disabled={f.rolling} onChange={(e) => set({ deadline: e.target.value })} />
              <div className="flex items-center gap-2 pt-1"><Switch id="jr" checked={f.rolling} onCheckedChange={(c) => set({ rolling: c })} /><Label htmlFor="jr" className="text-sm font-normal">Rolling deadline</Label></div>
            </div>
            <div className="flex flex-col gap-1.5"><L htmlFor="jterm">Term</L><Input id="jterm" value={f.term} onChange={(e) => set({ term: e.target.value })} /></div>
            <div className="flex flex-col gap-1.5"><L htmlFor="jpay">Pay</L><Input id="jpay" value={f.pay} placeholder="$40–$50/hr" onChange={(e) => set({ pay: e.target.value })} /></div>
            <div className="flex items-center gap-2 sm:col-span-2"><Switch id="jclosed" checked={!!f.closed} onCheckedChange={(c) => set({ closed: c })} /><Label htmlFor="jclosed" className="text-sm font-normal">Taken down early (hide from students as expired)</Label></div>
            <div className="flex flex-col gap-1.5 sm:col-span-2"><L htmlFor="ju">Posting link</L><Input id="ju" value={f.url} placeholder="https://" onChange={(e) => set({ url: e.target.value })} /></div>
            <div className="flex flex-col gap-1.5 sm:col-span-2"><L htmlFor="js">Description</L><Textarea id="js" rows={3} value={f.summary} onChange={(e) => set({ summary: e.target.value })} /></div>
            <div className="flex flex-col gap-1.5 sm:col-span-2"><L htmlFor="jresp">Responsibilities, one per line</L><Textarea id="jresp" rows={4} value={f.resp} onChange={(e) => set({ resp: e.target.value })} /></div>
            <div className="flex flex-col gap-1.5 sm:col-span-2"><L htmlFor="jq">Qualifications, one per line</L><Textarea id="jq" rows={3} value={f.quals} onChange={(e) => set({ quals: e.target.value })} /></div>
          </div>
          {err && <p className="text-sm text-destructive" role="alert">{err}</p>}
          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            {inReview ? (
              <>
                <Button type="submit" variant="outline" onClick={() => (action.current = "save")}>Save changes</Button>
                <Button type="submit" onClick={() => (action.current = "approve")}>Save and approve</Button>
              </>
            ) : job ? (
              <Button type="submit" onClick={() => (action.current = "save")}>Save changes</Button>
            ) : (
              <>
                <Button type="submit" variant="outline" onClick={() => (action.current = "hold")}>Hold for review</Button>
                <Button type="submit" onClick={() => (action.current = "save")}>Publish</Button>
              </>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}


const rowsOf = (plan: ImportPlan) => [
  ...plan.stage.map((j) => ["Review", j] as const),
  ...plan.add.map((j) => ["New", j] as const),
  ...plan.restage.map((j) => ["Review", j] as const),
  ...plan.update.map((j) => ["Updated", j] as const),
  ...plan.close.map((j) => ["Taken down", j] as const),
]

export function ImportDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { jobs, staged, saveJobs, saveStaged, touchMeta } = useApp()
  const [reviewAll, setReviewAll] = useState(false)
  const [text, setText] = useState("")
  const [fileName, setFileName] = useState("")
  const [closeMissing, setCloseMissing] = useState(false)
  const [busy, setBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const result = useMemo((): { plan?: ImportPlan; error?: string } => {
    if (!text.trim()) return {}
    try {
      return { plan: planImport(text, jobs, closeMissing, staged, reviewAll) }
    } catch (e) {
      return { error: (e as Error).message }
    }
  }, [text, jobs, closeMissing, staged, reviewAll])
  const plan = result.plan
  const changes = plan ? plan.add.length + plan.update.length + plan.close.length + plan.stage.length + plan.restage.length : 0

  const apply = async () => {
    if (!plan || !changes) return
    setBusy(true)
    try {
      await saveStaged([...plan.stage, ...plan.restage])
      await saveJobs([...plan.add, ...plan.update, ...plan.close])
      await touchMeta({ lastImport: { at: Date.now(), added: plan.add.length, updated: plan.update.length, closed: plan.close.length } })
      toast("Import finished", {
        description: `${plan.add.length} published, ${plan.stage.length} sent for review, ${plan.update.length} updated, ${plan.close.length} marked taken down.`,
      })
      setText("")
      setFileName("")
      onOpenChange(false)
    } catch {
      toast("The import stopped partway. Check your connection and run it again; finished rows won't be duplicated.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-3xl overflow-y-auto">
        <DialogHeader className="text-left">
          <DialogTitle className="font-display text-xl">Import postings</DialogTitle>
          <DialogDescription>Paste the scraper's JSON or CSV, or choose a file. You'll see what changes before anything is saved.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={fileRef}
              type="file"
              accept=".json,.csv,application/json,text/csv"
              className="hidden"
              onChange={async (e) => {
                const f = e.target.files?.[0]
                if (!f) return
                setFileName(f.name)
                setText(await f.text())
                e.target.value = ""
              }}
            />
            <Button type="button" variant="outline" onClick={() => fileRef.current?.click()}><FileUp className="size-4" /> Choose file</Button>
            {fileName && <span className="text-sm text-muted-foreground">{fileName}</span>}
            <Button
              type="button"
              variant="ghost"
              className="ml-auto"
              onClick={() => {
                navigator.clipboard.writeText(CSV_TEMPLATE).then(() => toast("CSV template copied"), () => setText(CSV_TEMPLATE))
              }}
            >
              <Copy className="size-4" /> Copy CSV template
            </Button>
          </div>
          <Textarea aria-label="Scraper output" rows={7} value={text} onChange={(e) => { setText(e.target.value); setFileName("") }} placeholder='[{"title": "Machine Learning Intern", "company": "Genentech", "locations": ["South San Francisco, CA"], "deadline": "2026-11-15", "url": "https://…"}]' className="text-xs" />
          <p className="text-xs text-muted-foreground">
            Columns: title, company, locations (separate with ;), category, deadline (YYYY-MM-DD, blank for rolling), first_seen, term, mode, pay, url, description, responsibilities and qualifications (separate with |). Postings are matched to existing ones by link, or by title and company.
          </p>
          <div className="flex items-center gap-2">
            <Switch id="reviewall" checked={reviewAll} onCheckedChange={setReviewAll} />
            <Label htmlFor="reviewall" className="text-sm font-normal">Send every new posting for review, not only the ones the checks flag</Label>
          </div>
          <div className="flex items-center gap-2">
            <Switch id="closemissing" checked={closeMissing} onCheckedChange={setCloseMissing} />
            <Label htmlFor="closemissing" className="text-sm font-normal">Mark live postings from these companies that aren't in this import as taken down</Label>
          </div>

          {result.error && <p className="text-sm text-destructive" role="alert">{result.error}</p>}
          {plan && (
            <div className="flex flex-col gap-3 rounded-lg border p-4 duration-200 animate-in fade-in">
              <div className="grid grid-cols-3 gap-3 sm:grid-cols-6">
                {([["Publish", plan.add.length], ["To review", plan.stage.length + plan.restage.length], ["Updated", plan.update.length], ["Unchanged", plan.unchanged + plan.rejected], ["Taken down", plan.close.length], ["Skipped rows", plan.errors.length]] as [string, number][]).map(([k, v]) => (
                  <div key={k}>
                    <div className="text-[0.7rem] font-semibold uppercase tracking-[0.07em] text-muted-foreground">{k}</div>
                    <div className={cn("font-display text-2xl font-semibold tabular-nums", k === "Skipped rows" && v > 0 && "text-destructive", k === "To review" && v > 0 && "text-warn")}>{v}</div>
                  </div>
                ))}
              </div>
              {rowsOf(plan).slice(0, 8).length > 0 && (
                <ul className="flex flex-col divide-y text-sm">
                  {rowsOf(plan).slice(0, 8).map(([k, j]) => (
                    <li key={k + j.id + j.title} className="flex items-baseline gap-3 py-1.5">
                      <span className={cn("w-20 shrink-0 text-xs font-medium text-muted-foreground", k === "Review" && "text-warn")}>{k}</span>
                      <span className="min-w-0 flex-1 truncate"><span className="font-medium">{j.title}</span>, {coById(j.company).name}</span>
                      {"review" in j && <span className="shrink-0 truncate text-xs text-muted-foreground">{(j as StagedJob).review.flags[0]}</span>}
                    </li>
                  ))}
                </ul>
              )}
              {changes > 8 && <p className="text-xs text-muted-foreground">and {changes - 8} more</p>}
              {plan.errors.length > 0 && (
                <div className="rounded-md bg-destructive/10 p-3 text-sm">
                  <p className="mb-1 font-medium text-destructive">These rows will be skipped</p>
                  <ul className="flex flex-col gap-0.5">
                    {plan.errors.slice(0, 6).map((e) => <li key={e.row}>Row {e.row}: {e.reason}</li>)}
                  </ul>
                  {plan.errors.length > 6 && <p className="mt-1 text-xs text-muted-foreground">and {plan.errors.length - 6} more</p>}
                </div>
              )}
            </div>
          )}
        </div>
        <DialogFooter className="gap-2">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="button" disabled={!changes || busy} onClick={apply}>{busy ? "Importing…" : changes ? `Apply ${changes} change${changes === 1 ? "" : "s"}` : "Nothing to apply"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
