-- AlterTable: when the GPU PC last checked for "Refresh now" requests, and which computer, so the Admin page can tell
-- whether anyone is listening. IF NOT EXISTS: safe to run twice.
ALTER TABLE "SiteMeta" ADD COLUMN IF NOT EXISTS "requestCheckAt" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "requestCheckHost" TEXT;
