"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { Check, MailPlus, ShieldAlert, UserX } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Panel } from "@/components/common"
import { Segmented } from "@/components/Segmented"
import { cn } from "@/lib/utils"
import { isEmail } from "@/lib/validate"
import { useApp } from "@/lib/state"
import { invite, listPeople, removePerson, revokeInvite, setAccess, setStudentsAccess } from "@/lib/people-actions"
import type { Invite, Person, Role } from "@/lib/types"

type Tab = "pending" | "students" | "staff" | "invites" | "blocked"
const ROLE_LABEL: Record<Role, string> = { student: "Student", staff: "Staff", admin: "Admin" }

/**
 * Staff provisioning on the Admin page: approve new students, invite people by email,
 * and (admins only) make people staff or admin.
 */
export function People({ flash }: { flash?: boolean }) {
  const { mode, me } = useApp()
  const [people, setPeople] = useState<Person[] | null>(null)
  const [invites, setInvites] = useState<Invite[]>([])
  const [viewerRole, setViewerRole] = useState<Role>("staff")
  const [tab, setTab] = useState<Tab>("pending")
  const [email, setEmail] = useState("")
  const [role, setRole] = useState<Role>("student")
  const [err, setErr] = useState("")
  const [removing, setRemoving] = useState<Person | null>(null)
  const [busy, setBusy] = useState(false)
  const isAdmin = viewerRole === "admin"

  const [version, setVersion] = useState(0)
  const load = useCallback(() => setVersion((n) => n + 1), [])
  useEffect(() => {
    if (mode !== "cloud") return
    let off = false
    listPeople().then(
      (r) => {
        if (off) return
        setPeople(r.people)
        setInvites(r.invites)
        setViewerRole(r.viewerRole)
      },
      () => {
        if (off) return
        setPeople([])
        toast("Couldn't load the people list.")
      }
    )
    return () => { off = true }
  }, [mode, version])

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true)
    try {
      await fn()
      toast(ok)
    } catch (e) {
      toast("That didn't work.", { description: e instanceof Error && e.message && !/server components render/i.test(e.message) ? e.message : "Check that you have permission, then try again." })
    } finally {
      setBusy(false)
      load()
    }
  }

  const groups = useMemo(() => {
    const p = people || []
    return {
      pending: p.filter((x) => x.status === "pending"),
      students: p.filter((x) => x.status === "active" && x.role === "student"),
      staff: p.filter((x) => x.status === "active" && x.role !== "student"),
      blocked: p.filter((x) => x.status === "blocked"),
    }
  }, [people])

  if (mode === "preview")
    return (
      <Panel id="admin-people" title="People & access" sub="Approving students and adding staff works once sign-in and the database are set up (see the README).">
        <p className="text-sm text-muted-foreground">This local preview has no accounts.</p>
      </Panel>
    )

  const sendInvite = (e: React.FormEvent) => {
    e.preventDefault()
    const addr = email.trim().toLowerCase()
    if (!isEmail(addr)) return setErr("Enter an email address.")
    run(async () => {
      const r = await invite(addr, role)
      setEmail("")
      if (!r.applied) setTab("invites")
    }, role === "student" ? `${addr} can sign in now` : `${addr} will be ${ROLE_LABEL[role].toLowerCase()} when they sign in`)
  }

  const rows = tab === "invites" ? [] : groups[tab]
  return (
    <Panel
      id="admin-people"
      flush
      className={cn("transition-shadow duration-500", flash && "ring-2 ring-primary")}
      title="People & access"
      sub="Everyone signs in with Google. New accounts wait here until staff approve them, unless their email was invited or matches an approved school domain."
      right={
        <Segmented
          label="Show"
          value={tab}
          onChange={setTab}
          items={[
            ["pending", `Waiting (${groups.pending.length})`],
            ["students", `Students (${groups.students.length})`],
            ["staff", `Staff (${groups.staff.length})`],
            ["invites", `Invites (${invites.length})`],
            ["blocked", `Blocked (${groups.blocked.length})`],
          ]}
        />
      }
    >
      <form onSubmit={sendInvite} className="flex flex-wrap items-end gap-2 border-t px-5 py-3">
        <div className="flex min-w-[220px] flex-1 flex-col gap-1.5">
          <Label htmlFor="invite-email">Invite by email</Label>
          <Input id="invite-email" type="email" value={email} onChange={(e) => { setEmail(e.target.value); setErr("") }} placeholder="name@school.edu" aria-invalid={!!err} aria-describedby={err ? "invite-err" : undefined} />
        </div>
        <Select value={role} onValueChange={(v) => setRole(v as Role)}>
          <SelectTrigger className="w-36" aria-label="Role"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="student">Student</SelectItem>
            {isAdmin && <SelectItem value="staff">Staff</SelectItem>}
            {isAdmin && <SelectItem value="admin">Admin</SelectItem>}
          </SelectContent>
        </Select>
        <Button type="submit" disabled={busy}><MailPlus /> Invite</Button>
        {err && <p id="invite-err" className="basis-full text-xs text-destructive">{err}</p>}
        {!isAdmin && <p className="basis-full text-xs text-muted-foreground">Only admins can add staff.</p>}
      </form>

      {people === null ? (
        <p className="border-t px-5 py-8 text-center text-sm text-muted-foreground">Loading…</p>
      ) : tab === "invites" ? (
        invites.length ? (
          <ul>
            {invites.map((g) => (
              <li key={g.email} className="flex flex-wrap items-center gap-3 border-t px-5 py-2.5 text-sm">
                <span className="min-w-0 flex-1 truncate font-medium">{g.email}</span>
                <span className="text-muted-foreground">{ROLE_LABEL[g.role]}, not signed in yet</span>
                {(isAdmin || g.role === "student") && (
                  <Button size="sm" variant="ghost" className="h-7" disabled={busy} onClick={() => run(() => revokeInvite(g.email), "Invite withdrawn")}>Withdraw</Button>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="border-t px-5 py-8 text-center text-sm text-muted-foreground">No open invites.</p>
        )
      ) : rows.length ? (
        <>
          {tab === "pending" && rows.length > 1 && (
            <div className="flex items-center justify-end gap-2 border-t bg-accent/50 px-5 py-2">
              <Button size="sm" variant="outline" className="h-8" disabled={busy} onClick={() => run(() => setStudentsAccess(rows.filter((p) => p.role === "student").map((p) => p.id), "active"), `Approved ${rows.length} people`)}>
                <Check className="size-3.5" /> Approve all {rows.length}
              </Button>
            </div>
          )}
          <ul>
            {rows.map((p) => {
              const self = p.id === me.id
              const canTouch = !self && (isAdmin || p.role === "student")
              return (
                <li key={p.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t px-5 py-2.5 text-sm">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{p.name || p.email}{self && <span className="ml-1.5 text-xs font-normal text-muted-foreground">(you)</span>}</p>
                    <p className="flex flex-wrap items-center gap-1.5 truncate text-xs text-muted-foreground">
                      {p.email}
                      {!p.emailVerified && (
                        <span className="inline-flex items-center gap-1 rounded bg-warn-soft px-1.5 py-px font-medium text-warn"><ShieldAlert className="size-3" /> Email not verified</span>
                      )}
                      <span>· joined {new Date(p.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</span>
                    </p>
                  </div>
                  {isAdmin && p.status === "active" ? (
                    <Select value={p.role} disabled={self || busy} onValueChange={(v) => run(() => setAccess(p.id, { role: v as Role }), `${p.name || p.email} is now ${ROLE_LABEL[v as Role].toLowerCase()}`)}>
                      <SelectTrigger className="h-8 w-28" aria-label={`Role for ${p.email}`}><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="student">Student</SelectItem>
                        <SelectItem value="staff">Staff</SelectItem>
                        <SelectItem value="admin">Admin</SelectItem>
                      </SelectContent>
                    </Select>
                  ) : (
                    p.status === "active" && <span className="text-muted-foreground">{ROLE_LABEL[p.role]}</span>
                  )}
                  {canTouch && p.status !== "active" && (
                    <Button size="sm" variant="outline" className="h-8" disabled={busy} onClick={() => run(() => setAccess(p.id, { status: "active" }), p.status === "blocked" ? "Access restored" : "Approved")}>
                      <Check className="size-3.5" /> {p.status === "blocked" ? "Unblock" : "Approve"}
                    </Button>
                  )}
                  {canTouch && p.status !== "blocked" && (
                    <Button size="sm" variant="ghost" className="h-8" disabled={busy} onClick={() => run(() => setAccess(p.id, { status: "blocked" }), "Blocked")}>Block</Button>
                  )}
                  {isAdmin && !self && (
                    <Button size="sm" variant="ghost" className="h-8 text-destructive hover:bg-destructive/10 hover:text-destructive" disabled={busy} onClick={() => setRemoving(p)}>
                      <UserX className="size-3.5" /> Remove
                    </Button>
                  )}
                </li>
              )
            })}
          </ul>
        </>
      ) : (
        <p className="border-t px-5 py-8 text-center text-sm text-muted-foreground">
          {tab === "pending" ? "Nobody is waiting for approval." : tab === "blocked" ? "Nobody is blocked." : "Nobody here yet."}
        </p>
      )}

      <Dialog open={!!removing} onOpenChange={(o) => !o && setRemoving(null)}>
        <DialogContent className="w-[calc(100vw-2rem)] max-w-md">
          <DialogHeader className="text-left">
            <DialogTitle className="font-display text-xl">Remove {removing?.name || removing?.email}?</DialogTitle>
            <DialogDescription>
              This deletes their saved and applied lists, notes, requests and reports from Launchpad and blocks the account. It can&apos;t be undone. You can unblock them later from the Blocked list; they start with nothing.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setRemoving(null)}>Cancel</Button>
            <Button variant="destructive" onClick={() => { const p = removing; setRemoving(null); if (p) run(() => removePerson(p.id), "Removed") }}>Remove</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Panel>
  )
}
