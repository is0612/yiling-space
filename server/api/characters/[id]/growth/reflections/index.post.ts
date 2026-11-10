import { getRouterParam, readBody } from "h3";
import { requireActorUserId } from "../../../../../utils/auth";
import { requireUuid } from "../../../../../utils/local-api";
import { getPrisma } from "../../../../../utils/prisma";
import { parseReflectionRequest, requestReflection } from "../../../../../utils/reflection-service";
export default defineEventHandler(async event => {
  const ownerId = await requireActorUserId(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const body = parseReflectionRequest(await readBody(event));
  return requestReflection(getPrisma(), { ownerId, characterId, ...body });
});
