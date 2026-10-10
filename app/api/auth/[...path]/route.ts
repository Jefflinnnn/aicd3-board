import { auth, authConfigured } from "@/lib/auth/server"
import { canSignIn, domainsLabel, signInDomains } from "@/lib/domains"

type Ctx = { params: Promise<{ path: string[] }> }

/**
 * Proxies the browser's auth calls to Neon Auth, but only the ones this app uses, and only for
 * UCSF addresses (SIGN_IN_EMAIL_DOMAINS): email + password sign-in and sign-up, the emailed codes
 * that confirm a new address, reset a password or sign in without one, the session, and sign-out.
 * Social sign-in, magic links, anonymous tokens, email changes and the admin/organization APIs
 * are refused here.
 * (lib/server/access.ts also turns away any non-UCSF session on every request, in case someone
 * talks to Neon Auth directly.)
 */
/** paths whose request body names an email address, which must be a UCSF one */
const EMAIL_PATHS = new Set([
  "sign-in/email", "sign-up/email",
  "sign-in/email-otp", "email-otp/send-verification-otp", "email-otp/verify-email",
  "email-otp/request-password-reset", "email-otp/reset-password",
])
const ALLOWED = new Set([
  ...EMAIL_PATHS,
  "get-session", "sign-out", "token", "list-sessions", "revoke-session", "revoke-other-sessions",
])
const CODE_TYPES = new Set(["sign-in", "email-verification", "forget-password"])

const refuse = (status: number, error: string, code?: string) => Response.json({ error, message: error, code }, { status })

async function route(method: "GET" | "POST", req: Request, ctx: Ctx) {
  if (!authConfigured()) return refuse(503, "Sign-in isn't configured yet.")
  const path = ((await ctx.params).path || []).join("/")
  if (!ALLOWED.has(path)) return refuse(404, "Not found")
  if (EMAIL_PATHS.has(path)) {
    const body = await req.text()
    let data: { type?: unknown; email?: unknown }
    try {
      data = JSON.parse(body)
    } catch {
      return refuse(400, "Bad request")
    }
    // codes to sign in, confirm an address or reset a password (not to change email)
    if (path === "email-otp/send-verification-otp" && !CODE_TYPES.has(String(data.type))) return refuse(400, "That kind of code isn't available.")
    if (typeof data.email !== "string" || !canSignIn(data.email))
      return refuse(403, `Only ${domainsLabel(signInDomains())} email addresses can sign in.`, "EMAIL_DOMAIN_NOT_ALLOWED")
    req = new Request(req.url, { method: req.method, headers: req.headers, body })
  }
  return auth().handler()[method](req, ctx)
}

export const GET = (req: Request, ctx: Ctx) => route("GET", req, ctx)
export const POST = (req: Request, ctx: Ctx) => route("POST", req, ctx)
