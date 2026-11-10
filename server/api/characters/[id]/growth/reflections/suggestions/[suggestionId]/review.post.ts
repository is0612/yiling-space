import { getRouterParam, readBody } from "h3";
import { requireActorUserId } from "../../../../../../../utils/auth";
import { requireUuid } from "../../../../../../../utils/local-api";
import { getPrisma } from "../../../../../../../utils/prisma";
import { parseReflectionReview, reviewReflectionSuggestion } from "../../../../../../../utils/reflection-service";
export default defineEventHandler(async event => {
  const ownerId = await requireActorUserId(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const suggestionId = requireUuid(getRouterParam(event, "suggestionId") ?? "", "反思建议");
  const body = parseReflectionReview(await readBody(event));
  return reviewReflectionSuggestion(getPrisma(), { ownerId, characterId, suggestionId, ...body });
});
