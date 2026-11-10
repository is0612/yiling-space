import { getRouterParam } from "h3";
import { requireActorUserId } from "../../../../../utils/auth";
import { requireUuid } from "../../../../../utils/local-api";
import { getPrisma } from "../../../../../utils/prisma";
import { readGrowthDelivery } from "../../../../../utils/growth-delivery-monitor";

export default defineEventHandler(async event => {
  const ownerId = await requireActorUserId(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const deliveryId = requireUuid(getRouterParam(event, "deliveryId") ?? "", "投递");
  return readGrowthDelivery(getPrisma(), { ownerId, characterId, deliveryId });
});
