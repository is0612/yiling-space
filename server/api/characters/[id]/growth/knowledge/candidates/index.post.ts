import { createError, getRouterParam, readBody } from "h3";
import type { Prisma } from "../../../../../../../src/generated/prisma/client";
import { requireActorUserId } from "../../../../../../utils/auth";
import { requireUuid } from "../../../../../../utils/local-api";
import { getPrisma } from "../../../../../../utils/prisma";

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export default defineEventHandler(async (event) => {
  const ownerId = await requireActorUserId(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const body = asRecord(await readBody<unknown>(event));
  const rawContent = typeof body.rawContent === "string" ? body.rawContent.trim() : "";
  if (!rawContent) throw createError({ statusCode: 400, statusMessage: "请先填写要整理的知识内容。" });
  if (rawContent.length > 20_000) throw createError({ statusCode: 400, statusMessage: "单条候选内容不能超过 20000 个字符。" });
  const sourceType = typeof body.sourceType === "string" && ["MANUAL", "CHAT", "IMPORT"].includes(body.sourceType)
    ? body.sourceType : "MANUAL";
  const sourceRef = body.sourceRef !== null && typeof body.sourceRef === "object" && !Array.isArray(body.sourceRef)
    ? body.sourceRef : undefined;
  if (sourceRef && JSON.stringify(sourceRef).length > 10_000) {
    throw createError({ statusCode: 400, statusMessage: "来源信息过大。" });
  }
  const prisma = getPrisma();
  const character = await prisma.character.findFirst({ where: { id: characterId, ownerId }, select: { id: true } });
  if (!character) throw createError({ statusCode: 404, statusMessage: "角色不存在。" });
  const candidate = await prisma.knowledgeCandidate.create({
    data: { characterId, sourceType, sourceRef: sourceRef as Prisma.InputJsonObject | undefined, rawContent },
    select: { id: true, sourceType: true, sourceRef: true, rawContent: true, status: true, createdAt: true },
  });
  return { candidate };
});
