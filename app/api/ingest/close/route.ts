import { z } from "zod"
import { audit } from "@/lib/server/access"
import { refuseIngest } from "@/lib/server/ingest-auth"
import { db } from "@/lib/server/db"
import { idsSchema, touchMeta } from "@/lib/server/postings"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * Marks postings the employer has taken down, as found by scraper/check_open.py.
 *
 *   POST /api/ingest/close   {"ids": ["j…", …], "reasons": {"j…": "404 on the posting page"}}
 *   Authorization: Bearer $SCRAPER_INGEST_TOKEN
 *
 * Only live, open postings change; they stay on the board as "Taken down" (expired) and staff can
 * reopen one from the Admin page if the check was wrong.
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
  const { ids, reasons } = parsed.data
  const r = await db().posting.updateMany({ where: { id: { in: ids }, state: "live", closed: false }, data: { closed: true } })
  if (r.count) {
    await touchMeta()
    await audit(null, "postings.check-closed", null, { ids, reasons: reasons ?? {}, closed: r.count })
  }
  return Response.json({ ok: true, closed: r.count })
}
