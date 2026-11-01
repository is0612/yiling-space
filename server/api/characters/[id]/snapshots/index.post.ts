import { randomUUID } from "node:crypto";
import { createError, getRouterParam, readBody } from "h3";
import { isMemoryModelConfigured } from "../../../../utils/memory-ai";
import { requireActorUserId } from "../../../../utils/auth";
import { requireUuid } from "../../../../utils/local-api";
import { getPrisma } from "../../../../utils/prisma";

type CreateSnapshotBody = {
  snapshotId?: unknown;
  mode?: unknown;
};

export default defineEventHandler(async (event) => {
  const ownerId = await requireActorUserId(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const body = await readBody<CreateSnapshotBody>(event).catch(() => ({} as CreateSnapshotBody));

  let sourceSnapshotId: string | undefined;
  if (body?.snapshotId !== undefined) {
    if (typeof body.snapshotId !== "string") {
      throw createError({ statusCode: 400, statusMessage: "阶段总结 ID 格式无效。" });
    }
    sourceSnapshotId = requireUuid(body.snapshotId, "阶段总结");
  }

  if (body?.mode !== undefined && body.mode !== "ai") {
    throw createError({ statusCode: 400, statusMessage: "归档操作模式无效。" });
  }
  if (body?.mode === "ai" && !sourceSnapshotId) {
    throw createError({ statusCode: 400, statusMessage: "AI 重新提炼必须指定一份已有的自动归档。" });
  }

  const prisma = getPrisma();
  const character = await prisma.character.findFirst({
    where: { id: characterId, ownerId },
    select: {
      id: true,
      memorySetting: { select: { snapshotIntervalDays: true } },
      memoryScopes: {
        where: { scopeType: "CHARACTER_GLOBAL" },
        select: { id: true },
        take: 1,
      },
    },
  });

  if (!character) {
    throw createError({ statusCode: 404, statusMessage: "角色不存在。" });
  }

  const memoryScopeId = character.memoryScopes[0]?.id;
  if (!memoryScopeId) {
    throw createError({ statusCode: 409, statusMessage: "该角色还没有全局记忆范围，请先重新保存角色档案。" });
  }

  const sourceSnapshot = sourceSnapshotId
    ? await prisma.memorySnapshot.findFirst({
        where: { id: sourceSnapshotId, memoryScopeId },
        select: { id: true, snapshotKey: true, periodStart: true, periodEnd: true, kind: true, status: true, version: true },
      })
    : null;

  if (sourceSnapshotId && !sourceSnapshot) {
    throw createError({ statusCode: 404, statusMessage: "阶段总结不存在。" });
  }

  if (body?.mode === "ai") {
    if (!sourceSnapshot || sourceSnapshot.kind !== "AUTOMATIC") {
      throw createError({ statusCode: 409, statusMessage: "只有自动 AI 归档支持 AI 重新提炼；手动归档请使用普通的版本复制操作。" });
    }
    if (!isMemoryModelConfigured()) {
      throw createError({ statusCode: 503, statusMessage: "尚未配置 AI 模型。请先在服务端 .env 填写 LLM_API_KEY 和 LLM_MODEL。" });
    }

    const activeJob = await prisma.memoryJob.findFirst({
      where: { memoryScopeId, snapshotId: sourceSnapshot.id, type: "REGENERATE_SNAPSHOT", status: { in: ["QUEUED", "RUNNING", "RETRY_WAIT"] } },
      orderBy: [{ createdAt: "desc" }],
      select: { id: true, status: true },
    });
    if (activeJob) {
      setResponseStatus(event, 202);
      return { id: activeJob.id, jobId: activeJob.id, status: activeJob.status, snapshotId: sourceSnapshot.id, queued: true, duplicate: true };
    }

    const now = new Date();
    const queuedJob = await prisma.$transaction(async (tx) => {
      const job = await tx.memoryJob.create({
        data: {
          memoryScopeId,
          snapshotId: sourceSnapshot.id,
          type: "REGENERATE_SNAPSHOT",
          idempotencyKey: "regenerate-snapshot:" + sourceSnapshot.id + ":" + randomUUID(),
          periodStart: sourceSnapshot.periodStart,
          periodEnd: sourceSnapshot.periodEnd,
          status: "QUEUED",
          runAt: now,
          maxAttempts: 3,
        },
        select: { id: true, status: true },
      });
      await tx.auditLog.create({
        data: {
          actorType: "USER",
          actorId: ownerId,
          characterId,
          action: "snapshot.ai_regeneration_requested",
          entityType: "MemorySnapshot",
          entityId: sourceSnapshot.id,
          details: { jobId: job.id, sourceVersion: sourceSnapshot.version, periodStart: sourceSnapshot.periodStart.toISOString(), periodEnd: sourceSnapshot.periodEnd.toISOString() },
        },
      });
      return job;
    });

    setResponseStatus(event, 202);
    return { id: queuedJob.id, jobId: queuedJob.id, status: queuedJob.status, snapshotId: sourceSnapshot.id, queued: true, duplicate: false };
  }

  const now = new Date();
  const intervalDays = Math.max(1, character.memorySetting?.snapshotIntervalDays ?? 8);
  const snapshotKey = sourceSnapshot?.snapshotKey ?? ("manual:" + memoryScopeId + ":" + randomUUID());
  const periodStart = sourceSnapshot?.periodStart ?? new Date(now.getTime() - intervalDays * 24 * 60 * 60 * 1000);
  const periodEnd = sourceSnapshot?.periodEnd ?? now;

  const activeItems = await prisma.memoryItem.findMany({
    where: { memoryScopeId, status: "ACTIVE" },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      category: true,
      content: true,
      confidence: true,
      validFrom: true,
      validTo: true,
      createdAt: true,
    },
  });

  const sourceMessages = await prisma.message.findMany({
    where: {
      conversation: { is: { characterId, memoryScopeId } },
      occurredAt: { gte: periodStart, lte: periodEnd },
    },
    orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
    take: 250,
    select: { id: true, eventType: true },
  });
  const summaryParts: string[] = [];
  if (activeItems.length) summaryParts.push(`关联 ${activeItems.length} 条长期记忆`);
  if (sourceMessages.length) summaryParts.push(`关联 ${sourceMessages.length} 条周期内消息/事件`);
  const summary = summaryParts.length
    ? `人工归档：${summaryParts.join("，")}。尚未调用大模型生成自然语言总结。`
    : "人工归档：周期内没有已保存的消息或长期记忆。尚未调用大模型生成自然语言总结。";
  const structuredContent = {
    generatedBy: "manual",
    capturedAt: now.toISOString(),
    messageCount: sourceMessages.length,
    eventCount: sourceMessages.filter((message) => message.eventType !== "message").length,
    memoryItems: activeItems.map((item) => ({
      id: item.id,
      category: item.category,
      content: item.content,
      ...(item.confidence !== null ? { confidence: item.confidence } : {}),
      ...(item.validFrom ? { validFrom: item.validFrom.toISOString() } : {}),
      ...(item.validTo ? { validTo: item.validTo.toISOString() } : {}),
      createdAt: item.createdAt.toISOString(),
    })),
  };

  const snapshot = await prisma.$transaction(async (tx) => {
    const latest = await tx.memorySnapshot.findFirst({
      where: { memoryScopeId, snapshotKey },
      orderBy: { version: "desc" },
      select: { version: true },
    });
    const version = (latest?.version ?? 0) + 1;

    await tx.memorySnapshot.updateMany({
      where: { memoryScopeId, snapshotKey, status: "CURRENT" },
      data: { status: "SUPERSEDED" },
    });

    return tx.memorySnapshot.create({
      data: {
        snapshotKey,
        memoryScopeId,
        kind: "MANUAL",
        version,
        periodStart,
        periodEnd,
        summary,
        structuredContent,
        status: "CURRENT",
        generatedAt: now,
        sources: {
          create: [
            ...activeItems.map((item) => ({
              sourceType: "MEMORY_ITEM" as const,
              sourceRef: item.id,
              memoryItemId: item.id,
            })),
            ...sourceMessages.map((message) => ({
              sourceType: "MESSAGE" as const,
              sourceRef: message.id,
              messageId: message.id,
            })),
          ],
        },
      },
      select: { id: true, version: true },
    });
  });

  return { id: snapshot.id, version: snapshot.version };
});
