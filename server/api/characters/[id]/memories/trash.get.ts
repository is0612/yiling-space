import { createError, getQuery, getRouterParam } from "h3";
import { requireActorUserId } from "../../../../utils/auth";
import { requireUuid } from "../../../../utils/local-api";
import { getPrisma } from "../../../../utils/prisma";

/**
 * 记忆回收站：只列软删除的长期记忆，按删除时间倒序分页。
 *
 * 以前一次全给：永久删除是少数操作，可回收站会长——一次几十上百条全画在弹窗里，
 * 打开就卡、也找不着最近删的那条。现在按页码取，和长期记忆列表同一套参数。
 */

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
  const character = await prisma.character.findFirst({ where: { id: characterId, ownerId }, select: { id: true } });
  if (!character) throw createError({ statusCode: 404, statusMessage: "角色不存在。" });

  const query = getQuery(event);
  const pageSize = positiveInt(query.pageSize, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
  const requestedPage = positiveInt(query.page, 1);

  const where = { status: "TRASHED" as const, memoryScope: { is: { characterId } } };
  const total = await prisma.memoryItem.count({ where });
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(requestedPage, totalPages);

  const rows = await prisma.memoryItem.findMany({
    where,
    orderBy: [{ deletedAt: "desc" }, { id: "desc" }],
    skip: (page - 1) * pageSize,
    take: pageSize,
    select: {
      id: true, category: true, content: true, status: true, statusBeforeTrash: true,
      deletedAt: true, createdAt: true, updatedAt: true,
    },
  });

  return {
    items: rows,
    total,
    page,
    pageSize,
    totalPages,
  };
});
