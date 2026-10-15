"use client"

import { useEffect, useRef, useState } from "react"
import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { ArrowLeft, Eye, EyeOff, Loader2, Mail } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Segmented } from "@/components/Segmented"
import { AICD_LOGO_INNER } from "@/components/aicdLogo"
import { authClient } from "@/lib/auth/client"
import { isEmail } from "@/lib/validate"
import { domainsLabel, inDomains } from "@/lib/domains"

/**
 * One page for both: "Create account" and "Sign in" tabs. New visitors land on Create account; anyone who has
 * signed in on this device before lands on Sign in (?mode=signin or ?mode=signup picks one).
 *
 *   Create account   name, UCSF email, password -> a 6-digit code to confirm the address -> signed in
 *   Sign in          email + password (the everyday path), or "Email me a code instead" -> code -> signed in
 *                    "Forgot password?" -> code + new password -> signed in (also how a code-only account sets one)
 *
 * Codes go in one box that takes a pasted code and submits itself once it has 6 digits; "Send a new code" waits
 * 30 seconds between sends. The server checks the UCSF domain again (app/api/auth and lib/server/access.ts); the
 * checks here only give quick messages.
 */
type Mode = "signup" | "signin"
type Step = "form" | "verify" | "code" | "codeEnter" | "reset" | "resetCode"
type ErrLike = { status?: number; code?: string; message?: string } | null

const MIN_PW = 8
const RESEND_WAIT = 30
const KNOWN = "aicd3:has-account"   // set once someone signs in or creates an account on this device

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
const remember = () => { try { localStorage.setItem(KNOWN, "1") } catch { /* private window: fine */ } }
const knownHere = () => { try { return localStorage.getItem(KNOWN) === "1" } catch { return false } }

