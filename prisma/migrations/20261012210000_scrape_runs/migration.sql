-- CreateEnum
CREATE TYPE "ScrapeStatus" AS ENUM ('running', 'succeeded', 'partial', 'failed', 'cancelled');

-- AlterTable
ALTER TABLE "SiteMeta" ADD COLUMN     "autoRefresh" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "refreshHours" INTEGER NOT NULL DEFAULT 48;

-- CreateTable
CREATE TABLE "ScrapeRun" (
    "id" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "requestedBy" TEXT,
    "status" "ScrapeStatus" NOT NULL DEFAULT 'running',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "pid" INTEGER,
    "summary" JSONB,
    "log" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "ScrapeRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ScrapeRun_startedAt_idx" ON "ScrapeRun"("startedAt");

-- CreateIndex
CREATE INDEX "ScrapeRun_status_idx" ON "ScrapeRun"("status");
