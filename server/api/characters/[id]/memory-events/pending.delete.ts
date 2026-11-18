import { defineEventHandler, getRouterParam, readBody } from "h3";
import { requireActorUserId } from "../../../../utils/auth";
import { requireUuid } from "../../../../utils/local-api";
import { getPrisma } from "../../../../utils/prisma";
import { deletePendingMemoryEvents } from "../../../../utils/memory-events-pending-delete";

export default defineEventHandler(async event => {
  const ownerId = await requireActorUserId(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  return deletePendingMemoryEvents(getPrisma(), { ownerId, characterId, body: await readBody(event) });
});
