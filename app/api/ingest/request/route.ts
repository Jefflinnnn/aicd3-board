import { z } from "zod"
import { refuseIngest } from "@/lib/server/ingest-auth"
import { db } from "@/lib/server/db"
import { audit } from "@/lib/server/access"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * "Refresh now" on the live site's Admin page, for the GPU PC. Vercel can't run the scraper, so the button leaves a
 * request in the database; scraper/refresh_requests.ps1 on the GPU PC asks here every few minutes.
 *
 *   GET  /api/ingest/request                      -> { requested, at, running }   (X-AICD3-Host: the PC's name)
 *   POST /api/ingest/request  {"action":"claim"}   -> { claimed }   take the request (only one caller gets it)
 *   POST /api/ingest/request  {"action":"requeue"} -> { requeued }  put it back (the run couldn't start)
 *   Authorization: Bearer $SCRAPER_INGEST_TOKEN
 *
 * The PC only claims a request while no refresh is running, so a manual refresh never overlaps the 9 AM / 9 PM ones.
 */
export async function GET(req: Request) {
  const refused = refuseIngest(req)
  if (refused) return refused
  // remember who's listening, so the Admin page can say whether the GPU PC is checking at all
  const host = (req.headers.get("x-aicd3-host") || "").replace(/[^\w .-]/g, "").slice(0, 100) || null
  const check = { requestCheckAt: new Date(), requestCheckHost: host }
  await db().siteMeta.upsert({ where: { id: 1 }, create: { id: 1, ...check }, update: check })
  const [meta, running] = await Promise.all([
    db().siteMeta.findUnique({ where: { id: 1 }, select: { refreshRequestedAt: true } }),
    db().scrapeRun.findFirst({ where: { status: "running" }, select: { id: true } }),
  ])
  return Response.json({
    requested: !!meta?.refreshRequestedAt,
    at: meta?.refreshRequestedAt?.toISOString() ?? null,
    running: !!running,
  })
}

const body = z.object({ action: z.enum(["claim", "requeue"]) })

export async function POST(req: Request) {
  const refused = refuseIngest(req)
  if (refused) return refused
  const parsed = body.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return Response.json({ error: 'Send {"action": "claim"} or {"action": "requeue"}.' }, { status: 400 })
  if (parsed.data.action === "claim") {
    // atomic: of two callers, only the one whose update matched gets the request
    const meta = await db().siteMeta.findUnique({ where: { id: 1 }, select: { refreshRequestedAt: true, refreshRequestedBy: true } })
    if (!meta?.refreshRequestedAt) return Response.json({ claimed: false })
    const r = await db().siteMeta.updateMany({
      where: { id: 1, refreshRequestedAt: meta.refreshRequestedAt },
      data: { refreshRequestedAt: null, refreshRequestedBy: null },
    })
    if (r.count) await audit(null, "refresh.request-claimed", null, { by: meta.refreshRequestedBy })
    return Response.json({ claimed: r.count > 0 })
  }
  await db().siteMeta.upsert({ where: { id: 1 }, create: { id: 1, refreshRequestedAt: new Date() }, update: { refreshRequestedAt: new Date() } })
  return Response.json({ requeued: true })
}
