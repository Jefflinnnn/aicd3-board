-- A lasting record of who applied to what. It has no foreign key to "Posting" on purpose:
-- postings get deleted for good (bin purge, stale queue drops) and the record must outlive them.
CREATE TABLE "Application" (
    "userId" TEXT NOT NULL,
    "postingId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "company" TEXT NOT NULL,
    "location" TEXT NOT NULL DEFAULT '',
    "url" TEXT NOT NULL DEFAULT '',
    "deadline" TEXT NOT NULL DEFAULT '',
    "appliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Application_pkey" PRIMARY KEY ("userId","postingId")
);

CREATE INDEX "Application_appliedAt_idx" ON "Application"("appliedAt");

ALTER TABLE "Application" ADD CONSTRAINT "Application_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Roles already marked applied: copy them over while their postings still exist.
INSERT INTO "Application" ("userId", "postingId", "title", "company", "location", "url", "deadline", "appliedAt")
SELECT s."userId", s."postingId", p."title", p."company", p."location", p."url", COALESCE(to_char(p."deadline", 'YYYY-MM-DD'), ''), s."updatedAt"
FROM "JobStatus" s JOIN "Posting" p ON p."id" = s."postingId"
WHERE s."status" = 'applied';
