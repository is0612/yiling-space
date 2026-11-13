import { createError, defineEventHandler, getRouterParam, readBody } from "h3";
import { requireActorUserId } from "../../../../../utils/auth";
import { requireUuid } from "../../../../../utils/local-api";
import { getPrisma } from "../../../../../utils/prisma";
import type { Prisma } from "../../../../../../src/generated/prisma/client";

export default defineEventHandler(async event => {
  const ownerId = await requireActorUserId(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const body = await readBody<Record<string, unknown>>(event);
  if (!body || typeof body.enabled !== "boolean" || Object.keys(body).some(key => key !== "enabled")) {
    throw createError({ statusCode: 400, statusMessage: "请提供自动形成经验的开关。" });
  }
  const enabled = body.enabled;
  return getPrisma().$transaction(async tx => {
    const character = await tx.character.findFirst({ where: { id: characterId, ownerId }, select: { modelConfig: true, updatedAt: true } });
    if (!character) throw createError({ statusCode: 404, statusMessage: "角色不存在。" });
    const config = character.modelConfig && typeof character.modelConfig === "object" && !Array.isArray(character.modelConfig)
      ? character.modelConfig as Prisma.JsonObject : {};
    const changed = await tx.character.updateMany({ where: { id: characterId, ownerId, updatedAt: character.updatedAt },
      data: { modelConfig: { ...config, interactionExperienceAutoEnabled: enabled } as Prisma.InputJsonObject } });
    if (changed.count !== 1) throw createError({ statusCode: 409, statusMessage: "角色设置已变化，请刷新后重试。" });
    await tx.auditLog.create({ data: { actorType: "USER", actorId: ownerId, characterId,
      action: "interaction_experience.automation_changed", entityType: "Character", entityId: characterId,
      details: { before: config.interactionExperienceAutoEnabled === true, enabled } } });
    return { enabled };
  });
});
