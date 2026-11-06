-- CreateTable
CREATE TABLE "bili_duty_leases" (
    "bindingId" UUID NOT NULL,
    "token" UUID NOT NULL,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bili_duty_leases_pkey" PRIMARY KEY ("bindingId")
);

-- CreateIndex
CREATE INDEX "bili_duty_leases_expiresAt_idx" ON "bili_duty_leases"("expiresAt");

-- AddForeignKey
ALTER TABLE "bili_duty_leases"
ADD CONSTRAINT "bili_duty_leases_bindingId_fkey"
FOREIGN KEY ("bindingId") REFERENCES "character_channel_bindings"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
