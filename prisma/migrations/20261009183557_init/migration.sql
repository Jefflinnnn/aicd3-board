-- CreateEnum
CREATE TYPE "Role" AS ENUM ('student', 'staff', 'admin');

-- CreateEnum
CREATE TYPE "AccessStatus" AS ENUM ('pending', 'active', 'blocked');

-- CreateEnum
CREATE TYPE "PostingState" AS ENUM ('live', 'review', 'rejected', 'bin');

-- CreateEnum
CREATE TYPE "MyStatus" AS ENUM ('saved', 'applied');

-- CreateTable
CREATE TABLE "Profile" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "name" TEXT,
    "role" "Role" NOT NULL DEFAULT 'student',
    "status" "AccessStatus" NOT NULL DEFAULT 'pending',
    "lastVisit" TIMESTAMP(3),
    "layout" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Profile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccessGrant" (
    "email" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'student',
    "grantedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccessGrant_pkey" PRIMARY KEY ("email")
);

-- CreateTable
CREATE TABLE "Posting" (
    "id" TEXT NOT NULL,
    "state" "PostingState" NOT NULL DEFAULT 'live',
    "title" TEXT NOT NULL,
    "company" TEXT NOT NULL,
    "location" TEXT NOT NULL,
    "locations" TEXT[],
    "category" TEXT NOT NULL,
    "posted" DATE NOT NULL,
    "deadline" DATE,
    "term" TEXT NOT NULL DEFAULT '',
    "mode" TEXT NOT NULL DEFAULT 'Onsite',
    "pay" TEXT NOT NULL DEFAULT '',
    "url" TEXT NOT NULL,
    "summary" TEXT NOT NULL DEFAULT '',
    "resp" TEXT[],
    "quals" TEXT[],
    "closed" BOOLEAN NOT NULL DEFAULT false,
    "sample" BOOLEAN NOT NULL DEFAULT false,
    "addedAt" TIMESTAMP(3),
    "review" JSONB,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Posting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobStatus" (
    "userId" TEXT NOT NULL,
    "postingId" TEXT NOT NULL,
    "status" "MyStatus" NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JobStatus_pkey" PRIMARY KEY ("userId","postingId")
);

-- CreateTable
CREATE TABLE "JobNote" (
    "userId" TEXT NOT NULL,
    "postingId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JobNote_pkey" PRIMARY KEY ("userId","postingId")
);

-- CreateTable
CREATE TABLE "CompanyRequest" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "site" TEXT NOT NULL DEFAULT '',
    "cat" TEXT NOT NULL DEFAULT '',
    "email" TEXT NOT NULL DEFAULT '',
    "why" TEXT NOT NULL DEFAULT '',
    "date" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "resolvedBy" TEXT,

    CONSTRAINT "CompanyRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IssueReport" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "jobId" TEXT NOT NULL DEFAULT '',
    "details" TEXT NOT NULL DEFAULT '',
    "email" TEXT NOT NULL DEFAULT '',
    "date" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "resolvedBy" TEXT,

    CONSTRAINT "IssueReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SiteMeta" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "customCats" JSONB NOT NULL DEFAULT '[]',
    "lastUpdated" TIMESTAMP(3),
    "lastImport" JSONB,

    CONSTRAINT "SiteMeta_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "target" TEXT,
    "detail" JSONB,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Profile_status_idx" ON "Profile"("status");

-- CreateIndex
CREATE INDEX "Profile_email_idx" ON "Profile"("email");

-- CreateIndex
CREATE INDEX "Posting_state_idx" ON "Posting"("state");

-- CreateIndex
CREATE INDEX "Posting_company_idx" ON "Posting"("company");

-- CreateIndex
CREATE INDEX "CompanyRequest_resolvedAt_idx" ON "CompanyRequest"("resolvedAt");

-- CreateIndex
CREATE INDEX "IssueReport_resolvedAt_idx" ON "IssueReport"("resolvedAt");

-- CreateIndex
CREATE INDEX "AuditLog_at_idx" ON "AuditLog"("at");

-- AddForeignKey
ALTER TABLE "JobStatus" ADD CONSTRAINT "JobStatus_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobStatus" ADD CONSTRAINT "JobStatus_postingId_fkey" FOREIGN KEY ("postingId") REFERENCES "Posting"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobNote" ADD CONSTRAINT "JobNote_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobNote" ADD CONSTRAINT "JobNote_postingId_fkey" FOREIGN KEY ("postingId") REFERENCES "Posting"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompanyRequest" ADD CONSTRAINT "CompanyRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IssueReport" ADD CONSTRAINT "IssueReport_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
