"use client"

import { useEffect, useRef, useState } from "react"
import { CalendarPlus, Monitor, Moon, Sun } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Segmented } from "@/components/Segmented"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { PageHead } from "@/components/common"
import { DEFAULT_SETTINGS, SORT_PRESETS, useApp, type ThemePref } from "@/lib/state"
import { HOME_CITIES, coById, fmt, jobLocations, parse, store } from "@/lib/data"

type DownloadsCap = { save(r: { filename: string; data: string }): Promise<unknown> }

function Row({ title, desc, children, id }: { title: string; desc?: string; children: React.ReactNode; id?: string }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t py-4 first:border-t-0">
      <div className="min-w-0 max-w-[56ch]">
        <div id={id} className="font-medium">{title}</div>
        {desc && <div className="text-sm text-muted-foreground">{desc}</div>}
      </div>
      {children}
    </div>
  )
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="spotlight rounded-lg border bg-card px-5 py-2">
      <h2 className="pb-1 pt-3 font-display text-[1rem] font-semibold">{title}</h2>
      {children}
    </section>
  )
}

const csvCell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)

export default function SettingsPage() {
  const { settings, setSettings, jobs, mine, setStatus, mode } = useApp()
  const [clearOpen, setClearOpen] = useState(false)
  const [fallback, setFallback] = useState("")
  const [downloads, setDownloads] = useState<DownloadsCap | null>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const mineIds = Object.keys(mine.status)
  const myJobs = jobs.filter((j) => mine.status[j.id])
  const withDeadline = myJobs.filter((j) => j.deadline)

  useEffect(() => {
    const c = (window as unknown as { claude?: { use(n: string): Promise<unknown> } }).claude
    c?.use("downloads").then((d) => setDownloads(d as DownloadsCap | null), () => setDownloads(null))
  }, [])

  const copy = () => {
    const text = ["Status\tTitle\tCompany\tLocation\tDeadline\tLink", ...myJobs.map((j) => [mine.status[j.id], j.title, coById(j.company).name, jobLocations(j)[0], j.deadline || "Rolling", j.url].join("\t"))].join("\n")
    const fb = () => {
      setFallback(text)
      setTimeout(() => taRef.current?.select(), 0)
      toast("Select the text below and copy it")
    }
    try {
      navigator.clipboard.writeText(text).then(() => toast(`Copied ${myJobs.length} roles`, { description: "Paste into a spreadsheet; columns are tab-separated." }), fb)
    } catch {
      fb()
    }
  }

  /* Google Calendar imports CSV with these exact column names */
  const exportDeadlines = async () => {
    if (!downloads) return
    const rows = withDeadline.map((j) => {
      const d = parse(j.deadline)
      const date = `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}/${d.getFullYear()}`
      return [`Deadline: ${j.title} (${coById(j.company).name})`, date, "True", `${mine.status[j.id] === "applied" ? "Applied" : "Saved"}. ${j.url}`].map(csvCell).join(",")
    })
    try {
      await downloads.save({ filename: "internship-deadlines.csv", data: ["Subject,Start Date,All Day Event,Description", ...rows].join("\n") })
      store.set("exportedDeadlines", true) // ticks the getting-started step
      toast("Deadlines saved", { description: "In Google Calendar, use Settings, then Import & export, to add them." })
    } catch {
      /* the viewer declined the save */
    }
  }

  return (
    <div className="flex max-w-3xl flex-col gap-5">
      <PageHead title="Settings" />

      <Group title="Appearance">
        <Row title="Theme" desc="System follows your device setting.">
          <Segmented
            size="md"
            value={settings.theme}
            onChange={(v) => setSettings({ theme: v as ThemePref })}
            label="Theme"
            items={([["system", "System", Monitor], ["light", "Light", Sun], ["dark", "Dark", Moon]] as const).map(([v, l, Icon]) => [v, <><Icon className="size-3.5" />{l}</>] as [ThemePref, React.ReactNode])}
          />
        </Row>
        <Row title="Start with the sidebar collapsed" desc="Shows icons only, leaving more room for the job table." id="ls">
          <Switch aria-labelledby="ls" checked={settings.sidebarCollapsed} onCheckedChange={(c) => setSettings({ sidebarCollapsed: c })} />
        </Row>
        <Row title="Compact job rows" desc="Fits more roles on screen by hiding the term and work-mode line." id="lc">
          <Switch aria-labelledby="lc" checked={settings.compact} onCheckedChange={(c) => setSettings({ compact: c })} />
        </Row>
        <Row title="Dotted background" desc="A faint dot grid behind the top of each page." id="lb">
          <Switch aria-labelledby="lb" checked={settings.backdrop} onCheckedChange={(c) => setSettings({ backdrop: c })} />
        </Row>
      </Group>

      <Group title="Job board">
        <Row title="My location" desc="Postings with several sites show the one closest to you first." id="lhome">
          <Select value={settings.home || "none"} onValueChange={(v) => setSettings({ home: v === "none" ? "" : v })}>
            <SelectTrigger className="h-9 w-60" aria-labelledby="lhome"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="none">No preference (A to Z)</SelectItem>
              {HOME_CITIES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
            </SelectContent>
          </Select>
        </Row>
        <Row title="Closing-soon window" desc="Deadlines inside this window are highlighted and counted on the dashboard.">
          <Segmented size="md" value={String(settings.soonDays)} onChange={(v) => setSettings({ soonDays: Number(v) })} label="Closing-soon window" items={["7", "14", "30"].map((v) => [v, `${v} days`] as [string, string])} />
        </Row>
        <Row title="Default sort" id="lsort">
          <Select value={settings.sort} onValueChange={(v) => setSettings({ sort: v })}>
            <SelectTrigger className="h-9 w-60" aria-labelledby="lsort"><SelectValue /></SelectTrigger>
            <SelectContent>{SORT_PRESETS.map((p) => <SelectItem key={p.id} value={p.id}>{p.label}</SelectItem>)}</SelectContent>
          </Select>
        </Row>
      </Group>

      <Group title="My applications">
        <Row title={`${Object.values(mine.status).filter((s) => s === "saved").length} saved, ${Object.values(mine.status).filter((s) => s === "applied").length} applied`} desc="Copy the list to paste into a spreadsheet or your notes.">
          <Button variant="outline" disabled={!myJobs.length} onClick={copy}>Copy list</Button>
        </Row>
        {fallback && <Textarea ref={taRef} readOnly rows={5} value={fallback} aria-label="Your roles" className="mb-4 text-xs" />}
        {downloads && (
          <Row title="Add deadlines to your calendar" desc={withDeadline.length ? `Saves a file with ${withDeadline.length} deadline${withDeadline.length === 1 ? "" : "s"} that Google Calendar can import. Next: ${fmt([...withDeadline].sort((a, b) => a.deadline.localeCompare(b.deadline))[0].deadline)}.` : "Save or apply to roles with a deadline first."}>
            <Button variant="outline" disabled={!withDeadline.length} onClick={exportDeadlines}><CalendarPlus className="size-4" /> Export deadlines</Button>
          </Row>
        )}
        <Row title="Clear my list" desc="Moves every saved and applied role back to To apply. Notes are kept.">
          <Button variant="outline" disabled={!mineIds.length} className="border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={() => setClearOpen(true)}>Clear list</Button>
        </Row>
        <Row title="Restore default settings">
          <Button variant="outline" onClick={() => { setSettings(DEFAULT_SETTINGS); toast("Default settings restored") }}>Restore defaults</Button>
        </Row>
      </Group>

      <Dialog open={clearOpen} onOpenChange={setClearOpen}>
        <DialogContent className="w-[calc(100vw-2rem)] max-w-md">
          <DialogHeader className="text-left">
            <DialogTitle className="font-display text-xl">Clear your list?</DialogTitle>
            <DialogDescription>All {mineIds.length} saved and applied roles move back to To apply.</DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setClearOpen(false)}>Cancel</Button>
            <Button variant="destructive" onClick={() => { setStatus(mineIds, null).then(() => toast("List cleared"), () => toast("Couldn't clear the list. Try again.")); setClearOpen(false) }}>Clear list</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
