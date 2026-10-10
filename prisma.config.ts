import { config } from "dotenv"
import { defineConfig } from "prisma/config"

// `neon deploy` writes .env.local; values there win over .env (same order as Next.js)
config({ path: [".env.local", ".env"], quiet: true })

// Prisma CLI (migrate, db push, studio) uses the direct, unpooled connection.
// The app itself connects through the pooled DATABASE_URL (see lib/server/db.ts).
// `prisma generate` (run on install and build, e.g. on Vercel) needs no database, so a
// missing URL is allowed here; commands that do need one fail with Prisma's own message.
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: {
    url: process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL ?? "",
  },
})
