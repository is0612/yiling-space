/**
 * 社交关系评估任务队列。
 *
 * 本模块只负责经历触发、合并、定期回顾、任务领取与租约状态；不调用模型，也不直接修改关系阶段。
 * 当前 Worker 只运行维护/恢复逻辑。等独立评估能力完成后，再把评估器接到 claim/complete/fail 生命周期。
 */

import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "../../src/generated/prisma/client";

export const SOCIAL_RELATIONSHIP_TASK_LEASE_MS = 5 * 60 * 1000;
export const SOCIAL_RELATIONSHIP_TASK_MAX_ATTEMPTS = 3;
export const SOCIAL_RELATIONSHIP_QUEUE_BATCH_SIZE = 100;
export const SOCIAL_RELATIONSHIP_REVIEW_DEFAULT_DAYS = 30;

const MIN_REVIEW_DAYS = 1;
const MAX_REVIEW_DAYS = 365;
const RETRY_BASE_MS = 60_000;
const RETRY_MAX_MS = 6 * 60 * 60 * 1000;

export type SocialRelationshipTriggerReason =
  | "NEW_EXPERIENCE"
  | "EXISTING_EXPERIENCE_RECOVERY"
  | "PERIODIC_REVIEW"
  | "LEASE_RECOVERY";

export type SocialRelationshipAssessmentLease = {
  taskId: string;
  scopeId: string;
  workerId: string;
  leaseToken: string;
  fencingToken: number;
  generation: number;
  triggerReasons: string[];
  attemptCount: number;
  maxAttempts: number;
  leaseExpiresAt: Date;
};

export class SocialRelationshipAssessmentLeaseLostError extends Error {
  constructor() {
    super("社交关系评估任务租约已失效；拒绝提交旧执行者的结果。");
    this.name = "SocialRelationshipAssessmentLeaseLostError";
  }
}

export function resolveSocialRelationshipReviewIntervalDays(
  raw: string | undefined = process.env.YILING_SOCIAL_RELATIONSHIP_REVIEW_INTERVAL_DAYS,
): number {
  if (!raw?.trim()) return SOCIAL_RELATIONSHIP_REVIEW_DEFAULT_DAYS;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < MIN_REVIEW_DAYS || value > MAX_REVIEW_DAYS) {
    return SOCIAL_RELATIONSHIP_REVIEW_DEFAULT_DAYS;
  }
  return value;
}

export function socialRelationshipRetryDelayMs(attemptCount: number): number {
  const exponent = Math.max(0, Math.min(16, Math.trunc(attemptCount) - 1));
  return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * (2 ** exponent));
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

/**
 * 在 SocialExperience 写入所在事务中调用。
 * 同一 scope 只保留一行任务；每个真正新插入的经历递增 generation。
 * RUNNING 时保留当前租约，只把 generation 增加，当前批完成后自然会排下一代。
 */
