import { getRouterParam, readBody } from "h3";
import { requireActorUserId } from "../../../../../utils/auth";
import { requireUuid } from "../../../../../utils/local-api";
import { getPrisma } from "../../../../../utils/prisma";
import { parseMemoryKnowledgeRequest, requestMemoryKnowledgeCandidate } from "../../../../../utils/knowledge-memory-candidates";

export default defineEventHandler(async event => {
  const ownerId = await requireActorUserId(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const memoryEventId = requireUuid(getRouterParam(event, "eventId") ?? "", "忆泡");
  const body = parseMemoryKnowledgeRequest(await readBody(event));
  return requestMemoryKnowledgeCandidate(getPrisma(), { ownerId, characterId, memoryEventId, ...body });
});
