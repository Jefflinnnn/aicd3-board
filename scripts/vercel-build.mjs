/**
 * Vercel's build (package.json "vercel-build"). On a production deploy, applies any new database
 * migrations before building, so new code never goes live against an old schema. Preview deploys
 * and local builds skip it: they must never change the production database.
 *
 * Needs DATABASE_URL_UNPOOLED (Neon's direct connection) in Vercel's Production environment variables.
 * Migrations should only add things (new tables, new nullable or defaulted columns); if a build fails
 * after migrating, the live site keeps running the previous code against the new schema.
 */
import { spawnSync } from "node:child_process"

const run = (cmd, args) => {
  console.log(`> ${cmd} ${args.join(" ")}`)
  const r = spawnSync(cmd, args, { stdio: "inherit", shell: process.platform === "win32" })
  if (r.status !== 0) process.exit(r.status ?? 1)
}

if (process.env.VERCEL_ENV === "production") {
  if (!process.env.DATABASE_URL_UNPOOLED) {
    console.error("DATABASE_URL_UNPOOLED isn't set for Production in Vercel, so migrations can't run. Add it (Neon's direct connection string) and redeploy.")
    process.exit(1)
  }
  run("pnpm", ["prisma", "migrate", "deploy"])
} else {
  console.log(`Skipping database migrations (VERCEL_ENV=${process.env.VERCEL_ENV || "unset"}; only production deploys migrate).`)
}
run("pnpm", ["build"])