export async function enqueueSocialRelationshipAssessment(
  tx: Prisma.TransactionClient,
  input: {
    scopeId: string;
    reason: SocialRelationshipTriggerReason;
    priority?: number;
    now?: Date;
    reviewIntervalDays?: number;
  },
): Promise<void> {
  const now = input.now ?? new Date();
  const priority = Math.max(0, Math.min(100, Math.trunc(input.priority ?? 0)));
  const reviewIntervalDays = input.reviewIntervalDays ?? resolveSocialRelationshipReviewIntervalDays();
  const nextReviewAt = addDays(now, reviewIntervalDays);

  await tx.$executeRaw`
    INSERT INTO "social_relationship_assessment_tasks" AS current_task (
      "id", "scopeId", "status", "triggerReasons", "generation", "processedGeneration",
      "priority", "runAt", "attemptCount", "maxAttempts", "nextReviewAt", "createdAt", "updatedAt"
    )
    VALUES (
      ${randomUUID()}::uuid,
      ${input.scopeId}::uuid,
      'QUEUED'::"SocialRelationshipAssessmentTaskStatus",
      ARRAY[${input.reason}]::TEXT[],
      1,
      0,
      ${priority},
      ${now},
      0,
      ${SOCIAL_RELATIONSHIP_TASK_MAX_ATTEMPTS},
      ${nextReviewAt},
      ${now},
      ${now}
    )
    ON CONFLICT ("scopeId") DO UPDATE SET
      "status" = CASE
        WHEN current_task."status" = 'RUNNING'::"SocialRelationshipAssessmentTaskStatus"
          THEN current_task."status"
        ELSE 'QUEUED'::"SocialRelationshipAssessmentTaskStatus"
      END,
      "triggerReasons" = ARRAY(
        SELECT DISTINCT reason
        FROM unnest(current_task."triggerReasons" || EXCLUDED."triggerReasons") AS reasons(reason)
        ORDER BY reason
      ),
      "generation" = current_task."generation" + 1,
      "priority" = GREATEST(current_task."priority", EXCLUDED."priority"),
      "runAt" = CASE
        WHEN current_task."status" = 'RUNNING'::"SocialRelationshipAssessmentTaskStatus"
          THEN current_task."runAt"
        ELSE LEAST(current_task."runAt", EXCLUDED."runAt")
      END,
      "attemptCount" = CASE
        WHEN current_task."status" = 'RUNNING'::"SocialRelationshipAssessmentTaskStatus"
          THEN current_task."attemptCount"
        ELSE 0
      END,
      "lastError" = CASE
        WHEN current_task."status" = 'RUNNING'::"SocialRelationshipAssessmentTaskStatus"
          THEN current_task."lastError"
        ELSE NULL
      END,
      "nextReviewAt" = COALESCE(current_task."nextReviewAt", EXCLUDED."nextReviewAt"),
      "updatedAt" = EXCLUDED."updatedAt"
  `;
}

type ExpiredTaskRow = {
  id: string;
  attemptCount: number;
  maxAttempts: number;
  fencingToken: number;
  leaseToken: string | null;
  generation: number;
  processedGeneration: number;
};

async function recoverExpiredLeasesInTransaction(
  tx: Prisma.TransactionClient,
  now: Date,
  batchSize: number,
): Promise<{ recovered: number; failed: number }> {
  const expired = await tx.$queryRaw<ExpiredTaskRow[]>`
    SELECT "id", "attemptCount", "maxAttempts", "fencingToken", "leaseToken",
      "generation", "processedGeneration"
    FROM "social_relationship_assessment_tasks"
    WHERE "status" = 'RUNNING'::"SocialRelationshipAssessmentTaskStatus"
      AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" <= ${now})
    ORDER BY COALESCE("leaseExpiresAt", "lockedAt", "updatedAt") ASC, "id" ASC
    LIMIT ${batchSize}
    FOR UPDATE SKIP LOCKED
  `;

  let recovered = 0;
  let failed = 0;
  for (const task of expired) {
    const hasNewGeneration = task.generation > task.processedGeneration;
    const retry = hasNewGeneration || task.attemptCount < task.maxAttempts;
    const status = hasNewGeneration ? "QUEUED" : retry ? "RETRY_WAIT" : "FAILED";
    const runAt = hasNewGeneration
      ? now
      : retry
        ? new Date(now.getTime() + socialRelationshipRetryDelayMs(task.attemptCount))
        : now;
    const changed = await tx.$executeRaw`
      UPDATE "social_relationship_assessment_tasks"
      SET
        "status" = ${status}::"SocialRelationshipAssessmentTaskStatus",
        "runAt" = ${runAt},
        "attemptCount" = CASE WHEN ${hasNewGeneration} THEN 0 ELSE "attemptCount" END,
        "lockedAt" = NULL,
        "lockedBy" = NULL,
        "leaseToken" = NULL,
        "leaseExpiresAt" = NULL,
        "lastError" = '执行租约已过期，系统已恢复该任务的队列状态。',
        "triggerReasons" = CASE
          WHEN 'LEASE_RECOVERY' = ANY("triggerReasons") THEN "triggerReasons"
          ELSE array_append("triggerReasons", 'LEASE_RECOVERY')
        END,
        "updatedAt" = ${now}
      WHERE "id" = ${task.id}::uuid
        AND "status" = 'RUNNING'::"SocialRelationshipAssessmentTaskStatus"
        AND "fencingToken" = ${task.fencingToken}
        AND "leaseToken" IS NOT DISTINCT FROM ${task.leaseToken}::uuid
        AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" <= ${now})
    `;
    if (changed !== 1) continue;
    if (retry) recovered += 1;
    else failed += 1;
  }
  return { recovered, failed };
}

