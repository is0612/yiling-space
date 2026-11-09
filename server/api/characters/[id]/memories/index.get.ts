import { createError, getQuery, getRouterParam } from "h3";
import type { Prisma } from "../../../../../src/generated/prisma/client";
import { requireActorUserId } from "../../../../utils/auth";
import { requireUuid } from "../../../../utils/local-api";
import { getPrisma } from "../../../../utils/prisma";

/**
 * 角色长期记忆的列表：页码分页 + 关键词 / 分类 / 状态 / 范围筛选。
 *
 * 为什么从游标翻页换成页码：
 * 这一页是「记忆中枢」，进来先看到的是按时间倒序的一页记忆，点页码就能跳到第 7 页；
 * 游标只能「加载更多」，翻不回去，也不给总数。记忆量不大，offset 的代价可以忽略。
 *
 * 以前不传 q 时页面走的是 `/timeline?kinds=memory&limit=400`，一次拉 400 条再在前端切页；
 * 现在列表就是一页，编辑、归档、删除后重新取这一页即可。
 *
 * 统计（消息数 / 事件数 / 承诺数）不在这里顺带返回：那是另一个维度，用 `/memory-stats`。
 */

const CATEGORIES = ["FACT", "PREFERENCE", "RELATIONSHIP", "COMMITMENT", "GOAL", "EVENT", "SUMMARY", "OTHER"] as const;
const STATUSES = ["ACTIVE", "SUPERSEDED", "ARCHIVED", "INVALIDATED", "TRASHED"] as const;
const SCOPES = ["CHARACTER_GLOBAL", "USER_PRIVATE", "EXTERNAL_IDENTITY"] as const;

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

function positiveInt(value: unknown, fallback: number, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

export default defineEventHandler(async (event) => {
  const ownerId = await requireActorUserId(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const prisma = getPrisma();

  const character = await prisma.character.findFirst({
    where: { id: characterId, ownerId },
    select: { id: true },
  });
  if (!character) {
    throw createError({ statusCode: 404, statusMessage: "角色不存在。" });
  }

  const query = getQuery(event);
  const keyword = String(query.q ?? "").trim().slice(0, 200);
  const categoryRaw = String(query.category ?? "").trim().toUpperCase();
  const statusRaw = String(query.status ?? "").trim().toUpperCase();
  const scopeRaw = String(query.scope ?? "").trim().toUpperCase();
  const pageSize = positiveInt(query.pageSize, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
  const requestedPage = positiveInt(query.page, 1);

  // 非法值当作「没传」，不做报错：筛选器多打一个字不该整页 400。
  const category = (CATEGORIES as readonly string[]).includes(categoryRaw)
    ? categoryRaw as (typeof CATEGORIES)[number]
    : undefined;
  const status = (STATUSES as readonly string[]).includes(statusRaw)
    ? statusRaw as (typeof STATUSES)[number]
    : undefined;
  const scope = (SCOPES as readonly string[]).includes(scopeRaw)
    ? scopeRaw as (typeof SCOPES)[number]
    : undefined;

  const where: Prisma.MemoryItemWhereInput = {
    // 默认不带回收站：要找已删的条目有专门的回收站入口
    status: status ?? { not: "TRASHED" },
    memoryScope: { is: { characterId, ...(scope ? { scopeType: scope } : {}) } },
  };
  if (category) where.category = category;
  if (keyword) where.content = { contains: keyword, mode: "insensitive" };

  const total = await prisma.memoryItem.count({ where });
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(requestedPage, totalPages);

  const rows = await prisma.memoryItem.findMany({
    where,
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    skip: (page - 1) * pageSize,
    take: pageSize,
    select: {
      id: true,
      category: true,
      content: true,
      status: true,
      importance: true,
      validTo: true,
      createdAt: true,
      updatedAt: true,
      memoryScope: { select: { scopeType: true } },
    },
  });

  return {
    items: rows.map((row) => ({
      id: row.id,
      category: row.category,
      content: row.content,
      status: row.status,
      scopeType: row.memoryScope.scopeType,
      importance: row.importance,
      validTo: row.validTo?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    })),
    total,
    page,
    pageSize,
    totalPages,
  };
});
