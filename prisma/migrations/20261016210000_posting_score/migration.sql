-- How well a private full-time role fits (d3's fit probability, 0-100); null for internships
ALTER TABLE "Posting" ADD COLUMN IF NOT EXISTS "score" INTEGER;
