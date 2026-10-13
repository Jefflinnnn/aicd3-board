import "server-only"
import { createHash, timingSafeEqual } from "node:crypto"
import { dbConfigured } from "@/lib/server/db"

const digest = (s: string) => createHash("sha256").update(s).digest()

/**
 * Checks the scraper's bearer token (SCRAPER_INGEST_TOKEN, compared in constant time).
 * Returns a response to send back when the request isn't allowed, or null when it is.
 */
export function refuseIngest(req: Request): Response | null {
  if (process.env.DEMO_MODE === "1") return Response.json({ error: "Not found" }, { status: 404 })   // never on the public demo
  const token = process.env.SCRAPER_INGEST_TOKEN || ""
  if (token.length < 32 || !dbConfigured()) return Response.json({ error: "Ingest isn't configured." }, { status: 503 })
  const sent = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "")
  if (!sent || !timingSafeEqual(digest(sent), digest(token))) return Response.json({ error: "Unauthorized" }, { status: 401 })
  return null
}