/**
 * 本地 Worker 每轮运行的维护工作：
 * 1. 为历史回填或旧数据中尚无任务的经历补建队列项；
 * 2. 将到期且上一代已处理的 PAUSED 任务排入下一次定期回顾；
 * 3. 回收租约过期的 RUNNING 任务。
 *
 * 不领取、不完成评估任务；避免在评估 AI 尚未接入时制造虚假的「成功」。
 */
export async function runSocialRelationshipQueueMaintenance(
  prisma: PrismaClient,
  options: {
    now?: Date;
    batchSize?: number;
    reviewIntervalDays?: number;
  } = {},
): Promise<{
  backfilled: number;
  periodicQueued: number;
  recoveredLeases: number;
  failedLeases: number;
}> {
  const now = options.now ?? new Date();
  const batchSize = Math.max(1, Math.min(500, Math.trunc(options.batchSize ?? SOCIAL_RELATIONSHIP_QUEUE_BATCH_SIZE)));
  const reviewDays = options.reviewIntervalDays ?? resolveSocialRelationshipReviewIntervalDays();
  const nextReviewAt = addDays(now, reviewDays);

  return prisma.$transaction(async (tx) => {
    const backfilled = await tx.$executeRaw`
      INSERT INTO "social_relationship_assessment_tasks" (
        "id", "scopeId", "status", "triggerReasons", "generation", "processedGeneration",
        "priority", "runAt", "attemptCount", "maxAttempts", "nextReviewAt", "createdAt", "updatedAt"
      )
      SELECT
        gen_random_uuid(),
        missing."scopeId",
        'QUEUED'::"SocialRelationshipAssessmentTaskStatus",
        ARRAY['EXISTING_EXPERIENCE_RECOVERY']::TEXT[],
        1,
        0,
        0,
        ${now},
        0,
        ${SOCIAL_RELATIONSHIP_TASK_MAX_ATTEMPTS},
        ${nextReviewAt},
        ${now},
        ${now}
      FROM (
        SELECT DISTINCT experience."scopeId"
        FROM "social_experiences" AS experience
        INNER JOIN "memory_scopes" AS scope
          ON scope."id" = experience."scopeId"
         AND scope."scopeType" = 'EXTERNAL_IDENTITY'
        LEFT JOIN "social_relationship_assessment_tasks" AS task
          ON task."scopeId" = experience."scopeId"
        WHERE task."id" IS NULL
        ORDER BY experience."scopeId" ASC
        LIMIT ${batchSize}
      ) AS missing
      ON CONFLICT ("scopeId") DO NOTHING
    `;

    const periodicQueued = await tx.$executeRaw`
      WITH due AS (
        SELECT "id"
        FROM "social_relationship_assessment_tasks"
        WHERE "status" = 'PAUSED'::"SocialRelationshipAssessmentTaskStatus"
          AND "nextReviewAt" IS NOT NULL
          AND "nextReviewAt" <= ${now}
          AND "generation" <= "processedGeneration"
        ORDER BY "nextReviewAt" ASC, "id" ASC
        LIMIT ${batchSize}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE "social_relationship_assessment_tasks" AS task
      SET
        "status" = 'QUEUED'::"SocialRelationshipAssessmentTaskStatus",
        "generation" = task."generation" + 1,
        "triggerReasons" = CASE
          WHEN 'PERIODIC_REVIEW' = ANY(task."triggerReasons") THEN task."triggerReasons"
          ELSE array_append(task."triggerReasons", 'PERIODIC_REVIEW')
        END,
        "runAt" = ${now},
        "attemptCount" = 0,
        "lastError" = NULL,
        "nextReviewAt" = ${nextReviewAt},
        "updatedAt" = ${now}
      FROM due
      WHERE task."id" = due."id"
    `;

    const leases = await recoverExpiredLeasesInTransaction(tx, now, batchSize);
    return {
      backfilled,
      periodicQueued,
      recoveredLeases: leases.recovered,
      failedLeases: leases.failed,
    };
  });
}

