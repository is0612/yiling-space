CREATE TABLE "local_access_roots" (
    "id" UUID NOT NULL,
    "path" VARCHAR(1000) NOT NULL,
    "label" VARCHAR(100) NOT NULL,
    "mode" VARCHAR(20) NOT NULL DEFAULT 'READ_ONLY',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "local_access_roots_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "local_access_roots_path_key" ON "local_access_roots"("path");
CREATE INDEX "local_access_roots_enabled_createdAt_idx" ON "local_access_roots"("enabled", "createdAt");
