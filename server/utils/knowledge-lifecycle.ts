import { createError } from "h3";
import type { Prisma } from "../../src/generated/prisma/client";

/**
 * 正式知识的生命周期规则。
 *
 * 四种状态：
 * - ACTIVE　　：正常知识，可以检索。
 * - ARCHIVED　：归档，不参与检索，可恢复。
 * - TRASHED　 ：回收站，不参与检索，可恢复或永久删除。
 * - MERGED　　：合并后的源知识，只作为审计链的一环，不允许普通恢复。
 *
 * 本阶段只开放四类人工操作，全部要求 expectedRevision 乐观锁：
 * ACTIVE→ARCHIVED、ARCHIVED→ACTIVE、ACTIVE→TRASHED、TRASHED→ACTIVE。
 * MERGED 是合并事务的产物，没有人工入口。
 */

export const KNOWLEDGE_STATUS = {
  ACTIVE: "ACTIVE",
  ARCHIVED: "ARCHIVED",
  TRASHED: "TRASHED",
  MERGED: "MERGED",
} as const;

export type KnowledgeStatus = typeof KNOWLEDGE_STATUS[keyof typeof KNOWLEDGE_STATUS];

export type KnowledgeLifecycleOperation = "ARCHIVE" | "UNARCHIVE" | "TRASH" | "RESTORE";

type LifecycleRule = {
  from: KnowledgeStatus;
  to: KnowledgeStatus;
  /** 写进 knowledge_item_revisions.action 的值，用来区分「内容修订」与「生命周期操作」。 */
  history: "ARCHIVE" | "UNARCHIVE" | "TRASH" | "RESTORE";
  label: string;
  message: string;
};

export const KNOWLEDGE_LIFECYCLE_RULES: Record<KnowledgeLifecycleOperation, LifecycleRule> = {
  ARCHIVE: {
    from: "ACTIVE", to: "ARCHIVED", history: "ARCHIVE",
    label: "归档", message: "知识已归档，不再参与检索。",
  },
  UNARCHIVE: {
    from: "ARCHIVED", to: "ACTIVE", history: "UNARCHIVE",
    label: "取消归档", message: "知识已取消归档，恢复参与检索。",
  },
  TRASH: {
    from: "ACTIVE", to: "TRASHED", history: "TRASH",
    label: "移入回收站", message: "知识已移入回收站，不再参与检索。",
  },
  RESTORE: {
    from: "TRASHED", to: "ACTIVE", history: "RESTORE",
    label: "从回收站恢复", message: "知识已从回收站恢复。",
  },
};

/** 永久删除必须显式带上的二次确认口令，避免误触和被脚本顺手调用。 */
export const KNOWLEDGE_PURGE_CONFIRMATION = "PERMANENT_DELETE";

const STATUS_LABELS: Record<string, string> = {
  ACTIVE: "正常", ARCHIVED: "已归档", TRASHED: "回收站", MERGED: "已合并",
};

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function parseLifecycleBody(value: unknown): { expectedRevision: number } {
  const body = asRecord(value);
  const allowed = new Set(["expectedRevision"]);
  if (Object.keys(body).some(key => !allowed.has(key))) {
    throw createError({ statusCode: 400, statusMessage: "生命周期请求包含不允许的字段。" });
  }
  const revision = body.expectedRevision;
  if (typeof revision !== "number" || !Number.isInteger(revision) || revision < 1) {
    throw createError({ statusCode: 400, statusMessage: "请提供有效的知识版本号（expectedRevision）。" });
  }
  return { expectedRevision: revision };
}

export function parsePurgeBody(value: unknown): { expectedRevision: number; confirm: string } {
  const body = asRecord(value);
  const allowed = new Set(["expectedRevision", "confirm"]);
  if (Object.keys(body).some(key => !allowed.has(key))) {
    throw createError({ statusCode: 400, statusMessage: "永久删除请求包含不允许的字段。" });
  }
  const { expectedRevision } = parseLifecycleBody({ expectedRevision: body.expectedRevision });
  if (body.confirm !== KNOWLEDGE_PURGE_CONFIRMATION) {
    throw createError({
      statusCode: 400,
      statusMessage: `永久删除需要二次确认：请在 confirm 中明确填写 ${KNOWLEDGE_PURGE_CONFIRMATION}。`,
    });
  }
  return { expectedRevision, confirm: KNOWLEDGE_PURGE_CONFIRMATION };
}

/**
 * 在一个事务里完成状态变更 + 历史快照。
 *
 * 快照记录的是「变更前」的完整状态，revision 取变更前的版本号，
 * 与内容编辑、合并保持同一套语义：第 N 行快照代表被第 N+1 版取代的那一版。
 */
