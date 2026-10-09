"use server"

/**
 * Staff provisioning: who can use the app, and who is staff.
 *
 *   - Staff can approve or block students, and pre-approve student emails.
 *   - Only admins can make someone staff or admin, change a staff member's access, or remove a person.
 *   - Nobody can change their own role or access, and the last active admin can't be demoted.
 * Every change is written to the audit log.
 */
import { z } from "zod"
import { db } from "@/lib/server/db"
import { Prisma } from "@/lib/generated/prisma/client"
import { AccessError, audit, requireStaff } from "@/lib/server/access"
import { isEmail } from "@/lib/validate"
import type { Invite, Person, Role } from "@/lib/types"

const roleSchema = z.enum(["student", "staff", "admin"])
const statusSchema = z.enum(["pending", "active", "blocked"])
const emailSchema = z.string().trim().toLowerCase().max(320).refine(isEmail, "Not an email address")

export async function listPeople(): Promise<{ people: Person[]; invites: Invite[]; viewerRole: Role }> {
  const v = await requireStaff()
  const [people, invites] = await Promise.all([
    db().profile.findMany({ orderBy: [{ status: "asc" }, { createdAt: "desc" }] }),
    db().accessGrant.findMany({ orderBy: { createdAt: "desc" } }),
  ])
  return {
    viewerRole: v.role,
    people: people.map((p) => ({ id: p.id, email: p.email, emailVerified: p.emailVerified, name: p.name, role: p.role, status: p.status, createdAt: p.createdAt.getTime() })),
    invites: invites.map((g) => ({ email: g.email, role: g.role, createdAt: g.createdAt.getTime() })),
  }
}

type Tx = Parameters<Parameters<ReturnType<typeof db>["$transaction"]>[0]>[0]

/**
 * Run an access change with every other access change waiting its turn (a Postgres advisory lock),
 * so two admins demoting each other at the same moment can't leave the app without an admin.
 */
function serialized<T>(fn: (tx: Tx) => Promise<T>) {
  return db().$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(724501)`
    return fn(tx)
  })
}

async function assertAdminsRemain(tx: Tx, changingId: string) {
  const others = await tx.profile.count({ where: { role: "admin", status: "active", id: { not: changingId } } })
  if (others === 0) throw new Error("There has to be at least one active admin.")
}

/** Change someone's role and/or access. */
export async function setAccess(userId: string, patch: { role?: Role; status?: "pending" | "active" | "blocked" }) {
  const v = await requireStaff()
  const id = z.string().min(1).max(128).parse(userId)
  const role = roleSchema.optional().parse(patch.role)
  const status = statusSchema.optional().parse(patch.status)
  if (id === v.id) throw new Error("You can't change your own access.")
  const target = await serialized(async (tx) => {
    const t = await tx.profile.findUnique({ where: { id } })
    if (!t) throw new Error("That person wasn't found.")
    const touchesStaff = t.role !== "student" || (role && role !== "student")
    if (touchesStaff && v.role !== "admin") throw new AccessError("forbidden")
    if (role && role !== "student" && !t.emailVerified) throw new Error("That account's email isn't verified, so it can't be made staff. Ask them to sign in with Google.")
    if (t.role === "admin" && t.status === "active" && ((role && role !== "admin") || (status && status !== "active"))) await assertAdminsRemain(tx, id)
    await tx.profile.update({ where: { id }, data: { ...(role ? { role } : {}), ...(status ? { status } : {}) } })
    return t
  })
  await audit(v.id, "access.set", id, { email: target.email, from: { role: target.role, status: target.status }, to: { role, status } })
}

/** Approve or block several students at once (the pending list). */
export async function setStudentsAccess(userIds: string[], status: "active" | "blocked") {
  const v = await requireStaff()
  const ids = z.array(z.string().min(1).max(128)).max(500).parse(userIds).filter((x) => x !== v.id)
  const st = z.enum(["active", "blocked"]).parse(status)
  const r = await db().profile.updateMany({ where: { id: { in: ids }, role: "student" }, data: { status: st } })
  await audit(v.id, "access.bulk", null, { ids, status: st, changed: r.count })
  return r.count
}

/**
 * Invite by email. If they've already signed in, their access changes now; otherwise it waits
 * for their first sign-in with that (verified) address.
 */
export async function invite(emailRaw: string, roleRaw: Role) {
  const v = await requireStaff()
  const email = emailSchema.parse(emailRaw)
  const role = roleSchema.parse(roleRaw)
  if (role !== "student" && v.role !== "admin") throw new AccessError("forbidden")
  // Only accounts whose provider verified this address get access now. Anyone else holding the
  // address unverified gets nothing; the invite waits for a verified sign-in.
  const existing = (await db().profile.findMany({ where: { email } })).filter((p) => p.emailVerified && p.id !== v.id)
  if (existing.length) {
    for (const p of existing) {
      if (p.role !== "student" && v.role !== "admin") throw new AccessError("forbidden")
      if (p.role === "admin" && role !== "admin" && p.status === "active") {
        await serialized(async (tx) => {
          await assertAdminsRemain(tx, p.id)
          await tx.profile.update({ where: { id: p.id }, data: { role, status: "active" } })
        })
      } else {
        await db().profile.update({ where: { id: p.id }, data: { role, status: "active" } })
      }
    }
    await audit(v.id, "access.invite-existing", email, { role })
    return { applied: true }
  }
  await db().accessGrant.upsert({ where: { email }, create: { email, role, grantedBy: v.id }, update: { role, grantedBy: v.id } })
  await audit(v.id, "access.invite", email, { role })
  return { applied: false }
}

export async function revokeInvite(emailRaw: string) {
  const v = await requireStaff()
  const email = emailSchema.parse(emailRaw)
  const g = await db().accessGrant.findUnique({ where: { email } })
  if (!g) return
  if (g.role !== "student" && v.role !== "admin") throw new AccessError("forbidden")
  await db().accessGrant.delete({ where: { email } })
  await audit(v.id, "access.revoke-invite", email, { role: g.role })
}

/**
 * Remove a person: delete everything they saved here (lists, notes, dashboard layout, requests,
 * reports) and block the account, so signing in again doesn't bring them back. An admin can
 * unblock them later; they start with nothing.
 */
export async function removePerson(userId: string) {
  const v = await requireStaff()
  if (v.role !== "admin") throw new AccessError("forbidden")
  const id = z.string().min(1).max(128).parse(userId)
  if (id === v.id) throw new Error("You can't remove yourself.")
  const target = await serialized(async (tx) => {
    const t = await tx.profile.findUnique({ where: { id } })
    if (!t) return null
    if (t.role === "admin" && t.status === "active") await assertAdminsRemain(tx, id)
    await tx.jobStatus.deleteMany({ where: { userId: id } })
    await tx.jobNote.deleteMany({ where: { userId: id } })
    await tx.companyRequest.deleteMany({ where: { userId: id } })
    await tx.issueReport.deleteMany({ where: { userId: id } })
    await tx.profile.update({ where: { id }, data: { role: "student", status: "blocked", name: null, layout: Prisma.DbNull, lastVisit: null } })
    await tx.accessGrant.deleteMany({ where: { email: t.email } })
    return t
  })
  if (target) await audit(v.id, "access.remove", id, { email: target.email, role: target.role })
}
