"use client"

import { useState } from "react"
import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { ArrowLeft, Eye, EyeOff, Loader2, Mail } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { AICD_LOGO_INNER } from "@/components/aicdLogo"
import { authClient } from "@/lib/auth/client"
import { isEmail } from "@/lib/validate"
import { domainsLabel, inDomains } from "@/lib/domains"

/**
 * UCSF email + password, with emailed codes only where they're needed:
 *   - signin:     email and password (the everyday path)
 *   - signup:     name, email, password, then one code to confirm the address (verify)
 *   - reset:      "Forgot or never set a password?" -> code + new password (resetCode).
 *                 Also how someone who has only used codes so far sets a password.
 *   - code:       sign in with a code instead (codeEnter)
 * The server checks the UCSF domain again (app/api/auth and lib/server/access.ts); the checks here
 * only give quick messages.
 */
type View = "signin" | "signup" | "verify" | "reset" | "resetCode" | "code" | "codeEnter"
type ErrLike = { status?: number; code?: string; message?: string } | null

const MIN_PW = 8

/** Error codes arrive either as Better Auth's (EMAIL_NOT_VERIFIED) or normalized (email_not_confirmed). */
const has = (e: ErrLike, re: RegExp) => re.test(`${e?.code || ""} ${e?.message || ""}`)

/** The auth client returns some errors and throws others (e.g. "Email verification required"); treat both alike. */
async function call<T>(p: Promise<{ error: ErrLike } & T>): Promise<{ error: ErrLike }> {
  try {
    const r = await p
    return { error: r.error ?? null }
  } catch (e) {
    const x = e as { message?: string; code?: string; status?: number }
    const message = x?.message || ""
    return { error: { message, status: x?.status ?? (/verif/i.test(message) ? 403 : 0), code: x?.code || (/verif/i.test(message) ? "EMAIL_NOT_VERIFIED" : "") } }
  }
}

