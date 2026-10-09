import { auth, authConfigured } from "@/lib/auth/server"

type Ctx = { params: Promise<{ path: string[] }> }

/**
 * Proxies the browser's auth calls to Neon Auth, but only the ones this app uses: Google sign-in,
 * the session, and sign-out. Email/password sign-up, magic links, OTP, anonymous tokens and the
 * admin/organization APIs are refused here, so nobody can create an account that would later be
 * linked to someone's Google sign-in. (Also turn email/password off in the Neon Console.)
 */
const ALLOWED = new Set(["sign-in/social", "get-session", "sign-out", "token", "list-sessions", "revoke-session", "revoke-other-sessions"])

const refuse = (status: number, error: string) => Response.json({ error }, { status })

async function route(method: "GET" | "POST", req: Request, ctx: Ctx) {
  if (!authConfigured()) return refuse(503, "Sign-in isn't configured yet.")
  const { path } = await ctx.params
  if (!ALLOWED.has((path || []).join("/"))) return refuse(404, "Not found")
  return auth().handler()[method](req, ctx)
}

export const GET = (req: Request, ctx: Ctx) => route("GET", req, ctx)
export const POST = (req: Request, ctx: Ctx) => route("POST", req, ctx)
