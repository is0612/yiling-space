import { createError, getRouterParam } from "h3";
import { requireActorUserId } from "../../../../../../utils/auth";
import { requireUuid } from "../../../../../../utils/local-api";
import { getPrisma } from "../../../../../../utils/prisma";
import { readModelTurnDetail, readModelTurnId } from "../../../../../../utils/model-turn-detail";

export default defineEventHandler(async (event) => {
  const ownerId = await requireActorUserId(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const logId = requireUuid(getRouterParam(event, "logId") ?? "", "日志");
  const prisma = getPrisma();
  const character = await prisma.character.findFirst({ where: { id: characterId, ownerId }, select: { id: true } });
  if (!character) throw createError({ statusCode: 404, statusMessage: "角色不存在。" });
  const log = await prisma.modelUsage.findFirst({ where: { id: logId, characterId }, select: { metadata: true } });
  const turnId = readModelTurnId(log?.metadata);
  if (!turnId) throw createError({ statusCode: 404, statusMessage: "这条历史记录未保存本轮详情。" });
  // Resolve only within the authorized character; never return raw metadata or another turn's diagnostics.
  const rows = await prisma.modelUsage.findMany({
    where: { characterId, kind: { in: ["chat", "channel"] }, metadata: { path: ["turnId"], equals: turnId } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 2,
    select: { createdAt: true, metadata: true },
  });
  for (const row of rows) {
    const metadata = row.metadata !== null && typeof row.metadata === "object" && !Array.isArray(row.metadata) ? row.metadata : {};
    const detail = readModelTurnDetail(metadata.turnDetail);
    if (detail) return { turnId, createdAt: row.createdAt.toISOString(), detail };
  }
  throw createError({ statusCode: 404, statusMessage: "本轮详情尚未保存或已不可用。" });
});
