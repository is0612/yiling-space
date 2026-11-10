import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "../../src/generated/prisma/client";
import {
  GROWTH_EVENT_LEASE_MS,
  GROWTH_EVENT_SUCCESS_RETENTION_DAYS,
  type GrowthEventEnvelope,
} from "./growth-event-center";

const RETRY_BASE_MS = 60_000;
const RETRY_MAX_MS = 6 * 60 * 60 * 1000;
const ERROR_MAX_CHARS = 2_000;
const EXPIRED_LEASE_RECLAIM_BATCH_SIZE = 100;

export type GrowthEventDeliveryLease = {
  deliveryId: string;
  eventId: string;
  consumerKey: string;
  workerId: string;
  leaseToken: string;
  fencingToken: number;
  attemptCount: number;
  maxAttempts: number;
  leaseExpiresAt: Date;
  event: GrowthEventEnvelope;
};

export type GrowthEventHandlerResult = void | { skipReason: string };
export type GrowthEventDeliveryHandler = (
  tx: Prisma.TransactionClient,
  event: GrowthEventEnvelope,
) => Promise<GrowthEventHandlerResult>;

export class GrowthEventDeliveryLeaseLostError extends Error {
  constructor() {
    super("成长事件投递租约已失效；拒绝提交旧执行者的结果。");
    this.name = "GrowthEventDeliveryLeaseLostError";
  }
}

export function growthEventRetryDelayMs(attemptCount: number): number {
  const exponent = Math.max(0, Math.min(16, Math.trunc(attemptCount) - 1));
  return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * (2 ** exponent));
}

/**
 * 单次领取：最多回收 100 条过期租约，再用 SKIP LOCKED 领取一条投递。
 * 回收与领取都跳过已被其它事务持锁的行，避免一个慢事务阻塞全部 Worker。
 * 未回收的租约留给后续轮次；旧执行者因 leaseToken/fencingToken 不匹配不能确认。
 */
