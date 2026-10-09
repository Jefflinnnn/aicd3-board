import { NextResponse, type NextRequest } from "next/server"
import { auth, authConfigured } from "@/lib/auth/server"

/**
 * Every page and server action requires a signed-in session; without one the visitor is sent to
 * /auth/sign-in. Neon Auth's middleware also completes the Google sign-in when the browser comes
 * back from the provider. What a signed-in person may see is checked again on the server for each
 * request (lib/server/access.ts) — this only keeps anonymous visitors out.
 *
 * /api/ingest is the scraper's door: it has no browser session and checks its own bearer token.
 */
const OPEN = ["/api/ingest"]

export default async function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname
  if (OPEN.some((p) => path === p || path.startsWith(p + "/"))) return NextResponse.next()
  if (!authConfigured()) {
    // Local development before `neon deploy`: run on sample data in the browser.
    if (process.env.NODE_ENV !== "production") return NextResponse.next()
    return new NextResponse("Sign-in isn't configured on this deployment yet.", { status: 503 })
  }
  return auth().middleware({ loginUrl: "/auth/sign-in" })(request)
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.svg|robots.txt).*)"],
}
