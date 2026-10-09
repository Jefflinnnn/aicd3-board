import "dotenv/config"
import { defineConfig, env } from "prisma/config"

// Prisma CLI (migrate, db push, studio) uses the direct, unpooled connection.
// The app itself connects through the pooled DATABASE_URL (see lib/server/db.ts).
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: {
    url: env("DATABASE_URL_UNPOOLED"),
  },
})
