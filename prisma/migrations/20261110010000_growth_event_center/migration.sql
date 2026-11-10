-- Unified growth Event Center: durable outbox + per-consumer delivery leases.
CREATE TYPE "GrowthEventDeliveryStatus" AS ENUM (
  'QUEUED',
  'RUNNING',
  'SUCCEEDED',
  'RETRY_WAIT',
  'FAILED',
  'SKIPPED',
  'CANCELLED'
);

CREATE TABLE "growth_events" (
  "id" UUID NOT NULL,
  "characterId" UUID NOT NULL,
  "sourceDomain" VARCHAR(40) NOT NULL,
  "eventType" VARCHAR(120) NOT NULL,
  "schemaVersion" INTEGER NOT NULL DEFAULT 1,
  "aggregateType" VARCHAR(120) NOT NULL,
  "aggregateId" VARCHAR(255) NOT NULL,
  "occurredAt" TIMESTAMPTZ(6) NOT NULL,
  "payload" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "idempotencyKey" VARCHAR(255) NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "growth_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "growth_events_schemaVersion_check" CHECK ("schemaVersion" > 0)
);

CREATE TABLE "growth_event_deliveries" (
  "id" UUID NOT NULL,
  "eventId" UUID NOT NULL,
  "consumerKey" VARCHAR(120) NOT NULL,
  "status" "GrowthEventDeliveryStatus" NOT NULL DEFAULT 'QUEUED',
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "maxAttempts" INTEGER NOT NULL DEFAULT 5,
  "runAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lockedAt" TIMESTAMPTZ(6),
  "lockedBy" VARCHAR(255),
  "leaseToken" UUID,
  "leaseExpiresAt" TIMESTAMPTZ(6),
  "fencingToken" INTEGER NOT NULL DEFAULT 0,
  "lastError" TEXT,
  "processedAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "growth_event_deliveries_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "growth_event_deliveries_attempts_check"
    CHECK ("attemptCount" >= 0 AND "maxAttempts" > 0 AND "fencingToken" >= 0)
);

CREATE UNIQUE INDEX "growth_events_characterId_sourceDomain_idempotencyKey_key"
  ON "growth_events"("characterId", "sourceDomain", "idempotencyKey");
CREATE INDEX "growth_events_characterId_createdAt_idx"
  ON "growth_events"("characterId", "createdAt");
CREATE INDEX "growth_events_sourceDomain_eventType_createdAt_idx"
  ON "growth_events"("sourceDomain", "eventType", "createdAt");

CREATE UNIQUE INDEX "growth_event_deliveries_eventId_consumerKey_key"
  ON "growth_event_deliveries"("eventId", "consumerKey");
CREATE INDEX "growth_event_deliveries_status_runAt_idx"
  ON "growth_event_deliveries"("status", "runAt");
CREATE INDEX "growth_event_deliveries_status_leaseExpiresAt_idx"
  ON "growth_event_deliveries"("status", "leaseExpiresAt");
CREATE INDEX "growth_event_deliveries_eventId_status_idx"
  ON "growth_event_deliveries"("eventId", "status");

ALTER TABLE "growth_events"
  ADD CONSTRAINT "growth_events_characterId_fkey"
  FOREIGN KEY ("characterId") REFERENCES "characters"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "growth_event_deliveries"
  ADD CONSTRAINT "growth_event_deliveries_eventId_fkey"
  FOREIGN KEY ("eventId") REFERENCES "growth_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;
