"use client"

import { useState } from "react"
import { ArrowUpRight, LayoutGrid, List, Plus } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Segmented } from "@/components/Segmented"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { PageHead } from "@/components/common"
import { useApp } from "@/lib/state"
import { CATS, COMPANIES, TODAY, TYPES, fmt, iso, isLive, store } from "@/lib/data"
import { isEmail, normalizeUrl } from "@/lib/validate"
import { cn } from "@/lib/utils"

function RequestDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { myInbox, addRequest } = useApp()
  const requests = myInbox.requests
  const [busy, setBusy] = useState(false)
  const [name, setName] = useState("")
  const [site, setSite] = useState("")
  const [cat, setCat] = useState("unsure")
  const [email, setEmail] = useState("")
  const [why, setWhy] = useState("")
  const [err, setErr] = useState("")
  const [siteErr, setSiteErr] = useState("")
  const [emailErr, setEmailErr] = useState("")
  const checkSite = (v: string) => {
    const e = v.trim() && !normalizeUrl(v) ? "Enter a full web address, such as careers.example.com or https://example.com/careers." : ""
    setSiteErr(e)
    return !e
  }
  const checkEmail = (v: string) => {
    const e = v.trim() && !isEmail(v) ? "Enter an email address such as name@university.edu." : ""
    setEmailErr(e)
    return !e
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    const n = name.trim()
    if (!n) return setErr("Add the company name so we know what to look up.")
    if (COMPANIES.some((c) => c.name.toLowerCase() === n.toLowerCase())) return setErr(`${n} is already on the list.`)
    if (requests.some((r) => r.name.toLowerCase() === n.toLowerCase())) return setErr(`You already requested ${n}.`)
    const siteOk = checkSite(site), emailOk = checkEmail(email)
    if (!siteOk || !emailOk) return setErr("")
    setBusy(true)
    const ok = await addRequest({ id: "r" + Date.now(), name: n, site: site.trim() ? (normalizeUrl(site) as string) : "", cat: cat === "unsure" ? "" : cat, email: email.trim(), why: why.trim(), date: iso(TODAY) })
    setBusy(false)
    if (!ok) return setErr("We couldn't send that. Sending requests needs Contributor access to this page, so ask the program team to give you access.")
    toast("Request sent", { description: `We'll look into adding ${n}.` })
    setName(""); setSite(""); setCat("unsure"); setEmail(""); setWhy(""); setErr(""); setSiteErr(""); setEmailErr("")
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[calc(100vw-2rem)] max-w-lg">
        <form onSubmit={submit} noValidate className="flex flex-col gap-4">
          <DialogHeader className="text-left">
            <DialogTitle className="font-display text-xl">Request a company</DialogTitle>
            <DialogDescription>Tell us which career site to add to the tracker.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5 sm:col-span-2">
              <Label htmlFor="rname">Company name</Label>
              <Input id="rname" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Xaira Therapeutics" autoFocus />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="rsite">Careers page (optional)</Label>
              <Input
                id="rsite"
                type="url"
                inputMode="url"
                value={site}
                onChange={(e) => { setSite(e.target.value); if (siteErr) checkSite(e.target.value) }}
                onBlur={(e) => checkSite(e.target.value)}
                placeholder="https://"
                aria-invalid={!!siteErr}
                aria-describedby={siteErr ? "rsite-err" : undefined}
                className={cn(siteErr && "border-destructive focus-visible:ring-destructive")}
              />
              {siteErr && <p id="rsite-err" className="text-xs text-destructive">{siteErr}</p>}
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="rcat">Mostly hires for</Label>
              <Select value={cat} onValueChange={setCat}>
                <SelectTrigger id="rcat"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="unsure">Not sure</SelectItem>
                  {CATS.map((c) => <SelectItem key={c.id} value={c.label}>{c.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5 sm:col-span-2">
              <Label htmlFor="remail">Your email (optional)</Label>
              <Input
                id="remail"
                type="email"
                inputMode="email"
                autoComplete="email"
                value={email}
                onChange={(e) => { setEmail(e.target.value); if (emailErr) checkEmail(e.target.value) }}
                onBlur={(e) => checkEmail(e.target.value)}
                placeholder="So we can tell you when it's added"
                aria-invalid={!!emailErr}
                aria-describedby={emailErr ? "remail-err" : undefined}
                className={cn(emailErr && "border-destructive focus-visible:ring-destructive")}
              />
              {emailErr && <p id="remail-err" className="text-xs text-destructive">{emailErr}</p>}
            </div>
            <div className="flex flex-col gap-1.5 sm:col-span-2">
              <Label htmlFor="rwhy">Why this company?</Label>
              <Textarea id="rwhy" rows={3} value={why} onChange={(e) => setWhy(e.target.value)} placeholder="Roles you've seen there, labs you're interested in…" />
            </div>
          </div>
          {err && <p className="text-sm text-destructive" role="alert">{err}</p>}
          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={busy}>{busy ? "Sending…" : "Send request"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export default function Companies() {
  const { jobs, myInbox, go } = useApp()
  const requests = myInbox.requests
  const [filter, setFilter] = useState("all")
  // cards or a dense list, like Baseten's model overview; remembered in this browser
  const [view, setViewS] = useState<"cards" | "list">(() => store.get("coView", "cards"))
  const setView = (v: "cards" | "list") => { setViewS(v); store.set("coView", v) }
  const [reqOpen, setReqOpen] = useState(false)
  const list = COMPANIES.filter((c) => filter === "all" || c.type === filter)
  const liveTotal = jobs.filter(isLive).length

  return (
    <div className="flex flex-col gap-5">
      <PageHead
        title="Companies we track"
        sub={
          <>
            We check these career sites daily for internship and co-op postings.
            <span className="mt-2 flex flex-wrap gap-x-6 gap-y-1">
              <span><b className="font-display text-lg font-semibold tabular-nums text-foreground">{COMPANIES.length}</b> companies</span>
              <span><b className="font-display text-lg font-semibold tabular-nums text-foreground">{liveTotal}</b> live roles</span>
            </span>
          </>
        }
        right={<Button onClick={() => setReqOpen(true)}><Plus className="size-4" /> Request a company</Button>}
      />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <Segmented size="md" value={filter} onChange={setFilter} label="Company type" items={[["all", "All"], ...TYPES.map((t) => [t, t] as [string, string])]} />
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
          {CATS.map((c) => (
            <span key={c.id} className="inline-flex items-center gap-1.5"><span className="size-2 rounded-[2px]" style={{ background: `var(${c.color})` }} />{c.label}</span>
          ))}
          <Segmented label="Layout" value={view} onChange={setView} items={[["cards", <span key="c" className="inline-flex items-center gap-1.5"><LayoutGrid className="size-3.5" /> Cards</span>], ["list", <span key="l" className="inline-flex items-center gap-1.5"><List className="size-3.5" /> List</span>]]} />
        </div>
      </div>

      {view === "list" ? (
        <div key={"list" + filter} className="spotlight overflow-x-auto rounded-lg border bg-card duration-200 animate-in fade-in">
          <table className="w-full min-w-[760px] border-collapse text-sm">
            <thead>
              <tr className="border-b bg-muted/60 text-left text-[0.7rem] uppercase tracking-[0.07em] text-muted-foreground">
                <th className="px-5 py-2.5 font-semibold">Company</th>
                <th className="px-3 py-2.5 font-semibold">Type</th>
                <th className="px-3 py-2.5 font-semibold">Hiring mix</th>
                <th className="px-3 py-2.5 text-right font-semibold">Live</th>
                <th className="px-3 py-2.5 text-right font-semibold">All-time</th>
                <th className="px-5 py-2.5 text-right font-semibold"><span className="sr-only">Links</span></th>
              </tr>
            </thead>
            <tbody>
              {list.map((c) => {
                const cj = jobs.filter((j) => j.company === c.id)
                const lv = cj.filter(isLive).length
                const n = CATS.map((k) => cj.filter((j) => j.category === k.id).length)
                const tot = n.reduce((a, b) => a + b, 0)
                const share = tot ? n.map((v) => v / tot) : CATS.map((_, i) => c.focus[i] || 0)
                return (
                  <tr key={c.id} className="border-b transition-colors last:border-b-0 hover:bg-muted/50">
                    <td className="px-5 py-2.5"><div className="font-medium">{c.name}</div><div className="text-xs text-muted-foreground">{c.hq}</div></td>
                    <td className="px-3 text-muted-foreground">{c.type}</td>
                    <td className="px-3">
                      <div className="flex h-1.5 w-40 gap-0.5 overflow-hidden rounded-full bg-muted" role="img" aria-label={"Hiring mix: " + CATS.map((k, i) => `${k.short} ${Math.round(share[i] * 100)}%`).join(", ")}>
                        {CATS.map((k, i) => share[i] > 0 && <span key={k.id} style={{ width: `${share[i] * 100}%`, background: `var(${k.color})` }} />)}
                      </div>
                    </td>
                    <td className="px-3 text-right font-mono tabular-nums">{lv}</td>
                    <td className="px-3 text-right font-mono tabular-nums text-muted-foreground">{tot}</td>
                    <td className="px-5">
                      <div className="flex items-center justify-end gap-3">
                        <a href={c.site} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline">Site <ArrowUpRight className="size-3" /></a>
                        <Button size="sm" variant="outline" className="h-7 w-[6.5rem] text-xs" disabled={!tot} onClick={() => go("jobs", lv ? { company: [c.id] } : { company: [c.id], status: "all" })}>
                          {lv ? `See ${lv} role${lv === 1 ? "" : "s"}` : tot ? "Past roles" : "No roles yet"}
                        </Button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      ) : (
      <div key={filter} className="grid auto-rows-fr gap-4 [grid-template-columns:repeat(auto-fill,minmax(min(100%,280px),1fr))]">
        {list.map((c, idx) => {
          const cj = jobs.filter((j) => j.company === c.id)
          const lv = cj.filter(isLive).length
          const n = CATS.map((k) => cj.filter((j) => j.category === k.id).length)
          const tot = n.reduce((a, b) => a + b, 0)
          const share = tot ? n.map((v) => v / tot) : CATS.map((_, i) => c.focus[i] || 0)
          const focusTxt = CATS.filter((_, i) => share[i] >= 0.2).map((k) => k.short).join(", ")
          return (
            <article
              key={c.id}
              style={{ animationDelay: `${Math.min(idx, 12) * 30}ms` }}
              className="spotlight flex flex-col gap-4 rounded-lg border bg-card p-5 duration-300 ease-out animate-in fade-in slide-in-from-bottom-2 fill-mode-both"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="truncate font-display text-lg font-semibold leading-tight" title={c.name}>{c.name}</h3>
                  <p className="truncate text-sm text-muted-foreground">{c.hq}</p>
                </div>
                <span className="shrink-0 whitespace-nowrap rounded-full bg-muted px-2 py-0.5 text-xs font-medium">{c.type}</span>
              </div>
              <div>
                <div className="flex h-2 gap-0.5 overflow-hidden rounded-full bg-muted" role="img" aria-label={"Hiring mix: " + CATS.map((k, i) => `${k.short} ${Math.round(share[i] * 100)}%`).join(", ")}>
                  {CATS.map((k, i) => share[i] > 0 && <span key={k.id} style={{ width: `${share[i] * 100}%`, background: `var(${k.color})` }} />)}
                </div>
                <p className="mt-1.5 truncate text-xs text-muted-foreground">Mostly hires for {focusTxt || "a mix of areas"}</p>
              </div>
              <div className="grid grid-cols-2 gap-4 text-sm text-muted-foreground">
                <div><b className="block font-display text-2xl leading-none tabular-nums text-foreground">{lv}</b>live now</div>
                <div><b className="block font-display text-2xl leading-none tabular-nums text-foreground">{tot}</b>tracked all-time</div>
              </div>
              <div className="mt-auto flex items-center justify-between gap-2 border-t pt-3">
                <a href={c.site} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline">
                  Company site <ArrowUpRight className="size-3.5" />
                </a>
                {/* every card gets the same footer button so the cards line up; with nothing live it opens past roles */}
                {lv > 0 ? (
                  <Button size="sm" variant="outline" className="w-[7.5rem]" onClick={() => go("jobs", { company: [c.id] })}>See {lv} role{lv === 1 ? "" : "s"}</Button>
                ) : tot > 0 ? (
                  <Button size="sm" variant="outline" className="w-[7.5rem] text-muted-foreground" onClick={() => go("jobs", { company: [c.id], status: "all" })}>See past roles</Button>
                ) : (
                  <Button size="sm" variant="outline" className="w-[7.5rem]" disabled>No roles yet</Button>
                )}
              </div>
            </article>
          )
        })}
      </div>
      )}

      {requests.length > 0 && (
        <section className="spotlight rounded-lg border bg-card p-5">
          <h2 className="font-display text-[1rem] font-semibold">Your requests</h2>
          <p className="text-[0.82rem] text-muted-foreground">We'll review these and add the ones that fit.</p>
          <ul className="mt-2">
            {requests.map((r) => (
              <li key={r.id} className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-t py-2.5 first:border-t-0">
                <b className="font-semibold">{r.name}</b>
                {r.site && <span className="text-sm text-muted-foreground">{r.site}</span>}
                <span className="ml-auto rounded-full bg-muted px-2 py-0.5 text-xs">Submitted {fmt(r.date)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <RequestDialog open={reqOpen} onOpenChange={setReqOpen} />
    </div>
  )
}
