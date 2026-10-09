"use client"

import { CloudOff, Hourglass, Inbox, LogIn, ShieldX } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useApp } from "@/lib/state"

/** Full-page states shown before (or instead of) the data: loading, signed out, nothing posted yet. */
export function Gate({ kind }: { kind: "loading" | "signedout" | "empty" | "pending" | "blocked" | "unavailable" }) {
  if (kind === "loading")
    return (
      <div className="flex flex-col gap-5" aria-busy="true" aria-label="Loading postings">
        <div className="h-5 w-64 animate-pulse rounded bg-muted" />
        <div className="grid h-28 animate-pulse rounded-lg bg-muted" />
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="h-72 animate-pulse rounded-lg bg-muted" />
          <div className="h-72 animate-pulse rounded-lg bg-muted" />
        </div>
      </div>
    )
  if (kind === "signedout")
    return (
      <Card icon={<LogIn className="size-5" />} title="Sign in to see postings">
        Your session ended. Taking you to the sign-in page…
      </Card>
    )
  if (kind === "pending" || kind === "blocked") return <Waiting blocked={kind === "blocked"} />
  if (kind === "unavailable")
    return (
      <Card icon={<CloudOff className="size-5" />} title="Can't load postings right now">
        The server didn&apos;t answer. Check your connection and reload the page in a moment.
        <div className="mt-4"><Button variant="outline" onClick={() => window.location.reload()}>Reload</Button></div>
      </Card>
    )
  return <Empty />
}

function Waiting({ blocked }: { blocked: boolean }) {
  const { me, signOut } = useApp()
  return (
    <Card icon={blocked ? <ShieldX className="size-5" /> : <Hourglass className="size-5" />} title={blocked ? "No access" : "Waiting for approval"}>
      {blocked
        ? "This account doesn't have access to AICD3 Launchpad. If you think that's a mistake, contact the program team."
        : "Thanks for signing in. Program staff approve new accounts, usually within a day; this page will show the postings once you're approved."}
      {me.email && <p className="mt-3">Signed in as <b className="font-medium text-foreground">{me.email}</b></p>}
      <div className="mt-4 flex gap-2">
        {!blocked && <Button onClick={() => window.location.reload()}>Check again</Button>}
        <Button variant="outline" onClick={signOut}>Use a different account</Button>
      </div>
    </Card>
  )
}

function Empty() {
  const { me, go } = useApp()
  return (
    <Card icon={<Inbox className="size-5" />} title="No postings yet">
      {me.canEdit ? (
        <>
          Add postings from the scraper on the Admin page to fill the dashboard and job board.
          <div className="mt-4"><Button onClick={() => go("admin")}>Go to Admin</Button></div>
        </>
      ) : (
        "The program team hasn't added any postings yet. Check back soon."
      )}
    </Card>
  )
}

function Card({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div className="mx-auto mt-[8vh] flex max-w-md flex-col gap-3 rounded-lg border bg-card p-6">
      <span className="grid size-10 place-items-center rounded-lg bg-muted text-foreground">{icon}</span>
      <h1 className="font-display text-xl font-semibold">{title}</h1>
      <div className="text-sm text-muted-foreground">{children}</div>
    </div>
  )
}
