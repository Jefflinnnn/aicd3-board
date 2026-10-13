/** Runs once when the server starts: begins the automatic job data refresh checks (lib/server/refresh.ts). */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return
  if (process.env.NODE_ENV === "development" && process.env.NEON_BRANCH === "production") {
    console.warn(
      "\n⚠  This local server is connected to the PRODUCTION database (NEON_BRANCH=production in .env.local).\n" +
        "   Edits, imports and refreshes here change what students see. Point .env.local at a dev branch\n" +
        "   instead (README → Local development database).\n",
    )
  }
  const { startScheduler } = await import("./lib/server/refresh")
  startScheduler()
}

/**
 * Every unhandled error in a page, route or server action, as one structured log line. On Vercel these
 * show up under the project's Logs (filter by "request-error"); locally they print in the terminal.
 * Only the path and the error go out: no request bodies, cookies or headers.
 */
export async function onRequestError(
  err: unknown,
  request: { path: string; method: string },
  context: { routerKind: string; routePath: string; routeType: string },
) {
  const e = err as Error & { digest?: string }
  console.error(
    JSON.stringify({
      event: "request-error",
      method: request.method,
      path: request.path.split("?")[0],
      route: context.routePath,
      type: context.routeType,
      digest: e?.digest,
      error: e?.name,
      message: e?.message?.slice(0, 500),
      stack: e?.stack?.split("\n").slice(0, 6).join("\n"),
    }),
  )
}
