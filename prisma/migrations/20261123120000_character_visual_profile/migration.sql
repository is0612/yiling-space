CREATE TYPE "CharacterVisualAssetKind" AS ENUM (
  'STANDARD', 'FRONT_VIEW', 'SIDE_VIEW', 'BACK_VIEW',
  'EXPRESSION', 'OUTFIT', 'ACCESSORY', 'SUPPLEMENT'
);

CREATE TYPE "CharacterVisualVersionStatus" AS ENUM ('DRAFT', 'PUBLISHED');

CREATE TABLE "character_visual_profiles" (
  "id" UUID NOT NULL,
  "characterId" UUID NOT NULL,
  "coreAppearance" TEXT NOT NULL DEFAULT '',
  "corePrompt" TEXT NOT NULL DEFAULT '',
  "negativePrompt" TEXT NOT NULL DEFAULT '',
  "currentPublishedRevision" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "character_visual_profiles_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "character_visual_profiles_characterId_key"
  ON "character_visual_profiles"("characterId");
ALTER TABLE "character_visual_profiles"
  ADD CONSTRAINT "character_visual_profiles_characterId_fkey"
  FOREIGN KEY ("characterId") REFERENCES "characters"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "character_visual_assets" (
  "id" UUID NOT NULL,
  "profileId" UUID NOT NULL,
  "kind" "CharacterVisualAssetKind" NOT NULL,
  "label" VARCHAR(120) NOT NULL,
  "relativePath" VARCHAR(500) NOT NULL,
  "mime" VARCHAR(80) NOT NULL,
  "sizeBytes" INTEGER NOT NULL,
  "width" INTEGER,
  "height" INTEGER,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "character_visual_assets_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "character_visual_assets_profileId_kind_sortOrder_idx"
  ON "character_visual_assets"("profileId", "kind", "sortOrder");
ALTER TABLE "character_visual_assets"
  ADD CONSTRAINT "character_visual_assets_profileId_fkey"
  FOREIGN KEY ("profileId") REFERENCES "character_visual_profiles"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "character_visual_outfits" (
  "id" UUID NOT NULL,
  "profileId" UUID NOT NULL,
  "name" VARCHAR(100) NOT NULL,
  "prompt" TEXT NOT NULL,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "character_visual_outfits_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "character_visual_outfits_profileId_name_key"
  ON "character_visual_outfits"("profileId", "name");
CREATE INDEX "character_visual_outfits_profileId_sortOrder_idx"
  ON "character_visual_outfits"("profileId", "sortOrder");
ALTER TABLE "character_visual_outfits"
  ADD CONSTRAINT "character_visual_outfits_profileId_fkey"
  FOREIGN KEY ("profileId") REFERENCES "character_visual_profiles"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "character_visual_versions" (
  "id" UUID NOT NULL,
  "profileId" UUID NOT NULL,
  "revision" INTEGER NOT NULL,
  "status" "CharacterVisualVersionStatus" NOT NULL DEFAULT 'DRAFT',
  "snapshot" JSONB NOT NULL,
  "note" VARCHAR(300) NOT NULL DEFAULT '',
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "publishedAt" TIMESTAMPTZ(6),
  CONSTRAINT "character_visual_versions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "character_visual_versions_profileId_revision_key"
  ON "character_visual_versions"("profileId", "revision");
CREATE INDEX "character_visual_versions_profileId_status_revision_idx"
  ON "character_visual_versions"("profileId", "status", "revision");
ALTER TABLE "character_visual_versions"
  ADD CONSTRAINT "character_visual_versions_profileId_fkey"
  FOREIGN KEY ("profileId") REFERENCES "character_visual_profiles"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
