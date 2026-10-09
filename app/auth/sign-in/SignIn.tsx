"use client"

import { useState } from "react"
import Link from "next/link"
import { useSearchParams } from "next/navigation"
import { Loader2, LogIn } from "lucide-react"
import { Button } from "@/components/ui/button"
import { AICD_LOGO_INNER } from "@/components/aicdLogo"
import { authClient } from "@/lib/auth/client"

export function SignIn() {
  const params = useSearchParams()
  const session = authClient.useSession()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(params.get("error") ? "Sign-in didn't finish. Try again, or use a different Google account." : null)

  const google = async () => {
    setBusy(true)
    setErr(null)
    const { error } = await authClient.signIn.social({
      provider: "google",
      callbackURL: window.location.origin + "/",
      errorCallbackURL: window.location.origin + "/auth/sign-in?error=1",
    })
    if (error) {
      setErr(error.message || "Couldn't reach the sign-in service. Try again in a moment.")
      setBusy(false)
    }
  }

  return (
    <main className="grid min-h-full place-items-center bg-background px-4 py-16">
      <div className="flex w-full max-w-sm flex-col gap-6 rounded-lg border bg-card p-7 shadow-sm">
        <div className="flex items-center gap-2.5">
          <svg viewBox="52 50 400 400" className="size-8" aria-hidden dangerouslySetInnerHTML={{ __html: AICD_LOGO_INNER }} />
          <span className="text-lg tracking-tight"><b className="font-semibold">AICD3</b> <span className="text-muted-foreground">Launchpad</span></span>
        </div>
        <div className="flex flex-col gap-1.5">
          <h1 className="font-display text-xl font-semibold">Sign in</h1>
          <p className="text-sm text-muted-foreground">
            Internship postings for AICD3 students. Sign in with your Google account; new accounts are approved by program staff.
          </p>
        </div>
        {session.data?.user ? (
          <Button asChild><Link href="/">Continue as {session.data.user.name || session.data.user.email}</Link></Button>
        ) : (
          <Button onClick={google} disabled={busy} size="lg">
            {busy ? <Loader2 className="animate-spin" /> : <LogIn />} Continue with Google
          </Button>
        )}
        {err && <p role="alert" className="text-sm text-destructive">{err}</p>}
        <p className="text-xs text-muted-foreground">
          Your saved lists and notes are private to you. Requests and reports you send go to program staff.
        </p>
      </div>
    </main>
  )
}
