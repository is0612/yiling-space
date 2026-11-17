import { createError, defineEventHandler, getQuery, getRouterParam } from "h3";
import { requireActorUserId } from "../../../../../../utils/auth";
import { requireUuid } from "../../../../../../utils/local-api";
import { getPrisma } from "../../../../../../utils/prisma";

const RUN_STATUSES = new Set(["QUEUED", "PROCESSING", "READY", "FAILED", "STALE"]);

export default defineEventHandler(async event => {
  const ownerId = await requireActorUserId(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const prisma = getPrisma();
  const character = await prisma.character.findFirst({ where: { id: characterId, ownerId }, select: { id: true } });
  if (!character) throw createError({ statusCode: 404, statusMessage: "角色不存在。" });

  const query = getQuery(event);
  const status = typeof query.status === "string" ? query.status : undefined;
  if (status && !RUN_STATUSES.has(status)) {
    throw createError({ statusCode: 400, statusMessage: "主题发现批次状态无效。" });
  }
  const page = Math.max(1, Math.min(10_000, Number.parseInt(String(query.page ?? "1"), 10) || 1));
  const pageSize = Math.max(1, Math.min(50, Number.parseInt(String(query.pageSize ?? "20"), 10) || 20));
  const where = { characterId, ...(status ? { status: status as "QUEUED" | "PROCESSING" | "READY" | "FAILED" | "STALE" } : {}) };
  const [runs, total] = await Promise.all([
    prisma.knowledgeTopicRun.findMany({
      where, orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * pageSize, take: pageSize,
      select: {
        id: true, status: true, attemptCount: true, maxAttempts: true, lastError: true,
        createdAt: true, updatedAt: true, completedAt: true, runAt: true,
        inputSnapshot: true, ungroupedIds: true,
        _count: { select: { suggestions: true } },
      },
    }),
    prisma.knowledgeTopicRun.count({ where }),
  ]);
  return {
    runs: runs.map(({ _count, inputSnapshot, ungroupedIds, ...run }) => ({
      ...run,
      inputCount: Array.isArray(inputSnapshot) ? inputSnapshot.length : 0,
      ungroupedCount: Array.isArray(ungroupedIds) ? ungroupedIds.length : 0,
      suggestionCount: _count.suggestions,
    })),
    pagination: { page, pageSize, total, pageCount: Math.max(1, Math.ceil(total / pageSize)) },
  };
});