export async function claimNextGrowthEventDelivery(
  prisma: PrismaClient,
  options: { workerId: string; now?: Date; leaseMs?: number } ,
): Promise<GrowthEventDeliveryLease | null> {
  const now = options.now ?? new Date();
  const leaseMs = Math.max(1_000, Math.trunc(options.leaseMs ?? GROWTH_EVENT_LEASE_MS));
  const leaseToken = randomUUID();
  const leaseExpiresAt = new Date(now.getTime() + leaseMs);
  const rows = await prisma.$queryRaw<Array<{
    deliveryId: string;
    eventId: string;
    consumerKey: string;
    workerId: string;
    leaseToken: string;
    fencingToken: number;
    attemptCount: number;
    maxAttempts: number;
    leaseExpiresAt: Date;
    id: string;
    characterId: string;
    sourceDomain: string;
    eventType: string;
    schemaVersion: number;
    aggregateType: string;
    aggregateId: string;
    occurredAt: Date;
    createdAt: Date;
    payload: Prisma.JsonValue;
  }>>`
    WITH expired_candidates AS (
      SELECT delivery."id"
      FROM "growth_event_deliveries" AS delivery
      WHERE delivery."status" = 'RUNNING'::"GrowthEventDeliveryStatus"
        AND (delivery."leaseExpiresAt" IS NULL OR delivery."leaseExpiresAt" <= ${now})
      ORDER BY delivery."leaseExpiresAt" ASC NULLS FIRST, delivery."id" ASC
      LIMIT ${EXPIRED_LEASE_RECLAIM_BATCH_SIZE}
      FOR UPDATE SKIP LOCKED
    ),
    expired AS (
      UPDATE "growth_event_deliveries" AS delivery
      SET
        "status" = CASE
          WHEN delivery."attemptCount" < delivery."maxAttempts" THEN 'RETRY_WAIT'::"GrowthEventDeliveryStatus"
          ELSE 'FAILED'::"GrowthEventDeliveryStatus"
        END,
        "runAt" = ${now}::timestamptz + (
          LEAST(21600000, 60000 * POWER(2, LEAST(GREATEST(delivery."attemptCount" - 1, 0), 16)))
          * INTERVAL '1 millisecond'
        ),
        "lockedAt" = NULL,
        "lockedBy" = NULL,
        "leaseToken" = NULL,
        "leaseExpiresAt" = NULL,
        "lastError" = COALESCE(delivery."lastError", '成长事件执行租约已过期，系统已回收。'),
        "updatedAt" = ${now}
      FROM expired_candidates
      WHERE delivery."id" = expired_candidates."id"
        AND delivery."status" = 'RUNNING'::"GrowthEventDeliveryStatus"
        AND (delivery."leaseExpiresAt" IS NULL OR delivery."leaseExpiresAt" <= ${now})
      RETURNING delivery."id"
    ),
    candidate AS (
      SELECT delivery."id"
      FROM "growth_event_deliveries" AS delivery
      WHERE delivery."status" IN (
        'QUEUED'::"GrowthEventDeliveryStatus",
        'RETRY_WAIT'::"GrowthEventDeliveryStatus"
      )
        AND delivery."runAt" <= ${now}
      ORDER BY delivery."runAt" ASC, delivery."createdAt" ASC, delivery."id" ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    ),
    claimed AS (
      UPDATE "growth_event_deliveries" AS delivery
      SET
        "status" = 'RUNNING'::"GrowthEventDeliveryStatus",
        "attemptCount" = delivery."attemptCount" + 1,
        "lockedAt" = ${now},
        "lockedBy" = ${options.workerId},
        "leaseToken" = ${leaseToken}::uuid,
        "leaseExpiresAt" = ${leaseExpiresAt},
        "fencingToken" = delivery."fencingToken" + 1,
        "lastError" = NULL,
        "updatedAt" = ${now}
      FROM candidate
      WHERE delivery."id" = candidate."id"
      RETURNING delivery."id" AS "deliveryId", delivery."eventId", delivery."consumerKey",
        delivery."attemptCount", delivery."maxAttempts", delivery."fencingToken",
        delivery."leaseToken", delivery."leaseExpiresAt"
    )
    SELECT
      claimed."deliveryId", claimed."eventId", claimed."consumerKey",
      ${options.workerId}::text AS "workerId",
      claimed."leaseToken"::text AS "leaseToken",
      claimed."fencingToken", claimed."attemptCount", claimed."maxAttempts",
      claimed."leaseExpiresAt",
      event."id", event."characterId", event."sourceDomain", event."eventType",
      event."schemaVersion", event."aggregateType", event."aggregateId",
      event."occurredAt", event."createdAt", event."payload"
    FROM claimed
    INNER JOIN "growth_events" AS event ON event."id" = claimed."eventId"
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    deliveryId: row.deliveryId,
    eventId: row.eventId,
    consumerKey: row.consumerKey,
    workerId: row.workerId,
    leaseToken: row.leaseToken,
    fencingToken: row.fencingToken,
    attemptCount: row.attemptCount,
    maxAttempts: row.maxAttempts,
    leaseExpiresAt: row.leaseExpiresAt,
    event: {
      id: row.id,
      characterId: row.characterId,
      sourceDomain: row.sourceDomain as GrowthEventEnvelope["sourceDomain"],
      eventType: row.eventType,
      schemaVersion: row.schemaVersion,
      aggregateType: row.aggregateType,
      aggregateId: row.aggregateId,
      occurredAt: row.occurredAt,
      createdAt: row.createdAt,
      payload: row.payload,
    },
  };
}

export async function renewGrowthEventDeliveryLease(
  prisma: PrismaClient,
  lease: GrowthEventDeliveryLease,
  now: Date = new Date(),
  leaseMs = GROWTH_EVENT_LEASE_MS,
): Promise<Date> {
  const expiresAt = new Date(now.getTime() + Math.max(1_000, Math.trunc(leaseMs)));
  const changed = await prisma.$executeRaw`
    UPDATE "growth_event_deliveries"
    SET "lockedAt" = ${now}, "leaseExpiresAt" = ${expiresAt}, "updatedAt" = ${now}
    WHERE "id" = ${lease.deliveryId}::uuid
      AND "status" = 'RUNNING'::"GrowthEventDeliveryStatus"
      AND "lockedBy" = ${lease.workerId}
      AND "leaseToken" = ${lease.leaseToken}::uuid
      AND "fencingToken" = ${lease.fencingToken}
      AND "leaseExpiresAt" > ${now}
  `;
  if (changed !== 1) throw new GrowthEventDeliveryLeaseLostError();
  return expiresAt;
}

/**
 * 消费者的短事务：第一条 SQL 必须条件 UPDATE 并持有投递行锁；
 * 随后才执行领域内的短读/写，最后在同一事务内确认 SUCCEEDED/SKIPPED。
 * 模型调用与其它长耗时 I/O 不允许放进 handler。
 */
export async function completeGrowthEventDelivery(
  prisma: PrismaClient,
  lease: GrowthEventDeliveryLease,
  handler: GrowthEventDeliveryHandler,
  now: Date,
): Promise<"SUCCEEDED" | "SKIPPED"> {
  return prisma.$transaction(async (tx) => {
    const locked = await tx.$executeRaw`
      UPDATE "growth_event_deliveries"
      SET "lockedAt" = ${now},
          "leaseExpiresAt" = ${new Date(now.getTime() + GROWTH_EVENT_LEASE_MS)},
          "updatedAt" = ${now}
      WHERE "id" = ${lease.deliveryId}::uuid
        AND "status" = 'RUNNING'::"GrowthEventDeliveryStatus"
        AND "lockedBy" = ${lease.workerId}
        AND "leaseToken" = ${lease.leaseToken}::uuid
        AND "fencingToken" = ${lease.fencingToken}
        AND "leaseExpiresAt" > ${now}
    `;
    if (locked !== 1) throw new GrowthEventDeliveryLeaseLostError();

    const result = await handler(tx, lease.event);
    const skipReason = result && "skipReason" in result ? result.skipReason : undefined;
    const skipped = skipReason !== undefined;
    const status = skipped ? "SKIPPED" : "SUCCEEDED";
    const reason = skipReason === undefined ? null : skipReason.slice(0, ERROR_MAX_CHARS);
    const changed = await tx.$executeRaw`
      UPDATE "growth_event_deliveries"
      SET "status" = ${status}::"GrowthEventDeliveryStatus",
          "processedAt" = ${now},
          "lastError" = ${reason},
          "lockedAt" = NULL,
          "lockedBy" = NULL,
          "leaseToken" = NULL,
          "leaseExpiresAt" = NULL,
          "updatedAt" = ${now}
      WHERE "id" = ${lease.deliveryId}::uuid
        AND "status" = 'RUNNING'::"GrowthEventDeliveryStatus"
        AND "leaseToken" = ${lease.leaseToken}::uuid
        AND "fencingToken" = ${lease.fencingToken}
    `;
    if (changed !== 1) throw new GrowthEventDeliveryLeaseLostError();
    return status;
  });
}

export async function failGrowthEventDelivery(
  prisma: PrismaClient,
  lease: GrowthEventDeliveryLease,
  error: unknown,
  now: Date = new Date(),
): Promise<"RETRY_WAIT" | "FAILED" | null> {
  const status = lease.attemptCount < lease.maxAttempts ? "RETRY_WAIT" : "FAILED";
  const runAt = new Date(now.getTime() + growthEventRetryDelayMs(lease.attemptCount));
  const message = (error instanceof Error ? error.message : String(error)).slice(0, ERROR_MAX_CHARS);
  const rows = await prisma.$queryRaw<Array<{ status: "RETRY_WAIT" | "FAILED" }>>`
    UPDATE "growth_event_deliveries"
    SET "status" = ${status}::"GrowthEventDeliveryStatus",
        "runAt" = ${runAt},
        "lastError" = ${message},
        "lockedAt" = NULL,
        "lockedBy" = NULL,
        "leaseToken" = NULL,
        "leaseExpiresAt" = NULL,
        "updatedAt" = ${now}
    WHERE "id" = ${lease.deliveryId}::uuid
      AND "status" = 'RUNNING'::"GrowthEventDeliveryStatus"
      AND "lockedBy" = ${lease.workerId}
      AND "leaseToken" = ${lease.leaseToken}::uuid
      AND "fencingToken" = ${lease.fencingToken}
      AND "leaseExpiresAt" > ${now}
    RETURNING "status"
  `;
  return rows[0]?.status ?? null;
}

export async function processNextGrowthEventDelivery(
  prisma: PrismaClient,
  handlers: Readonly<Record<string, GrowthEventDeliveryHandler>>,
  options: { workerId: string; now?: Date } ,
): Promise<{
  processed: boolean;
  deliveryId?: string;
  consumerKey?: string;
  status?: "SUCCEEDED" | "SKIPPED" | "RETRY_WAIT" | "FAILED";
}> {
  const lease = await claimNextGrowthEventDelivery(prisma, options);
  if (!lease) return { processed: false };
  try {
    const handler = handlers[lease.consumerKey];
    if (!handler) throw new Error(`成长事件消费者未注册：${lease.consumerKey}`);
    const status = await completeGrowthEventDelivery(prisma, lease, handler, options.now ?? new Date());
    return { processed: true, deliveryId: lease.deliveryId, consumerKey: lease.consumerKey, status };
  } catch (error) {
    if (error instanceof GrowthEventDeliveryLeaseLostError) throw error;
    const status = await failGrowthEventDelivery(prisma, lease, error, options.now ?? new Date());
    if (!status) throw new GrowthEventDeliveryLeaseLostError();
    return { processed: true, deliveryId: lease.deliveryId, consumerKey: lease.consumerKey, status };
  }
}


/**
 * 只清理超过保留期、且所有消费者都已到终态的事件。
 * FAILED / RETRY_WAIT / RUNNING / QUEUED 事件保留，方便恢复与追查；
 * 无订阅者的事件在保留期后也可清理。删除事件由外键级联清除其投递行。
 */
export async function cleanupGrowthEvents(
  prisma: PrismaClient,
  options: { now?: Date; retentionDays?: number; batchSize?: number } = {},
): Promise<number> {
  const now = options.now ?? new Date();
  const retentionDays = Math.max(1, Math.trunc(options.retentionDays ?? GROWTH_EVENT_SUCCESS_RETENTION_DAYS));
  const batchSize = Math.max(1, Math.min(2_000, Math.trunc(options.batchSize ?? 500)));
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
  const deleted = await prisma.$queryRaw<Array<{ id: string }>>`
    WITH candidates AS (
      SELECT event."id"
      FROM "growth_events" AS event
      WHERE event."createdAt" < ${cutoff}
        AND NOT EXISTS (
          SELECT 1
          FROM "growth_event_deliveries" AS delivery
          WHERE delivery."eventId" = event."id"
            AND delivery."status" NOT IN (
              'SUCCEEDED'::"GrowthEventDeliveryStatus",
              'SKIPPED'::"GrowthEventDeliveryStatus",
              'CANCELLED'::"GrowthEventDeliveryStatus"
            )
        )
      ORDER BY event."createdAt" ASC, event."id" ASC
      LIMIT ${batchSize}
      FOR UPDATE SKIP LOCKED
    )
    DELETE FROM "growth_events" AS event
    USING candidates
    WHERE event."id" = candidates."id"
    RETURNING event."id"
  `;
  return deleted.length;
}


/**
 * 角色所有者或 CLI 运维手动恢复已达到重试上限的投递。
 * HTTP 路径必须传 actor，在 SQL 内约束角色归属并写 USER 审计；CLI 写 SYSTEM 审计。
 * 状态切换与审计同事务，fencingToken 保持单调递增，attemptCount 从新一轮归零。
 */
export async function retryFailedGrowthEventDelivery(
  prisma: PrismaClient,
  deliveryId: string,
  now: Date = new Date(),
  actor?: { ownerId: string; characterId: string },
): Promise<{
  deliveryId: string;
  eventId: string;
  characterId: string;
  consumerKey: string;
  previousAttemptCount: number;
} | null> {
  return prisma.$transaction(async (tx) => {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(deliveryId)) {
      throw new Error("成长事件投递 ID 必须是 UUID。");
    }
    const rows = await tx.$queryRaw<Array<{
      deliveryId: string;
      eventId: string;
      characterId: string;
      consumerKey: string;
      previousAttemptCount: number;
      previousLastError: string | null;
    }>>`
      WITH candidate AS (
        SELECT delivery."id", delivery."attemptCount", delivery."lastError"
        FROM "growth_event_deliveries" AS delivery
        INNER JOIN "growth_events" AS source_event ON source_event."id" = delivery."eventId"
        INNER JOIN "characters" AS character ON character."id" = source_event."characterId"
        WHERE delivery."id" = ${deliveryId}::uuid
          AND delivery."status" = 'FAILED'::"GrowthEventDeliveryStatus"
          AND (${actor?.ownerId ?? null}::uuid IS NULL OR (
            character."ownerId" = ${actor?.ownerId ?? null}::uuid
            AND character."id" = ${actor?.characterId ?? null}::uuid
          ))
        FOR UPDATE OF delivery
      ),
      updated AS (
        UPDATE "growth_event_deliveries" AS delivery
        SET
          "status" = 'QUEUED'::"GrowthEventDeliveryStatus",
          "attemptCount" = 0,
          "runAt" = ${now},
          "lockedAt" = NULL,
          "lockedBy" = NULL,
          "leaseToken" = NULL,
          "leaseExpiresAt" = NULL,
          "processedAt" = NULL,
          "updatedAt" = ${now}
        FROM candidate, "growth_events" AS event
        WHERE delivery."id" = candidate."id"
          AND delivery."eventId" = event."id"
        RETURNING delivery."id" AS "deliveryId", delivery."eventId",
          event."characterId", delivery."consumerKey"
      )
      SELECT updated.*, candidate."attemptCount" AS "previousAttemptCount",
        candidate."lastError" AS "previousLastError"
      FROM updated
      INNER JOIN candidate ON candidate."id" = updated."deliveryId"
    `;
    const row = rows[0];
    if (!row) return null;

    await tx.auditLog.create({
      data: {
        actorType: actor ? "USER" : "SYSTEM",
        actorId: actor?.ownerId,
        characterId: row.characterId,
        action: "growth.event_delivery.manual_retry",
        entityType: "GrowthEventDelivery",
        entityId: row.deliveryId,
        details: {
          eventId: row.eventId,
          consumerKey: row.consumerKey,
          retryQueuedAt: now.toISOString(),
          previousStatus: "FAILED",
          previousAttemptCount: row.previousAttemptCount,
          previousLastError: row.previousLastError,
        },
      },
    });
    const { previousLastError: _previousLastError, ...result } = row;
    return result;
  });
}
