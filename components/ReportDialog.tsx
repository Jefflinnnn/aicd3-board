"use client"

import { useEffect, useState } from "react"
import { Check, ChevronsUpDown } from "lucide-react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { useApp } from "@/lib/state"
import { ISSUE_KINDS, TODAY, coById, iso, isLive } from "@/lib/data"
import { isEmail } from "@/lib/validate"
import { cn } from "@/lib/utils"

const NONE = "none"

export function ReportDialog({ open, onOpenChange, jobId }: { open: boolean; onOpenChange: (o: boolean) => void; jobId: string | null }) {
  const { jobs, addReport } = useApp()
  const [pick, setPick] = useState(false)
  const [busy, setBusy] = useState(false)
  const [sendErr, setSendErr] = useState("")
  const [kind, setKind] = useState(ISSUE_KINDS[0])
  const [job, setJob] = useState(NONE)
  const [details, setDetails] = useState("")
  const [email, setEmail] = useState("")
  const [err, setErr] = useState<{ details?: string; email?: string }>({})

  useEffect(() => {
    if (open) {
      setJob(jobId || NONE)
      setKind(jobId ? ISSUE_KINDS[0] : ISSUE_KINDS[4])
      setDetails("")
      setEmail("")
      setErr({})
      setSendErr("")
    }
  }, [open, jobId])

  const options = [...jobs].sort((a, b) => Number(isLive(b)) - Number(isLive(a)) || a.title.localeCompare(b.title))

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    const next: typeof err = {}
    if (details.trim().length < 10) next.details = "Tell us a little more so we can find and fix it (at least 10 characters)."
    if (email.trim() && !isEmail(email)) next.email = "Enter an email address such as name@university.edu."
    setErr(next)
    if (next.details || next.email) return
    setBusy(true)
    const ok = await addReport({ id: "i" + Date.now(), kind, jobId: job === NONE ? "" : job, details: details.trim(), email: email.trim(), date: iso(TODAY) })
    setBusy(false)
    if (!ok) return setSendErr("We couldn't send that. Sending reports needs Contributor access to this page, so ask the program team to give you access.")
    toast("Thanks, we got your report", { description: "The program team will take a look." })
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[calc(100vw-2rem)] max-w-lg">
        <form onSubmit={submit} noValidate className="flex flex-col gap-4">
          <DialogHeader className="text-left">
            <DialogTitle className="font-display text-xl">Report an issue</DialogTitle>
            <DialogDescription>Spotted a broken link, a closed posting or wrong details? Let us know.</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ikind">What's wrong?</Label>
            <Select value={kind} onValueChange={setKind}>
              <SelectTrigger id="ikind"><SelectValue /></SelectTrigger>
              <SelectContent>{ISSUE_KINDS.map((k) => <SelectItem key={k} value={k}>{k}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ijob">Which posting? (optional)</Label>
            <Popover open={pick} onOpenChange={setPick} modal>
              <PopoverTrigger asChild>
                <Button id="ijob" type="button" variant="outline" role="combobox" aria-expanded={pick} className="justify-between font-normal">
                  <span className="truncate">{job === NONE ? "Not about a specific posting" : (() => { const j = jobs.find((x) => x.id === job); return j ? `${j.title}, ${coById(j.company).name}` : "Not about a specific posting" })()}</span>
                  <ChevronsUpDown className="size-4 shrink-0 opacity-50" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
                <Command>
                  <CommandInput placeholder="Search by title or company" />
                  <CommandList className="max-h-64">
                    <CommandEmpty>No posting matches.</CommandEmpty>
                    <CommandGroup>
                      <CommandItem value="none not about a specific posting" onSelect={() => { setJob(NONE); setPick(false) }}>
                        <Check className={cn("mr-2 size-4", job === NONE ? "opacity-100" : "opacity-0")} /> Not about a specific posting
                      </CommandItem>
                      {options.map((j) => (
                        <CommandItem key={j.id} value={`${j.title} ${coById(j.company).name} ${j.id}`} onSelect={() => { setJob(j.id); setPick(false) }}>
                          <Check className={cn("mr-2 size-4 shrink-0", job === j.id ? "opacity-100" : "opacity-0")} />
                          <span className="truncate">{j.title}, {coById(j.company).name}{isLive(j) ? "" : " (expired)"}</span>
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="idetails">Details</Label>
            <Textarea
              id="idetails"
              rows={4}
              value={details}
              onChange={(e) => setDetails(e.target.value)}
              placeholder="What did you expect, and what happened instead?"
              aria-invalid={!!err.details}
              aria-describedby={err.details ? "idetails-err" : undefined}
              className={cn(err.details && "border-destructive")}
            />
            {err.details && <p id="idetails-err" className="text-xs text-destructive">{err.details}</p>}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="iemail">Your email (optional)</Label>
            <Input
              id="iemail"
              type="email"
              inputMode="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onBlur={() => setErr((x) => ({ ...x, email: email.trim() && !isEmail(email) ? "Enter an email address such as name@university.edu." : undefined }))}
              placeholder="So we can follow up"
              aria-invalid={!!err.email}
              aria-describedby={err.email ? "iemail-err" : undefined}
              className={cn(err.email && "border-destructive")}
            />
            {err.email && <p id="iemail-err" className="text-xs text-destructive">{err.email}</p>}
          </div>
          {sendErr && <p className="text-sm text-destructive" role="alert">{sendErr}</p>}
          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={busy}>{busy ? "Sending…" : "Send report"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
