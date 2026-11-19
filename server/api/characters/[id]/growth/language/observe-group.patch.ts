import { createError, getRouterParam, readBody } from "h3";
import { requireActorUserId } from "../../../../../utils/auth";
import { requireUuid } from "../../../../../utils/local-api";
import { getPrisma } from "../../../../../utils/prisma";
import { setAutomaticGroupObservation } from "../../../../../utils/group-observation-automatic";

export default defineEventHandler(async event => {
  const ownerId = await requireActorUserId(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const body = await readBody(event);
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 2 || typeof body.enabled !== "boolean" || typeof body.conversationId !== "string") {
    throw createError({ statusCode: 400, statusMessage: "请选择群聊和自动观察状态。" });
  }
  const conversationId = requireUuid(body.conversationId, "会话");
  return setAutomaticGroupObservation(getPrisma(), { ownerId, characterId, conversationId, enabled: body.enabled });
});
