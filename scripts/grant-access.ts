/**
 * Give someone a role from the command line, e.g. the first admin:
 *
 *   pnpm grant-access you@school.edu admin
 *
 * If they have signed in already, their account changes now; otherwise the role is applied
 * the first time they sign in with that (Google-verified) email.
 */
import "dotenv/config"
import { PrismaNeon } from "@prisma/adapter-neon"
import { PrismaPg } from "@prisma/adapter-pg"
import { PrismaClient } from "../lib/generated/prisma/client"

const [emailRaw, roleRaw = "admin"] = process.argv.slice(2)
const email = (emailRaw || "").trim().toLowerCase()
const role = roleRaw as "student" | "staff" | "admin"
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !["student", "staff", "admin"].includes(role)) {
  console.error("Usage: pnpm grant-access <email> [student|staff|admin]")
  process.exit(1)
}
const url = process.env.DATABASE_URL
if (!url) {
  console.error("DATABASE_URL isn't set. Run `neon deploy` (or `neon env pull`) first.")
  process.exit(1)
}
const prisma = new PrismaClient({ adapter: /\.neon\.tech\b/.test(url) ? new PrismaNeon({ connectionString: url }) : new PrismaPg({ connectionString: url }) })

async function main() {
  const existing = await prisma.profile.findMany({ where: { email } })
  if (existing.length) {
    await prisma.profile.updateMany({ where: { email }, data: { role, status: "active" } })
    console.log(`${email} is now ${role} (active).`)
  } else {
    await prisma.accessGrant.upsert({ where: { email }, create: { email, role, grantedBy: "cli" }, update: { role, grantedBy: "cli" } })
    console.log(`${email} will be ${role} when they first sign in.`)
  }
  await prisma.auditLog.create({ data: { action: "access.cli-grant", target: email, detail: { role } } })
}
main().finally(() => prisma.$disconnect())
