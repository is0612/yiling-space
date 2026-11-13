import { createError } from "h3";
import { Prisma, type PrismaClient } from "../../src/generated/prisma/client";

export function readGrowthOverviewDays(value: unknown): 7 | 14 | 30 {
  if (value === undefined) return 7;
  if (typeof value !== "string" || !["7", "14", "30"].includes(value)) throw createError({ statusCode: 400, statusMessage: "时间范围只能是7、14或30天。" });
  return Number(value) as 7 | 14 | 30;
}
const stageLabels: Record<string, string> = { STRANGER: "陌生", ACQUAINTANCE: "认识", FRIEND: "朋友", CLOSE_FRIEND: "好朋友" };
const relationStatusLabels: Record<string, string> = { NORMAL: "正常", DISTANT: "疏远", CONFLICT: "冲突", REPAIRING: "修复中", UNOBSERVED: "尚未观察" };

export async function readGrowthOverview(prisma: PrismaClient, input: { ownerId: string; characterId: string; days: 7 | 14 | 30; now?: Date }) {
  const now = input.now ?? new Date();
  const start = new Date(now.getTime() - input.days * 86_400_000);
  const period = { gte: start, lt: now };
  const role = { characterId: input.characterId, character: { ownerId: input.ownerId } };
  const globalScope = { ...role, scopeType: "CHARACTER_GLOBAL" as const };
  const relationScope = { ...role, scopeType: "EXTERNAL_IDENTITY" as const };
  // One consistent read snapshot; a review committed during aggregation cannot split counters and rows.
  return prisma.$transaction(async tx => {
    const character = await tx.character.findFirst({ where: { id: input.characterId, ownerId: input.ownerId }, select: { id: true, name: true } });
    if (!character) throw createError({ statusCode: 404, statusMessage: "角色不存在。" });
    const conclusionWhere = { status: "ACCEPTED" as const, acceptedAt: period, run: { ...role, conversationId: null, memoryScopeId: null } };
    const knowledgeWhere = { ...role, status: "ACTIVE", createdAt: period };
    const changeWhere = { scope: relationScope, createdAt: period };
    const deliveryBase = { event: { is: role } };
    const [memories, knowledge, relationships, conclusions, pendingReflection, pendingKnowledge, pendingRelationships,
      latestConclusions, knowledgeRows, changeRows, snapshotRows, failed, stuck, ready] = await Promise.all([
      tx.memoryEvent.count({ where: { memoryScope: globalScope, status: "ACTIVE", occurredAt: period } }),
      tx.knowledgeItem.count({ where: knowledgeWhere }),
      tx.socialRelationChange.count({ where: changeWhere }),
      tx.reflectionSuggestion.count({ where: conclusionWhere }),
      tx.reflectionSuggestion.count({ where: { status: { in: ["PENDING", "DEFERRED"] }, run: { ...role, conversationId: null, memoryScopeId: null } } }),
      tx.knowledgeCandidate.count({ where: { ...role, status: { in: ["PENDING", "REVIEW", "FAILED"] } } }),
      tx.socialRelationshipAssessment.count({ where: { scope: relationScope, status: "SUCCEEDED", reviewStatus: { in: ["PENDING", "DEFERRED"] } } }),
      tx.reflectionSuggestion.findMany({ where: conclusionWhere, orderBy: [{ acceptedAt: "desc" }, { id: "desc" }], take: 8,
        select: { id: true, title: true, observation: true, inference: true, recommendation: true, acceptedAt: true, sourceRefs: true } }),
      tx.knowledgeItem.findMany({ where: knowledgeWhere, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 8, select: { id: true, title: true, createdAt: true } }),
      tx.socialRelationChange.findMany({ where: changeWhere, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 8, select: { id: true, fromStage: true, toStage: true, fromStatus: true, toStatus: true, createdAt: true } }),
      tx.memorySnapshot.findMany({ where: { memoryScope: globalScope, status: "CURRENT", createdAt: period }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 8, select: { id: true, version: true, createdAt: true, periodStart: true, periodEnd: true } }),
      tx.growthEventDelivery.count({ where: { ...deliveryBase, status: "FAILED" } }),
      tx.growthEventDelivery.count({ where: { ...deliveryBase, status: "RUNNING", OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }] } }),
      tx.growthEventDelivery.count({ where: { ...deliveryBase, status: { in: ["QUEUED", "RETRY_WAIT"] }, runAt: { lte: now } } }),
    ]);
    const href = (path: string) => `${path}?c=${encodeURIComponent(character.id)}`;
    const timeline = [
      ...latestConclusions.map(row => ({ id: row.id, type: "reflection" as const, title: row.title, at: row.acceptedAt!.toISOString(), description: "已接受的成长结论 · 不自动修改人设", href: href("/growth/reflection") })),
      ...knowledgeRows.map(row => ({ id: row.id, type: "knowledge" as const, title: row.title, at: row.createdAt.toISOString(), description: "已入库的正式知识", href: href("/growth/knowledge") })),
      ...changeRows.map(row => ({ id: row.id, type: "relationship" as const, title: row.fromStage !== row.toStage ? `关系阶段：${stageLabels[row.fromStage]} → ${stageLabels[row.toStage]}` : `相处状态：${relationStatusLabels[row.fromStatus ?? "UNOBSERVED"]} → ${relationStatusLabels[row.toStatus ?? "UNOBSERVED"]}`, at: row.createdAt.toISOString(), description: "已保存的关系变化 · 查看评估与依据", href: href("/growth/social/assessments") })),
      ...snapshotRows.map(row => ({ id: row.id, type: "snapshot" as const, title: "保存了一份阶段总结", at: row.createdAt.toISOString(), description: `${row.periodStart.toISOString().slice(0, 10)} — ${row.periodEnd.toISOString().slice(0, 10)} · 第${row.version}版（UTC）`, href: href("/growth/memory/snapshots") })),
    ].sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id)).slice(0, 8);
    return {
      character, period: { days: input.days, start: start.toISOString(), end: now.toISOString() }, generatedAt: now.toISOString(),
      stats: { memories, knowledge, relationships, conclusions },
      pending: { reflections: pendingReflection, knowledge: pendingKnowledge, relationships: pendingRelationships },
      conclusions: latestConclusions.slice(0, 2).map(row => ({ ...row, acceptedAt: row.acceptedAt!.toISOString() })),
      timeline, delivery: { failed, stuck, ready },
    };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 15_000 });
}
