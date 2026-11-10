CREATE TABLE "character_growth_import_identities" (
  "id" UUID NOT NULL,
  "characterId" UUID NOT NULL,
  "domain" VARCHAR(80) NOT NULL,
  "originId" UUID NOT NULL,
  "localId" UUID NOT NULL,
  CONSTRAINT "character_growth_import_identities_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "character_growth_import_identities_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "characters"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "character_growth_import_identities_characterId_domain_originId_key" ON "character_growth_import_identities"("characterId", "domain", "originId");
CREATE UNIQUE INDEX "character_growth_import_identities_characterId_domain_localId_key" ON "character_growth_import_identities"("characterId", "domain", "localId");