type ClaimedTaskRow = {
  id: string;
  scopeId: string;
  attemptCount: number;
  maxAttempts: number;
  fencingToken: number;
  leaseToken: string;
  leaseExpiresAt: Date;
  generation: number;
  triggerReasons: string[];
};

export async function claimNextSocialRelationshipAssessmentTask(
  prisma: PrismaClient,
  options: { workerId?: string; scopeId?: string; now?: Date; leaseMs?: number; requireAssistantEnabled?: boolean } = {},
): Promise<SocialRelationshipAssessmentLease | null> {
  const now = options.now ?? new Date();
  const workerId = options.workerId ?? `social-assessment-worker-${process.pid}`;
  const leaseToken = randomUUID();
  const leaseMs = Math.max(1_000, Math.trunc(options.leaseMs ?? SOCIAL_RELATIONSHIP_TASK_LEASE_MS));
  const leaseExpiresAt = new Date(now.getTime() + leaseMs);
  const scopeFilter = options.scopeId ? Prisma.sql`AND task."scopeId" = ${options.scopeId}::uuid` : Prisma.empty;
  const enabledFilter = options.requireAssistantEnabled ? Prisma.raw("AND character.\"modelConfig\" ->> 'socialRelationshipAssessmentAssistantEnabled' = 'true'") : Prisma.empty;

  return prisma.$transaction(async (tx) => {
    await recoverExpiredLeasesInTransaction(tx, now, SOCIAL_RELATIONSHIP_QUEUE_BATCH_SIZE);
    const rows = await tx.$queryRaw<ClaimedTaskRow[]>`
      WITH candidate AS (
        SELECT task."id", task."generation", task."triggerReasons"
        FROM "social_relationship_assessment_tasks" AS task
        INNER JOIN "memory_scopes" AS scope
          ON scope."id" = task."scopeId"
         AND scope."scopeType" = 'EXTERNAL_IDENTITY'
        INNER JOIN "characters" AS character ON character."id" = scope."characterId"
        WHERE task."status" IN (
            'QUEUED'::"SocialRelationshipAssessmentTaskStatus",
            'RETRY_WAIT'::"SocialRelationshipAssessmentTaskStatus"
          )
          AND task."runAt" <= ${now}
          AND task."attemptCount" < task."maxAttempts"
          ${scopeFilter}
          ${enabledFilter}
        ORDER BY task."priority" DESC, task."runAt" ASC, task."createdAt" ASC, task."id" ASC
        LIMIT 1
        FOR UPDATE OF task SKIP LOCKED
      ),
      claimed AS (
        UPDATE "social_relationship_assessment_tasks" AS task
        SET
          "status" = 'RUNNING'::"SocialRelationshipAssessmentTaskStatus",
          "attemptCount" = task."attemptCount" + 1,
          "lockedAt" = ${now},
          "lockedBy" = ${workerId},
          "leaseToken" = ${leaseToken}::uuid,
          "leaseExpiresAt" = ${leaseExpiresAt},
          "fencingToken" = task."fencingToken" + 1,
          -- 领取即认领本代：过期恢复靠 generation > processedGeneration 判断「执行期间是否来了新代」，
          -- 若这里不前移，任何过期都会满足该条件，退避与最大尝试次数形同虚设（毒任务无限重试）。
          "processedGeneration" = task."generation",
          -- 领取即把「本批待处理原因」移出任务行：本代的原因冻结在返回的租约里，
          -- 执行期间新到的原因才是下一代的。失败时 failSocialRelationshipAssessmentTask
          -- 会把租约里的原因并回去，所以这里必须先清空，否则两代会共用同一批原因。
          "triggerReasons" = ARRAY[]::TEXT[],
          "lastError" = NULL,
          "updatedAt" = ${now}
        FROM candidate
        WHERE task."id" = candidate."id"
        RETURNING task."id", task."scopeId", task."attemptCount", task."maxAttempts",
          task."fencingToken", task."leaseToken", task."leaseExpiresAt"
      )
      SELECT claimed."id", claimed."scopeId", claimed."attemptCount", claimed."maxAttempts",
        claimed."fencingToken", claimed."leaseToken", claimed."leaseExpiresAt",
        candidate."generation", candidate."triggerReasons"
      FROM claimed
      INNER JOIN candidate ON candidate."id" = claimed."id"
    `;
    const task = rows[0];
    if (!task) return null;
    return {
      taskId: task.id,
      scopeId: task.scopeId,
      workerId,
      leaseToken: task.leaseToken,
      fencingToken: task.fencingToken,
      generation: task.generation,
      triggerReasons: task.triggerReasons,
      attemptCount: task.attemptCount,
      maxAttempts: task.maxAttempts,
      leaseExpiresAt: task.leaseExpiresAt,
    };
  });
}