export function SignIn({ domains }: { domains: string[] }) {
  const params = useSearchParams()
  const router = useRouter()
  const session = authClient.useSession()
  const label = domainsLabel(domains)
  const asked = params.get("mode")
  const [mode, setModeS] = useState<Mode>(asked === "signin" ? "signin" : "signup")
  const [step, setStep] = useState<Step>("form")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [name, setName] = useState("")
  const [code, setCode] = useState("")
  const [showPw, setShowPw] = useState(false)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(params.get("error") ? "Sign-in didn't finish. Try again." : null)
  const [wait, setWait] = useState(0)   // seconds until another code can be sent

  // someone who has signed in on this device before starts on Sign in (after hydration: localStorage is browser-only)
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!asked && knownHere()) setModeS("signin")
  }, [asked])
  useEffect(() => {
    if (wait <= 0) return
    const id = window.setTimeout(() => setWait((w) => w - 1), 1000)
    return () => window.clearTimeout(id)
  }, [wait])

  const go = (s: Step, msg: string | null = null) => { setStep(s); setErr(null); setNote(msg); setCode("") }
  const setMode = (m: Mode, msg: string | null = null) => { setModeS(m); go("form", msg) }
  const addr = () => email.trim().toLowerCase()
  const checkEmail = () => {
    if (!isEmail(addr())) return "Enter your email address."
    if (!inDomains(addr(), domains)) return `Use your ${label} email address.`
    return null
  }
  const otp = (v = code) => v.replace(/\D/g, "").slice(0, 6)
  const done = () => { remember(); router.replace("/"); router.refresh() }
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

  const signUp = run(async () => {
    if (!name.trim()) return setErr("Enter your name.")
    const bad = checkEmail()
    if (bad) return setErr(bad)
    if (password.length < MIN_PW) return setErr(`Use at least ${MIN_PW} characters for your password.`)
    const { error } = await call(authClient.signUp.email({ email: addr(), password, name: name.trim() }))
    if (error) {
      if (error.status === 409 || error.status === 422 || has(error, /EXIST|already/i))
        return setMode("signin", `There's already an account for ${addr()}. Sign in below, or use “Forgot password?” to set a new one.`)
      return setErr(explain(error, "Couldn't create the account. Try again in a moment."))
    }
    remember()
    setWait(RESEND_WAIT)
    go("verify", `We sent a 6-digit code to ${addr()} to confirm it's yours.`)
  })

  const signIn = run(async () => {
    const bad = checkEmail()
    if (bad) return setErr(bad)
    if (!password) return setErr("Enter your password.")
    const { error } = await call(authClient.signIn.email({ email: addr(), password }))
    if (!error) return done()
    if (has(error, /NOT_VERIFIED|not_confirmed|verification required/i)) {
      await call(authClient.emailOtp.sendVerificationOtp({ email: addr(), type: "email-verification" }))
      setWait(RESEND_WAIT)
      return go("verify", `Confirm your email first: we sent a 6-digit code to ${addr()}.`)
    }
    setErr(explain(error, "Email or password is incorrect. No account yet? Use Create account. Never set a password? Use “Email me a code instead”."))
  })

  const verify = (value = code) => run(async () => {
    if (otp(value).length < 6) return setErr("Enter the 6-digit code from the email.")
    const { error } = await call(authClient.emailOtp.verifyEmail({ email: addr(), otp: otp(value) }))
    if (error) return setErr(explain(error, "That code didn't work. Check it, or send a new one."))
    if (!password) return setMode("signin", "Email confirmed. Sign in with your password.")
    const r = await call(authClient.signIn.email({ email: addr(), password }))
    if (r.error) return setMode("signin", "Email confirmed. Sign in with your password.")
    done()
  })()

  const sendCode = run(async () => {
    const bad = checkEmail()
    if (bad) return setErr(bad)
    const { error } = await call(authClient.emailOtp.sendVerificationOtp({ email: addr(), type: "sign-in" }))
    if (error) return setErr(explain(error, "Couldn't send a code. Check the address and try again."))
    setWait(RESEND_WAIT)
    go("codeEnter", `We sent a 6-digit code to ${addr()}.`)
  })

  const codeSignIn = (value = code) => run(async () => {
    if (otp(value).length < 6) return setErr("Enter the 6-digit code from the email.")
    const { error } = await call(authClient.signIn.emailOtp({ email: addr(), otp: otp(value) }))
    if (error) return setErr(explain(error, "That code didn't work. Check it, or send a new one."))
    done()
  })()

  const requestReset = run(async () => {
    const bad = checkEmail()
    if (bad) return setErr(bad)
    const { error } = await call(authClient.emailOtp.requestPasswordReset({ email: addr() }))
    if (error) return setErr(explain(error, "Couldn't send a code. Try again in a moment."))
    setPassword("")
    setWait(RESEND_WAIT)
    go("resetCode", `If there's an account for ${addr()}, we sent it a 6-digit code.`)
  })

  const reset = run(async () => {
    if (otp().length < 6) return setErr("Enter the 6-digit code from the email.")
    if (password.length < MIN_PW) return setErr(`Use at least ${MIN_PW} characters for your new password.`)
    const { error } = await call(authClient.emailOtp.resetPassword({ email: addr(), otp: otp(), password }))
    if (error) return setErr(explain(error, "Couldn't set the password. Check the code and try again."))
    const r = await call(authClient.signIn.email({ email: addr(), password }))
    if (r.error) return setMode("signin", "Password saved. Sign in with it now.")
    done()
  })

  const resend = run(async () => {
    if (wait > 0) return
    const type = step === "verify" ? "email-verification" : step === "resetCode" ? "forget-password" : "sign-in"
    const { error } = type === "forget-password"
      ? await call(authClient.emailOtp.requestPasswordReset({ email: addr() }))
      : await call(authClient.emailOtp.sendVerificationOtp({ email: addr(), type }))
    if (error) return setErr(explain(error, "Couldn't send a new code. Try again in a moment."))
    setCode("")
    setWait(RESEND_WAIT)
    setNote(`We sent a new code to ${addr()}. Only the newest code works.`)
  })

  /* the code box: digits only, paste-friendly, submits itself at 6 digits (not for reset, which also needs a password) */
  const codeRef = useRef<HTMLInputElement>(null)
  useEffect(() => { if (step === "verify" || step === "codeEnter" || step === "resetCode") codeRef.current?.focus() }, [step])
  const onCode = (v: string) => {
    const digits = otp(v)
    setCode(digits)
    setErr(null)
    if (digits.length === 6 && !busy) {
      if (step === "verify") verify(digits)
      else if (step === "codeEnter") codeSignIn(digits)
    }
  }

  const emailField = (autoFocus = false) => (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor="email">UCSF email</Label>
      <Input id="email" type="email" autoComplete="username" autoFocus={autoFocus} value={email} onChange={(e) => { setEmail(e.target.value); setErr(null) }} placeholder={`you${label.split(" ")[0]}`} />
    </div>
  )
  const passwordField = (id: string, labelText: string, autoComplete: string, extra?: React.ReactNode) => (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <Label htmlFor={id}>{labelText}</Label>
        {extra}
      </div>
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
      <Input
        id="otp" ref={codeRef} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]*" maxLength={12} value={code}
        onChange={(e) => onCode(e.target.value)} placeholder="••••••"
        className="h-12 text-center font-mono text-2xl tracking-[0.5em] placeholder:tracking-[0.5em]"
        aria-describedby="otp-help"
      />
      <p id="otp-help" className="text-xs text-muted-foreground">Check your inbox (and spam) for an email from the AICD3 Job Board. The code works for a few minutes.</p>
    </div>
  )
  const spin = busy && <Loader2 className="animate-spin" />
  const link = "text-primary hover:underline disabled:opacity-50 disabled:no-underline"
  const back = (to: Mode = mode) => (
    <button type="button" className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground" onClick={() => setMode(to)}>
      <ArrowLeft className="size-3.5" /> Back
    </button>
  )
  const resendBtn = (
    <button type="button" className={link} disabled={busy || wait > 0} onClick={() => resend()}>
      {wait > 0 ? `Send a new code in ${wait}s` : "Send a new code"}
    </button>
  )

  const heading = step === "verify" ? "Confirm your email" : step === "code" ? "Sign in with a code" : step === "codeEnter" ? "Check your email"
    : step === "reset" || step === "resetCode" ? "Set a new password" : null

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
        ) : step === "form" ? (
          <>
            <div className="flex flex-col gap-3">
              <Segmented
                size="md"
                label="Create an account or sign in"
                value={mode}
                onChange={(m) => setMode(m)}
                className="w-full [&>button]:flex-1"
                items={[["signup", "Create account"], ["signin", "Sign in"]]}
              />
              <p className="text-sm text-muted-foreground">
                {mode === "signup"
                  ? <>Internship postings for AICD3 students. Create your account with your {label} address.</>
                  : <>Welcome back. Use the {label} address you signed up with.</>}
              </p>
              {note && <p className="rounded-md bg-muted px-3 py-2 text-sm">{note}</p>}
            </div>

            {mode === "signup" ? (
              <form onSubmit={signUp} className="flex flex-col gap-3" noValidate>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="name">Your name</Label>
                  <Input id="name" autoComplete="name" value={name} onChange={(e) => { setName(e.target.value); setErr(null) }} />
                </div>
                {emailField()}
                {passwordField("new-password", "Choose a password", "new-password")}
                <Button type="submit" disabled={busy}>{spin} Create account</Button>
                <p className="text-xs text-muted-foreground">We&apos;ll email you a 6-digit code to confirm the address.</p>
              </form>
            ) : (
              <>
                <form onSubmit={signIn} className="flex flex-col gap-3" noValidate>
                  {emailField()}
                  {passwordField("password", "Password", "current-password",
                    <button type="button" className={link + " text-xs"} onClick={() => go("reset")}>Forgot password?</button>)}
                  <Button type="submit" disabled={busy}>{spin} Sign in</Button>
                </form>
                <div className="flex items-center gap-3 text-xs text-muted-foreground">
                  <span className="h-px flex-1 bg-border" /> or <span className="h-px flex-1 bg-border" />
                </div>
                <Button type="button" variant="outline" disabled={busy} onClick={() => go("code")}><Mail /> Email me a sign-in code</Button>
              </>
            )}
          </>
        ) : (
          <>
            <div className="flex flex-col gap-1.5">
              <h1 className="font-display text-xl font-semibold">{heading}</h1>
              {step === "reset" && <p className="text-sm text-muted-foreground">Forgot your password, or never set one? We&apos;ll email you a code to set it.</p>}
              {step === "code" && <p className="text-sm text-muted-foreground">We&apos;ll email a 6-digit code to your {label} address. No password needed.</p>}
              {note && <p className="text-sm text-muted-foreground">{note}</p>}
            </div>

            {(step === "verify" || step === "codeEnter") && (
              <>
                <form onSubmit={(e) => { e.preventDefault(); if (step === "verify") verify(); else codeSignIn() }} className="flex flex-col gap-3">
                  {codeField}
                  <Button type="submit" disabled={busy}>{spin} {step === "verify" ? "Confirm and sign in" : "Sign in"}</Button>
                </form>
                <div className="flex flex-wrap justify-between gap-2 text-sm">
                  {back(step === "verify" ? mode : "signin")}
                  {resendBtn}
                </div>
                <p className="-mt-3 text-xs text-muted-foreground">
                  Wrong address? <button type="button" className={link} onClick={() => setMode(step === "verify" ? "signup" : "signin")}>Change it</button>
                </p>
              </>
            )}

            {step === "resetCode" && (
              <>
                <form onSubmit={reset} className="flex flex-col gap-3">
                  {codeField}
                  {passwordField("new-password", "New password", "new-password")}
                  <Button type="submit" disabled={busy}>{spin} Save password and sign in</Button>
                </form>
                <div className="flex flex-wrap justify-between gap-2 text-sm">{back("signin")}{resendBtn}</div>
              </>
            )}

            {(step === "reset" || step === "code") && (
              <>
                <form onSubmit={step === "reset" ? requestReset : sendCode} className="flex flex-col gap-3" noValidate>
                  {emailField(!email)}
                  <Button type="submit" disabled={busy}>{busy ? <Loader2 className="animate-spin" /> : <Mail />} Email me a code</Button>
                </form>
                <div className="text-sm">{back("signin")}</div>
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
