import { getRouterParam, readBody } from "h3";
import { requireActorUserId } from "../../../../../utils/auth";
import { requireUuid } from "../../../../../utils/local-api";
import { getPrisma } from "../../../../../utils/prisma";
import { updatePreference } from "../../../../../utils/preferences";

export default defineEventHandler(async event => {
  const ownerId = await requireActorUserId(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const preferenceId = requireUuid(getRouterParam(event, "preferenceId") ?? "", "偏好");
  return updatePreference(getPrisma(), { ownerId, characterId, preferenceId, body: await readBody(event) });
});
