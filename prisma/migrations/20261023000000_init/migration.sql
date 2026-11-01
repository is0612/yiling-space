-- Initial PostgreSQL schema for Yiling Hub.
-- Generated conceptually from prisma/schema.prisma; keep this migration immutable.
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'DISABLED');
CREATE TYPE "CharacterStatus" AS ENUM ('ACTIVE', 'PAUSED', 'ARCHIVED');
CREATE TYPE "PlatformConnectionStatus" AS ENUM ('CONNECTED', 'DISCONNECTED', 'ERROR', 'DISABLED');
CREATE TYPE "BindingStatus" AS ENUM ('ACTIVE', 'PAUSED');
CREATE TYPE "ExternalIdentityStatus" AS ENUM ('UNVERIFIED', 'VERIFIED', 'REVOKED');
CREATE TYPE "ConversationStatus" AS ENUM ('ACTIVE', 'ARCHIVED');
CREATE TYPE "MessageRole" AS ENUM ('SYSTEM', 'USER', 'ASSISTANT', 'TOOL');
CREATE TYPE "MemoryScopeType" AS ENUM ('CHARACTER_GLOBAL', 'USER_PRIVATE', 'EXTERNAL_IDENTITY');
CREATE TYPE "MemoryCategory" AS ENUM ('FACT', 'PREFERENCE', 'RELATIONSHIP', 'COMMITMENT', 'GOAL', 'EVENT', 'SUMMARY', 'OTHER');
CREATE TYPE "MemoryItemStatus" AS ENUM ('ACTIVE', 'SUPERSEDED', 'ARCHIVED', 'INVALIDATED');
CREATE TYPE "SnapshotKind" AS ENUM ('AUTOMATIC', 'MANUAL');
CREATE TYPE "SnapshotStatus" AS ENUM ('CURRENT', 'SUPERSEDED');
CREATE TYPE "SnapshotSourceType" AS ENUM ('MESSAGE', 'MEMORY_ITEM', 'PLATFORM_EVENT', 'EXTERNAL_REFERENCE');
CREATE TYPE "MemorySettingsChangePolicy" AS ENUM ('NEXT_CYCLE', 'IMMEDIATE_RECALC');
CREATE TYPE "MemoryJobType" AS ENUM ('GENERATE_SNAPSHOT', 'REGENERATE_SNAPSHOT', 'UPDATE_LONG_TERM_MEMORY', 'CLEAN_EXPIRED_MESSAGES');
CREATE TYPE "MemoryJobStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'SKIPPED', 'RETRY_WAIT', 'CANCELLED');
CREATE TYPE "AuditActorType" AS ENUM ('USER', 'SYSTEM', 'WORKER');

CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "username" VARCHAR(100) NOT NULL,
    "passwordHash" VARCHAR(255) NOT NULL,
    "displayName" VARCHAR(120),
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "characters" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "avatar" TEXT,
    "basePrompt" TEXT NOT NULL,
    "modelConfig" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "status" "CharacterStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "characters_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "characters_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "platform_connections" (
    "id" UUID NOT NULL,
    "platform" VARCHAR(50) NOT NULL,
    "displayName" VARCHAR(120) NOT NULL,
    "platformAccountKey" VARCHAR(255),
    "status" "PlatformConnectionStatus" NOT NULL DEFAULT 'DISCONNECTED',
    "credentialsCiphertext" BYTEA,
    "credentialKeyId" VARCHAR(255),
    "metadata" JSONB,
    "lastEventAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "platform_connections_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "character_channel_bindings" (
    "id" UUID NOT NULL,
    "characterId" UUID NOT NULL,
    "connectionId" UUID NOT NULL,
    "status" "BindingStatus" NOT NULL DEFAULT 'ACTIVE',
    "routingKey" VARCHAR(255),
    "config" JSONB,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "character_channel_bindings_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "character_channel_bindings_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "characters"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "character_channel_bindings_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "platform_connections"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "external_identities" (
    "id" UUID NOT NULL,
    "platform" VARCHAR(50) NOT NULL,
    "platformUid" VARCHAR(255) NOT NULL,
    "displayName" VARCHAR(255),
    "linkedUserId" UUID,
    "connectionId" UUID,
    "status" "ExternalIdentityStatus" NOT NULL DEFAULT 'UNVERIFIED',
    "verifiedAt" TIMESTAMPTZ(6),
    "metadata" JSONB,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "external_identities_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "external_identities_linkedUserId_fkey" FOREIGN KEY ("linkedUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "external_identities_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "platform_connections"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE "memory_scopes" (
    "id" UUID NOT NULL,
    "characterId" UUID NOT NULL,
    "scopeType" "MemoryScopeType" NOT NULL,
    "scopeKey" VARCHAR(500) NOT NULL,
    "userId" UUID,
    "externalIdentityId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "memory_scopes_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "memory_scopes_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "characters"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "memory_scopes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "memory_scopes_externalIdentityId_fkey" FOREIGN KEY ("externalIdentityId") REFERENCES "external_identities"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE "conversations" (
    "id" UUID NOT NULL,
    "characterId" UUID NOT NULL,
    "memoryScopeId" UUID NOT NULL,
    "channelBindingId" UUID,
    "externalConversationId" VARCHAR(255),
    "title" VARCHAR(255),
    "status" "ConversationStatus" NOT NULL DEFAULT 'ACTIVE',
    "metadata" JSONB,
    "lastMessageAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "conversations_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "characters"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "conversations_memoryScopeId_fkey" FOREIGN KEY ("memoryScopeId") REFERENCES "memory_scopes"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "conversations_channelBindingId_fkey" FOREIGN KEY ("channelBindingId") REFERENCES "character_channel_bindings"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE "messages" (
    "id" UUID NOT NULL,
    "conversationId" UUID NOT NULL,
    "externalMessageId" VARCHAR(255),
    "role" "MessageRole" NOT NULL,
    "eventType" VARCHAR(80) NOT NULL DEFAULT 'message',
    "content" TEXT NOT NULL,
    "occurredAt" TIMESTAMPTZ(6) NOT NULL,
    "ingestedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" JSONB,
    CONSTRAINT "messages_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "messages_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "memory_snapshots" (
    "id" UUID NOT NULL,
    "snapshotKey" VARCHAR(500) NOT NULL,
    "memoryScopeId" UUID NOT NULL,
    "kind" "SnapshotKind" NOT NULL DEFAULT 'AUTOMATIC',
    "version" INTEGER NOT NULL DEFAULT 1,
    "periodStart" TIMESTAMPTZ(6) NOT NULL,
    "periodEnd" TIMESTAMPTZ(6) NOT NULL,
    "summary" TEXT NOT NULL,
    "structuredContent" JSONB NOT NULL,
    "status" "SnapshotStatus" NOT NULL DEFAULT 'CURRENT',
    "modelMetadata" JSONB,
    "generatedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "memory_snapshots_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "memory_snapshots_memoryScopeId_fkey" FOREIGN KEY ("memoryScopeId") REFERENCES "memory_scopes"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "memory_items" (
    "id" UUID NOT NULL,
    "memoryScopeId" UUID NOT NULL,
    "category" "MemoryCategory" NOT NULL,
    "content" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION,
    "status" "MemoryItemStatus" NOT NULL DEFAULT 'ACTIVE',
    "sourceMessageId" UUID,
    "sourceSnapshotId" UUID,
    "dedupeKey" VARCHAR(255),
    "validFrom" TIMESTAMPTZ(6),
    "validTo" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "memory_items_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "memory_items_memoryScopeId_fkey" FOREIGN KEY ("memoryScopeId") REFERENCES "memory_scopes"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "memory_items_sourceMessageId_fkey" FOREIGN KEY ("sourceMessageId") REFERENCES "messages"("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "memory_items_sourceSnapshotId_fkey" FOREIGN KEY ("sourceSnapshotId") REFERENCES "memory_snapshots"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE "memory_snapshot_sources" (
    "id" UUID NOT NULL,
    "snapshotId" UUID NOT NULL,
    "sourceType" "SnapshotSourceType" NOT NULL,
    "sourceRef" VARCHAR(500) NOT NULL,
    "messageId" UUID,
    "memoryItemId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "memory_snapshot_sources_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "memory_snapshot_sources_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "memory_snapshots"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "memory_snapshot_sources_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "messages"("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "memory_snapshot_sources_memoryItemId_fkey" FOREIGN KEY ("memoryItemId") REFERENCES "memory_items"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE "character_memory_settings" (
    "id" UUID NOT NULL,
    "characterId" UUID NOT NULL,
    "snapshotIntervalDays" INTEGER NOT NULL DEFAULT 8,
    "timezone" VARCHAR(100) NOT NULL DEFAULT 'Asia/Shanghai',
    "anchorAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "nextSnapshotAt" TIMESTAMPTZ(6),
    "autoSnapshotEnabled" BOOLEAN NOT NULL DEFAULT true,
    "changePolicy" "MemorySettingsChangePolicy" NOT NULL DEFAULT 'NEXT_CYCLE',
    "rawMessageRetentionDays" INTEGER,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "character_memory_settings_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "character_memory_settings_characterId_key" UNIQUE ("characterId"),
    CONSTRAINT "character_memory_settings_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "characters"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "memory_jobs" (
    "id" UUID NOT NULL,
    "memoryScopeId" UUID NOT NULL,
    "snapshotId" UUID,
    "type" "MemoryJobType" NOT NULL,
    "idempotencyKey" VARCHAR(500) NOT NULL,
    "periodStart" TIMESTAMPTZ(6),
    "periodEnd" TIMESTAMPTZ(6),
    "status" "MemoryJobStatus" NOT NULL DEFAULT 'QUEUED',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "runAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedAt" TIMESTAMPTZ(6),
    "lockedBy" VARCHAR(255),
    "lastError" TEXT,
    "startedAt" TIMESTAMPTZ(6),
    "completedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "memory_jobs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "memory_jobs_memoryScopeId_fkey" FOREIGN KEY ("memoryScopeId") REFERENCES "memory_scopes"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "memory_jobs_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "memory_snapshots"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "actorType" "AuditActorType" NOT NULL,
    "actorId" UUID,
    "characterId" UUID,
    "action" VARCHAR(120) NOT NULL,
    "entityType" VARCHAR(120) NOT NULL,
    "entityId" VARCHAR(255),
    "details" JSONB,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "audit_logs_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "audit_logs_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "characters"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "users_username_key" ON "users"("username");
CREATE INDEX "characters_ownerId_status_idx" ON "characters"("ownerId", "status");
CREATE INDEX "characters_updatedAt_idx" ON "characters"("updatedAt");
CREATE UNIQUE INDEX "platform_connections_platform_platformAccountKey_key" ON "platform_connections"("platform", "platformAccountKey");
CREATE INDEX "platform_connections_platform_status_idx" ON "platform_connections"("platform", "status");
CREATE UNIQUE INDEX "character_channel_bindings_characterId_connectionId_key" ON "character_channel_bindings"("characterId", "connectionId");
CREATE INDEX "character_channel_bindings_status_idx" ON "character_channel_bindings"("status");
CREATE UNIQUE INDEX "external_identities_platform_platformUid_key" ON "external_identities"("platform", "platformUid");
CREATE INDEX "external_identities_linkedUserId_status_idx" ON "external_identities"("linkedUserId", "status");
CREATE INDEX "external_identities_connectionId_idx" ON "external_identities"("connectionId");
CREATE UNIQUE INDEX "memory_scopes_scopeKey_key" ON "memory_scopes"("scopeKey");
CREATE INDEX "memory_scopes_characterId_scopeType_idx" ON "memory_scopes"("characterId", "scopeType");
CREATE INDEX "memory_scopes_userId_idx" ON "memory_scopes"("userId");
CREATE INDEX "memory_scopes_externalIdentityId_idx" ON "memory_scopes"("externalIdentityId");
CREATE UNIQUE INDEX "conversations_channelBindingId_externalConversationId_key" ON "conversations"("channelBindingId", "externalConversationId");
CREATE INDEX "conversations_characterId_updatedAt_idx" ON "conversations"("characterId", "updatedAt");
CREATE INDEX "conversations_memoryScopeId_updatedAt_idx" ON "conversations"("memoryScopeId", "updatedAt");
CREATE UNIQUE INDEX "messages_conversationId_externalMessageId_key" ON "messages"("conversationId", "externalMessageId");
CREATE INDEX "messages_conversationId_occurredAt_idx" ON "messages"("conversationId", "occurredAt");
CREATE INDEX "messages_eventType_occurredAt_idx" ON "messages"("eventType", "occurredAt");
CREATE UNIQUE INDEX "memory_items_memoryScopeId_dedupeKey_key" ON "memory_items"("memoryScopeId", "dedupeKey");
CREATE INDEX "memory_items_memoryScopeId_status_category_idx" ON "memory_items"("memoryScopeId", "status", "category");
CREATE INDEX "memory_items_memoryScopeId_validTo_idx" ON "memory_items"("memoryScopeId", "validTo");
CREATE UNIQUE INDEX "memory_snapshots_snapshotKey_version_key" ON "memory_snapshots"("snapshotKey", "version");
CREATE INDEX "memory_snapshots_memoryScopeId_periodStart_periodEnd_idx" ON "memory_snapshots"("memoryScopeId", "periodStart", "periodEnd");
CREATE INDEX "memory_snapshots_memoryScopeId_status_periodEnd_idx" ON "memory_snapshots"("memoryScopeId", "status", "periodEnd");
CREATE UNIQUE INDEX "memory_snapshot_sources_snapshotId_sourceType_sourceRef_key" ON "memory_snapshot_sources"("snapshotId", "sourceType", "sourceRef");
CREATE INDEX "memory_snapshot_sources_messageId_idx" ON "memory_snapshot_sources"("messageId");
CREATE INDEX "memory_snapshot_sources_memoryItemId_idx" ON "memory_snapshot_sources"("memoryItemId");
CREATE UNIQUE INDEX "memory_jobs_idempotencyKey_key" ON "memory_jobs"("idempotencyKey");
CREATE INDEX "memory_jobs_status_runAt_idx" ON "memory_jobs"("status", "runAt");
CREATE INDEX "memory_jobs_memoryScopeId_periodStart_periodEnd_idx" ON "memory_jobs"("memoryScopeId", "periodStart", "periodEnd");
CREATE INDEX "audit_logs_createdAt_idx" ON "audit_logs"("createdAt");
CREATE INDEX "audit_logs_characterId_createdAt_idx" ON "audit_logs"("characterId", "createdAt");
CREATE INDEX "audit_logs_entityType_entityId_idx" ON "audit_logs"("entityType", "entityId");
