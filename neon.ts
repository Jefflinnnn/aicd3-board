import { defineConfig } from "@neon/config/v1";

// Neon services for this project. `neon deploy` applies this to the linked branch and
// writes DATABASE_URL, NEON_AUTH_BASE_URL and NEON_AUTH_JWKS_URL to .env.
//
// The Data API is deliberately NOT enabled: every read and write goes through this app's
// server code, which checks the signed-in person's role first. Turning on `dataApi` would
// expose a public REST endpoint into the database that relies on row-level security instead.
export default defineConfig({
  auth: true,
});
