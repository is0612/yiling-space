-- Persist scheduled window attempts separately from successful round reports.
CREATE TABLE "bili_duty_window_runs" (
    "id" UUID NOT NULL,
    "bindingId" UUID NOT NULL,
    "businessDay" VARCHAR(10) NOT NULL,
    "windowKey" VARCHAR(10) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'RUNNING',
    "attemptCount" INTEGER NOT NULL DEFAULT 1,
    "leaseToken" UUID NOT NULL,
    "startedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMPTZ(6),
    "lastError" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bili_duty_window_runs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "bili_duty_window_runs_bindingId_businessDay_windowKey_key"
ON "bili_duty_window_runs"("bindingId", "businessDay", "windowKey");

CREATE INDEX "bili_duty_window_runs_bindingId_createdAt_idx"
ON "bili_duty_window_runs"("bindingId", "createdAt");

CREATE INDEX "bili_duty_window_runs_status_updatedAt_idx"
ON "bili_duty_window_runs"("status", "updatedAt");

ALTER TABLE "bili_duty_window_runs"
ADD CONSTRAINT "bili_duty_window_runs_bindingId_fkey"
FOREIGN KEY ("bindingId") REFERENCES "character_channel_bindings"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