export async function renewSocialRelationshipAssessmentLease(
  prisma: PrismaClient,
  lease: SocialRelationshipAssessmentLease,
  now: Date = new Date(),
  leaseMs = SOCIAL_RELATIONSHIP_TASK_LEASE_MS,
): Promise<Date> {
  const expiresAt = new Date(now.getTime() + Math.max(1_000, Math.trunc(leaseMs)));
  const updated = await prisma.$executeRaw`
    UPDATE "social_relationship_assessment_tasks"
    SET "lockedAt" = ${now}, "leaseExpiresAt" = ${expiresAt}, "updatedAt" = ${now}
    WHERE "id" = ${lease.taskId}::uuid
      AND "status" = 'RUNNING'::"SocialRelationshipAssessmentTaskStatus"
      AND "lockedBy" = ${lease.workerId}
      AND "leaseToken" = ${lease.leaseToken}::uuid
      AND "fencingToken" = ${lease.fencingToken}
      AND "leaseExpiresAt" > ${now}
  `;
  if (updated !== 1) throw new SocialRelationshipAssessmentLeaseLostError();
  return expiresAt;
}

/**
 * 评估器完成当前 generation 后调用。若执行期间 generation 已增加，只将任务重新排队，
 * 不会覆盖新触发；否则进入 PAUSED 并安排下一次定期回顾。
 */
