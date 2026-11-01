-- AlterTable
ALTER TABLE "users" ADD COLUMN "email" VARCHAR(255);
ALTER TABLE "users" ADD COLUMN "registrationIpHash" VARCHAR(64);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");
