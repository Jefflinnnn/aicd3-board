import { audit } from "@/lib/server/access"
import { refuseIngest } from "@/lib/server/ingest-auth"
import { runImport } from "@/lib/server/postings"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const MAX_BYTES = 10 * 1024 * 1024

/**
 * The scraper posts its output here (same JSON or CSV the Admin import dialog takes).
 *
 *   POST /api/ingest?reviewAll=1&closeMissing=0&dryRun=0
 *   Authorization: Bearer $SCRAPER_INGEST_TOKEN
 *
 * By default every new posting goes to the staff review queue; nothing reaches students until
 * staff approve it. Changes to postings already on the board are applied directly.
 */
export async function POST(req: Request) {
  const refused = refuseIngest(req)
  if (refused) return refused

  if (Number(req.headers.get("content-length") || 0) > MAX_BYTES) return Response.json({ error: "Too large" }, { status: 413 })
  const body = await req.text()
  if (body.length > MAX_BYTES) return Response.json({ error: "Too large" }, { status: 413 })

  const q = new URL(req.url).searchParams
  const opts = { reviewAll: q.get("reviewAll") !== "0", closeMissing: q.get("closeMissing") === "1", dryRun: q.get("dryRun") === "1" }
  try {
    const summary = await runImport(body, opts)
    if (!opts.dryRun) await audit(null, "postings.ingest", null, { ...summary, errors: summary.errors.length, opts })
    return Response.json({ ok: true, dryRun: opts.dryRun, ...summary })
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "Import failed" }, { status: 400 })
  }
}
