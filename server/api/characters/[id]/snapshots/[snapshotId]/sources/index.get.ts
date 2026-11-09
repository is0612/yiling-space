import { createError, getQuery, getRouterParam } from "h3";
import type { Prisma } from "../../../../../../../src/generated/prisma/client";
import { requireActorUserId } from "../../../../../../utils/auth";
import { requireUuid } from "../../../../../../utils/local-api";
import { getPrisma } from "../../../../../../utils/prisma";

/**
 * 一份阶段总结的「来源消息与原文」，分页返回。
 *
 * 跨度大的周期能挂上百条原文，之前跟列表一起返回（还得整段渲染出来）。
 * 现在展开这一块才请求，一次只给一页；`index` 是这条消息在整份来源里的序号，
 * 翻到第 3 页也仍然是「#27」，和提炼结果里的「依据 #27」对得上。
 */

const DEFAULT_PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 50;

function positiveInt(value: unknown, fallback: number, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

export default defineEventHandler(async (event) => {
  const ownerId = await requireActorUserId(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const snapshotId = requireUuid(getRouterParam(event, "snapshotId") ?? "", "阶段总结");
  const prisma = getPrisma();

  const character = await prisma.character.findFirst({
    where: { id: characterId, ownerId },
    select: { id: true },
  });
  if (!character) {
    throw createError({ statusCode: 404, statusMessage: "角色不存在。" });
  }

  const snapshot = await prisma.memorySnapshot.findFirst({
    where: { id: snapshotId, memoryScope: { is: { characterId } } },
    select: { id: true },
  });
  if (!snapshot) {
    throw createError({ statusCode: 404, statusMessage: "阶段总结不存在。" });
  }

  const query = getQuery(event);
  const pageSize = positiveInt(query.pageSize, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
  const requestedPage = positiveInt(query.page, 1);

  // 与详情接口同一个排序：证据编号「#3」必须两处一致。
  const where: Prisma.MemorySnapshotSourceWhereInput = {
    snapshotId,
    sourceType: "MESSAGE",
    messageId: { not: null },
  };
  const total = await prisma.memorySnapshotSource.count({ where });
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(requestedPage, totalPages);
  const skip = (page - 1) * pageSize;

  const rows = await prisma.memorySnapshotSource.findMany({
    where,
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    skip,
    take: pageSize,
    select: {
      message: {
        select: {
          id: true,
          role: true,
          eventType: true,
          content: true,
          occurredAt: true,
          conversation: { select: { title: true } },
        },
      },
    },
  });

  return {
    items: rows.flatMap((row, offset) => row.message
      ? [{
          index: skip + offset + 1,
          id: row.message.id,
          role: row.message.role,
          eventType: row.message.eventType,
          content: row.message.content,
          occurredAt: row.message.occurredAt.toISOString(),
          conversationTitle: row.message.conversation.title,
        }]
      : []),
    total,
    page,
    pageSize,
    totalPages,
  };
});
