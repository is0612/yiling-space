-- Existing history has no complete input manifest; leave its fingerprint unknown.
ALTER TABLE "reflection_runs" ADD COLUMN "sourcesHash" VARCHAR(64);
CREATE INDEX "reflection_runs_characterId_sourcesHash_idx" ON "reflection_runs"("characterId", "sourcesHash");
