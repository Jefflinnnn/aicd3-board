import "server-only"
import { PrismaNeon } from "@prisma/adapter-neon"
import { PrismaPg } from "@prisma/adapter-pg"
import { PrismaClient } from "@/lib/generated/prisma/client"

/** True once `neon deploy` (or `neon env pull`) has written DATABASE_URL. */
export const dbConfigured = () => !!process.env.DATABASE_URL

function makeClient() {
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) throw new Error("DATABASE_URL is not set. Run `neon deploy` (or `neon env pull`) to write it to .env.")
  // Neon: the serverless driver over WebSockets, through the pooled endpoint.
  // Anything else (a local Postgres for development or tests): node-postgres.
  const adapter = /\.neon\.tech\b/.test(connectionString)
    ? new PrismaNeon({ connectionString })
    : new PrismaPg({ connectionString })
  return new PrismaClient({ adapter })
}

// One client per server process. Next.js dev reloads modules, so it lives on globalThis.
const g = globalThis as unknown as { __prisma?: PrismaClient }

/** The Prisma client. Server code only: this module refuses to load in the browser. */
export function db(): PrismaClient {
  return (g.__prisma ??= makeClient())
}
