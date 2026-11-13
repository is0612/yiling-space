import { createError, getRouterParam, readBody } from "h3";
import { requireActorUserId } from "../../../../../utils/auth";
import { requireUuid } from "../../../../../utils/local-api";
import { getPrisma } from "../../../../../utils/prisma";
import { updateInteractionExperience } from "../../../../../utils/interaction-experiences";
export default defineEventHandler(async event => {
 const ownerId = await requireActorUserId(event);
 const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");
 const id = requireUuid(getRouterParam(event, "experienceId") ?? "", "经验");
 const body = await readBody<Record<string, unknown>>(event);
 if (!Number.isInteger(body?.revision) || Number(body.revision) < 1 || typeof body.operation !== "string") throw createError({ statusCode: 400, statusMessage: "请提供版本和操作。" });
 return updateInteractionExperience(getPrisma(), { ownerId, characterId, id, revision: Number(body.revision), operation: body.operation, content: body.content, context: body.context, learning: body.learning });
});
