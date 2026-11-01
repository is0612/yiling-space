import { createError, getRouterParam, readBody } from "h3";
import { requireActorUserId } from "../../../../../utils/auth";
import { requireUuid } from "../../../../../utils/local-api";
import { getPrisma } from "../../../../../utils/prisma";
import { applyMemoryChange, normalizeMemoryText } from "../../../../../utils/memory-change-apply";
import type { MemoryCategoryValue, MemoryChange } from "../../../../../utils/memory-ai";

type ReviewBody = {
  changeIndex?: unknown;
  decision?: unknown;
};

const DECISIONS = ["ACCEPT", "IGNORE"] as const;
type ReviewDecisionInput = (typeof DECISIONS)[number];

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * 逐条处置重新提炼提出的长期记忆建议。
 *
 * 采纳走的是和 Worker 自动生成完全相同的落库函数（applyMemoryChange），
 * 否则「人工采纳」和「自动生成」会慢慢长出两套行为。
 */
export default defineEventHandler(async (event) => {
  const ownerId = await requireActorUserId(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const snapshotId = requireUuid(getRouterParam(event, "snapshotId") ?? "", "阶段总结");
  const body = await readBody<ReviewBody>(event).catch(() => ({} as ReviewBody));

  if (typeof body?.changeIndex !== "number" || !Number.isInteger(body.changeIndex) || body.changeIndex < 0) {
    throw createError({ statusCode: 400, statusMessage: "建议序号无效。" });
  }
  const changeIndex = body.changeIndex;
  if (typeof body?.decision !== "string" || !(DECISIONS as readonly string[]).includes(body.decision)) {
    throw createError({ statusCode: 400, statusMessage: "处置动作无效，只能是采纳或忽略。" });
  }
  const decision = body.decision as ReviewDecisionInput;

  const prisma = getPrisma();
  const character = await prisma.character.findFirst({
    where: { id: characterId, ownerId },
    select: {
      id: true,
      memoryScopes: { where: { scopeType: "CHARACTER_GLOBAL" }, select: { id: true }, take: 1 },
    },
  });
  if (!character) {
    throw createError({ statusCode: 404, statusMessage: "角色不存在。" });
  }
  const memoryScopeId = character.memoryScopes[0]?.id;
  if (!memoryScopeId) {
    throw createError({ statusCode: 409, statusMessage: "该角色还没有全局记忆范围。" });
  }

  const snapshot = await prisma.memorySnapshot.findFirst({
    where: { id: snapshotId, memoryScopeId },
    select: {
      id: true,
      kind: true,
      structuredContent: true,
      reviews: { select: { changeIndex: true, decision: true } },
    },
  });
  if (!snapshot) {
    throw createError({ statusCode: 404, statusMessage: "阶段总结不存在。" });
  }
  if (snapshot.kind !== "AUTOMATIC") {
    throw createError({ statusCode: 409, statusMessage: "只有自动归档的提炼建议可以逐条审核。" });
  }

  const structured = asRecord(snapshot.structuredContent);
  const changes = Array.isArray(structured?.memoryChangesApplied) ? structured.memoryChangesApplied : [];
  const target = asRecord(changes[changeIndex]);
  if (!target) {
    throw createError({ statusCode: 404, statusMessage: "这条建议不存在，可能该版本已被重新提炼替代。" });
  }
  if (target.result !== "NOT_APPLIED_REGENERATION") {
    throw createError({ statusCode: 409, statusMessage: "这条建议已经应用过，不需要再审核。" });
  }
  const previousReview = snapshot.reviews.find((review) => review.changeIndex === changeIndex);
  if (previousReview) {
    throw createError({
      statusCode: 409,
      statusMessage: previousReview.decision === "ACCEPTED" ? "这条建议已经采纳过了。" : "这条建议已经忽略过了。",
    });
  }

  if (decision === "IGNORE") {
    await prisma.$transaction(async (tx) => {
      await tx.memoryReview.create({
        data: { snapshotId, changeIndex, decision: "IGNORED", decidedByUserId: ownerId },
      });
      await tx.auditLog.create({
        data: {
          actorType: "USER",
          actorId: ownerId,
          characterId,
          action: "snapshot.review_ignored",
          entityType: "MemorySnapshot",
          entityId: snapshotId,
          details: {
            changeIndex,
            action: typeof target.action === "string" ? target.action : null,
            content: typeof target.content === "string" ? target.content : null,
          },
        },
      });
    });
    return { snapshotId, changeIndex, decision: "IGNORED" as const, memoryItemId: null, outcome: null };
  }

  const change: MemoryChange = {
    action: target.action as MemoryChange["action"],
    category: target.category as MemoryCategoryValue,
    content: String(target.content ?? ""),
    confidence: typeof target.confidence === "number" ? target.confidence : 0,
    evidenceMessageIds: Array.isArray(target.evidenceMessageIds)
      ? target.evidenceMessageIds.filter((id): id is string => typeof id === "string")
      : [],
    ...(typeof target.supersededMemoryId === "string" ? { relatedMemoryId: target.supersededMemoryId } : {}),
  };

  // 证据消息可能已经被保留期限清理掉；取不到就只丢来源指针，不阻塞采纳。
  const evidence = change.evidenceMessageIds.length
    ? await prisma.message.findMany({
        where: { id: { in: change.evidenceMessageIds } },
        select: { id: true, occurredAt: true },
      })
    : [];

  // 已存在的同内容记忆要先灌进签名集合，否则采纳会和库里已有条目重复。
  const activeItems = await prisma.memoryItem.findMany({
    where: { memoryScopeId, status: "ACTIVE" },
    select: { category: true, content: true },
    take: 2000,
  });
  const existingItemSignatures = new Set(
    activeItems.map((item) => item.category + ":" + normalizeMemoryText(item.content)),
  );

  let outcome: Record<string, unknown> | null = null;
  try {
    outcome = await prisma.$transaction(async (tx) => {
      const applied = await applyMemoryChange(
        tx,
        {
          memoryScopeId,
          characterId,
          snapshotId,
          actorType: "USER",
          auditActionPrefix: "memory.review_",
          actorId: ownerId,
          // 人工采纳用此刻数据库里的状态做对照：这条记忆可能已经被后面的归档改过了。
          resolvePrevious: async (memoryId) => tx.memoryItem.findFirst({
            where: { id: memoryId, memoryScopeId },
            select: { category: true, content: true },
          }),
          canTarget: () => true,
          handledMemoryIds: new Set<string>(),
          existingItemSignatures,
          existingDedupeKeys: new Set<string>(),
        },
        change,
        evidence,
      );
      if (!applied) return null;

      const memoryItemId = typeof applied.memoryItemId === "string"
        ? applied.memoryItemId
        : typeof applied.supersededMemoryId === "string"
          ? applied.supersededMemoryId
          : null;
      await tx.memoryReview.create({
        data: {
          snapshotId,
          changeIndex,
          decision: "ACCEPTED",
          memoryItemId,
          outcome: typeof applied.result === "string" ? applied.result : null,
          decidedByUserId: ownerId,
        },
      });
      await tx.auditLog.create({
        data: {
          actorType: "USER",
          actorId: ownerId,
          characterId,
          action: "snapshot.review_accepted",
          entityType: "MemorySnapshot",
          entityId: snapshotId,
          details: {
            changeIndex,
            action: typeof applied.action === "string" ? applied.action : null,
            result: typeof applied.result === "string" ? applied.result : null,
            memoryItemId,
            supersededMemoryId: typeof applied.supersededMemoryId === "string" ? applied.supersededMemoryId : null,
            content: typeof applied.content === "string" ? applied.content : null,
          },
        },
      });
      return applied;
    });
  } catch (error) {
    // 并发双击时唯一索引会先报错：整笔事务回滚，记忆不会被改两次。
    if (error && typeof error === "object" && "code" in error && error.code === "P2002") {
      throw createError({ statusCode: 409, statusMessage: "这条建议刚刚已被处理，请刷新后再看。" });
    }
    throw error;
  }

  if (!outcome) {
    throw createError({
      statusCode: 409,
      statusMessage: "这条建议已经不能应用：它指向的记忆已被后续归档改动或删除。可以改为忽略。",
    });
  }

  return {
    snapshotId,
    changeIndex,
    decision: "ACCEPTED" as const,
    outcome: outcome.result ?? null,
    memoryItemId: typeof outcome.memoryItemId === "string" ? outcome.memoryItemId : null,
    supersededMemoryId: typeof outcome.supersededMemoryId === "string" ? outcome.supersededMemoryId : null,
  };
});