export async function applyKnowledgeLifecycle(
  tx: Prisma.TransactionClient,
  input: {
    characterId: string;
    itemId: string;
    operation: KnowledgeLifecycleOperation;
    expectedRevision: number;
  },
): Promise<{ id: string; status: string; revision: number }> {
  const rule = KNOWLEDGE_LIFECYCLE_RULES[input.operation];

  const current = await tx.knowledgeItem.findFirst({
    where: { id: input.itemId, characterId: input.characterId },
    select: {
      id: true, status: true, revision: true, title: true, content: true,
      category: true, tags: true, confidence: true, sourceType: true, sourceRef: true,
    },
  });
  if (!current) {
    throw createError({ statusCode: 404, statusMessage: "正式知识不存在或不属于当前角色。" });
  }
  if (current.status !== rule.from) {
    throw createError({
      statusCode: 409,
      statusMessage: `当前知识处于「${STATUS_LABELS[current.status] ?? current.status}」，不能执行${rule.label}。`,
    });
  }
  if (current.revision !== input.expectedRevision) {
    throw createError({ statusCode: 409, statusMessage: "这条知识已被其他操作修改，请刷新后再试。" });
  }

  // 条件更新兜住读与写之间的并发：状态或版本被抢先改动时 count 为 0。
  const updated = await tx.knowledgeItem.updateMany({
    where: {
      id: input.itemId,
      characterId: input.characterId,
      status: rule.from,
      revision: input.expectedRevision,
    },
    data: { status: rule.to, revision: { increment: 1 } },
  });
  if (updated.count !== 1) {
    throw createError({ statusCode: 409, statusMessage: "这条知识刚刚发生变化，请刷新后再试。" });
  }

  await tx.knowledgeItemRevision.create({
    data: {
      itemId: current.id,
      revision: current.revision,
      title: current.title,
      content: current.content,
      category: current.category,
      tags: current.tags,
      confidence: current.confidence,
      // 快照保留变更前的状态，配合 action 能完整还原每次生命周期变化。
      status: current.status,
      sourceType: current.sourceType,
      sourceRef: current.sourceRef === null ? undefined : current.sourceRef as Prisma.InputJsonValue,
      action: rule.history,
    },
  });

  return { id: current.id, status: rule.to, revision: current.revision + 1 };
}

/**
 * 永久删除：只允许回收站条目，且必须没有 MERGED_INTO 审计关系。
 *
 * 关系与版本历史都在同一事务内显式清理（虽然外键是级联删除），
 * 目的是让「删了什么」在代码里一眼可见，也避免未来外键行为变化时留下孤立数据。
 */
export async function purgeKnowledgeItem(
  tx: Prisma.TransactionClient,
  input: { characterId: string; itemId: string; expectedRevision: number },
): Promise<{ id: string; deletedRelations: number; deletedRevisions: number }> {
  const item = await tx.knowledgeItem.findFirst({
    where: { id: input.itemId, characterId: input.characterId },
    select: { id: true, status: true, revision: true },
  });
  if (!item) {
    throw createError({ statusCode: 404, statusMessage: "正式知识不存在或不属于当前角色。" });
  }
  if (item.status !== KNOWLEDGE_STATUS.TRASHED) {
    throw createError({ statusCode: 409, statusMessage: "只有回收站中的知识可以永久删除。" });
  }
  if (item.revision !== input.expectedRevision) {
    throw createError({ statusCode: 409, statusMessage: "这条知识已被其他操作修改，请刷新后再试。" });
  }

  // 合并审计链：只要这条知识参与过任何一次 MERGED_INTO（作为源或目标），就拒绝删除。
  const auditRelation = await tx.knowledgeItemRelation.findFirst({
    where: {
      characterId: input.characterId,
      relationType: "MERGED_INTO",
      OR: [{ sourceItemId: item.id }, { targetItemId: item.id }],
    },
    select: { id: true },
  });
  if (auditRelation) {
    throw createError({
      statusCode: 409,
      statusMessage: "这条知识参与过合并，属于合并审计链的一部分，不能永久删除。",
    });
  }

  const relations = await tx.knowledgeItemRelation.deleteMany({
    where: {
      characterId: input.characterId,
      OR: [{ sourceItemId: item.id }, { targetItemId: item.id }],
    },
  });
  const revisions = await tx.knowledgeItemRevision.deleteMany({ where: { itemId: item.id } });
  const removed = await tx.knowledgeItem.deleteMany({
    where: { id: item.id, characterId: input.characterId, status: KNOWLEDGE_STATUS.TRASHED },
  });
  if (removed.count !== 1) {
    throw createError({ statusCode: 409, statusMessage: "知识状态刚刚发生变化，已取消永久删除。" });
  }

  return { id: item.id, deletedRelations: relations.count, deletedRevisions: revisions.count };
}
