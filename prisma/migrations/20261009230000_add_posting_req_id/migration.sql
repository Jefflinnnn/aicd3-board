-- AlterTable
ALTER TABLE "Posting" ADD COLUMN     "reqId" TEXT NOT NULL DEFAULT '';

-- CreateIndex
CREATE INDEX "Posting_company_reqId_idx" ON "Posting"("company", "reqId");
