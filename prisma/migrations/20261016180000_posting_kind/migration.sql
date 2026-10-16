-- AlterTable: postings are internships (the job board) or full-time roles (a private tab for the people in
-- PRIVATE_ROLES_EMAILS); level and note describe full-time roles. IF NOT EXISTS: safe to run twice.
ALTER TABLE "Posting" ADD COLUMN IF NOT EXISTS "kind" TEXT NOT NULL DEFAULT 'internship',
ADD COLUMN IF NOT EXISTS "level" TEXT NOT NULL DEFAULT '',
ADD COLUMN IF NOT EXISTS "note" TEXT NOT NULL DEFAULT '';

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Posting_kind_state_idx" ON "Posting"("kind", "state");
