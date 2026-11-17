import { createError, defineEventHandler, getRouterParam } from "h3";
import { requireActorUserId } from "../../../../../../../utils/auth";
import { requireUuid } from "../../../../../../../utils/local-api";
import { getPrisma } from "../../../../../../../utils/prisma";

function idsFromJson(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
}

export default defineEventHandler(async event => {
  const ownerId = await requireActorUserId(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const runId = requireUuid(getRouterParam(event, "runId") ?? "", "主题发现批次");
  const prisma = getPrisma();
  const character = await prisma.character.findFirst({ where: { id: characterId, ownerId }, select: { id: true } });
  if (!character) throw createError({ statusCode: 404, statusMessage: "角色不存在。" });

  const run = await prisma.knowledgeTopicRun.findFirst({
    where: { id: runId, characterId },
    include: {
      suggestions: {
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: {
          id: true, name: true, description: true, reason: true, memberItemIds: true,
          acceptedMemberItemIds: true, status: true, reviewedAt: true, createdAt: true,
        },
      },
    },
  });
  if (!run) throw createError({ statusCode: 404, statusMessage: "主题发现批次不存在。" });

  const inputSnapshot = Array.isArray(run.inputSnapshot) ? run.inputSnapshot as Array<{ itemId?: unknown; revision?: unknown }> : [];
  const itemIds = [...new Set([
    ...inputSnapshot.map(row => row.itemId).filter((id): id is string => typeof id === "string"),
    ...run.suggestions.flatMap(suggestion => idsFromJson(suggestion.memberItemIds)),
  ])];
  const items = itemIds.length ? await prisma.knowledgeItem.findMany({
    where: { id: { in: itemIds }, characterId },
    select: { id: true, title: true, category: true, status: true, revision: true, updatedAt: true },
  }) : [];
  const itemById = new Map(items.map(item => [item.id, item]));
  return {
    run: {
      id: run.id, status: run.status, attemptCount: run.attemptCount, maxAttempts: run.maxAttempts,
      lastError: run.lastError, runAt: run.runAt, createdAt: run.createdAt,
      updatedAt: run.updatedAt, completedAt: run.completedAt,
      inputSnapshot: inputSnapshot.map(row => ({
        itemId: row.itemId, revision: row.revision,
        item: typeof row.itemId === "string" ? itemById.get(row.itemId) ?? null : null,
      })),
      ungroupedItems: idsFromJson(run.ungroupedIds).map(id => itemById.get(id)).filter(Boolean),
      suggestions: run.suggestions.map(suggestion => ({
        ...suggestion,
        members: idsFromJson(suggestion.memberItemIds).map(id => ({
          itemId: id, item: itemById.get(id) ?? null,
        })),
        acceptedMembers: idsFromJson(suggestion.acceptedMemberItemIds).map(id => ({
          itemId: id, item: itemById.get(id) ?? null,
        })),
      })),
    },
  };
});
