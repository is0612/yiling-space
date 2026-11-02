-- DropIndex
DROP INDEX "character_stickers_characterId_contentHash_idx";

-- AlterTable
ALTER TABLE "character_catchphrases" ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "character_stickers" ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "memory_scopes" ADD COLUMN     "aliases" TEXT[] DEFAULT ARRAY[]::TEXT[];