export async function completeSocialRelationshipAssessmentTask(
  prisma: PrismaClient | Prisma.TransactionClient,
  lease: SocialRelationshipAssessmentLease,
  options: { now?: Date; reviewIntervalDays?: number } = {},
): Promise<"QUEUED" | "PAUSED"> {
  const now = options.now ?? new Date();
  const nextReviewAt = addDays(now, options.reviewIntervalDays ?? resolveSocialRelationshipReviewIntervalDays());
  const rows = await prisma.$queryRaw<Array<{ status: "QUEUED" | "PAUSED" }>>`
    UPDATE "social_relationship_assessment_tasks"
    SET
      "processedGeneration" = GREATEST("processedGeneration", ${lease.generation}),
      "triggerReasons" = CASE
        WHEN "generation" > ${lease.generation} THEN "triggerReasons"
        ELSE ARRAY[]::TEXT[]
      END,
      "status" = CASE
        WHEN "generation" > ${lease.generation}
          THEN 'QUEUED'::"SocialRelationshipAssessmentTaskStatus"
        ELSE 'PAUSED'::"SocialRelationshipAssessmentTaskStatus"
      END,
      "runAt" = CASE WHEN "generation" > ${lease.generation} THEN ${now} ELSE "runAt" END,
      "nextReviewAt" = CASE WHEN "generation" > ${lease.generation} THEN "nextReviewAt" ELSE ${nextReviewAt} END,
      "attemptCount" = 0,
      "lockedAt" = NULL,
      "lockedBy" = NULL,
      "leaseToken" = NULL,
      "leaseExpiresAt" = NULL,
      "lastError" = NULL,
      "lastAssessedAt" = ${now},
      "updatedAt" = ${now}
    WHERE "id" = ${lease.taskId}::uuid
      AND "status" = 'RUNNING'::"SocialRelationshipAssessmentTaskStatus"
      AND "lockedBy" = ${lease.workerId}
      AND "leaseToken" = ${lease.leaseToken}::uuid
      AND "fencingToken" = ${lease.fencingToken}
      AND "leaseExpiresAt" > ${now}
    RETURNING "status"
  `;
  const status = rows[0]?.status;
  if (!status) throw new SocialRelationshipAssessmentLeaseLostError();
  return status;
}

export async function failSocialRelationshipAssessmentTask(
  prisma: PrismaClient | Prisma.TransactionClient,
  lease: SocialRelationshipAssessmentLease,
  error: unknown,
  now: Date = new Date(),
): Promise<"QUEUED" | "RETRY_WAIT" | "FAILED"> {
  const retryAt = new Date(now.getTime() + socialRelationshipRetryDelayMs(lease.attemptCount));
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 4_000) || "未知评估错误";
  const rows = await prisma.$queryRaw<Array<{ status: "QUEUED" | "RETRY_WAIT" | "FAILED" }>>`
    UPDATE "social_relationship_assessment_tasks"
    SET
      "status" = CASE
        WHEN "generation" > ${lease.generation}
          THEN 'QUEUED'::"SocialRelationshipAssessmentTaskStatus"
        WHEN ${lease.attemptCount < lease.maxAttempts}
          THEN 'RETRY_WAIT'::"SocialRelationshipAssessmentTaskStatus"
        ELSE 'FAILED'::"SocialRelationshipAssessmentTaskStatus"
      END,
      "runAt" = CASE
        -- 三个分支都是参数时 Postgres 推不出类型，会把整列当 text 再赋给 timestamptz，
        -- 报 42804。complete 那边能用是因为 ELSE 引用了列本身，类型有依据，这里没有。
        WHEN "generation" > ${lease.generation} THEN ${now}::timestamptz
        WHEN ${lease.attemptCount < lease.maxAttempts} THEN ${retryAt}::timestamptz
        ELSE ${now}::timestamptz
      END,
      "attemptCount" = CASE
        WHEN "generation" > ${lease.generation} THEN 0
        ELSE "attemptCount"
      END,
      "triggerReasons" = ARRAY(
        SELECT DISTINCT reason
        FROM unnest("triggerReasons" || ${lease.triggerReasons}::TEXT[]) AS reasons(reason)
        ORDER BY reason
      ),
      "lockedAt" = NULL,
      "lockedBy" = NULL,
      "leaseToken" = NULL,
      "leaseExpiresAt" = NULL,
      "lastError" = ${message},
      "updatedAt" = ${now}
    WHERE "id" = ${lease.taskId}::uuid
      AND "status" = 'RUNNING'::"SocialRelationshipAssessmentTaskStatus"
      AND "lockedBy" = ${lease.workerId}
      AND "leaseToken" = ${lease.leaseToken}::uuid
      AND "fencingToken" = ${lease.fencingToken}
      AND "leaseExpiresAt" > ${now}
    RETURNING "status"
  `;
  const status = rows[0]?.status;
  if (!status) throw new SocialRelationshipAssessmentLeaseLostError();
  return status;
}
