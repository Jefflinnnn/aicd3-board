-- AlterTable: earliest and latest month (1-12) an internship can start, read from the posting's text.
-- IF NOT EXISTS so it is harmless if the columns were already added by hand (e.g. in Neon's SQL Editor).
ALTER TABLE "Posting" ADD COLUMN IF NOT EXISTS "startFrom" INTEGER,
ADD COLUMN IF NOT EXISTS "startTo" INTEGER;
