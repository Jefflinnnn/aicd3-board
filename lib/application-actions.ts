"use server"

/**
 * Staff view of who applied to what. Reads the Application table, which keeps its own copy of each
 * role, so roles that have since expired, been taken down or been deleted for good still show up.
 */
import { db } from "@/lib/server/db"
import { requireStaff } from "@/lib/server/access"
import { toJob } from "@/lib/server/postings"
import { isLive } from "@/lib/data"
import type { AppliedPostingState, StudentApplications } from "@/lib/types"

export async function listApplications(): Promise<{ students: StudentApplications[] }> {
  await requireStaff()
  const prisma = db()
  const apps = await prisma.application.findMany({
    orderBy: { appliedAt: "desc" },
    include: { user: { select: { id: true, name: true, email: true, status: true, role: true } } },
  })
  // where each role stands now; ones missing from this lookup have been deleted for good
  const postings = await prisma.posting.findMany({ where: { id: { in: [...new Set(apps.map((a) => a.postingId))] } } })
  const now = new Map<string, AppliedPostingState>(postings.map((p) => [p.id, p.state === "live" && isLive(toJob(p)) ? "open" : p.state === "live" ? "expired" : "removed"]))

  const byUser = new Map<string, StudentApplications>()
  for (const a of apps) {
    const row = byUser.get(a.userId) ?? { id: a.user.id, name: a.user.name, email: a.user.email, status: a.user.status, applications: [] }
    row.applications.push({
      postingId: a.postingId, title: a.title, company: a.company, location: a.location, url: a.url,
      deadline: a.deadline, appliedAt: a.appliedAt.getTime(), state: now.get(a.postingId) ?? "removed",
    })
    byUser.set(a.userId, row)
  }
  return { students: [...byUser.values()] }
}
