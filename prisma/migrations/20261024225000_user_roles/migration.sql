-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('ADMIN', 'USER');

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "role" "UserRole" NOT NULL DEFAULT 'USER';

-- Every account that exists at this point predates multi-user support, so the only one is the local
-- administrator created by scripts/seed-dev-user.ts. Accounts created later through the admin API
-- always start as USER.
UPDATE "users" SET "role" = 'ADMIN';
