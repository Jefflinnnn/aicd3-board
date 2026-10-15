-- AlterTable: a refresh asked for on the Admin page of a server that can't run the scraper (the live site on
-- Vercel); the GPU PC checks for it every few minutes and runs it. IF NOT EXISTS: safe to run twice.
ALTER TABLE "SiteMeta" ADD COLUMN IF NOT EXISTS "refreshRequestedAt" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "refreshRequestedBy" TEXT;
