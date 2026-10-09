import { createHash, timingSafeEqual } from "node:crypto"
import { audit } from "@/lib/server/access"
import { dbConfigured } from "@/lib/server/db"
import { runImport } from "@/lib/server/postings"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const MAX_BYTES = 10 * 1024 * 1024
const digest = (s: string) => createHash("sha256").update(s).digest()

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
  const token = process.env.SCRAPER_INGEST_TOKEN || ""
  if (token.length < 32 || !dbConfigured()) return Response.json({ error: "Ingest isn't configured." }, { status: 503 })
  const sent = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "")
  if (!sent || !timingSafeEqual(digest(sent), digest(token))) return Response.json({ error: "Unauthorized" }, { status: 401 })

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
