import { createError, getRouterParam } from "h3";
import { requireActorUserId } from "../../../../../../../utils/auth";
import { requireUuid } from "../../../../../../../utils/local-api";
import { getPrisma } from "../../../../../../../utils/prisma";

export default defineEventHandler(async (event) => {
  const ownerId = await requireActorUserId(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const candidateId = requireUuid(getRouterParam(event, "candidateId") ?? "", "知识候选");
  const prisma = getPrisma();
  const character = await prisma.character.findFirst({ where: { id: characterId, ownerId }, select: { id: true } });
  if (!character) throw createError({ statusCode: 404, statusMessage: "角色不存在。" });
  const result = await prisma.knowledgeCandidate.updateMany({
    where: { id: candidateId, characterId, status: { notIn: ["ACCEPTED", "PROCESSING"] } },
    data: { status: "DISMISSED" },
  });
  if (!result.count) throw createError({ statusCode: 404, statusMessage: "候选不存在、正在处理或已经入库。" });
  return { ok: true };
});