export function SignIn({ domains }: { domains: string[] }) {
  const params = useSearchParams()
  const router = useRouter()
  const session = authClient.useSession()
  const label = domainsLabel(domains)
  const [view, setViewS] = useState<View>("signin")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [name, setName] = useState("")
  const [code, setCode] = useState("")
  const [showPw, setShowPw] = useState(false)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(params.get("error") ? "Sign-in didn't finish. Try again." : null)

  const go = (v: View, msg: string | null = null) => { setViewS(v); setErr(null); setNote(msg); setCode("") }
  const addr = () => email.trim().toLowerCase()
  const checkEmail = () => {
    if (!isEmail(addr())) return "Enter your email address."
    if (!inDomains(addr(), domains)) return `Use your ${label} email address.`
    return null
  }
  const otp = () => code.replace(/\D/g, "")
  const done = () => { router.replace("/"); router.refresh() }
  const explain = (e: ErrLike, fallback: string) => {
    // Neon Auth refuses sites missing from its trusted domains (Neon console > Auth > Configuration > Domains)
    if (has(e, /INVALID_ORIGIN|invalid origin/i)) return "Sign-in isn't enabled for this web address yet. An admin needs to add it to the trusted domains in Neon Auth."
    // a code is void after 3 wrong tries: waiting doesn't help, a new code does
    if (has(e, /TOO_MANY_ATTEMPTS|too many attempts/i)) return "That code was entered wrong too many times, so it no longer works. Choose “Send a new code” and use the newest email."
    if (e?.status === 429 || has(e, /TOO_MANY|rate_limit/i)) return "Too many tries. Wait a minute and try again."
    if (has(e, /DOMAIN_NOT_ALLOWED|addresses can sign in/i)) return `Use your ${label} email address.`
    if (has(e, /PASSWORD_TOO_LONG/i)) return "That password is too long. Use 128 characters or fewer."
    if (has(e, /PASSWORD_TOO|weak_password/i)) return `Use at least ${MIN_PW} characters.`
    if (has(e, /COMPROMISED|breach|pwned/i)) return "That password appears in known data breaches. Choose a different one."
    if (has(e, /OTP_EXPIRED|expired/i)) return "That code has expired (codes last a few minutes). Choose “Send a new code”."
    if (has(e, /OTP|invalid code/i)) return "That code didn't work. Only the newest code works; check it, or send a new one."
    // say what the server said rather than hide it behind a generic line
    return e?.message && !/^(fetch failed|failed to fetch)$/i.test(e.message) ? `${fallback} (${e.message})` : fallback
  }
  /** wrap a step: one at a time, errors shown under the form */
  const run = (fn: () => Promise<void>) => async (e?: React.FormEvent) => {
    e?.preventDefault()
    if (busy) return
    setBusy(true)
    setErr(null)
    try {
      await fn()
    } catch {
      setErr("Something went wrong. Check your connection and try again.")
    } finally {
      setBusy(false)
    }
  }

  const signIn = run(async () => {
    const bad = checkEmail()
    if (bad) return setErr(bad)
    if (!password) return setErr("Enter your password.")
    const { error } = await call(authClient.signIn.email({ email: addr(), password }))
    if (!error) return done()
    if (has(error, /NOT_VERIFIED|not_confirmed|verification required/i)) {
      await call(authClient.emailOtp.sendVerificationOtp({ email: addr(), type: "email-verification" }))
      return go("verify", "Confirm your email first: we sent a 6-digit code to " + addr() + ".")
    }
    setErr(explain(error, "Email or password is incorrect. If you've never set a password, choose \u201cForgot your password, or never set one?\u201d"))
  })

  const signUp = run(async () => {
    const bad = checkEmail()
    if (bad) return setErr(bad)
    if (!name.trim()) return setErr("Enter your name.")
    if (password.length < MIN_PW) return setErr(`Use at least ${MIN_PW} characters for your password.`)
    const { error } = await call(authClient.signUp.email({ email: addr(), password, name: name.trim() }))
    if (error) {
      if (error.status === 409 || has(error, /EXIST|already/i))
        return setErr("There's already an account for this address. Sign in, or set a new password below.")
      return setErr(explain(error, "Couldn't create the account. Try again in a moment."))
    }
    go("verify", "We sent a 6-digit code to " + addr() + " to confirm it's yours.")
  })

  const verify = run(async () => {
    if (otp().length < 6) return setErr("Enter the 6-digit code from the email.")
    const { error } = await call(authClient.emailOtp.verifyEmail({ email: addr(), otp: otp() }))
    if (error) return setErr(explain(error, "That code didn't work. Check it, or send a new one."))
    const r = await call(authClient.signIn.email({ email: addr(), password }))
    if (r.error) return go("signin", "Email confirmed. Sign in with your password.")
    done()
  })

  const requestReset = run(async () => {
    const bad = checkEmail()
    if (bad) return setErr(bad)
    const { error } = await call(authClient.emailOtp.requestPasswordReset({ email: addr() }))
    if (error) return setErr(explain(error, "Couldn't send a code. Try again in a moment."))
    setPassword("")
    go("resetCode", "If there's an account for " + addr() + ", we sent it a 6-digit code. New here? Create an account instead.")
  })

  const reset = run(async () => {
    if (otp().length < 6) return setErr("Enter the 6-digit code from the email.")
    if (password.length < MIN_PW) return setErr(`Use at least ${MIN_PW} characters for your new password.`)
    const { error } = await call(authClient.emailOtp.resetPassword({ email: addr(), otp: otp(), password }))
    if (error) return setErr(explain(error, "Couldn't set the password. Check the code and try again."))
    const r = await call(authClient.signIn.email({ email: addr(), password }))
    if (r.error) return go("signin", "Password saved. Sign in with it now.")
    done()
  })

  const sendCode = run(async () => {
    const bad = checkEmail()
    if (bad) return setErr(bad)
    const { error } = await call(authClient.emailOtp.sendVerificationOtp({ email: addr(), type: "sign-in" }))
    if (error) return setErr(explain(error, "Couldn't send a code. Check the address and try again."))
    go("codeEnter", "We sent a 6-digit code to " + addr() + ".")
  })

  const codeSignIn = run(async () => {
    if (otp().length < 6) return setErr("Enter the 6-digit code from the email.")
    const { error } = await call(authClient.signIn.emailOtp({ email: addr(), otp: otp() }))
    if (error) return setErr(explain(error, "That code didn't work. Check it, or send a new one."))
    done()
  })

  const resend = run(async () => {
    const type = view === "verify" ? "email-verification" : view === "resetCode" ? "forget-password" : "sign-in"
    const { error } = type === "forget-password"
      ? await call(authClient.emailOtp.requestPasswordReset({ email: addr() }))
      : await call(authClient.emailOtp.sendVerificationOtp({ email: addr(), type }))
    if (error) return setErr(explain(error, "Couldn't send a new code. Try again in a moment."))
    setNote("We sent a new code to " + addr() + ".")
  })

  const emailField = (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor="email">UCSF email</Label>
      <Input id="email" type="email" autoComplete="username" value={email} onChange={(e) => { setEmail(e.target.value); setErr(null) }} placeholder={`you${label.split(" ")[0]}`} />
    </div>
  )
  const passwordField = (id: string, labelText: string, autoComplete: string) => (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{labelText}</Label>
      <div className="relative">
        <Input id={id} type={showPw ? "text" : "password"} autoComplete={autoComplete} value={password} onChange={(e) => { setPassword(e.target.value); setErr(null) }} className="pr-10" />
        <button type="button" onClick={() => setShowPw((s) => !s)} aria-label={showPw ? "Hide password" : "Show password"} className="absolute inset-y-0 right-0 grid w-10 place-items-center text-muted-foreground hover:text-foreground">
          {showPw ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
        </button>
      </div>
      {autoComplete === "new-password" && <p className="text-xs text-muted-foreground">At least {MIN_PW} characters. Don&apos;t reuse your MyAccess password.</p>}
    </div>
  )
  const codeField = (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor="otp">6-digit code</Label>
      <Input id="otp" inputMode="numeric" autoComplete="one-time-code" maxLength={8} value={code} onChange={(e) => { setCode(e.target.value); setErr(null) }} placeholder="123456" className="tracking-[0.3em]" autoFocus />
    </div>
  )
  const spin = busy && <Loader2 className="animate-spin" />
  const link = "text-primary hover:underline disabled:opacity-50"
  const back = (
    <button type="button" className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground" onClick={() => go("signin")}>
      <ArrowLeft className="size-3.5" /> Back to sign in
    </button>
  )

  const titles: Record<View, string> = {
    signin: "Sign in", signup: "Create your account", verify: "Confirm your email", reset: "Set a new password",
    resetCode: "Set a new password", code: "Sign in with a code", codeEnter: "Check your email",
  }

  return (
    <main className="grid min-h-full place-items-center bg-background px-4 py-16">
      <div className="flex w-full max-w-sm flex-col gap-6 rounded-lg border bg-card p-7 shadow-sm">
        <div className="flex items-center gap-2.5">
          <svg viewBox="52 50 400 400" className="size-8" aria-hidden dangerouslySetInnerHTML={{ __html: AICD_LOGO_INNER }} />
          <span className="text-lg tracking-tight"><b className="font-semibold">AICD3</b> <span className="text-muted-foreground">Job Board</span></span>
        </div>

        {session.data?.user ? (
          <>
            <h1 className="font-display text-xl font-semibold">You&apos;re signed in</h1>
            <Button asChild><Link href="/">Continue as {session.data.user.name || session.data.user.email}</Link></Button>
          </>
        ) : (
          <>
            <div className="flex flex-col gap-1.5">
              <h1 className="font-display text-xl font-semibold">{titles[view]}</h1>
              {view === "signin" && <p className="text-sm text-muted-foreground">Internship postings for AICD3 students. Use your {label} address.</p>}
              {view === "reset" && <p className="text-sm text-muted-foreground">Forgot your password, or never set one? We&apos;ll email you a code to set it.</p>}
              {view === "code" && <p className="text-sm text-muted-foreground">We&apos;ll email a 6-digit code to your {label} address.</p>}
              {note && <p className="text-sm text-muted-foreground">{note}</p>}
            </div>

            {view === "signin" && (
              <>
                <form onSubmit={signIn} className="flex flex-col gap-3">
                  {emailField}
                  {passwordField("password", "Password", "current-password")}
                  <Button type="submit" disabled={busy}>{spin} Sign in</Button>
                </form>
                <div className="flex flex-col gap-2 text-sm">
                  <button type="button" className={link + " self-start"} onClick={() => go("reset")}>Forgot your password, or never set one?</button>
                  <button type="button" className={link + " self-start"} onClick={() => go("code")}>Email me a sign-in code instead</button>
                  <p className="text-muted-foreground">New here? <button type="button" className={link} onClick={() => go("signup")}>Create an account</button></p>
                </div>
              </>
            )}

            {view === "signup" && (
              <>
                <form onSubmit={signUp} className="flex flex-col gap-3">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="name">Your name</Label>
                    <Input id="name" autoComplete="name" value={name} onChange={(e) => { setName(e.target.value); setErr(null) }} />
                  </div>
                  {emailField}
                  {passwordField("new-password", "Choose a password", "new-password")}
                  <Button type="submit" disabled={busy}>{spin} Create account</Button>
                </form>
                <div className="text-sm">{back}</div>
              </>
            )}

            {(view === "verify" || view === "resetCode" || view === "codeEnter") && (
              <>
                <form onSubmit={view === "verify" ? verify : view === "resetCode" ? reset : codeSignIn} className="flex flex-col gap-3">
                  {codeField}
                  {view === "resetCode" && passwordField("new-password", "New password", "new-password")}
                  <Button type="submit" disabled={busy}>{spin} {view === "verify" ? "Confirm and sign in" : view === "resetCode" ? "Save password and sign in" : "Sign in"}</Button>
                </form>
                <div className="flex justify-between text-sm">
                  {back}
                  <button type="button" className={link} disabled={busy} onClick={() => resend()}>Send a new code</button>
                </div>
              </>
            )}

            {(view === "reset" || view === "code") && (
              <>
                <form onSubmit={view === "reset" ? requestReset : sendCode} className="flex flex-col gap-3">
                  {emailField}
                  <Button type="submit" disabled={busy}>{busy ? <Loader2 className="animate-spin" /> : <Mail />} Email me a code</Button>
                </form>
                <div className="text-sm">{back}</div>
              </>
            )}
          </>
        )}

        {err && <p role="alert" className="text-sm text-destructive">{err}</p>}
        <p className="text-xs text-muted-foreground">
          Your saved lists and notes are private to you. Requests and reports you send go to program staff.
        </p>
      </div>
    </main>
  )
}
