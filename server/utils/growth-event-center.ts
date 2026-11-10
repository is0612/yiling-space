import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "../../src/generated/prisma/client";

/**
 * 统一成长事件的稳定协议。事件只表达「发生了什么」和来源引用，
 * 不复制 MemoryEvent / SocialExperience / KnowledgeItem 的正文。
 */
export type GrowthEventDomain = "memory" | "social" | "knowledge" | "preference" | "corpus" | "state" | "reflection" | "goal";

export type GrowthEventInput = {
  characterId: string;
  sourceDomain: GrowthEventDomain;
  eventType: string;
  schemaVersion?: number;
  aggregateType: string;
  aggregateId: string;
  occurredAt: Date;
  idempotencyKey: string;
  payload?: Prisma.InputJsonValue;
};

export type GrowthEventEnvelope = {
  id: string;
  characterId: string;
  sourceDomain: GrowthEventDomain;
  eventType: string;
  schemaVersion: number;
  aggregateType: string;
  aggregateId: string;
  occurredAt: Date;
  createdAt: Date;
  payload: Prisma.JsonValue;
};

export type GrowthEventPublishResult = {
  eventId: string;
  created: boolean;
  deliveryCount: number;
};

export const GROWTH_EVENT_MAX_ATTEMPTS = 5;
export const GROWTH_EVENT_LEASE_MS = 5 * 60 * 1000;
export const GROWTH_EVENT_SUCCESS_RETENTION_DAYS = 30;

/**
 * 订阅在代码中显式声明，新增订阅只影响此后发布的事件。
 * 第一阶段不回补历史事件，避免上线消费者时瞬间触发历史任务。
 */
export const GROWTH_EVENT_SUBSCRIPTIONS: Readonly<Record<string, readonly string[]>> = Object.freeze({});

const EVENT_TYPE_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const DOMAIN_SET = new Set<GrowthEventDomain>([
  "memory", "social", "knowledge", "preference", "corpus", "state", "reflection", "goal",
]);

export function normalizeGrowthEventInput(input: GrowthEventInput): GrowthEventInput {
  const characterId = input.characterId.trim();
  const sourceDomain = input.sourceDomain;
  const eventType = input.eventType.trim();
  const aggregateType = input.aggregateType.trim();
  const aggregateId = input.aggregateId.trim();
  const idempotencyKey = input.idempotencyKey.trim();
  const schemaVersion = input.schemaVersion ?? 1;

  if (!characterId) throw new Error("成长事件必须关联角色。");
  if (!DOMAIN_SET.has(sourceDomain)) throw new Error("成长事件来源领域无效。");
  if (!EVENT_TYPE_PATTERN.test(eventType) || eventType.length > 120) throw new Error("成长事件类型格式无效。");
  if (!aggregateType || aggregateType.length > 120) throw new Error("成长事件聚合类型无效。");
  if (!aggregateId || aggregateId.length > 255) throw new Error("成长事件聚合 ID 无效。");
  if (!idempotencyKey || idempotencyKey.length > 255) throw new Error("成长事件幂等键无效。");
  if (!Number.isSafeInteger(schemaVersion) || schemaVersion < 1) throw new Error("成长事件 schemaVersion 必须是正整数。");
  if (!(input.occurredAt instanceof Date) || !Number.isFinite(input.occurredAt.getTime())) {
    throw new Error("成长事件发生时间无效。");
  }
  if (input.payload !== undefined) {
    try {
      JSON.stringify(input.payload);
    } catch {
      throw new Error("成长事件 payload 必须是可序列化 JSON。");
    }
  }
  return {
    ...input,
    characterId,
    sourceDomain,
    eventType,
    schemaVersion,
    aggregateType,
    aggregateId,
    idempotencyKey,
    payload: input.payload ?? {},
  };
}

/**
 * 必须在领域数据变更所在的 Prisma transaction 内调用。
 * 先写 Outbox，再按发布时的订阅快照扇出投递；唯一键冲突只返回既有事件，
 * 不会给后来新增的订阅者补投历史事件。
 */
export async function publishGrowthEvent(
  tx: Prisma.TransactionClient,
  rawInput: GrowthEventInput,
): Promise<GrowthEventPublishResult> {
  const input = normalizeGrowthEventInput(rawInput);
  const eventId = randomUUID();
  const payload = JSON.stringify(input.payload ?? {});
  const inserted = await tx.$executeRaw`
    INSERT INTO "growth_events" (
      "id", "characterId", "sourceDomain", "eventType", "schemaVersion",
      "aggregateType", "aggregateId", "occurredAt", "payload", "idempotencyKey", "createdAt"
    ) VALUES (
      ${eventId}::uuid, ${input.characterId}::uuid, ${input.sourceDomain}, ${input.eventType},
      ${input.schemaVersion}, ${input.aggregateType}, ${input.aggregateId},
      ${input.occurredAt}, ${payload}::jsonb, ${input.idempotencyKey}, NOW()
    )
    ON CONFLICT ("characterId", "sourceDomain", "idempotencyKey") DO NOTHING
  `;

  if (inserted === 0) {
    const existing = await tx.$queryRaw<Array<{
      id: string; eventType: string; schemaVersion: number; aggregateType: string; aggregateId: string;
    }>>`
      SELECT "id", "eventType", "schemaVersion", "aggregateType", "aggregateId"
      FROM "growth_events"
      WHERE "characterId" = ${input.characterId}::uuid
        AND "sourceDomain" = ${input.sourceDomain}
        AND "idempotencyKey" = ${input.idempotencyKey}
      LIMIT 1
    `;
    const row = existing[0];
    if (!row) throw new Error("成长事件幂等记录写入后无法读取。");
    if (
      row.eventType !== input.eventType
      || row.schemaVersion !== input.schemaVersion
      || row.aggregateType !== input.aggregateType
      || row.aggregateId !== input.aggregateId
    ) {
      throw new Error("成长事件幂等键冲突：同一业务键对应了不同事件主体。");
    }
    return { eventId: row.id, created: false, deliveryCount: 0 };
  }

  const consumers = GROWTH_EVENT_SUBSCRIPTIONS[input.eventType] ?? [];
  if (consumers.length) {
    const rows = consumers.map((consumerKey) => Prisma.sql`(
      ${randomUUID()}::uuid, ${eventId}::uuid, ${consumerKey},
      'QUEUED'::"GrowthEventDeliveryStatus", 0, ${GROWTH_EVENT_MAX_ATTEMPTS}, NOW(), NOW(), NOW()
    )`);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "growth_event_deliveries" (
        "id", "eventId", "consumerKey", "status", "attemptCount", "maxAttempts",
        "runAt", "createdAt", "updatedAt"
      ) VALUES ${Prisma.join(rows)}
      ON CONFLICT ("eventId", "consumerKey") DO NOTHING
    `);
  }

  return { eventId, created: true, deliveryCount: consumers.length };
}

/** 便于测试与运行时诊断：当前某类事件在发布时会扇出给哪些消费者。 */
export function listGrowthEventSubscribers(eventType: string): readonly string[] {
  return GROWTH_EVENT_SUBSCRIPTIONS[eventType] ?? [];
}

/** PrismaClient 导入保留给后续 delivery/worker 模块统一类型边界。 */
export type GrowthEventPrisma = PrismaClient;
