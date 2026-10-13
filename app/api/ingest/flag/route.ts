import { z } from "zod"
import { audit } from "@/lib/server/access"
import { refuseIngest } from "@/lib/server/ingest-auth"
import { db } from "@/lib/server/db"
import { idsSchema, toJob, touchMeta, upsertStaged } from "@/lib/server/postings"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * Sends postings scraper/check_open.py couldn't confirm are still open to the staff review queue.
 *
 *   POST /api/ingest/flag   {"ids": ["j…", …], "reasons": {"j…": "posting page answered 500"}}
 *   Authorization: Bearer $SCRAPER_INGEST_TOKEN
 *
 * Only live, open postings move. Each waits in the review queue with the checker's reason as its
 * flag: Approve puts it back on the job board, Reject keeps it off.
 */
export async function POST(req: Request) {
  const refused = refuseIngest(req)
  if (refused) return refused
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: "Send JSON: {\"ids\": [...]}" }, { status: 400 })
  }
  const parsed = z.object({ ids: idsSchema, reasons: z.record(z.string(), z.string().max(300)).optional() }).safeParse(body)
  if (!parsed.success) return Response.json({ error: "ids must be a list of posting ids" }, { status: 400 })
  const { ids, reasons = {} } = parsed.data
  const rows = await db().posting.findMany({ where: { id: { in: ids }, state: "live", closed: false } })
  if (!rows.length) return Response.json({ ok: true, flagged: 0 })
  const now = Date.now()
  const flagged = await db().$transaction(async (tx) => {
    const n = await upsertStaged(tx, rows.map((r) => ({
      ...toJob(r),
      review: {
        flags: [("Couldn't confirm it's still open: " + (reasons[r.id] || "no answer from the site")).slice(0, 300)],
        source: "check" as const, at: now, status: "pending" as const,
      },
    })), ["live"])
    await touchMeta(tx)
    return n
  })
  await audit(null, "postings.check-unconfirmed", null, { ids: rows.map((r) => r.id), reasons, flagged })
  return Response.json({ ok: true, flagged })
}
