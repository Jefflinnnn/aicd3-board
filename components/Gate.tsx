"use client"

import { Inbox, LogIn } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useApp } from "@/lib/state"

/** Full-page states shown before (or instead of) the data: loading, signed out, nothing posted yet. */
export function Gate({ kind }: { kind: "loading" | "signedout" | "empty" }) {
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
        Sign in to Claude to load the internship postings.
      </Card>
    )
  return <Empty />
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
