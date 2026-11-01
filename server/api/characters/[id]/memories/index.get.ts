import { createError, getQuery, getRouterParam } from "h3";
import type { Prisma } from "../../../../../src/generated/prisma/client";
import { requireActorUserId } from "../../../../utils/auth";
import { requireUuid } from "../../../../utils/local-api";
import { getPrisma } from "../../../../utils/prisma";

/**
 * 角色记忆的检索。
 *
 * 为什么需要它：时间线只载最近 400 条（且记忆和总结抢额度），
 * 「找一条三个月前记下的偏好」在页面上是做不到的。这个接口走关键词 + 分类 + 状态筛选，
 * 用游标翻页，不受时间线的额度影响。
 *
 * 游标的用意：记忆会不断更新（updatedAt 在变），offset 分页会漏条目或重复，
 * 所以按 `(updatedAt, id)` 做 keyset 分页，并把它编码成不透明字符串，前端不需要知道内部结构。
 */

const CATEGORIES = ["FACT", "PREFERENCE", "RELATIONSHIP", "COMMITMENT", "GOAL", "EVENT", "SUMMARY", "OTHER"] as const;
const STATUSES = ["ACTIVE", "SUPERSEDED", "ARCHIVED", "INVALIDATED", "TRASHED"] as const;
const SCOPES = ["CHARACTER_GLOBAL", "USER_PRIVATE", "EXTERNAL_IDENTITY"] as const;

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;

type Cursor = { updatedAt: Date; id: string };

function decodeCursor(raw: unknown): Cursor | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const [time, id] = Buffer.from(raw, "base64url").toString("utf8").split("|");
    if (!time || !id) return null;
    const updatedAt = new Date(time);
    if (Number.isNaN(updatedAt.getTime())) return null;
    return { updatedAt, id };
  } catch {
    return null;
  }
}

function encodeCursor(updatedAt: Date, id: string): string {
  return Buffer.from(`${updatedAt.toISOString()}|${id}`, "utf8").toString("base64url");
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
  const cursor = decodeCursor(query.cursor);
  const limit = Math.min(Math.max(Number(query.limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);

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

  const baseWhere: Prisma.MemoryItemWhereInput = {
    // 默认不带回收站：要找已删的条目有专门的回收站入口
    status: status ?? { not: "TRASHED" },
    memoryScope: { is: { characterId, ...(scope ? { scopeType: scope } : {}) } },
  };
  if (category) baseWhere.category = category;
  if (keyword) baseWhere.content = { contains: keyword, mode: "insensitive" };

  const pageWhere: Prisma.MemoryItemWhereInput = cursor
    ? {
      ...baseWhere,
      OR: [
        { updatedAt: { lt: cursor.updatedAt } },
        { updatedAt: cursor.updatedAt, id: { lt: cursor.id } },
      ],
    }
    : baseWhere;

  const [rows, total] = await Promise.all([
    // 多取一条用来判断「还有没有下一页」，比再发一次 count 便宜
    prisma.memoryItem.findMany({
      where: pageWhere,
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take: limit + 1,
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
    }),
    prisma.memoryItem.count({ where: baseWhere }),
  ]);

  const hasMore = rows.length > limit;
  const items = (hasMore ? rows.slice(0, limit) : rows).map((row) => ({
    id: row.id,
    category: row.category,
    content: row.content,
    status: row.status,
    scopeType: row.memoryScope.scopeType,
    importance: row.importance,
    validTo: row.validTo?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }));
  const last = items.at(-1);

  return {
    items,
    total,
    nextCursor: hasMore && last ? encodeCursor(new Date(last.updatedAt), last.id) : null,
  };
});
