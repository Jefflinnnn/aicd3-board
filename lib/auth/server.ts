import "server-only"
import { createNeonAuth, type NeonAuth } from "@neondatabase/auth/next/server"

/**
 * Neon Auth (managed Better Auth). `neon deploy` writes NEON_AUTH_BASE_URL to .env;
 * NEON_AUTH_COOKIE_SECRET is yours to generate (`openssl rand -base64 32`) and keep secret.
 */
export const authConfigured = () => !!(process.env.NEON_AUTH_BASE_URL && process.env.NEON_AUTH_COOKIE_SECRET)

const g = globalThis as unknown as { __neonAuth?: NeonAuth }

export function auth(): NeonAuth {
  if (!authConfigured()) throw new Error("Neon Auth isn't configured: set NEON_AUTH_BASE_URL and NEON_AUTH_COOKIE_SECRET.")
  return (g.__neonAuth ??= createNeonAuth({
    baseUrl: process.env.NEON_AUTH_BASE_URL!,
    cookies: {
      secret: process.env.NEON_AUTH_COOKIE_SECRET!,
      // a role or access change reaches the session cache within a minute
      sessionDataTtl: 60,
    },
  }))
}
