/**
 * `prisma migrate deploy` for networks that block Postgres's port 5432 (UCSF's, for one): applies the migrations in
 * prisma/migrations that the database hasn't recorded yet, over Neon's serverless driver, which connects through the
 * regular HTTPS port like the app itself does. Each migration runs in a transaction with its row in Prisma's own
 * _prisma_migrations table, so `prisma migrate deploy` / `status` later see it as applied.
 *
 *   pnpm db:deploy:web               # the database in .env.local (refuses production)
 *   pnpm db:deploy:web --status      # only show what's applied and what's pending
 *   pnpm db:deploy:web --production  # allow it when .env.local points at production (normally Vercel's deploy does this)
 *
 * Uses DATABASE_URL_UNPOOLED (else DATABASE_URL) from the environment or .env.local / .env.
 */
import { createHash, randomUUID } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { config } from "dotenv"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
config({ path: [path.join(ROOT, ".env.local"), path.join(ROOT, ".env")], quiet: true })
const args = new Set(process.argv.slice(2))
const statusOnly = args.has("--status")
const url = (process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL || "").trim().replace(/^["']|["']$/g, "")
if (!url) {
  console.error("No DATABASE_URL_UNPOOLED or DATABASE_URL (in .env.local).")
  process.exit(1)
}
let host = "?"
try { host = new URL(url).host } catch { /* shown as ? */ }
const branch = process.env.NEON_BRANCH || "unknown"
if (branch === "production" && !args.has("--production") && !statusOnly) {
  console.error(`.env.local points at the PRODUCTION database (NEON_BRANCH=production, ${host}). Production deploys apply ` +
    "migrations themselves; to do it from here anyway, add --production.")
  process.exit(1)
}

// the drivers the app's Prisma adapters already bring along
const req = createRequire(import.meta.url)
async function connect() {
  if (/\.neon\.tech\b/.test(host)) {
    const { Pool } = createRequire(req.resolve("@prisma/adapter-neon"))("@neondatabase/serverless")
    return new Pool({ connectionString: url })   // WebSockets over port 443 (Node 22+ has WebSocket built in)
  }
  const pg = createRequire(req.resolve("@prisma/adapter-pg"))("pg")
  return new pg.Pool({ connectionString: url })
}

const dir = path.join(ROOT, "prisma", "migrations")
const local = fs.readdirSync(dir, { withFileTypes: true })
  .filter((d) => d.isDirectory() && fs.existsSync(path.join(dir, d.name, "migration.sql")))
  .map((d) => d.name).sort()
  .map((name) => {
    const sql = fs.readFileSync(path.join(dir, name, "migration.sql"), "utf8")
    return { name, sql, checksum: createHash("sha256").update(sql).digest("hex") }
  })

const pool = await connect()
const client = await pool.connect()
let code = 0
try {
  console.log(`Database: ${host} (NEON_BRANCH=${branch})`)
  // Prisma's own bookkeeping table, as `prisma migrate deploy` creates it
  await client.query(`CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
    "id" VARCHAR(36) PRIMARY KEY NOT NULL,
    "checksum" VARCHAR(64) NOT NULL,
    "finished_at" TIMESTAMPTZ,
    "migration_name" VARCHAR(255) NOT NULL,
    "logs" TEXT,
    "rolled_back_at" TIMESTAMPTZ,
    "started_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "applied_steps_count" INTEGER NOT NULL DEFAULT 0
  )`)
  const { rows } = await client.query(
    `SELECT migration_name, checksum FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`)
  const applied = new Map(rows.map((r) => [r.migration_name, r.checksum]))
  const pending = local.filter((m) => !applied.has(m.name))
  for (const m of local) {
    if (applied.has(m.name) && applied.get(m.name) !== m.checksum) console.log(`  note: ${m.name} was changed after it was applied (left as it is)`)
  }
  console.log(`${local.length - pending.length} of ${local.length} migrations applied.`)
  if (!pending.length) {
    console.log("Nothing to apply.")
  } else if (statusOnly) {
    console.log("Pending:\n" + pending.map((m) => "  " + m.name).join("\n"))
  } else {
    for (const m of pending) {
      process.stdout.write(`Applying ${m.name} ... `)
      try {
        await client.query("BEGIN")
        await client.query(m.sql)
        await client.query(
          `INSERT INTO "_prisma_migrations" (id, checksum, finished_at, migration_name, started_at, applied_steps_count)
           VALUES ($1, $2, now(), $3, now(), 1)`, [randomUUID(), m.checksum, m.name])
        await client.query("COMMIT")
        console.log("done")
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {})
        console.log("FAILED")
        console.error(`  ${e instanceof Error ? e.message : e}\n  Nothing from this migration was kept; the ones after it weren't tried.`)
        code = 1
        break
      }
    }
  }
} finally {
  client.release()
  await pool.end()
}
process.exit(code)
