/**
 * Vercel's build (package.json "vercel-build"). On a production deploy, applies any new database
 * migrations before building, so new code never goes live against an old schema. Preview deploys
 * and local builds skip it: they must never change the production database. So does the public demo
 * (DEMO_MODE=1), which has no database at all.
 *
 * Needs DATABASE_URL_UNPOOLED (Neon's direct connection) in Vercel's Production environment variables.
 * Migrations should only add things (new tables, new nullable or defaulted columns); if a build fails
 * after migrating, the live site keeps running the previous code against the new schema.
 */
import { spawnSync } from "node:child_process"

const run = (cmd, args, env = process.env) => {
  console.log(`> ${cmd} ${args.join(" ")}`)
  const r = spawnSync(cmd, args, { stdio: "inherit", shell: process.platform === "win32", env })
  if (r.status !== 0) process.exit(r.status ?? 1)
}

/**
 * The connection string as pasted into Vercel, tidied: surrounding spaces and quotes (copied from
 * .env.local, where values are often quoted) and a pasted "NAME=" in front are removed. Returns the
 * cleaned value, or explains what's wrong without printing the secret.
 */
export function cleanDbUrl(name, raw) {
  let v = (raw || "").trim()
  v = v.replace(new RegExp(`^${name}\\s*=\\s*`), "").trim()
  if (/^(["']).*\1$/.test(v)) v = v.slice(1, -1).trim()
  if (/^postgres(ql)?:\/\//.test(v)) return { url: v }
  const start = v.startsWith("psql") ? "a psql command (copy only the postgresql://... part)"
    : /^["']/.test(v) ? "an unmatched quote mark"
    : v.includes("://") ? `the scheme "${v.split("://")[0].slice(0, 20)}" instead of postgresql`
    : "no postgresql:// address"
  return { problem: `${name} in Vercel's Production environment variables has ${start}. It should look like postgresql://user:password@host/dbname?sslmode=require, with no quotes, and be Neon's direct connection (host without -pooler). Fix it and redeploy.` }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  if (process.env.DEMO_MODE === "1") {
    // the public demo has no database by design (README: Public demo)
    console.log("Skipping database migrations: this is the public demo (DEMO_MODE=1), which has no database.")
  } else if (process.env.VERCEL_ENV === "production") {
    if (!process.env.DATABASE_URL_UNPOOLED) {
      console.error("DATABASE_URL_UNPOOLED isn't available to this Production build, so migrations can't run. In this Vercel project's " +
        "Settings > Environment Variables, add it (Neon's direct connection string, no quotes) with the Production environment ticked, " +
        "then redeploy. If this project is the public demo, set DEMO_MODE=1 instead.")
      process.exit(1)
    }
    const { url, problem } = cleanDbUrl("DATABASE_URL_UNPOOLED", process.env.DATABASE_URL_UNPOOLED)
    if (problem) {
      console.error(problem)
      process.exit(1)
    }
    if (url !== process.env.DATABASE_URL_UNPOOLED) console.log("Note: removed quotes or spaces around DATABASE_URL_UNPOOLED; consider fixing the value in Vercel.")
    if (url.includes("-pooler")) console.log("Note: DATABASE_URL_UNPOOLED points at Neon's pooled host (-pooler); migrations work best on the direct one.")
    run("pnpm", ["prisma", "migrate", "deploy"], { ...process.env, DATABASE_URL_UNPOOLED: url })
  } else {
    console.log(`Skipping database migrations (VERCEL_ENV=${process.env.VERCEL_ENV || "unset"}; only production deploys migrate).`)
  }
  run("pnpm", ["build"])
}
