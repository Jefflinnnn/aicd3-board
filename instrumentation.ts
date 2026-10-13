/** Runs once when the server starts: begins the automatic job data refresh checks (lib/server/refresh.ts). */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return
  const { startScheduler } = await import("./lib/server/refresh")
  startScheduler()
}
