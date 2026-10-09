import "server-only"
import { cache } from "react"
import { auth } from "@/lib/auth/server"
import { db } from "@/lib/server/db"
import type { AccessStatus, Role } from "@/lib/generated/prisma/client"

/**
 * Who is asking, and what they may do.
 *
 * Signing in (Google through Neon Auth) proves who someone is. Whether they can use the app is
 * decided here, from this app's own Profile table:
 *   - a staff invite or pre-approval for their verified email (AccessGrant) gives that role at once;
 *   - otherwise, on their first sign-in, a verified email at a domain in ALLOWED_EMAIL_DOMAINS makes them
 *     an active student (later, only staff decide: someone set back to pending or blocked stays that way);
 *   - otherwise they wait as "pending" until staff approve them on the Admin page.
 * Unverified addresses (e.g. an email/password sign-up that hasn't confirmed) never get access
 * from a grant or domain match, so nobody can claim a staff invite by typing someone's address.
 */
export interface Viewer {
  id: string
  email: string
  emailVerified: boolean
  name: string | null
  role: Role
  status: AccessStatus
  lastVisit: Date | null
  layout: unknown
}

export class AccessError extends Error {
  constructor(public code: "signedout" | "pending" | "blocked" | "forbidden") {
    super(
      code === "signedout" ? "Please sign in again." :
      code === "pending" ? "Your account is waiting for staff approval." :
      code === "blocked" ? "This account doesn't have access." :
      "You don't have permission to do that."
    )
  }
}

export const allowedDomains = () =>
  (process.env.ALLOWED_EMAIL_DOMAINS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase().replace(/^@/, ""))
    .filter(Boolean)

const domainOk = (email: string) => {
  const d = email.split("@")[1] || ""
  return allowedDomains().some((a) => d === a || d.endsWith("." + a))
}

export async function audit(actorId: string | null, action: string, target?: string | null, detail?: unknown) {
  await db().auditLog.create({ data: { actorId, action, target: target ?? null, detail: detail === undefined ? undefined : JSON.parse(JSON.stringify(detail)) } })
}

/** The signed-in person with their Profile, created on first visit. One lookup per request. */
export const getViewer = cache(async (): Promise<Viewer | null> => {
  const { data } = await auth().getSession()
  const u = data?.user
  if (!u?.id || !u.email) return null
  const email = u.email.trim().toLowerCase()
  const verified = !!u.emailVerified
  const name = u.name?.trim() || null
  const prisma = db()

  let p = await prisma.profile.findUnique({ where: { id: u.id } })
  const grant = verified && (!p || p.status === "pending") ? await prisma.accessGrant.findUnique({ where: { email } }) : null
  const autoStudent = !p && verified && domainOk(email)

  if (!p) {
    p = await prisma.profile.upsert({
      where: { id: u.id },
      create: {
        id: u.id, email, emailVerified: verified, name,
        role: grant?.role ?? "student",
        status: grant || autoStudent ? "active" : "pending",
      },
      update: {},
    })
    if (grant) {
      await prisma.accessGrant.deleteMany({ where: { email } })
      await audit(u.id, "access.grant-applied", u.id, { email, role: grant.role })
    }
  } else if (p.status === "pending" && grant) {
    p = await prisma.profile.update({ where: { id: u.id }, data: { status: "active", role: grant.role } })
    await prisma.accessGrant.deleteMany({ where: { email } })
    await audit(u.id, "access.grant-applied", u.id, { email, role: grant.role })
  }
  if (p.email !== email || p.name !== name || p.emailVerified !== verified) {
    p = await prisma.profile.update({ where: { id: u.id }, data: { email, name, emailVerified: verified } })
  }
  return { id: p.id, email: p.email, emailVerified: p.emailVerified, name: p.name, role: p.role, status: p.status, lastVisit: p.lastVisit, layout: p.layout }
})

/** Signed in and approved. Every server action that reads or writes app data starts here. */
export async function requireActive(): Promise<Viewer> {
  const v = await getViewer()
  if (!v) throw new AccessError("signedout")
  if (v.status === "blocked") throw new AccessError("blocked")
  if (v.status !== "active") throw new AccessError("pending")
  return v
}

export const isStaff = (r: Role) => r === "staff" || r === "admin"

export async function requireStaff(): Promise<Viewer> {
  const v = await requireActive()
  if (!isStaff(v.role)) throw new AccessError("forbidden")
  return v
}

export async function requireAdmin(): Promise<Viewer> {
  const v = await requireActive()
  if (v.role !== "admin") throw new AccessError("forbidden")
  return v
}
