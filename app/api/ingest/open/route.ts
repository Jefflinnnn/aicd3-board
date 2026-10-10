import { refuseIngest } from "@/lib/server/ingest-auth"
import { db } from "@/lib/server/db"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * Postings currently open on the job board, for scraper/check_open.py to re-check.
 *
 *   GET /api/ingest/open
 *   Authorization: Bearer $SCRAPER_INGEST_TOKEN
 *
 * Returns only what the check needs: id, company, job ID, link and title.
 */
export async function GET(req: Request) {
  const refused = refuseIngest(req)
  if (refused) return refused
  const rows = await db().posting.findMany({
    where: { state: "live", closed: false },
    select: { id: true, company: true, reqId: true, url: true, title: true },
    orderBy: { company: "asc" },
  })
  return Response.json({ postings: rows })
}
