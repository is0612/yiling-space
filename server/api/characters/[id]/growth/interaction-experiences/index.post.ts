import { getRouterParam, readBody } from "h3";
import { requireActorUserId } from "../../../../../utils/auth";
import { requireUuid } from "../../../../../utils/local-api";
import { getPrisma } from "../../../../../utils/prisma";
import { generateInteractionExperience } from "../../../../../utils/interaction-experiences";
export default defineEventHandler(async event => {
 const ownerId = await requireActorUserId(event);
 const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");
 const body = await readBody<Record<string, unknown>>(event);
 return generateInteractionExperience(getPrisma(), { ownerId, characterId, assistantMessageId: requireUuid(String(body?.assistantMessageId ?? ""), "助手回复"), feedbackMessageId: requireUuid(String(body?.feedbackMessageId ?? ""), "用户反馈") });
});
